mod app_menu;
mod core_process;
mod credentials;
mod desktop_links;
mod diagnostics;
mod document_export;
mod error;
mod exit_gate;
mod provider_boundary;
mod settings_transaction;
mod sidecar;
mod sidecar_paths;
mod startup;
mod startup_theme;
mod updates;
mod window_geometry;

#[cfg(test)]
mod test_support;

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State, WindowEvent};

use error::{code, IpcError};
use sidecar::{ActiveSidecar, SecretRequest};

/// The build this app was made from (`build.rs`): short commit, `+dirty` when the tree had uncommitted
/// changes, and the UTC build date.
pub(crate) const BUILD_SHA: &str = env!("POMI_BUILD_SHA");
pub(crate) const BUILD_DATE: &str = env!("POMI_BUILD_DATE");

const ALLOWED_REQUESTS: &[&str] = &[
    "app.bootstrap",
    "app.reset",
    "prefs.set",
    "notices.get",
    "settings.get",
    "settings.import_legacy",
    "settings.set",
    "credentials.delete",
    "worlds.list",
    "worlds.remember",
    "worlds.forget",
    "world.inspect",
    "worlds.discover",
    "resume.status",
    "models.list",
    "prompt.enhance",
    "provider.usage",
    "scan.start",
    "candidates.page",
    "estimate.get",
    "translate.start",
    "translate.resume",
    "backups.list",
    "restore.start",
    // Unfinished-job recovery and backup maintenance write to worlds or the backup store; they run
    // as jobs (see `sidecar::lane`). `jobs.recover` is accepted for a core that names it so.
    "recovery.start",
    "jobs.recover",
    "backups.delete",
    "backups.prune",
    // Per-world review drafts are small reads and writes of the core's own data.
    "review.draft.get",
    "review.draft.set",
    "review.draft.clear",
    // The glossary (global and per world) is read and written by the core itself; import and
    // export move a file the person chose. All four are short requests, none carries a key.
    "glossary.get",
    "glossary.set",
    "glossary.import",
    "glossary.export",
];

/// Requests whose payload gets `credentialOwner: rust`, so the sidecar never touches the keychain.
const CREDENTIAL_OWNER_REQUESTS: &[&str] = &[
    "app.bootstrap",
    "settings.get",
    "settings.set",
    "models.list",
    "prompt.enhance",
    "provider.usage",
    "scan.start",
    "translate.start",
    "translate.resume",
];

/// Requests that need the stored API key, which Rust reads and puts in the payload.
const KEY_INJECTED_REQUESTS: &[&str] = &[
    "models.list",
    "prompt.enhance",
    "provider.usage",
    "translate.start",
    "translate.resume",
];

fn is_allowed_request(kind: &str) -> bool {
    ALLOWED_REQUESTS.contains(&kind)
}

/// Only the pinned, public OpenRouter catalog can bypass credential access.
fn is_public_catalog(kind: &str, payload: &serde_json::Map<String, Value>) -> bool {
    kind == "models.list"
        && payload.get("provider").and_then(Value::as_str) == Some("openrouter")
        && payload.get("publicCatalog").and_then(Value::as_bool) == Some(true)
}

/// Where credentials, reports and the logs live.
pub(crate) fn app_data_root(app: &tauri::AppHandle) -> Result<PathBuf, IpcError> {
    app.path()
        .app_data_dir()
        .map_err(|_| IpcError::new(code::INTERNAL, "Application data directory is unavailable"))
}

/// A vault or keychain failure while a request needs the key: the request cannot run, and the page is
/// told which step repairs it. Other errors (an endpoint mismatch, a bad provider) pass through.
fn credential_unavailable(error: IpcError) -> IpcError {
    let storage = error.code.starts_with("VAULT_") || error.code.starts_with("KEYCHAIN_");
    if storage {
        IpcError::new(code::CREDENTIAL_UNAVAILABLE, error.message).with_detail(error.code)
    } else {
        error
    }
}

/// What `credentials.delete` answers with when the key could not be removed. A refused OS delete
/// (`KEYCHAIN_UNCONFIRMED`) is its own answer, not an unavailable store: the app's own copies are
/// gone, the OS entry is not, and deleting again tries it again.
fn delete_error(error: IpcError) -> IpcError {
    if error.code == code::KEYCHAIN_UNCONFIRMED {
        error
    } else {
        credential_unavailable(error)
    }
}

/// Run blocking vault work off the async workers and the main thread (CR-6).
async fn vault<T: Send + 'static>(
    app: &tauri::AppHandle,
    work: impl FnOnce(&credentials::Credentials, &Path) -> Result<T, IpcError> + Send + 'static,
) -> Result<T, IpcError> {
    let root = app_data_root(app)?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let credentials = handle.state::<credentials::Credentials>();
        work(&credentials, &root)
    })
    .await
    .map_err(|_| IpcError::new(code::INTERNAL, "Credential work could not finish"))?
}

fn logged<T>(source: &str, result: Result<T, IpcError>) -> Result<T, IpcError> {
    if let Err(error) = &result {
        diagnostics::global().log_error(source, error);
    }
    result
}

#[tauri::command]
async fn credential_status(
    app: tauri::AppHandle,
    provider: String,
) -> Result<credentials::State, IpcError> {
    vault(&app, move |credentials, root| {
        Ok(credentials.state(root, &provider))
    })
    .await
}

#[tauri::command]
async fn credential_import(
    app: tauri::AppHandle,
    provider: String,
    endpoint: Option<String>,
) -> Result<credentials::Status, IpcError> {
    let endpoint = endpoint
        .as_deref()
        .and_then(provider_boundary::canonical_endpoint);
    logged(
        "credential_import",
        vault(&app, move |credentials, root| {
            credentials.import_keychain(root, &provider, endpoint.as_deref())
        })
        .await,
    )
}

/// "Reset credential storage": set the damaged vault aside and start an empty one. Saved keys in it
/// are gone from the app; the set-aside copy stays on disk until the app is reset.
#[tauri::command]
async fn credential_reset_storage(
    app: tauri::AppHandle,
    state: State<'_, ActiveSidecar>,
) -> Result<(), IpcError> {
    // Held until the reset is done: no request starts, and no core is active or unconfirmed (R10).
    let _gate = logged("credential_reset_storage", state.maintenance())?;
    logged(
        "credential_reset_storage",
        vault(&app, |credentials, root| {
            credentials.reset_storage(root).map_err(|error| {
                IpcError::new(code::CREDENTIAL_RESET_FAILED, error.message).with_detail(error.code)
            })
        })
        .await,
    )
}

/// What `native_reset` did, whatever went wrong on the way (M6). The page reads this to say exactly
/// what was and was not removed; a failure of one step never hides the others.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ResetOutcome {
    /// Every credential store (the OS entries this app wrote, the vault, the key directory and the
    /// set-aside copies) was emptied and confirmed. False when keys were not asked for, too.
    keys_deleted: bool,
    /// Some stores were emptied and some could not be confirmed; see `errors`.
    keys_partially_deleted: bool,
    /// The saved run reports are gone.
    reports_cleared: bool,
    /// Stable codes of what failed, without repeats.
    errors: Vec<&'static str>,
}

impl ResetOutcome {
    fn note(&mut self, code: &'static str) {
        if !self.errors.contains(&code) {
            self.errors.push(code);
        }
    }

    fn absorb_purge(&mut self, purged: &credentials::Purged) {
        self.keys_deleted = purged.complete();
        self.keys_partially_deleted =
            !self.keys_deleted && (!purged.keychain_deleted.is_empty() || purged.files_removed);
        if !purged.keychain_failed.is_empty() {
            self.note(code::KEYCHAIN_UNCONFIRMED);
        }
        for reason in &purged.errors {
            self.note(reason);
        }
        if !purged.files_removed && purged.errors.is_empty() {
            self.note(code::VAULT_IO);
        }
    }
}

/// The Rust-owned half of "reset the app" (RB-9): saved keys first (when asked), then the run
/// reports. The page resets the core's own data only after this reports `keysDeleted` (when keys
/// were asked for) and `reportsCleared`. Every step runs even when an earlier one failed, and the
/// outcome says which ones did; only a busy gate is an error.
#[tauri::command]
async fn native_reset(
    app: tauri::AppHandle,
    state: State<'_, ActiveSidecar>,
    delete_keys: bool,
) -> Result<ResetOutcome, IpcError> {
    // Held until the reset is done: no request starts, and no core is active or unconfirmed (R10).
    let _gate = logged("native_reset", state.maintenance())?;
    let outcome = vault(&app, move |credentials, root| {
        Ok(reset_native(credentials, root, delete_keys))
    })
    .await;
    match outcome {
        Ok(outcome) => {
            for reason in &outcome.errors {
                diagnostics::global().log("ERROR", "native_reset", reason);
            }
            Ok(outcome)
        }
        Err(error) => logged("native_reset", Err(error)),
    }
}

fn reset_native(
    credentials: &credentials::Credentials,
    root: &Path,
    delete_keys: bool,
) -> ResetOutcome {
    let mut outcome = ResetOutcome::default();
    if delete_keys {
        match credentials.purge(root) {
            Ok(purged) => outcome.absorb_purge(&purged),
            Err(error) => outcome.note(error.code),
        }
    }
    match clear_reports(&root.join("reports")) {
        Ok(()) => outcome.reports_cleared = true,
        Err(error) => outcome.note(error.code),
    }
    outcome
}

fn clear_reports(reports: &Path) -> Result<(), IpcError> {
    let failed = || IpcError::new(code::RESET_FAILED, "Could not remove the saved run reports");
    let entries = match fs::read_dir(reports) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(failed()),
    };
    // Every entry is tried; an entry that cannot be listed or removed fails the whole step.
    let mut clean = true;
    for entry in entries {
        let Ok(entry) = entry else {
            clean = false;
            continue;
        };
        let path = entry.path();
        let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        let removed = if is_dir {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        clean &= removed.is_ok();
    }
    if clean {
        Ok(())
    } else {
        Err(failed())
    }
}

#[tauri::command]
async fn sidecar_request(
    app: tauri::AppHandle,
    state: State<'_, ActiveSidecar>,
    request: Value,
) -> Result<Value, IpcError> {
    let kind = request
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    logged(
        &format!("sidecar_request:{kind}"),
        handle_request(&app, &state, request).await,
    )
}

async fn handle_request(
    app: &tauri::AppHandle,
    state: &ActiveSidecar,
    request: Value,
) -> Result<Value, IpcError> {
    // From here on the request is wiped when it is dropped, whichever way this function ends: the
    // key is put into it later, and nothing between that and the core's stdin can strand a copy (M5).
    let mut request = SecretRequest::new(request);
    let invalid = |message: &str| IpcError::new(code::INVALID_REQUEST, message.to_owned());
    let kind = request
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Missing request type"))?
        .to_string();
    if !is_allowed_request(&kind) {
        return Err(IpcError::new(
            code::UNSUPPORTED_REQUEST,
            "Unsupported request type",
        ));
    }
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Missing request id"))?
        .to_string();
    if request.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(invalid("Unsupported protocol version"));
    }

    let _request_guard = state.request_gate.try_lock().map_err(|_| {
        IpcError::new(
            code::BUSY,
            "Another PomiTranslate operation is still running",
        )
    })?;

    let provider = request
        .get("payload")
        .and_then(|payload| payload.get("provider"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if kind == "credentials.delete" {
        if provider.is_empty() {
            return Err(invalid("Missing credential provider"));
        }
        let target = provider.clone();
        vault(app, move |credentials, root| {
            credentials.delete(root, &target)
        })
        .await
        .map_err(delete_error)?;
        return Ok(serde_json::json!({
            "v": 1,
            "id": id,
            "type": "response.ok",
            "payload": {"provider": provider, "deleted": true, "apiKeyStored": false}
        }));
    }
    if CREDENTIAL_OWNER_REQUESTS.contains(&kind.as_str()) {
        if let Some(payload) = request.get_mut("payload").and_then(Value::as_object_mut) {
            payload.insert("credentialOwner".into(), Value::String("rust".into()));
        }
    }
    // (mode, key the person typed, endpoint the key is for) to commit after the core saved.
    let mut pending_credential = None;
    if kind == "settings.set" {
        let payload = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| invalid("Invalid settings payload"))?;
        provider_boundary::validate(payload)?;
        let endpoint = provider_boundary::bound_endpoint(payload);
        let supplied = zeroize::Zeroizing::new(match payload.remove("apiKey") {
            Some(Value::String(value)) => value,
            None | Some(Value::Null) => String::new(),
            _ => return Err(invalid("API key must be text")),
        });
        let requested: Option<credentials::Mode> = match payload.remove("credentialMode") {
            Some(value) => Some(
                serde_json::from_value(value)
                    .map_err(|_| invalid("Unknown credential storage mode"))?,
            ),
            None => None,
        };
        let current = {
            let target = provider.clone();
            vault(app, move |credentials, root| {
                Ok(credentials.state(root, &target))
            })
            .await?
        };
        let mode = requested.or(current.mode).unwrap_or_default();
        // A settings change that does not touch the key never needs the vault, so a damaged one
        // cannot stop preferences from saving (CR-3).
        let changes_storage = !supplied.is_empty()
            || match current.error {
                None => current.mode != Some(mode),
                Some(_) => current.mode.is_some() && current.mode != Some(mode),
            };
        if changes_storage {
            pending_credential = Some((mode, supplied, endpoint));
        }
    } else if KEY_INJECTED_REQUESTS.contains(&kind.as_str()) {
        let payload = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| invalid("Invalid provider payload"))?;
        provider_boundary::validate(payload)?;
        // Frontend cannot bypass the selected store with an arbitrary supplied key.
        payload.remove("apiKey");
        // The core independently checks that all included sources have manual values.
        // A false claim receives no key and cannot enable an authenticated API call.
        let manual_only = matches!(kind.as_str(), "translate.start" | "translate.resume")
            && payload.get("manualOnly").and_then(Value::as_bool) == Some(true);
        if !manual_only && !is_public_catalog(&kind, payload) {
            let endpoint = provider_boundary::bound_endpoint(payload);
            let target = provider.clone();
            let secret = vault(app, move |credentials, root| {
                credentials.read(root, &target, endpoint.as_deref())
            })
            .await
            .map_err(credential_unavailable)?;
            if let Some(mut secret) = secret {
                // Moved, not copied: the Zeroizing wrapper is left with an empty string.
                payload.insert("apiKey".into(), Value::String(std::mem::take(&mut *secret)));
            }
        }
    }

    let (mut response, committed_status) =
        if let Some((mode, supplied, endpoint)) = pending_credential {
            let root = app_data_root(app)?;
            let credentials = app.state::<credentials::Credentials>();
            settings_transaction::save(
                // The key was taken out of this request above: nothing in it needs wiping.
                request.into_value(),
                |request| sidecar::exchange(app, state, request),
                || {
                    credentials
                        .save(&root, &provider, mode, &supplied, endpoint.as_deref())
                        .map_err(|error| settings_transaction::CommitError {
                            uncertain: error.uncertain,
                            reason: Some(error.error.code),
                        })
                },
            )
            .await?
        } else {
            (sidecar::exchange(app, state, request).await?, None)
        };
    if response.get("type").and_then(Value::as_str) == Some("response.ok")
        && matches!(
            kind.as_str(),
            "app.bootstrap" | "settings.get" | "settings.set"
        )
    {
        let response_provider = if provider.is_empty() {
            response
                .get("payload")
                .and_then(|p| p.get("settings"))
                .and_then(|s| s.get("provider"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            provider.clone()
        };
        // Credential storage is reported as data: a vault that cannot be opened never fails these
        // requests, and "unavailable" is never presented as "empty".
        let storage = if let Some(status) = committed_status {
            credentials::State {
                mode: Some(status.mode),
                stored: Some(status.stored),
                error: None,
            }
        } else {
            vault(app, move |credentials, root| {
                Ok(credentials.state(root, &response_provider))
            })
            .await?
        };
        if let Some(payload) = response.get_mut("payload").and_then(Value::as_object_mut) {
            payload.insert(
                "apiKeyStored".into(),
                Value::Bool(storage.stored.unwrap_or(false)),
            );
            if let Some(mode) = storage.mode {
                payload.insert(
                    "credentialMode".into(),
                    serde_json::to_value(mode)
                        .map_err(|_| IpcError::new(code::INTERNAL, "Invalid credential mode"))?,
                );
            }
            payload.insert(
                "credentialState".into(),
                serde_json::to_value(&storage)
                    .map_err(|_| IpcError::new(code::INTERNAL, "Invalid credential state"))?,
            );
        }
    }

    Ok(response)
}

#[tauri::command]
fn operation_active(state: State<'_, ActiveSidecar>) -> bool {
    state.busy()
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<updates::UpdateInfo, IpcError> {
    logged("update_check", updates::check(&app).await)
}

#[tauri::command]
async fn update_install(
    app: tauri::AppHandle,
    state: State<'_, ActiveSidecar>,
    control: State<'_, updates::UpdateControl>,
) -> Result<(), IpcError> {
    logged(
        "update_install",
        updates::install(&app, &control, &state).await,
    )
}

#[tauri::command]
fn update_cancel(control: State<'_, updates::UpdateControl>) {
    control.cancel();
}

#[tauri::command]
fn cancel_active(state: State<'_, ActiveSidecar>) -> Result<bool, IpcError> {
    state.request_cancel()
}

/// What `force_stop_active` returns.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForceStopResult {
    /// A core was running and is now gone.
    was_running: bool,
    /// It had to be killed because it did not end when its stdin closed.
    killed: bool,
    /// The `app.bootstrap` reply read right after the stop, so the page shows the interrupted job.
    #[serde(skip_serializing_if = "Option::is_none")]
    bootstrap: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bootstrap_error: Option<IpcError>,
}

/// Wait until the interrupted request has let go of the operation gate and the slot.
async fn wait_until_idle(state: &ActiveSidecar, limit: Duration) -> bool {
    let started = tokio::time::Instant::now();
    while state.busy() {
        if started.elapsed() >= limit {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    true
}

/// "Stop now" for a job that did not react to its cancel request (SC-2, SC-6). Allowed only
/// `FORCE_STOP_AFTER_CANCEL` after the cancel request. The core is stopped as a tree and its exit is
/// observed before this returns; then the app state is read back (read-only `app.bootstrap`), which
/// is where the core reports the job it found interrupted.
#[tauri::command]
async fn force_stop_active(
    app: tauri::AppHandle,
    state: State<'_, ActiveSidecar>,
) -> Result<ForceStopResult, IpcError> {
    let stopped = logged(
        "force_stop_active",
        state.force_stop(sidecar::FORCE_STOP_AFTER_CANCEL).await,
    )?;
    let mut result = ForceStopResult {
        was_running: stopped.was_running,
        killed: stopped.killed,
        bootstrap: None,
        bootstrap_error: None,
    };
    if stopped.was_running {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        let request = serde_json::json!({
            "v": 1,
            "id": format!("force-stop-bootstrap-{millis}"),
            "type": "app.bootstrap",
            "payload": {}
        });
        let outcome = if wait_until_idle(&state, Duration::from_secs(10)).await {
            handle_request(&app, &state, request).await
        } else {
            Err(IpcError::new(
                code::BUSY,
                "The stopped job has not released the core yet",
            ))
        };
        match logged("force_stop_active:bootstrap", outcome) {
            Ok(reply) => result.bootstrap = Some(reply),
            Err(error) => result.bootstrap_error = Some(error),
        }
    }
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    build_sha: &'static str,
    build_date: &'static str,
    os: &'static str,
    arch: &'static str,
}

/// Version and build of this app, for About and diagnostics.
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        build_sha: BUILD_SHA,
        build_date: BUILD_DATE,
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

/// Versions, platform, recent events and the core's last stderr lines, for "copy diagnostics".
#[tauri::command]
fn diagnostics_snapshot() -> String {
    diagnostics::global().snapshot()
}

/// The folder in a second launch's arguments, if any: a world folder or its `level.dat`. Relative
/// paths are taken from the second launch's own working directory.
fn world_path_from_args(args: &[String], cwd: &str) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-') && !arg.is_empty())
        .find_map(|arg| {
            let mut path = PathBuf::from(arg);
            if path.is_relative() {
                path = Path::new(cwd).join(path);
            }
            if path
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("level.dat"))
                && path.is_file()
            {
                path.pop();
            }
            path.is_dir().then(|| path.to_string_lossy().into_owned())
        })
}

/// Only the app's own pages may load in the main window. Everything else goes through
/// `open_external` to the system browser (EX-6).
fn navigation_allowed(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    let own = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        "about" => url.as_str() == "about:blank",
        _ => false,
    };
    own || dev_url.is_some_and(|dev| {
        url.scheme() == dev.scheme() && url.host_str() == dev.host_str() && url.port() == dev.port()
    })
}

fn navigation_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_url = if cfg!(debug_assertions) {
                webview.app_handle().config().build.dev_url.clone()
            } else {
                None
            };
            let allowed = navigation_allowed(url, dev_url.as_ref());
            if !allowed {
                // Where the page tried to go is not logged: it is the page's text.
                diagnostics::global().log("WARN", "navigation", "blocked a navigation");
            }
            allowed
        })
        .build()
}

pub fn run() {
    diagnostics::install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                // A second launch with a world folder opens it, like dropping it on the window.
                if let Some(path) = world_path_from_args(&args, &cwd) {
                    let _ = window.emit("pomi-open-world", path);
                }
            }
        }))
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(window_geometry::state_plugin())
        .plugin(window_geometry::clamp_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ActiveSidecar::default())
        .manage(credentials::Credentials::default())
        .manage(updates::UpdateControl::default())
        .manage(exit_gate::ExitControl::default())
        .setup(|app| {
            if let Ok(local) = app.path().app_local_data_dir() {
                diagnostics::global().set_dir(local.join("logs"));
            }
            diagnostics::global().log("INFO", "app", "PomiTranslate started");
            if let Ok(root) = app.path().app_data_dir() {
                credentials::remove_legacy_ledger(&root);
            }
            app_menu::install(app)?;
            startup_theme::apply(app);
            Ok(())
        })
        .on_menu_event(|app, event| {
            app_menu::select(app, event.id().as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_request,
            cancel_active,
            force_stop_active,
            app_info,
            credential_status,
            credential_import,
            credential_reset_storage,
            native_reset,
            operation_active,
            diagnostics_snapshot,
            document_export::diagnostics_export,
            document_export::export_document,
            app_menu::set_menu_labels,
            app_menu::set_menu_theme,
            desktop_links::open_external,
            desktop_links::data_locations,
            desktop_links::reveal_data_folder,
            update_check,
            update_install,
            update_cancel,
            exit_gate::exit_set_settings_dirty,
            exit_gate::exit_confirm,
            exit_gate::exit_keep_waiting,
            exit_gate::exit_cancel,
            exit_gate::exit_force
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !exit_gate::allow_close(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build PomiTranslate")
        .run(|app, event| {
            match &event {
                // Quitting by Cmd+Q, the app menu or a session logout skips CloseRequested. It is held
                // the same way while a job runs or settings are unsaved. An exit the person already
                // confirmed carries a code and passes.
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if code.is_none() && !exit_gate::allow_close(app) {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => app.state::<ActiveSidecar>().kill_now(),
                _ => {}
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_catalog_bypass_is_limited_to_openrouter_model_reads() {
        let public = serde_json::json!({"provider":"openrouter", "publicCatalog":true});
        assert!(is_public_catalog(
            "models.list",
            public.as_object().unwrap()
        ));
        for kind in [
            "translate.start",
            "translate.resume",
            "prompt.enhance",
            "provider.usage",
        ] {
            assert!(!is_public_catalog(kind, public.as_object().unwrap()));
        }
        for payload in [
            serde_json::json!({"provider":"custom", "publicCatalog":true}),
            serde_json::json!({"provider":"openai", "publicCatalog":true}),
            serde_json::json!({"provider":"openrouter", "publicCatalog":"true"}),
            serde_json::json!({"provider":"openrouter"}),
        ] {
            assert!(!is_public_catalog(
                "models.list",
                payload.as_object().unwrap()
            ));
        }
    }

    #[test]
    fn only_known_requests_reach_the_sidecar() {
        for kind in [
            "app.bootstrap",
            "settings.set",
            "scan.start",
            "candidates.page",
            "estimate.get",
            "translate.start",
            "translate.resume",
            "backups.list",
            "restore.start",
            "models.list",
            "prefs.set",
            "app.reset",
            "recovery.start",
            "jobs.recover",
            "backups.delete",
            "backups.prune",
            "review.draft.get",
            "review.draft.set",
            "review.draft.clear",
            "glossary.get",
            "glossary.set",
            "glossary.import",
            "glossary.export",
            "credentials.delete",
        ] {
            assert!(is_allowed_request(kind), "{kind} must be allowed");
        }
        for kind in [
            "",
            "shell.exec",
            "scan.start ",
            "SCAN.START",
            "settings.set/../x",
            "translate",
        ] {
            assert!(!is_allowed_request(kind), "{kind:?} must be refused");
        }
    }

    #[test]
    fn every_request_that_runs_as_a_job_is_allowed_and_none_gets_a_key_or_credential_ownership() {
        for kind in ALLOWED_REQUESTS {
            let job = sidecar::lane(kind) == sidecar::Lane::Job;
            // Backup maintenance, recovery and restore never need the provider key.
            if job && !matches!(*kind, "translate.start" | "translate.resume" | "scan.start") {
                assert!(!KEY_INJECTED_REQUESTS.contains(kind), "{kind}");
                assert!(!CREDENTIAL_OWNER_REQUESTS.contains(kind), "{kind}");
            }
        }
        for kind in [
            "scan.start",
            "translate.start",
            "translate.resume",
            "restore.start",
            "recovery.start",
            "backups.delete",
            "backups.prune",
        ] {
            assert_eq!(sidecar::lane(kind), sidecar::Lane::Job, "{kind}");
            assert!(is_allowed_request(kind), "{kind}");
        }
        for kind in [
            "review.draft.get",
            "review.draft.set",
            "review.draft.clear",
            "glossary.get",
            "glossary.set",
            "glossary.import",
            "glossary.export",
        ] {
            assert_eq!(sidecar::lane(kind), sidecar::Lane::Query, "{kind}");
            assert!(!KEY_INJECTED_REQUESTS.contains(&kind));
            assert!(!CREDENTIAL_OWNER_REQUESTS.contains(&kind));
        }
    }

    #[test]
    fn requests_that_carry_a_key_also_hand_credential_ownership_to_rust() {
        for kind in KEY_INJECTED_REQUESTS {
            assert!(
                CREDENTIAL_OWNER_REQUESTS.contains(kind),
                "{kind} is given a key but not told Rust owns it"
            );
            assert!(is_allowed_request(kind));
        }
        for kind in CREDENTIAL_OWNER_REQUESTS
            .iter()
            .chain(KEY_INJECTED_REQUESTS)
        {
            assert!(is_allowed_request(kind), "{kind} is listed but not allowed");
        }
        // Reading a world, plan or settings preview never needs the key.
        for kind in [
            "settings.import_legacy",
            "prefs.set",
            "app.reset",
            "scan.start",
            "candidates.page",
            "estimate.get",
            "restore.start",
            "backups.list",
        ] {
            assert!(
                !KEY_INJECTED_REQUESTS.contains(&kind),
                "{kind} must not receive the API key"
            );
        }
    }

    #[test]
    fn storage_failures_become_one_actionable_code_with_the_reason_attached() {
        for reason in [
            code::VAULT_PERMISSIONS,
            code::VAULT_SCHEMA,
            code::VAULT_CORRUPT,
            code::VAULT_IO,
            code::VAULT_KEY_MISSING,
            code::VAULT_LOCKED,
            code::KEYCHAIN_UNAVAILABLE,
            code::KEYCHAIN_FAILED,
        ] {
            let error = credential_unavailable(IpcError::new(reason, "x"));
            assert_eq!(error.code, code::CREDENTIAL_UNAVAILABLE);
            assert_eq!(error.detail, Some(reason));
        }
        let mismatch =
            credential_unavailable(IpcError::new(code::CREDENTIAL_ENDPOINT_MISMATCH, "x"));
        assert_eq!(
            mismatch.code,
            code::CREDENTIAL_ENDPOINT_MISMATCH,
            "passes through unchanged"
        );
    }

    #[test]
    fn a_second_launch_with_a_world_folder_or_level_dat_opens_it() {
        let dir = tempfile::tempdir().unwrap();
        let world = dir.path().join("My World");
        fs::create_dir(&world).unwrap();
        fs::write(world.join("level.dat"), b"x").unwrap();
        let exe = "C:/Program Files/PomiTranslate/pomitranslate.exe".to_owned();
        let expected = world.to_string_lossy().into_owned();
        let cwd = dir.path().to_string_lossy().into_owned();
        for args in [
            vec![exe.clone(), expected.clone()],
            vec![
                exe.clone(),
                "--flag".into(),
                world.join("level.dat").to_string_lossy().into_owned(),
            ],
            vec![exe.clone(), "My World".into()],
        ] {
            assert_eq!(
                world_path_from_args(&args, &cwd).as_deref(),
                Some(expected.as_str()),
                "{args:?}"
            );
        }
        for args in [
            vec![exe.clone()],
            vec![exe.clone(), "--help".into()],
            vec![exe.clone(), "does-not-exist".into()],
            vec![
                exe.clone(),
                world
                    .join("level.dat")
                    .to_string_lossy()
                    .replace("level.dat", "other.txt"),
            ],
        ] {
            assert_eq!(world_path_from_args(&args, &cwd), None, "{args:?}");
        }
    }

    #[test]
    fn navigation_is_limited_to_the_app_and_the_dev_server() {
        let url = |text: &str| tauri::Url::parse(text).unwrap();
        let dev = url("http://127.0.0.1:5173");
        for allowed in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/#/settings",
            "about:blank",
        ] {
            assert!(navigation_allowed(&url(allowed), None), "{allowed}");
        }
        assert!(navigation_allowed(
            &url("http://127.0.0.1:5173/"),
            Some(&dev)
        ));
        for refused in [
            "https://evil.example/",
            "http://tauri.localhost.evil.example/",
            "http://127.0.0.1:5173/",
            "http://127.0.0.1:9999/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,hi",
            "tauri://evil/",
        ] {
            assert!(!navigation_allowed(&url(refused), None), "{refused}");
        }
        assert!(!navigation_allowed(
            &url("http://127.0.0.1:9999/"),
            Some(&dev)
        ));
    }

    #[test]
    fn reports_are_cleared_without_touching_other_data() {
        let dir = tempfile::tempdir().unwrap();
        let reports = dir.path().join("reports");
        fs::create_dir_all(reports.join("nested")).unwrap();
        fs::write(reports.join("scan-report.json"), b"{}").unwrap();
        fs::write(reports.join("nested/x.json"), b"{}").unwrap();
        let keep = dir.path().join("other.txt");
        fs::write(&keep, b"x").unwrap();
        clear_reports(&reports).unwrap();
        assert!(reports.is_dir());
        assert_eq!(fs::read_dir(&reports).unwrap().count(), 0);
        assert!(keep.exists());
        clear_reports(&dir.path().join("missing")).unwrap();
    }

    #[test]
    fn there_is_no_request_that_binds_a_stored_key_to_an_endpoint() {
        // R2: the renderer cannot say where a legacy key belongs; only re-entering the key does.
        for kind in ["credentials.confirmEndpoint", "credentials.bind"] {
            assert!(!is_allowed_request(kind), "{kind}");
        }
        assert!(ALLOWED_REQUESTS
            .iter()
            .all(|kind| !kind.starts_with("credentials.") || *kind == "credentials.delete"));
        // Nothing asks the shell to forget or accept what is in the OS keychain: the app only ever
        // deletes its own entries, on the person's explicit delete, mode switch or reset.
        assert!(!is_allowed_request(
            "credentials.acknowledgeUnknownKeychain"
        ));
    }

    // --- M6: the reset reports what it did, whatever failed --------------------------------------

    const KEY: &str = "fixture-secret-never-persist-in-plaintext-1942";

    #[test]
    fn a_reset_clears_the_reports_and_confirms_the_keys_when_everything_worked() {
        let dir = tempfile::tempdir().unwrap();
        let (credentials, fake) = credentials::with_fake_keychain();
        credentials
            .save(dir.path(), "openai", credentials::Mode::Keychain, KEY, None)
            .unwrap();
        fs::create_dir_all(dir.path().join("reports")).unwrap();
        fs::write(dir.path().join("reports/a.json"), b"{}").unwrap();
        let outcome = reset_native(&credentials, dir.path(), true);
        assert_eq!(
            outcome,
            ResetOutcome {
                keys_deleted: true,
                keys_partially_deleted: false,
                reports_cleared: true,
                errors: vec![],
            }
        );
        assert!(fake.entries.lock().unwrap().is_empty());
        assert!(!dir.path().join("credentials").exists());
    }

    #[test]
    fn a_reset_asks_the_os_store_only_about_providers_the_vault_says_used_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let (credentials, fake) = credentials::with_fake_keychain();
        credentials
            .save(dir.path(), "openai", credentials::Mode::Keychain, KEY, None)
            .unwrap();
        credentials
            .save(dir.path(), "gemini", credentials::Mode::Local, KEY, None)
            .unwrap();
        // No row says the keychain was ever used for gemini: an entry of that name is not touched.
        fake.entries
            .lock()
            .unwrap()
            .insert("gemini".into(), "not-ours-fixture".into());
        // Entries under other names are not the app's and stay.
        fake.entries
            .lock()
            .unwrap()
            .insert("someone-else".into(), "foreign-fixture".into());
        fake.log.lock().unwrap().clear();
        let outcome = reset_native(&credentials, dir.path(), true);
        assert!(outcome.keys_deleted, "{outcome:?}");
        assert!(outcome.errors.is_empty(), "{outcome:?}");
        let entries = fake.entries.lock().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.contains_key("someone-else") && entries.contains_key("gemini"));
        // One delete, for the one provider the vault recorded; nothing read, nothing listed.
        assert_eq!(*fake.log.lock().unwrap(), ["delete:openai"]);
    }

    #[test]
    fn a_reset_of_someone_who_never_used_the_keychain_reports_deleted_and_never_reaches_the_os() {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let (credentials, fake) = credentials::with_fake_keychain();
        credentials
            .save(dir.path(), "openai", credentials::Mode::Local, KEY, None)
            .unwrap();
        // A platform without a credential store, or a locked one, must not matter to them.
        fake.fail_delete.store(true, Ordering::SeqCst);
        let outcome = reset_native(&credentials, dir.path(), true);
        assert!(outcome.keys_deleted, "{outcome:?}");
        assert!(!outcome.keys_partially_deleted, "{outcome:?}");
        assert!(outcome.errors.is_empty(), "{outcome:?}");
        assert!(fake.log.lock().unwrap().is_empty());
        assert!(!dir.path().join("credentials").exists());
    }

    #[test]
    fn a_reset_with_a_missing_vault_tries_every_provider_and_no_store_is_nothing_to_delete() {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let (credentials, fake) = credentials::with_fake_keychain();
        fake.unavailable.store(true, Ordering::SeqCst);
        let outcome = reset_native(&credentials, dir.path(), true);
        assert!(
            outcome.keys_deleted && outcome.errors.is_empty(),
            "{outcome:?}"
        );
        assert_eq!(
            fake.log.lock().unwrap().len(),
            credentials::PROVIDERS.len(),
            "every provider was tried"
        );
        // A refused delete is still reported.
        fake.unavailable.store(false, Ordering::SeqCst);
        fake.fail_delete.store(true, Ordering::SeqCst);
        let refused = reset_native(&credentials, dir.path(), true);
        assert!(!refused.keys_deleted, "{refused:?}");
        assert_eq!(refused.errors, [code::KEYCHAIN_UNCONFIRMED]);
    }

    #[test]
    fn deleting_a_key_reports_could_not_confirm_as_its_own_code_and_other_storage_errors_as_before()
    {
        let unconfirmed = delete_error(IpcError::new(code::KEYCHAIN_UNCONFIRMED, "x"));
        assert_eq!(unconfirmed.code, code::KEYCHAIN_UNCONFIRMED);
        let failed = delete_error(IpcError::new(code::KEYCHAIN_FAILED, "x"));
        assert_eq!(failed.code, code::CREDENTIAL_UNAVAILABLE);
        assert_eq!(failed.detail, Some(code::KEYCHAIN_FAILED));
    }

    #[test]
    fn a_key_that_cannot_be_deleted_is_reported_and_the_rest_of_the_reset_still_runs() {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let (credentials, fake) = credentials::with_fake_keychain();
        credentials
            .save(dir.path(), "openai", credentials::Mode::Keychain, KEY, None)
            .unwrap();
        fs::create_dir_all(dir.path().join("reports")).unwrap();
        fs::write(dir.path().join("reports/a.json"), b"{}").unwrap();
        fake.fail_delete.store(true, Ordering::SeqCst);

        let outcome = reset_native(&credentials, dir.path(), true);
        assert!(!outcome.keys_deleted, "{outcome:?}");
        assert!(
            outcome.keys_partially_deleted,
            "the files are gone: {outcome:?}"
        );
        assert!(
            outcome.reports_cleared,
            "reports are cleared regardless: {outcome:?}"
        );
        assert_eq!(outcome.errors, [code::KEYCHAIN_UNCONFIRMED]);
        assert!(fake.entries.lock().unwrap().contains_key("openai"));

        // The retry finishes it: every known provider is deleted again.
        fake.fail_delete.store(false, Ordering::SeqCst);
        let retry = reset_native(&credentials, dir.path(), true);
        assert!(retry.keys_deleted && retry.errors.is_empty(), "{retry:?}");
        assert!(fake.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn without_delete_keys_nothing_credential_related_is_touched_or_claimed() {
        let dir = tempfile::tempdir().unwrap();
        let (credentials, fake) = credentials::with_fake_keychain();
        credentials
            .save(dir.path(), "openai", credentials::Mode::Keychain, KEY, None)
            .unwrap();
        let outcome = reset_native(&credentials, dir.path(), false);
        assert!(!outcome.keys_deleted && !outcome.keys_partially_deleted);
        assert!(outcome.reports_cleared && outcome.errors.is_empty());
        assert!(fake.entries.lock().unwrap().contains_key("openai"));
        assert!(dir.path().join("credentials").is_dir());
    }

    #[test]
    fn a_reports_failure_does_not_hide_that_the_keys_were_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let (credentials, fake) = credentials::with_fake_keychain();
        credentials
            .save(dir.path(), "openai", credentials::Mode::Keychain, KEY, None)
            .unwrap();
        // `reports` is a file, not a folder: it cannot be listed.
        fs::write(dir.path().join("reports"), b"not a folder").unwrap();
        let outcome = reset_native(&credentials, dir.path(), true);
        assert!(outcome.keys_deleted, "{outcome:?}");
        assert!(!outcome.reports_cleared);
        assert_eq!(outcome.errors, [code::RESET_FAILED]);
        assert!(fake.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn the_outcome_reaches_the_page_in_camel_case() {
        let value = serde_json::to_value(ResetOutcome {
            keys_deleted: true,
            keys_partially_deleted: false,
            reports_cleared: false,
            errors: vec![code::RESET_FAILED],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "keysDeleted": true,
                "keysPartiallyDeleted": false,
                "reportsCleared": false,
                "errors": ["RESET_FAILED"]
            })
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_report_that_cannot_be_removed_fails_the_step_but_every_other_entry_is_still_tried() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let reports = dir.path().join("reports");
        fs::create_dir_all(&reports).unwrap();
        fs::write(reports.join("a-first.json"), b"{}").unwrap();
        fs::write(reports.join("locked.json"), b"{}").unwrap();
        fs::write(reports.join("z-last.json"), b"{}").unwrap();
        // Held open without FILE_SHARE_DELETE: it cannot be removed.
        let _held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(reports.join("locked.json"))
            .unwrap();
        let error = clear_reports(&reports).unwrap_err();
        assert_eq!(error.code, code::RESET_FAILED);
        assert!(!reports.join("a-first.json").exists());
        assert!(!reports.join("z-last.json").exists());
        assert!(reports.join("locked.json").exists());
    }

    // --- L1: an empty verification plan is an error, not a pass --------------------------------

    #[test]
    fn verify_local_refuses_an_empty_step_selection_with_exit_code_two() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let script = root.join("scripts").join("verify-local.mjs");
        let Ok(output) = std::process::Command::new("node")
            .arg(&script)
            .args(["--only", "rust", "--skip", "rust"])
            .current_dir(&root)
            .output()
        else {
            eprintln!("skipped: node is not available");
            return;
        };
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(2), "{stderr}");
        assert!(
            stderr.contains("No verification steps selected"),
            "{stderr}"
        );
        assert!(
            !String::from_utf8_lossy(&output.stdout).contains("verify:local PASS"),
            "an empty plan must not look like a pass"
        );
    }
}

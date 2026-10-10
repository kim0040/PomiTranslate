mod app_menu;
mod close_guard;
mod credentials;
mod desktop_links;
mod document_export;
mod provider_boundary;
mod settings_transaction;
mod sidecar_paths;
mod sidecar_process;
mod startup;
mod startup_theme;
mod updates;
mod window_state;
mod zoom_menu;

use std::{fs, path::PathBuf, sync::Mutex, time::Duration};

use serde_json::Value;
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri_plugin_shell::ShellExt;

struct ActiveProcess {
    cancel_path: PathBuf,
}

#[derive(Default)]
struct ActiveSidecar {
    process: Mutex<Option<ActiveProcess>>,
    request_gate: tauri::async_runtime::Mutex<()>,
}

const ALLOWED_REQUESTS: &[&str] = &[
    "app.bootstrap",
    "app.reset",
    "prefs.set",
    "notices.get",
    "settings.get",
    "settings.import_legacy",
    "settings.set",
    "glossary.get",
    "glossary.set",
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
    "translate.retry_failed",
    "translate.apply",
    "translate.reapply",
    "translations.page",
    "backups.list",
    "restore.start",
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
    "translate.retry_failed",
];

/// Requests that need the stored API key, which Rust reads and puts in the payload.
const KEY_INJECTED_REQUESTS: &[&str] = &[
    "models.list",
    "prompt.enhance",
    "provider.usage",
    "translate.start",
    "translate.resume",
    "translate.retry_failed",
];

pub(crate) const CODE_BUSY: &str = "BUSY";
pub(crate) const CODE_CORE_STOPPED: &str = "CORE_STOPPED";
/// The page sent a request larger than any real request (see `MAX_REQUEST_BYTES`).
pub(crate) const CODE_REQUEST_TOO_LARGE: &str = "REQUEST_TOO_LARGE";
const CODE_CORE_WRITE_FAILED: &str = "CORE_WRITE_FAILED";

/// The largest serialized request the shell forwards to the core. The biggest real requests are
/// review edits and glossaries, far below this; the cap bounds memory and the stdin write.
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
/// The core reads its request right after its handshake, so a write that cannot finish within the
/// handshake allowance means the core is not reading.
const REQUEST_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Cancel files and extraction folders this old cannot belong to a core that is still stopping.
const STALE_CANCEL_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const STALE_EXTRACTION_AGE: Duration = Duration::from_secs(60 * 60);

/// Errors reach the page as a stable code, which the page maps to catalog text in the user's
/// language. The English detail stays in the log: it never carries a path or a key.
fn coded(code: &'static str, detail: &str) -> String {
    eprintln!("[pomitranslate] {code}: {detail}");
    code.to_string()
}

fn is_allowed_request(kind: &str) -> bool {
    ALLOWED_REQUESTS.contains(&kind)
}

/// The frontend passes its selected world, never an arbitrary file or URL.
fn validated_world_folder(world_dir: &str) -> Result<PathBuf, String> {
    let supplied = PathBuf::from(world_dir);
    if !supplied.is_absolute() || !supplied.is_dir() {
        return Err("Select an existing Java world folder first".into());
    }
    let world = supplied
        .canonicalize()
        .map_err(|_| "The world folder is unavailable")?;
    let level = world.join("level.dat");
    if !level.is_file()
        || level
            .symlink_metadata()
            .map_err(|_| "The world folder is unavailable")?
            .file_type()
            .is_symlink()
    {
        return Err("The selected folder must contain level.dat".into());
    }
    Ok(world)
}

/// Show the world in the file manager by selecting its `level.dat`. Opening the folder itself
/// would launch it on macOS when the chosen folder is a bundle such as `Foo.app`.
fn reveal_target(world: &std::path::Path) -> PathBuf {
    world.join("level.dat")
}

#[tauri::command]
fn reveal_world_folder(app: tauri::AppHandle, world_dir: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let world = validated_world_folder(&world_dir)?;
    app.opener()
        .reveal_item_in_dir(reveal_target(&world))
        .map_err(|_| "The world folder could not be opened".into())
}

/// Only the pinned, public OpenRouter catalog can bypass credential access.
fn is_public_catalog(kind: &str, payload: &serde_json::Map<String, Value>) -> bool {
    kind == "models.list"
        && payload.get("provider").and_then(Value::as_str) == Some("openrouter")
        && payload.get("publicCatalog").and_then(Value::as_bool) == Some(true)
}

/// An unsaved key typed in the UI, accepted for one request kind only: it lets a new user check a
/// key and list models before saving anything.
const DRAFT_KEY_FIELD: &str = "draftApiKey";
const MAX_DRAFT_KEY_CHARS: usize = 4096;

/// Take the draft key out of the payload. The field is removed from every request so it can never
/// reach the sidecar under its own name; only `models.list` may use the value.
fn take_draft_key(
    kind: &str,
    payload: &mut serde_json::Map<String, Value>,
) -> Result<Option<zeroize::Zeroizing<String>>, String> {
    let mut value = match payload.remove(DRAFT_KEY_FIELD) {
        Some(Value::String(value)) => value,
        Some(Value::Null) | None => return Ok(None),
        Some(_) => return Err("API key must be text".into()),
    };
    let key = zeroize::Zeroizing::new(value.trim().to_string());
    zeroize::Zeroize::zeroize(&mut value);
    if kind != "models.list" || key.is_empty() {
        return Ok(None);
    }
    if key.chars().count() > MAX_DRAFT_KEY_CHARS {
        return Err("API key is too long".into());
    }
    Ok(Some(key))
}

/// Whether a key-injected request carries any key at all.
fn wants_stored_key(kind: &str, payload: &serde_json::Map<String, Value>) -> bool {
    // The core independently checks that all included sources have manual values.
    // A false claim receives no key and cannot enable an authenticated API call.
    let manual_only = matches!(kind, "translate.start" | "translate.resume")
        && payload.get("manualOnly").and_then(Value::as_bool) == Some(true);
    !(manual_only || is_public_catalog(kind, payload))
}

/// Decide which key a key-injected request carries. A draft key replaces the stored credential
/// (which is then never read); the public OpenRouter catalog and manual-only runs get none.
fn provider_key(
    kind: &str,
    payload: &serde_json::Map<String, Value>,
    draft: Option<&zeroize::Zeroizing<String>>,
    stored: impl FnOnce() -> Result<Option<zeroize::Zeroizing<String>>, String>,
) -> Result<Option<zeroize::Zeroizing<String>>, String> {
    if !wants_stored_key(kind, payload) {
        return Ok(None);
    }
    match draft {
        Some(key) => Ok(Some(zeroize::Zeroizing::new(key.to_string()))),
        None => stored(),
    }
}

/// Own the cleanup obligation before any fallible sidecar preparation. The payload's plain copy
/// is scrubbed even when validation, data paths, command creation, spawn or serialization fail.
struct PayloadSecretGuard<'a>(&'a mut Value);

impl PayloadSecretGuard<'_> {
    fn scrub(&mut self) {
        if let Some(Value::String(secret)) = self.0.get_mut("payload").and_then(|p| p.get_mut("apiKey")) {
            zeroize::Zeroize::zeroize(secret);
        }
    }
}

impl Drop for PayloadSecretGuard<'_> {
    fn drop(&mut self) {
        self.scrub();
    }
}

/// Remove and return every complete line in `buffer`, without its trailing whitespace.
/// A partial last line stays in the buffer for the next chunk.
fn drain_complete_lines(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line: Vec<u8> = buffer.drain(..=newline).collect();
        while line.last().is_some_and(|byte| byte.is_ascii_whitespace()) {
            line.pop();
        }
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

fn credential_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| coded("DATA_DIR_UNAVAILABLE", "Application data directory is unavailable"))
}

/// Credential work takes a file lock and may wait on an OS keychain prompt. Run it on a blocking
/// thread, never on the main thread or an async worker.
async fn credential_task<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&credentials::Credentials, &std::path::Path) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = credential_root(&app)?;
        work(&app.state::<credentials::Credentials>(), &root)
    })
    .await
    .map_err(|_| coded("INTERNAL_STATE", "Credential task stopped unexpectedly"))?
}

#[tauri::command]
async fn credential_status(
    app: tauri::AppHandle,
    provider: String,
) -> Result<credentials::Status, String> {
    credential_task(app, move |state, root| state.status(root, &provider)).await
}

#[tauri::command]
async fn credential_import(
    app: tauri::AppHandle,
    provider: String,
) -> Result<credentials::Status, String> {
    credential_task(app, move |state, root| state.import_keychain(root, &provider)).await
}

#[tauri::command]
async fn sidecar_request(
    app: tauri::AppHandle,
    state: State<'_, ActiveSidecar>,
    mut request: Value,
) -> Result<Value, String> {
    let kind = request
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| coded("INVALID_REQUEST", "Missing request type"))?
        .to_string();
    if !is_allowed_request(&kind) {
        return Err(coded("UNSUPPORTED_REQUEST", "Unsupported request type"));
    }
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| coded("INVALID_REQUEST", "Missing request id"))?
        .to_string();
    if request.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(coded("UNSUPPORTED_REQUEST", "Unsupported protocol version"));
    }

    let _request_guard = state
        .request_gate
        .try_lock()
        .map_err(|_| coded(CODE_BUSY, "Another PomiTranslate operation is still running"))?;

    let provider = request
        .get("payload")
        .and_then(|payload| payload.get("provider"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if kind == "credentials.delete" {
        if provider.is_empty() {
            return Err(coded("INVALID_REQUEST", "Missing credential provider"));
        }
        let target = provider.clone();
        credential_task(app.clone(), move |credentials, root| credentials.delete(root, &target)).await?;
        return Ok(serde_json::json!({
            "v": 1,
            "id": id,
            "type": "response.ok",
            "payload": {"provider": provider, "deleted": true, "apiKeyStored": false}
        }));
    }
    let draft_key = match request.get_mut("payload").and_then(Value::as_object_mut) {
        Some(payload) => take_draft_key(&kind, payload)?,
        None => None,
    };
    if CREDENTIAL_OWNER_REQUESTS.contains(&kind.as_str()) {
        if let Some(payload) = request.get_mut("payload").and_then(Value::as_object_mut) {
            payload.insert("credentialOwner".into(), Value::String("rust".into()));
        }
    }
    let mut pending_credential = None;
    if kind == "settings.set" {
        let payload = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| coded("INVALID_REQUEST", "Invalid settings payload"))?;
        provider_boundary::validate(payload)?;
        let origin = provider_boundary::custom_origin(payload);
        let supplied = zeroize::Zeroizing::new(match payload.remove("apiKey") {
            Some(Value::String(value)) => value,
            None | Some(Value::Null) => String::new(),
            _ => return Err("API key must be text".into()),
        });
        let mode: credentials::Mode = if let Some(value) = payload.remove("credentialMode") {
            serde_json::from_value(value).map_err(|_| "Unknown credential storage mode")?
        } else {
            let target = provider.clone();
            credential_task(app.clone(), move |credentials, root| credentials.status(root, &target))
                .await?
                .mode
        };
        pending_credential = Some((mode, supplied, origin));
    } else if KEY_INJECTED_REQUESTS.contains(&kind.as_str()) {
        let payload = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| coded("INVALID_REQUEST", "Invalid provider payload"))?;
        provider_boundary::validate(payload)?;
        // Frontend cannot bypass the selected store with an arbitrary supplied key.
        payload.remove("apiKey");
        // A stored custom key only goes to the origin it was saved for.
        let origin = provider_boundary::custom_origin(payload);
        let stored = if draft_key.is_none() && wants_stored_key(&kind, payload) {
            let target = provider.clone();
            credential_task(app.clone(), move |credentials, root| {
                credentials.read(root, &target, origin.as_deref())
            })
            .await?
        } else {
            None
        };
        let secret = provider_key(&kind, payload, draft_key.as_ref(), move || Ok(stored))?;
        if let Some(secret) = secret {
            payload.insert("apiKey".into(), Value::String(secret.to_string()));
        }
    }

    let (mut response, committed_status) = if let Some((mode, supplied, origin)) = pending_credential {
        let root = credential_root(&app)?;
        let credentials = app.state::<credentials::Credentials>();
        settings_transaction::save(
            request,
            |request| exchange_sidecar(&app, &state, request),
            || {
                credentials
                    .save(&root, &provider, mode, &supplied, origin.as_deref())
                    .map_err(|error| settings_transaction::CommitError {
                        uncertain: error.uncertain,
                    })
            },
        )
        .await?
    } else {
        (exchange_sidecar(&app, &state, request).await?, None)
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
        let status = if let Some(status) = committed_status {
            status
        } else {
            credential_task(app.clone(), move |credentials, root| {
                credentials.status(root, &response_provider)
            })
            .await?
        };
        if let Some(payload) = response.get_mut("payload").and_then(Value::as_object_mut) {
            payload.insert("apiKeyStored".into(), Value::Bool(status.stored));
            payload.insert(
                "credentialMode".into(),
                serde_json::to_value(status.mode).map_err(|_| "Invalid credential mode")?,
            );
        }
    }

    Ok(response)
}

/// Serialize the request once, refusing anything larger than the core could need.
fn request_line(request: &Value) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    let mut line = zeroize::Zeroizing::new(
        serde_json::to_vec(request).map_err(|_| coded("INVALID_REQUEST", "Invalid request"))?,
    );
    if line.len() > MAX_REQUEST_BYTES {
        return Err(coded(CODE_REQUEST_TOO_LARGE, "The request is larger than the core accepts"));
    }
    line.push(b'\n');
    Ok(line)
}

/// Raw exchange: the outer request gate stays locked across multi-step settings recovery.
async fn exchange_sidecar(
    app: &tauri::AppHandle,
    state: &ActiveSidecar,
    mut request: Value,
) -> Result<Value, String> {
    let mut request = PayloadSecretGuard(&mut request);
    let deadlines = startup::StartupDeadlines::new(
        request.0.get("type").and_then(Value::as_str).unwrap_or(""),
    );
    let id = request
        .0
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| coded("INVALID_REQUEST", "Missing request id"))?
        .to_owned();
    let line = request_line(request.0)?;
    request.scrub();
    let app_data = credential_root(app)?;
    let data_dir = sidecar_paths::core_data_dir(&app_data, &app.config().identifier)?;
    let report_dir = app_data.join("reports");
    fs::create_dir_all(&report_dir).map_err(|_| coded("DATA_DIR_UNAVAILABLE", "Cannot create the report directory"))?;
    sidecar_process::sweep_cancel_files(&report_dir, STALE_CANCEL_AGE);
    let cancel_path = sidecar_process::cancel_file(&report_dir)
        .map_err(|_| coded("INTERNAL_STATE", "Cannot name the cancel file"))?;
    let mut spawned = {
        let mut active = state
            .process
            .lock()
            .map_err(|_| coded("INTERNAL_STATE", "Sidecar state is unavailable"))?;
        if active.is_some() {
            return Err(coded(CODE_BUSY, "Another PomiTranslate operation is still running"));
        }
        let mut command: std::process::Command = app
            .shell()
            .sidecar("pomi-sidecar")
            .map_err(|_| coded("CORE_UNAVAILABLE", "Packaged translation core is unavailable"))?
            .args(sidecar_paths::arguments(
                &data_dir,
                &report_dir,
                &cancel_path,
            ))
            .into();
        if let Ok(cache) = app.path().app_cache_dir() {
            sidecar_process::use_extraction_dir(&mut command, &sidecar_process::extraction_dir(&cache));
        }
        let spawned = sidecar_process::spawn(command)
            .map_err(|_| coded("CORE_START_FAILED", "Could not start the translation core"))?;
        *active = Some(ActiveProcess {
            cancel_path: cancel_path.clone(),
        });
        spawned
    };
    let child = spawned.child.clone();

    // The write happens outside the state lock and has a deadline. Closing stdin right after the
    // one request lets the core exit by itself as soon as it has answered.
    let written = match spawned.stdin.take() {
        Some(stdin) => sidecar_process::write_and_close(stdin, line, REQUEST_WRITE_TIMEOUT).await,
        None => Err(sidecar_process::WriteFailure::Failed),
    };

    let mut saw_hello = false;
    let mut stdout_buffer = Vec::<u8>::new();
    let mut child_stopped = false;
    let result: Result<Value, String> = if written.is_err() {
        Err(coded(CODE_CORE_WRITE_FAILED, "Could not send the request to the translation core"))
    } else {
        'events: loop {
            let event = match deadlines.receive(saw_hello, spawned.output.recv()).await {
                Ok(event) => event,
                Err(code) => break Err(coded(code, "Translation core did not answer in time")),
            };
            match event {
                Some(sidecar_process::Output::Chunk(bytes)) => {
                    stdout_buffer.extend_from_slice(&bytes);
                    if stdout_buffer.len() > 8 * 1024 * 1024 {
                        break Err(coded("CORE_BAD_MESSAGE", "Translation core returned an oversized message"));
                    }
                    for line in drain_complete_lines(&mut stdout_buffer) {
                        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                            break 'events Err(coded(
                                "CORE_BAD_MESSAGE",
                                "Translation core returned an invalid JSONL message",
                            ));
                        };
                        if message.get("type").and_then(Value::as_str) == Some("system.hello") {
                            let version = message
                                .get("payload")
                                .and_then(|value| value.get("protocolVersion"))
                                .and_then(Value::as_u64);
                            if version != Some(1) {
                                break 'events Err(coded(
                                    "CORE_PROTOCOL_MISMATCH",
                                    "Translation core protocol version does not match",
                                ));
                            }
                            saw_hello = true;
                            continue;
                        }
                        if !saw_hello {
                            break 'events Err(coded(
                                "CORE_PROTOCOL_MISMATCH",
                                "Translation core did not complete its handshake",
                            ));
                        }
                        if message.get("id").and_then(Value::as_str) == Some(id.as_str())
                            && message
                                .get("type")
                                .and_then(Value::as_str)
                                .is_some_and(|kind| kind.ends_with(".progress"))
                        {
                            let _ = app.emit("pomi-progress", &message);
                            continue;
                        }
                        if message.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                            break 'events Ok(message);
                        }
                    }
                }
                Some(sidecar_process::Output::Closed) | None => {
                    child_stopped = true;
                    break Err(coded(
                        CODE_CORE_STOPPED,
                        "Translation core stopped before it returned a result",
                    ));
                }
            }
        }
    };
    drop(spawned.output);

    if result.is_ok() {
        // The answer is final and stdin is closed, so the idle core exits on its own. Let it, in
        // the background, so its extraction folder is removed; the next request does not wait.
        if let Ok(mut active) = state.process.lock() {
            active.take();
        }
        std::thread::spawn(move || {
            let stopped = sidecar_process::stop_blocking(&child, sidecar_process::AFTER_RESPONSE);
            sidecar_process::settle_cancel_file(&cancel_path, &stopped);
        });
        return result;
    }

    // Something went wrong while the core may still be working. Ask it to stop at a safe point
    // and keep this request (and the quit guard) open until it is gone or has been killed.
    let plan = if child_stopped {
        sidecar_process::ALREADY_STOPPING
    } else {
        let _ = fs::write(&cancel_path, b"cancel");
        sidecar_process::ABNORMAL
    };
    let stopped = sidecar_process::stop(child, plan).await;
    if !stopped.confirmed() {
        eprintln!("[pomitranslate] CORE_STOP_UNCONFIRMED: the core was killed; its cancel file stays in place");
    }
    sidecar_process::settle_cancel_file(&cancel_path, &stopped);
    if let Ok(mut active) = state.process.lock() {
        active.take();
    }
    result
}

#[tauri::command]
fn operation_active(state: State<'_, ActiveSidecar>) -> bool {
    state.request_gate.try_lock().is_err()
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<updates::UpdateInfo, String> {
    updates::check(&app).await
}

/// Installing replaces the program, so it owns the same gate as a scan or a write: it cannot start
/// during a job, a job cannot start during it, and quitting is held until it ends.
#[tauri::command]
async fn update_install(app: tauri::AppHandle, state: State<'_, ActiveSidecar>) -> Result<(), String> {
    let _gate = state
        .request_gate
        .try_lock()
        .map_err(|_| "UPDATE_BUSY")?;
    let close_guard = app.state::<close_guard::CloseGuard>();
    let _restart_scope = close_guard.updater_restart_scope();
    updates::install(&app).await
}

#[tauri::command]
async fn cancel_active(state: State<'_, ActiveSidecar>) -> Result<bool, String> {
    // Copy the path out so the file write never happens under the state lock.
    let cancel_path = {
        let active = state
            .process
            .lock()
            .map_err(|_| coded("INTERNAL_STATE", "Sidecar state is unavailable"))?;
        let Some(process) = active.as_ref() else {
            return Ok(false);
        };
        process.cancel_path.clone()
    };
    fs::write(&cancel_path, b"cancel").map_err(|_| coded("CANCEL_FAILED", "Could not request cancellation"))?;
    Ok(true)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state::flags())
                .skip_initial_state("main")
                .build(),
        )
        .manage(ActiveSidecar::default())
        .manage(credentials::Credentials::default())
        .manage(close_guard::CloseGuard::default())
        .setup(|app| {
            zoom_menu::install(app)?;
            startup_theme::apply(app);
            // No core runs yet: remove extraction folders that killed cores of earlier runs left.
            if let Ok(cache) = app.path().app_cache_dir() {
                std::thread::spawn(move || {
                    sidecar_process::sweep_extractions(
                        &sidecar_process::extraction_dir(&cache),
                        STALE_EXTRACTION_AGE,
                    )
                });
            }
            Ok(())
        })
        .on_page_load(|webview, _payload| {
            if webview.label() == "main" {
                window_state::guard(webview.app_handle());
                window_state::mark_ready();
            }
        })
        .on_menu_event(|app, event| {
            if !app_menu::select(app, event.id().as_ref()) {
                zoom_menu::select(app, event.id().as_ref());
            }
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_request,
            cancel_active,
            credential_status,
            credential_import,
            operation_active,
            document_export::export_document,
            app_menu::set_menu_labels,
            app_menu::set_menu_theme,
            desktop_links::open_external,
            desktop_links::data_locations,
            desktop_links::reveal_data_folder,
            reveal_world_folder,
            update_check,
            update_install,
            close_guard::set_unsaved_settings,
            close_guard::close_guard_ack,
            close_guard::finish_close
        ])
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                window_state::save_normal_geometry(window);
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<ActiveSidecar>();
                let gate = state.request_gate.try_lock();
                let guard = window.state::<close_guard::CloseGuard>();
                match guard.boundary(gate.is_err(), close_guard::Source::Window) {
                    close_guard::Decision::Allow => window_state::flush_normal_geometry(window),
                    close_guard::Decision::BlockJob => {
                        api.prevent_close();
                        // Tell the window why it did not close, instead of ignoring the click.
                        let _ = window.emit("pomi-close-blocked", true);
                    }
                    close_guard::Decision::AskUnsaved(source) => {
                        api.prevent_close();
                        close_guard::ask_page(window.app_handle(), source);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build PomiTranslate")
        .run(|app, event| {
            // Quitting (Cmd+Q, the app menu, a session logout) skips CloseRequested. Hold it the same
            // way while a scan, write or restore owns the core, instead of killing it mid-write.
            // Explicit exits obey the same guard. Only an updater holding the gate may request
            // the dedicated restart code; ordinary app.exit(0) never bypasses a running job.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                let guard = app.state::<close_guard::CloseGuard>();
                if guard.permits_restart(*code) { return; }
                let state = app.state::<ActiveSidecar>();
                let gate = state.request_gate.try_lock();
                match guard.boundary(gate.is_err(), close_guard::Source::Quit) {
                    close_guard::Decision::Allow => {
                        if let Some(window) = app.get_webview_window("main") {
                            window_state::flush_normal_geometry(&window.as_ref().window());
                        } else {
                            window_state::flush_pending_geometry(app);
                        }
                    }
                    close_guard::Decision::BlockJob => {
                        api.prevent_exit();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.emit("pomi-close-blocked", true);
                        }
                        return;
                    }
                    close_guard::Decision::AskUnsaved(source) => {
                        api.prevent_exit();
                        close_guard::ask_page(app, source);
                        return;
                    }
                }
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injected_payload_secrets_are_scrubbed_on_every_early_error() {
        fn fail(request: &mut Value, error: &str) -> Result<(), String> {
            let guard = PayloadSecretGuard(request);
            // These seams model returns before startup and a failed serializer. Value itself
            // cannot fail JSON serialization, so inject the serializer's error explicitly.
            let result: Result<Vec<u8>, String> = if error == "INVALID_REQUEST" {
                Err(error.into())
            } else {
                assert!(guard.0["payload"]["apiKey"].is_string());
                return Err(error.into());
            };
            let _line = zeroize::Zeroizing::new(result?);
            Ok(())
        }
        for error in ["BUSY", "DATA_DIR_UNAVAILABLE", "CORE_UNAVAILABLE", "CORE_START_FAILED", "INVALID_REQUEST"] {
            let mut request = serde_json::json!({"payload": {"apiKey": "synthetic-only", "provider": "openai"}});
            assert_eq!(fail(&mut request, error), Err(error.into()));
            assert_eq!(request["payload"]["apiKey"].as_str(), Some(""));
            assert_eq!(request["payload"]["provider"], "openai");
        }
    }

    fn payload(value: Value) -> serde_json::Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn stored_secret() -> Result<Option<zeroize::Zeroizing<String>>, String> {
        Ok(Some(zeroize::Zeroizing::new("stored-secret".to_string())))
    }

    #[test]
    fn a_draft_key_replaces_the_stored_key_for_model_lists() {
        let mut body = payload(serde_json::json!({"provider":"openai", "draftApiKey":"  typed-secret \n"}));
        let draft = take_draft_key("models.list", &mut body).unwrap();
        assert_eq!(draft.as_ref().map(|key| key.as_str()), Some("typed-secret"));
        let key = provider_key("models.list", &body, draft.as_ref(), || {
            panic!("the stored credential must not be read when a draft key is supplied")
        })
        .unwrap();
        assert_eq!(key.as_ref().map(|key| key.as_str()), Some("typed-secret"));
    }

    #[test]
    fn no_draft_key_keeps_the_stored_key_behavior() {
        for draft_field in [
            serde_json::json!({"provider":"openai"}),
            serde_json::json!({"provider":"openai", "draftApiKey":""}),
            serde_json::json!({"provider":"openai", "draftApiKey":"   "}),
            serde_json::json!({"provider":"openai", "draftApiKey":null}),
        ] {
            let mut body = payload(draft_field);
            let draft = take_draft_key("models.list", &mut body).unwrap();
            assert!(draft.is_none());
            let key = provider_key("models.list", &body, draft.as_ref(), stored_secret).unwrap();
            assert_eq!(key.as_ref().map(|key| key.as_str()), Some("stored-secret"));
        }
    }

    #[test]
    fn the_draft_field_never_reaches_the_sidecar_under_its_own_name() {
        for kind in [
            "models.list",
            "settings.set",
            "translate.start",
            "prompt.enhance",
            "provider.usage",
            "scan.start",
        ] {
            let mut body = payload(serde_json::json!({"provider":"openai", "draftApiKey":"typed-secret"}));
            take_draft_key(kind, &mut body).unwrap();
            assert!(!body.contains_key(DRAFT_KEY_FIELD), "{kind} still carries the draft field");
            assert!(!body.contains_key("apiKey"), "{kind}: the draft is only held, not forwarded");
        }
        let mut malformed = payload(serde_json::json!({"draftApiKey": 7}));
        assert!(take_draft_key("models.list", &mut malformed).is_err());
        let mut long = payload(serde_json::json!({"draftApiKey": "k".repeat(MAX_DRAFT_KEY_CHARS + 1)}));
        assert!(take_draft_key("models.list", &mut long).is_err());
    }

    #[test]
    fn other_requests_ignore_a_draft_key() {
        for kind in ["translate.start", "translate.resume", "prompt.enhance", "provider.usage"] {
            let mut body = payload(serde_json::json!({"provider":"openai", "draftApiKey":"typed-secret"}));
            let draft = take_draft_key(kind, &mut body).unwrap();
            assert!(draft.is_none(), "{kind} must not accept a draft key");
            let key = provider_key(kind, &body, draft.as_ref(), stored_secret).unwrap();
            assert_eq!(key.as_ref().map(|key| key.as_str()), Some("stored-secret"));
        }
    }

    #[test]
    fn the_public_catalog_and_manual_runs_carry_no_key_even_with_a_draft() {
        let mut public = payload(serde_json::json!({"provider":"openrouter", "publicCatalog":true, "draftApiKey":"typed-secret"}));
        let draft = take_draft_key("models.list", &mut public).unwrap();
        let key = provider_key("models.list", &public, draft.as_ref(), stored_secret).unwrap();
        assert!(key.is_none());
        let manual = payload(serde_json::json!({"provider":"openai", "manualOnly":true}));
        let key = provider_key("translate.start", &manual, None, stored_secret).unwrap();
        assert!(key.is_none());
    }

    #[test]
    fn public_catalog_bypass_is_limited_to_openrouter_model_reads() {
        let public = serde_json::json!({"provider":"openrouter", "publicCatalog":true});
        assert!(is_public_catalog("models.list", public.as_object().unwrap()));
        for kind in ["translate.start", "translate.resume", "prompt.enhance", "provider.usage"] {
            assert!(!is_public_catalog(kind, public.as_object().unwrap()));
        }
        for payload in [
            serde_json::json!({"provider":"custom", "publicCatalog":true}),
            serde_json::json!({"provider":"openai", "publicCatalog":true}),
            serde_json::json!({"provider":"openrouter", "publicCatalog":"true"}),
            serde_json::json!({"provider":"openrouter"}),
        ] {
            assert!(!is_public_catalog("models.list", payload.as_object().unwrap()));
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
            "translate.retry_failed",
            "translate.apply",
            "translate.reapply",
            "translations.page",
            "backups.list",
            "restore.start",
            "models.list",
            "prefs.set",
            "app.reset",
            "glossary.get",
            "glossary.set",
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
    fn review_requests_do_not_access_credentials() {
        assert!(KEY_INJECTED_REQUESTS.contains(&"translate.retry_failed"));
        for kind in ["translate.apply", "translate.reapply", "translations.page"] {
            assert!(is_allowed_request(kind));
            // These handlers only read public settings, with no keychain fallback.
            assert!(!CREDENTIAL_OWNER_REQUESTS.contains(&kind));
            assert!(!KEY_INJECTED_REQUESTS.contains(&kind));
        }
    }

    #[test]
    fn world_reveal_only_accepts_an_existing_java_world_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        assert!(validated_world_folder("").is_err());
        assert!(validated_world_folder(".").is_err());
        assert!(validated_world_folder(&root.to_string_lossy()).is_err());
        fs::write(root.join("level.dat"), b"synthetic world").unwrap();
        assert_eq!(
            validated_world_folder(&root.to_string_lossy()).unwrap(),
            root.canonicalize().unwrap()
        );
        assert!(validated_world_folder(&root.join("level.dat").to_string_lossy()).is_err());
        assert!(validated_world_folder(&root.join("missing").to_string_lossy()).is_err());
    }

    #[test]
    fn revealing_a_bundle_like_world_selects_its_level_file_instead_of_opening_it() {
        let temporary = tempfile::tempdir().unwrap();
        let bundle = temporary.path().join("Foo.app");
        fs::create_dir(&bundle).unwrap();
        fs::write(bundle.join("level.dat"), b"synthetic world").unwrap();
        let world = validated_world_folder(&bundle.to_string_lossy()).unwrap();
        let target = reveal_target(&world);
        assert_eq!(target, world.join("level.dat"));
        assert!(target.is_file(), "the file manager is asked to select a file, not open a folder");
    }

    #[test]
    fn oversized_requests_are_refused_with_a_stable_code_before_any_core_starts() {
        let small = serde_json::json!({"v":1, "id":"a", "type":"glossary.set", "payload":{"entries":"x".repeat(1024)}});
        let line = request_line(&small).unwrap();
        assert_eq!(line.last(), Some(&b'\n'));
        let large = serde_json::json!({"v":1, "id":"b", "type":"glossary.set", "payload":{"entries":"x".repeat(MAX_REQUEST_BYTES)}});
        assert_eq!(request_line(&large).unwrap_err(), CODE_REQUEST_TOO_LARGE);
        assert!(CODE_REQUEST_TOO_LARGE.chars().all(|c| c.is_ascii_uppercase() || c == '_'));
    }

    #[test]
    fn manual_and_public_catalog_requests_never_read_a_stored_key() {
        let manual = payload(serde_json::json!({"provider":"custom", "manualOnly":true}));
        assert!(!wants_stored_key("translate.start", &manual));
        assert!(wants_stored_key("translate.retry_failed", &manual));
        let public = payload(serde_json::json!({"provider":"openrouter", "publicCatalog":true}));
        assert!(!wants_stored_key("models.list", &public));
        assert!(wants_stored_key("models.list", &payload(serde_json::json!({"provider":"custom"}))));
    }

    #[cfg(unix)]
    #[test]
    fn world_reveal_refuses_a_linked_level_file() {
        let temporary = tempfile::tempdir().unwrap();
        let world = temporary.path().join("world");
        fs::create_dir(&world).unwrap();
        let outside = temporary.path().join("outside.dat");
        fs::write(&outside, b"synthetic").unwrap();
        std::os::unix::fs::symlink(outside, world.join("level.dat")).unwrap();
        assert!(validated_world_folder(&world.to_string_lossy()).is_err());
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
            "glossary.get",
            "glossary.set",
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
    fn errors_that_reach_the_page_are_stable_codes_not_english_sentences() {
        for code in [CODE_BUSY, CODE_CORE_STOPPED] {
            assert!(
                code.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "{code} must look like a code"
            );
        }
        assert_eq!(CODE_CORE_STOPPED, "CORE_STOPPED");
        assert_eq!(coded(CODE_CORE_STOPPED, "detail stays in the log"), "CORE_STOPPED");
    }

    #[test]
    fn a_message_split_across_chunks_is_reassembled() {
        let mut buffer = Vec::new();
        buffer.extend_from_slice(b"{\"a\":1}\n{\"b\":");
        assert_eq!(
            drain_complete_lines(&mut buffer),
            vec![b"{\"a\":1}".to_vec()]
        );
        assert_eq!(
            buffer,
            b"{\"b\":".to_vec(),
            "the partial line waits for its end"
        );
        buffer.extend_from_slice(b"2}\r\n\n  \n");
        assert_eq!(
            drain_complete_lines(&mut buffer),
            vec![b"{\"b\":2}".to_vec()]
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn several_messages_in_one_chunk_come_out_in_order() {
        let mut buffer = b"one\ntwo\nthree\n".to_vec();
        let lines: Vec<String> = drain_complete_lines(&mut buffer)
            .into_iter()
            .map(|line| String::from_utf8(line).unwrap())
            .collect();
        assert_eq!(lines, ["one", "two", "three"]);
    }
}

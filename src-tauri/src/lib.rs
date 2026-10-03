mod app_menu;
mod close_guard;
mod credentials;
mod desktop_links;
mod document_export;
mod provider_boundary;
mod settings_transaction;
mod sidecar_paths;
mod startup;
mod startup_theme;
mod updates;
mod window_state;
mod zoom_menu;

use std::{fs, path::PathBuf, sync::Mutex};

use serde_json::Value;
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct ActiveProcess {
    child: CommandChild,
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

pub(crate) const CODE_BUSY: &str = "BUSY";
pub(crate) const CODE_CORE_STOPPED: &str = "CORE_STOPPED";

/// Errors reach the page as a stable code, which the page maps to catalog text in the user's
/// language. The English detail stays in the log: it never carries a path or a key.
fn coded(code: &'static str, detail: &str) -> String {
    eprintln!("[pomitranslate] {code}: {detail}");
    code.to_string()
}

fn is_allowed_request(kind: &str) -> bool {
    ALLOWED_REQUESTS.contains(&kind)
}

/// Only the pinned, public OpenRouter catalog can bypass credential access.
fn is_public_catalog(kind: &str, payload: &serde_json::Map<String, Value>) -> bool {
    kind == "models.list"
        && payload.get("provider").and_then(Value::as_str) == Some("openrouter")
        && payload.get("publicCatalog").and_then(Value::as_bool) == Some(true)
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

#[tauri::command]
fn credential_status(
    app: tauri::AppHandle,
    state: State<'_, credentials::Credentials>,
    provider: String,
) -> Result<credentials::Status, String> {
    state.status(&credential_root(&app)?, &provider)
}

#[tauri::command]
fn credential_import(
    app: tauri::AppHandle,
    state: State<'_, credentials::Credentials>,
    provider: String,
) -> Result<credentials::Status, String> {
    state.import_keychain(&credential_root(&app)?, &provider)
}

#[tauri::command]
async fn sidecar_request(
    app: tauri::AppHandle,
    state: State<'_, ActiveSidecar>,
    credentials: State<'_, credentials::Credentials>,
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
        credentials.delete(&credential_root(&app)?, &provider)?;
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
    let mut pending_credential = None;
    if kind == "settings.set" {
        let payload = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| coded("INVALID_REQUEST", "Invalid settings payload"))?;
        provider_boundary::validate(payload)?;
        let supplied = zeroize::Zeroizing::new(match payload.remove("apiKey") {
            Some(Value::String(value)) => value,
            None | Some(Value::Null) => String::new(),
            _ => return Err("API key must be text".into()),
        });
        let mode: credentials::Mode = if let Some(value) = payload.remove("credentialMode") {
            serde_json::from_value(value).map_err(|_| "Unknown credential storage mode")?
        } else {
            credentials.status(&credential_root(&app)?, &provider)?.mode
        };
        pending_credential = Some((mode, supplied));
    } else if KEY_INJECTED_REQUESTS.contains(&kind.as_str()) {
        let payload = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| coded("INVALID_REQUEST", "Invalid provider payload"))?;
        provider_boundary::validate(payload)?;
        // Frontend cannot bypass the selected store with an arbitrary supplied key.
        payload.remove("apiKey");
        // The core independently checks that all included sources have manual values.
        // A false claim receives no key and cannot enable an authenticated API call.
        let manual_only = matches!(kind.as_str(), "translate.start" | "translate.resume")
            && payload.get("manualOnly").and_then(Value::as_bool) == Some(true);
        if !manual_only && !is_public_catalog(&kind, payload) {
            if let Some(secret) = credentials.read(&credential_root(&app)?, &provider)? {
                payload.insert("apiKey".into(), Value::String(secret.to_string()));
            }
        }
    }

    let (mut response, committed_status) = if let Some((mode, supplied)) = pending_credential {
        let root = credential_root(&app)?;
        settings_transaction::save(
            request,
            |request| exchange_sidecar(&app, &state, request),
            || {
                credentials
                    .save(&root, &provider, mode, &supplied)
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
            credentials.status(&credential_root(&app)?, &response_provider)?
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

/// Raw exchange: the outer request gate stays locked across multi-step settings recovery.
async fn exchange_sidecar(
    app: &tauri::AppHandle,
    state: &ActiveSidecar,
    mut request: Value,
) -> Result<Value, String> {
    let deadlines = startup::StartupDeadlines::new(
        request.get("type").and_then(Value::as_str).unwrap_or(""),
    );
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| coded("INVALID_REQUEST", "Missing request id"))?
        .to_owned();
    let app_data = credential_root(app)?;
    let data_dir = sidecar_paths::core_data_dir(&app_data, &app.config().identifier)?;
    let report_dir = app_data.join("reports");
    fs::create_dir_all(&report_dir).map_err(|_| coded("DATA_DIR_UNAVAILABLE", "Cannot create the report directory"))?;
    let cancel_path = report_dir.join("active-operation.cancel");
    let mut receiver = {
        let mut active = state
            .process
            .lock()
            .map_err(|_| coded("INTERNAL_STATE", "Sidecar state is unavailable"))?;
        if active.is_some() {
            return Err(coded(CODE_BUSY, "Another PomiTranslate operation is still running"));
        }
        let _ = fs::remove_file(&cancel_path);
        let command = app
            .shell()
            .sidecar("pomi-sidecar")
            .map_err(|_| coded("CORE_UNAVAILABLE", "Packaged translation core is unavailable"))?
            .args(sidecar_paths::arguments(
                &data_dir,
                &report_dir,
                &cancel_path,
            ));
        let (receiver, mut child) = command
            .spawn()
            .map_err(|_| coded("CORE_START_FAILED", "Could not start the translation core"))?;
        let mut line =
            zeroize::Zeroizing::new(serde_json::to_vec(&request).map_err(|_| coded("INVALID_REQUEST", "Invalid request"))?);
        if let Some(secret) = request
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .and_then(|p| p.get_mut("apiKey"))
        {
            if let Value::String(value) = secret {
                zeroize::Zeroize::zeroize(value);
            }
        }
        line.push(b'\n');
        if child.write(&line).is_err() {
            let _ = child.kill();
            return Err(coded("CORE_WRITE_FAILED", "Could not send the request to the translation core"));
        }
        *active = Some(ActiveProcess {
            child,
            cancel_path: cancel_path.clone(),
        });
        receiver
    };

    let mut saw_hello = false;
    let mut stdout_buffer = Vec::<u8>::new();
    let result: Result<Value, String> = 'events: loop {
        let event = match deadlines.receive(saw_hello, receiver.recv()).await {
            Ok(event) => event,
            Err(code) => break Err(coded(code, "Translation core did not answer in time")),
        };
        match event {
            Some(CommandEvent::Stdout(bytes)) => {
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
            Some(CommandEvent::Stderr(_)) => {
                // The sidecar may include private world paths and provider errors.
            }
            Some(CommandEvent::Error(_)) | Some(CommandEvent::Terminated(_)) | None => {
                break Err(coded(
                    CODE_CORE_STOPPED,
                    "Translation core stopped before it returned a result",
                ));
            }
            Some(_) => continue,
        }
    };

    if let Ok(mut active) = state.process.lock() {
        if let Some(process) = active.take() {
            let _ = process.child.kill();
            let _ = fs::remove_file(process.cancel_path);
        }
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
    updates::install(&app).await
}

#[tauri::command]
fn cancel_active(state: State<'_, ActiveSidecar>) -> Result<bool, String> {
    let active = state
        .process
        .lock()
        .map_err(|_| coded("INTERNAL_STATE", "Sidecar state is unavailable"))?;
    let Some(process) = active.as_ref() else {
        return Ok(false);
    };
    fs::write(&process.cancel_path, b"cancel").map_err(|_| coded("CANCEL_FAILED", "Could not request cancellation"))?;
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
                .build(),
        )
        .manage(ActiveSidecar::default())
        .manage(credentials::Credentials::default())
        .manage(close_guard::CloseGuard::default())
        .setup(|app| {
            zoom_menu::install(app)?;
            startup_theme::apply(app);
            window_state::guard(app);
            Ok(())
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
            update_check,
            update_install,
            close_guard::set_unsaved_settings,
            close_guard::close_guard_ack,
            close_guard::finish_close
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let job_running = window.state::<ActiveSidecar>().request_gate.try_lock().is_err();
                let unsaved = window.state::<close_guard::CloseGuard>().unsaved();
                match close_guard::decide(job_running, unsaved, close_guard::Source::Window) {
                    close_guard::Decision::Allow => {}
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
            // A request with an exit code came from the app itself (an update restart, or the
            // answer to the unsaved-settings question): it always goes through.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = &event {
                let job_running = app.state::<ActiveSidecar>().request_gate.try_lock().is_err();
                let unsaved = app.state::<close_guard::CloseGuard>().unsaved();
                match close_guard::decide(job_running, unsaved, close_guard::Source::Quit) {
                    close_guard::Decision::Allow => {}
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
            "backups.list",
            "restore.start",
            "models.list",
            "prefs.set",
            "app.reset",
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

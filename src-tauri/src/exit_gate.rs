//! One way out of the app (U1, SC-6). The window's close button, Alt+F4, the Quit menu item, Cmd+Q
//! and a session end all end up in `request_exit`:
//!
//! * nothing running and nothing unsaved: the app exits at once;
//! * otherwise the page is asked, in its own dialog, what to do. A running job offers "Cancel the job
//!   and quit" / "Keep working"; unsaved settings offer "Save and quit" / "Quit without saving" /
//!   "Cancel". After "Cancel the job and quit" the core is asked to stop and given about 30 seconds;
//!   if it does not, the page offers "Quit now", which kills it.
//!
//! A confirmed exit is let through `ExitRequested` (its `code` is then `Some`), so the guard never
//! blocks the exit it asked for.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{error::IpcError, sidecar::ActiveSidecar, updates::UpdateControl};

/// How long a cancelled job may take to stop before "Quit now" is offered.
const CANCEL_WAIT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct ExitControl {
    settings_dirty: AtomicBool,
    confirmed: AtomicBool,
    /// A "cancel and quit" is waiting for the job to stop.
    waiting: AtomicBool,
}

/// What the dialog is about. `job` takes priority: settings cannot be saved while the core is busy.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Prompt {
    pub job: bool,
    pub dirty: bool,
}

pub fn prompt_for(job: bool, dirty: bool) -> Option<Prompt> {
    (job || dirty).then_some(Prompt { job, dirty })
}

fn job_running(app: &AppHandle) -> bool {
    app.state::<ActiveSidecar>().busy() || app.state::<UpdateControl>().active()
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn ask(app: &AppHandle, prompt: Prompt) {
    show_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("pomi-exit-confirm", prompt);
    }
}

/// True when the window or the app may close right now; otherwise the page was asked and false is
/// returned so the caller prevents the close.
pub fn allow_close(app: &AppHandle) -> bool {
    let control = app.state::<ExitControl>();
    if control.confirmed.load(Ordering::SeqCst) {
        return true;
    }
    match prompt_for(
        job_running(app),
        control.settings_dirty.load(Ordering::SeqCst),
    ) {
        None => true,
        Some(prompt) => {
            if control.waiting.load(Ordering::SeqCst) {
                // A cancel is already in progress; show that, do not stack a second question.
                show_window(app);
                let _ = app.emit("pomi-exit-waiting", ());
            } else {
                ask(app, prompt);
            }
            false
        }
    }
}

/// The Quit menu item and any other deliberate quit.
pub fn request_exit(app: &AppHandle) {
    if allow_close(app) {
        app.state::<ExitControl>()
            .confirmed
            .store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

/// The settings screen reports whether it holds unsaved changes.
#[tauri::command]
pub fn exit_set_settings_dirty(control: State<'_, ExitControl>, dirty: bool) {
    control.settings_dirty.store(dirty, Ordering::SeqCst);
}

/// The person chose to quit. A running job or update is asked to stop first.
#[tauri::command]
pub fn exit_confirm(app: AppHandle) -> Result<(), IpcError> {
    let control = app.state::<ExitControl>();
    if control.waiting.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // Settings the person chose not to save (or already saved) no longer hold the app back.
    control.settings_dirty.store(false, Ordering::SeqCst);
    if !job_running(&app) {
        control.waiting.store(false, Ordering::SeqCst);
        control.confirmed.store(true, Ordering::SeqCst);
        app.exit(0);
        return Ok(());
    }
    let _ = app.emit("pomi-exit-waiting", ());
    app.state::<UpdateControl>().cancel();
    let _ = app.state::<ActiveSidecar>().request_cancel();
    tauri::async_runtime::spawn(async move {
        let started = tokio::time::Instant::now();
        while started.elapsed() < CANCEL_WAIT {
            tokio::time::sleep(POLL).await;
            if !job_running(&app) {
                let control = app.state::<ExitControl>();
                control.confirmed.store(true, Ordering::SeqCst);
                control.waiting.store(false, Ordering::SeqCst);
                app.exit(0);
                return;
            }
        }
        app.state::<ExitControl>()
            .waiting
            .store(false, Ordering::SeqCst);
        let _ = app.emit("pomi-exit-stuck", ());
    });
    Ok(())
}

/// "Quit now": the job did not stop, so the core is killed.
#[tauri::command]
pub fn exit_force(app: AppHandle) {
    app.state::<UpdateControl>().cancel();
    app.state::<ActiveSidecar>().kill_now();
    let control = app.state::<ExitControl>();
    control.confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_running_and_nothing_unsaved_asks_nothing() {
        assert_eq!(prompt_for(false, false), None);
    }

    #[test]
    fn a_job_or_unsaved_settings_ask_and_the_job_comes_first() {
        assert_eq!(
            prompt_for(true, false),
            Some(Prompt {
                job: true,
                dirty: false
            })
        );
        assert_eq!(
            prompt_for(false, true),
            Some(Prompt {
                job: false,
                dirty: true
            })
        );
        assert_eq!(
            prompt_for(true, true),
            Some(Prompt {
                job: true,
                dirty: true
            })
        );
    }

    #[test]
    fn the_prompt_reaches_the_page_as_plain_flags() {
        let value = serde_json::to_value(Prompt {
            job: true,
            dirty: false,
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({"job": true, "dirty": false}));
    }
}

//! What happens when the window is closed or the app is quit. A running job always holds it. Unsaved
//! settings (an API key typed but not stored yet) hold it until the page asked the user, with a
//! deadline so a page that stopped answering can never keep the app from shutting down.
use std::{
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};

use tauri::{Emitter, Manager, State};

/// How long the page has to acknowledge a close request before the old behavior applies.
pub const ANSWER_DEADLINE: Duration = Duration::from_secs(10);
pub const REQUEST_EVENT: &str = "pomi-close-requested";

/// Where the request came from: the window's close button, or quitting the whole app (⌘Q, the
/// app menu, a session logout), which skips the window event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Window,
    Quit,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Window => "window",
            Source::Quit => "quit",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "window" => Some(Source::Window),
            "quit" => Some(Source::Quit),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Close or quit as usual.
    Allow,
    /// A scan, write or restore owns the core: refuse and say why.
    BlockJob,
    /// Unsaved settings: refuse and let the page ask. The source says how to finish afterwards.
    AskUnsaved(Source),
}

/// A job comes first: it must never be cut off, whatever the settings screen holds.
pub fn decide(job_running: bool, unsaved: bool, source: Source) -> Decision {
    if job_running {
        Decision::BlockJob
    } else if unsaved {
        Decision::AskUnsaved(source)
    } else {
        Decision::Allow
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Completion {
    BlockJob,
    CloseWindow,
    ExitApp,
}

/// The answer/deadline is permission to discard edits, never permission to interrupt a job.
pub fn completion(job_running: bool, source: Source, has_window: bool) -> Completion {
    if job_running {
        Completion::BlockJob
    } else if source == Source::Window && has_window {
        Completion::CloseWindow
    } else {
        Completion::ExitApp
    }
}

pub fn controlled_restart(code: Option<i32>, updater_owns_gate: bool) -> bool {
    updater_owns_gate && code == Some(tauri::RESTART_EXIT_CODE)
}

#[derive(Default)]
pub struct CloseGuard {
    unsaved: AtomicBool,
    /// Serial of the latest request sent to the page, and of the latest one the page acknowledged.
    requested: AtomicU64,
    acknowledged: AtomicU64,
    completing: AtomicBool,
    updater_owns_gate: AtomicBool,
}

impl CloseGuard {
    pub fn unsaved(&self) -> bool {
        self.unsaved.load(Ordering::SeqCst)
    }

    fn set_unsaved(&self, value: bool) {
        self.unsaved.store(value, Ordering::SeqCst);
    }

    /// Register a request and return its serial.
    fn begin_request(&self) -> u64 {
        self.requested.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn acknowledge(&self) {
        self.acknowledged
            .store(self.requested.load(Ordering::SeqCst), Ordering::SeqCst);
    }

    /// True when the page never answered request `serial` and nothing was saved or dropped since.
    fn must_force(&self, serial: u64) -> bool {
        self.unsaved() && self.acknowledged.load(Ordering::SeqCst) < serial
    }

    /// Recheck at the actual window/exit event, including explicit app.exit calls.
    pub fn boundary(&self, job_running: bool, source: Source) -> Decision {
        let completing = self.completing.load(Ordering::SeqCst);
        let decision = decide(job_running, self.unsaved() && !completing, source);
        if decision == Decision::BlockJob {
            self.completing.store(false, Ordering::SeqCst);
        } else if decision == Decision::Allow && completing {
            self.set_unsaved(false);
            self.completing.store(false, Ordering::SeqCst);
        }
        decision
    }

    pub fn permits_restart(&self, code: Option<i32>) -> bool {
        controlled_restart(code, self.updater_owns_gate.load(Ordering::SeqCst))
    }

    pub fn updater_restart_scope(&self) -> UpdateRestartScope<'_> {
        self.updater_owns_gate.store(true, Ordering::SeqCst);
        UpdateRestartScope(self)
    }
}

pub struct UpdateRestartScope<'a>(&'a CloseGuard);

impl Drop for UpdateRestartScope<'_> {
    fn drop(&mut self) {
        self.0.updater_owns_gate.store(false, Ordering::SeqCst);
    }
}

/// Hold a close or quit for unsaved settings: wake the window, ask the page, and start the clock.
pub fn ask_page(app: &tauri::AppHandle, source: Source) {
    let guard = app.state::<CloseGuard>();
    let serial = guard.begin_request();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit(REQUEST_EVENT, source.as_str());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ANSWER_DEADLINE).await;
        let guard = app.state::<CloseGuard>();
        if guard.must_force(serial) {
            eprintln!(
                "[pomitranslate] close guard: the page did not answer within {}s, closing as before",
                ANSWER_DEADLINE.as_secs()
            );
            let _ = finish(&app, source);
        }
    });
}

/// Drop the hold and complete the close or quit that was waiting.
fn finish(app: &tauri::AppHandle, source: Source) -> Result<(), String> {
    let state = app.state::<crate::ActiveSidecar>();
    let gate = state.request_gate.try_lock();
    let window = app.get_webview_window("main");
    let guard = app.state::<CloseGuard>();
    match completion(gate.is_err(), source, window.is_some()) {
        Completion::BlockJob => {
            guard.completing.store(false, Ordering::SeqCst);
            if let Some(window) = window {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("pomi-close-blocked", true);
            }
            return Err(crate::CODE_BUSY.into());
        }
        action => {
            // Keep unsaved until the final event accepts it. A job may start before that event.
            guard.completing.store(true, Ordering::SeqCst);
            drop(gate);
            if action == Completion::CloseWindow {
                if window.unwrap().close().is_err() {
                    guard.completing.store(false, Ordering::SeqCst);
                    return Err("INTERNAL_STATE".into());
                }
            } else {
                app.exit(0);
            }
        }
    }
    Ok(())
}

/// The page reports whether the settings screen holds changes that are not saved.
#[tauri::command]
pub fn set_unsaved_settings(state: State<'_, CloseGuard>, unsaved: bool) {
    state.set_unsaved(unsaved);
}

/// The page received the close request and is asking the user.
#[tauri::command]
pub fn close_guard_ack(state: State<'_, CloseGuard>) {
    state.acknowledge();
}

/// The user answered (saved, or dropped the changes): complete the close or quit.
#[tauri::command]
pub fn finish_close(app: tauri::AppHandle, source: String) -> Result<(), String> {
    let source = Source::parse(&source).ok_or_else(|| "INVALID_REQUEST".to_string())?;
    finish(&app, source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_job_always_holds_the_close() {
        for unsaved in [false, true] {
            for source in [Source::Window, Source::Quit] {
                assert_eq!(decide(true, unsaved, source), Decision::BlockJob);
            }
        }
    }

    #[test]
    fn unsaved_settings_ask_and_remember_where_the_request_came_from() {
        assert_eq!(
            decide(false, true, Source::Window),
            Decision::AskUnsaved(Source::Window)
        );
        assert_eq!(
            decide(false, true, Source::Quit),
            Decision::AskUnsaved(Source::Quit)
        );
    }

    #[test]
    fn nothing_pending_closes_as_usual() {
        assert_eq!(decide(false, false, Source::Window), Decision::Allow);
        assert_eq!(decide(false, false, Source::Quit), Decision::Allow);
    }

    #[test]
    fn a_source_round_trips_through_its_text_and_unknown_text_is_refused() {
        for source in [Source::Window, Source::Quit] {
            assert_eq!(Source::parse(source.as_str()), Some(source));
        }
        assert_eq!(Source::parse("WINDOW"), None);
        assert_eq!(Source::parse(""), None);
    }

    #[test]
    fn a_page_that_never_answers_is_forced_but_an_answered_request_is_not() {
        let guard = CloseGuard::default();
        guard.set_unsaved(true);
        let silent = guard.begin_request();
        assert!(guard.must_force(silent), "no acknowledgement: fall back");
        let answered = guard.begin_request();
        guard.acknowledge();
        assert!(!guard.must_force(answered), "the page is asking the user");
        assert!(!guard.must_force(silent), "an older request is covered too");
    }

    #[test]
    fn nothing_is_forced_once_the_changes_were_saved_or_dropped() {
        let guard = CloseGuard::default();
        guard.set_unsaved(true);
        let serial = guard.begin_request();
        guard.set_unsaved(false);
        assert!(!guard.must_force(serial));
    }

    #[test]
    fn the_deadline_is_ten_seconds() {
        assert_eq!(ANSWER_DEADLINE, Duration::from_secs(10));
    }

    #[test]
    fn a_job_starting_after_begin_blocks_finish_and_fallback_without_discarding_edits() {
        for source in [Source::Window, Source::Quit] {
            for has_window in [false, true] {
                for fallback in [false, true] {
                    let guard = CloseGuard::default();
                    guard.set_unsaved(true);
                    assert_eq!(decide(false, true, source), Decision::AskUnsaved(source));
                    let serial = guard.begin_request();
                    if fallback { assert!(guard.must_force(serial)); }
                    assert_eq!(completion(true, source, has_window), Completion::BlockJob);
                    assert_eq!(guard.boundary(true, source), Decision::BlockJob);
                    assert!(guard.unsaved());
                }
            }
        }
    }

    #[test]
    fn an_operation_starting_between_finish_and_the_event_still_holds_unsaved() {
        for source in [Source::Window, Source::Quit] {
            let guard = CloseGuard::default();
            guard.set_unsaved(true);
            guard.completing.store(true, Ordering::SeqCst);
            assert_eq!(guard.boundary(true, source), Decision::BlockJob);
            assert!(guard.unsaved());
            assert_eq!(guard.boundary(false, source), Decision::AskUnsaved(source));
            guard.completing.store(true, Ordering::SeqCst);
            assert_eq!(guard.boundary(false, source), Decision::Allow);
            assert!(!guard.unsaved());
        }
        assert_eq!(completion(false, Source::Window, true), Completion::CloseWindow);
        assert_eq!(completion(false, Source::Window, false), Completion::ExitApp);
        assert_eq!(completion(false, Source::Quit, true), Completion::ExitApp);
    }

    #[test]
    fn only_the_scoped_updater_restart_bypasses_its_own_gate() {
        let guard = CloseGuard::default();
        assert!(!guard.permits_restart(Some(tauri::RESTART_EXIT_CODE)));
        {
            let _scope = guard.updater_restart_scope();
            assert!(guard.permits_restart(Some(tauri::RESTART_EXIT_CODE)));
            assert!(!guard.permits_restart(Some(0)));
            assert!(!guard.permits_restart(None));
        }
        assert!(!guard.permits_restart(Some(tauri::RESTART_EXIT_CODE)));
    }
}

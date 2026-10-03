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

#[derive(Default)]
pub struct CloseGuard {
    unsaved: AtomicBool,
    /// Serial of the latest request sent to the page, and of the latest one the page acknowledged.
    requested: AtomicU64,
    acknowledged: AtomicU64,
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
            finish(&app, source);
        }
    });
}

/// Drop the hold and complete the close or quit that was waiting.
fn finish(app: &tauri::AppHandle, source: Source) {
    app.state::<CloseGuard>().set_unsaved(false);
    match source {
        Source::Quit => app.exit(0),
        Source::Window => match app.get_webview_window("main") {
            // A new CloseRequested follows; with the hold gone it goes through.
            Some(window) => {
                let _ = window.close();
            }
            None => app.exit(0),
        },
    }
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
    // A job that started meanwhile still holds the window: the normal guards decide again.
    finish(&app, source);
    Ok(())
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
}

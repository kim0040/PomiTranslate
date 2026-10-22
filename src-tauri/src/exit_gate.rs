//! One way out of the app (U1, SC-6). The window's close button, Alt+F4, the Quit menu item, Cmd+Q
//! and a session end all end up in `request_exit`:
//!
//! * nothing running and nothing unsaved: the app exits at once;
//! * otherwise the page is asked, in its own dialog, what to do. A running job offers "Cancel the job
//!   and quit" / "Keep working"; unsaved settings offer "Save and quit" / "Quit without saving" /
//!   "Cancel". After "Cancel the job and quit" the core is asked to stop and given about 30 seconds;
//!   if it does not, the page offers "Quit now", which kills it - or "Keep waiting", which starts the
//!   wait again (`exit_keep_waiting`).
//!
//! Installing an update restarts the app, so it goes through the same intent (M3): an operation in
//! progress refuses it, unsaved settings raise the same dialog with `reason: "update"`, and only the
//! person's answer (`exit_confirm` to go on, `exit_cancel` to stay) lets the install and restart
//! happen.
//!
//! A confirmed exit is let through `ExitRequested` (its `code` is then `Some`), so the guard never
//! blocks the exit it asked for.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::oneshot;

use crate::{
    error::{code, IpcError},
    sidecar::ActiveSidecar,
    updates::UpdateControl,
};

/// How long a cancelled job may take to stop before "Quit now" is offered.
const CANCEL_WAIT: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(100);
/// How long an update install waits for the person to answer the unsaved-settings question.
const UPDATE_ANSWER_WAIT: Duration = Duration::from_secs(600);

/// What the open dialog is for.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Quit,
    Update,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Proceed,
    Stay,
}

pub struct ExitControl {
    settings_dirty: AtomicBool,
    confirmed: AtomicBool,
    /// A "cancel and quit" is waiting for the job to stop.
    waiting: AtomicBool,
    /// What the dialog shown last was asked for.
    reason: Mutex<Reason>,
    /// An update install waits for the answer to the unsaved-settings question.
    update_answer: Mutex<Option<oneshot::Sender<Answer>>>,
}

impl Default for ExitControl {
    fn default() -> Self {
        Self {
            settings_dirty: AtomicBool::new(false),
            confirmed: AtomicBool::new(false),
            waiting: AtomicBool::new(false),
            reason: Mutex::new(Reason::Quit),
            update_answer: Mutex::new(None),
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ExitControl {
    fn reason(&self) -> Reason {
        *locked(&self.reason)
    }

    fn set_reason(&self, reason: Reason) {
        *locked(&self.reason) = reason;
    }

    /// Hand the answer to an update install that is waiting for it. False when none waits.
    fn answer_update(&self, answer: Answer) -> bool {
        match locked(&self.update_answer).take() {
            Some(sender) => sender.send(answer).is_ok(),
            None => false,
        }
    }
}

/// What the dialog is about. `job` takes priority: settings cannot be saved while the core is busy.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Prompt {
    pub job: bool,
    pub dirty: bool,
    pub reason: Reason,
}

pub fn prompt_for(job: bool, dirty: bool) -> Option<Prompt> {
    (job || dirty).then_some(Prompt {
        job,
        dirty,
        reason: Reason::Quit,
    })
}

fn job_running<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<ActiveSidecar>().busy() || app.state::<UpdateControl>().active()
}

fn show_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn ask<R: Runtime>(app: &AppHandle<R>, prompt: Prompt) {
    app.state::<ExitControl>().set_reason(prompt.reason);
    show_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("pomi-exit-confirm", prompt);
    }
}

/// True when the window or the app may close right now; otherwise the page was asked and false is
/// returned so the caller prevents the close.
pub fn allow_close<R: Runtime>(app: &AppHandle<R>) -> bool {
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
pub fn request_exit<R: Runtime>(app: &AppHandle<R>) {
    if allow_close(app) {
        app.state::<ExitControl>()
            .confirmed
            .store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

/// The restart of an update install passes the same checks as a quit (M3). Resolves once the install
/// may go on; an error (`UPDATE_BUSY` while an operation runs, `UPDATE_CANCELLED` when the person
/// stays or does not answer) means it must not.
pub async fn authorize_update_restart<R: Runtime>(app: &AppHandle<R>) -> Result<(), IpcError> {
    let handle = app.clone();
    authorize_restart(
        &app.state::<ExitControl>(),
        || app.state::<ActiveSidecar>().busy(),
        move |prompt| ask(&handle, prompt),
        UPDATE_ANSWER_WAIT,
    )
    .await
}

/// The decision behind [`authorize_update_restart`], without the app.
async fn authorize_restart(
    control: &ExitControl,
    operation_active: impl Fn() -> bool,
    ask: impl FnOnce(Prompt),
    answer_wait: Duration,
) -> Result<(), IpcError> {
    let busy = || IpcError::new(code::UPDATE_BUSY, "A job is running");
    if operation_active() {
        return Err(busy());
    }
    if !control.settings_dirty.load(Ordering::SeqCst) {
        return Ok(());
    }
    let (sender, receiver) = oneshot::channel();
    {
        let mut slot = locked(&control.update_answer);
        if slot.is_some() {
            return Err(IpcError::new(
                code::UPDATE_BUSY,
                "An update is already waiting for an answer",
            ));
        }
        *slot = Some(sender);
    }
    ask(Prompt {
        job: false,
        dirty: true,
        reason: Reason::Update,
    });
    let answer = tokio::time::timeout(answer_wait, receiver).await;
    // Whatever happened, no answer is left waiting.
    locked(&control.update_answer).take();
    match answer {
        Ok(Ok(Answer::Proceed)) => {
            // A job may have started while the question was open.
            if operation_active() {
                Err(busy())
            } else {
                Ok(())
            }
        }
        _ => Err(IpcError::new(
            code::UPDATE_CANCELLED,
            "The update was not installed: the person kept the app open",
        )),
    }
}

/// The settings screen reports whether it holds unsaved changes.
#[tauri::command]
pub fn exit_set_settings_dirty(control: State<'_, ExitControl>, dirty: bool) {
    control.settings_dirty.store(dirty, Ordering::SeqCst);
}

/// Wait until `still_running` turns false; true if it did within `limit`.
async fn wait_until_stopped(
    still_running: impl Fn() -> bool,
    limit: Duration,
    poll: Duration,
) -> bool {
    let started = tokio::time::Instant::now();
    while started.elapsed() < limit {
        tokio::time::sleep(poll).await;
        if !still_running() {
            return true;
        }
    }
    false
}

/// Wait for the cancelled job to stop, then exit; if it does not stop in time, the page is told
/// (`pomi-exit-stuck`) and may start the wait again with `exit_keep_waiting`.
fn start_waiter(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let stopped = wait_until_stopped(|| job_running(&app), CANCEL_WAIT, POLL).await;
        let control = app.state::<ExitControl>();
        if stopped {
            control.confirmed.store(true, Ordering::SeqCst);
            control.waiting.store(false, Ordering::SeqCst);
            app.exit(0);
            return;
        }
        control.waiting.store(false, Ordering::SeqCst);
        let _ = app.emit("pomi-exit-stuck", ());
    });
}

/// The person chose to quit (or, for `reason: "update"`, to go on with the install). A running job
/// or update download is asked to stop first.
#[tauri::command]
pub fn exit_confirm(app: AppHandle) -> Result<(), IpcError> {
    let control = app.state::<ExitControl>();
    if control.reason() == Reason::Update {
        // Settings the person saved or chose to discard no longer hold the install back.
        control.settings_dirty.store(false, Ordering::SeqCst);
        if control.answer_update(Answer::Proceed) {
            return Ok(());
        }
    }
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
    start_waiter(app);
    Ok(())
}

/// "Keep waiting" after the quit wait ran out: wait for the stopping job again (the cancel request
/// is repeated), and quit as soon as it is gone.
#[tauri::command]
pub fn exit_keep_waiting(app: AppHandle) {
    let control = app.state::<ExitControl>();
    if !job_running(&app) {
        control.waiting.store(false, Ordering::SeqCst);
        control.confirmed.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }
    if control.waiting.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("pomi-exit-waiting", ());
    let _ = app.state::<ActiveSidecar>().request_cancel();
    start_waiter(app);
}

/// The person chose to stay. An update install that waits for the answer is called off; for a
/// plain quit dialog this changes nothing.
#[tauri::command]
pub fn exit_cancel(control: State<'_, ExitControl>) {
    control.answer_update(Answer::Stay);
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
    use std::{
        cell::Cell,
        sync::{atomic::AtomicUsize, Arc},
    };

    #[test]
    fn nothing_running_and_nothing_unsaved_asks_nothing() {
        assert_eq!(prompt_for(false, false), None);
    }

    #[test]
    fn a_job_or_unsaved_settings_ask_and_the_job_comes_first() {
        let quit = |job, dirty| {
            Some(Prompt {
                job,
                dirty,
                reason: Reason::Quit,
            })
        };
        assert_eq!(prompt_for(true, false), quit(true, false));
        assert_eq!(prompt_for(false, true), quit(false, true));
        assert_eq!(prompt_for(true, true), quit(true, true));
    }

    #[test]
    fn the_prompt_reaches_the_page_as_plain_flags_and_a_reason() {
        let value = serde_json::to_value(Prompt {
            job: true,
            dirty: false,
            reason: Reason::Quit,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"job": true, "dirty": false, "reason": "quit"})
        );
        let update = serde_json::to_value(Prompt {
            job: false,
            dirty: true,
            reason: Reason::Update,
        })
        .unwrap();
        assert_eq!(update["reason"], "update");
    }

    const SHORT: Duration = Duration::from_millis(60);

    #[tokio::test]
    async fn an_update_install_with_nothing_unsaved_goes_ahead_without_a_question() {
        let control = ExitControl::default();
        let asked = Cell::new(false);
        authorize_restart(&control, || false, |_| asked.set(true), SHORT)
            .await
            .unwrap();
        assert!(!asked.get());
    }

    #[tokio::test]
    async fn an_update_install_is_refused_while_an_operation_runs() {
        let control = ExitControl::default();
        control.settings_dirty.store(true, Ordering::SeqCst);
        let asked = Cell::new(false);
        let error = authorize_restart(&control, || true, |_| asked.set(true), SHORT)
            .await
            .unwrap_err();
        assert_eq!(error.code, code::UPDATE_BUSY);
        assert!(!asked.get(), "a running job refuses without a dialog");
    }

    #[tokio::test]
    async fn unsaved_settings_raise_the_quit_dialog_with_the_update_reason_and_wait_for_the_answer()
    {
        for (answer, expected) in [
            (Answer::Proceed, None),
            (Answer::Stay, Some(code::UPDATE_CANCELLED)),
        ] {
            let control = Arc::new(ExitControl::default());
            control.settings_dirty.store(true, Ordering::SeqCst);
            let prompts = Arc::new(Mutex::new(Vec::new()));
            let waiter = {
                let (control, prompts) = (Arc::clone(&control), Arc::clone(&prompts));
                tokio::spawn(async move {
                    authorize_restart(
                        &control,
                        || false,
                        |prompt| prompts.lock().unwrap().push(prompt),
                        Duration::from_secs(20),
                    )
                    .await
                })
            };
            while prompts.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            // Not decided until the person answers.
            assert!(!waiter.is_finished());
            assert_eq!(
                prompts.lock().unwrap()[0],
                Prompt {
                    job: false,
                    dirty: true,
                    reason: Reason::Update
                }
            );
            assert!(control.answer_update(answer));
            let outcome = waiter.await.unwrap();
            assert_eq!(outcome.err().map(|error| error.code), expected);
            assert!(
                !control.answer_update(Answer::Proceed),
                "nothing left waiting"
            );
        }
    }

    #[tokio::test]
    async fn an_unanswered_question_calls_the_install_off() {
        let control = ExitControl::default();
        control.settings_dirty.store(true, Ordering::SeqCst);
        let error = authorize_restart(&control, || false, |_| {}, SHORT)
            .await
            .unwrap_err();
        assert_eq!(error.code, code::UPDATE_CANCELLED);
        assert!(!control.answer_update(Answer::Proceed));
    }

    #[tokio::test]
    async fn a_job_that_started_during_the_question_still_refuses_the_install() {
        let control = Arc::new(ExitControl::default());
        control.settings_dirty.store(true, Ordering::SeqCst);
        let calls = Arc::new(AtomicUsize::new(0));
        let waiter = {
            let (control, calls) = (Arc::clone(&control), Arc::clone(&calls));
            tokio::spawn(async move {
                authorize_restart(
                    &control,
                    // Idle at the first look, busy at the second.
                    || calls.fetch_add(1, Ordering::SeqCst) > 0,
                    |_| {},
                    Duration::from_secs(20),
                )
                .await
            })
        };
        while locked(&control.update_answer).is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        control.answer_update(Answer::Proceed);
        assert_eq!(waiter.await.unwrap().unwrap_err().code, code::UPDATE_BUSY);
    }

    #[tokio::test]
    async fn keep_waiting_starts_the_wait_again_and_ends_when_the_job_is_gone() {
        // The first wait runs out with the job still there: that is the "stuck" dialog.
        let still_there = Arc::new(AtomicBool::new(true));
        let probe = {
            let still_there = Arc::clone(&still_there);
            move || still_there.load(Ordering::SeqCst)
        };
        assert!(
            !wait_until_stopped(&probe, Duration::from_millis(40), Duration::from_millis(5)).await
        );
        // "Keep waiting" waits again with the same rule; the job ends in the meantime.
        let ends = {
            let still_there = Arc::clone(&still_there);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                still_there.store(false, Ordering::SeqCst);
            })
        };
        assert!(wait_until_stopped(&probe, Duration::from_secs(5), Duration::from_millis(5)).await);
        ends.await.unwrap();
    }

    #[test]
    fn only_a_dialog_asked_for_an_update_hands_its_answer_to_the_install() {
        let control = ExitControl::default();
        assert_eq!(control.reason(), Reason::Quit);
        control.set_reason(Reason::Update);
        assert_eq!(control.reason(), Reason::Update);
        assert!(!control.answer_update(Answer::Proceed), "none is waiting");
    }
}

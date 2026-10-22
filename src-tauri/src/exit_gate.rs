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
//! Every prompt carries an intent id (R9) and the answer must name it. There is at most one open
//! intent. A second quit prompt while a quit prompt is open reuses it (the page is told again, same
//! id). A prompt of the other kind *replaces* the open one atomically: a superseded update prompt
//! calls its install off (`UPDATE_CANCELLED`). An answer whose id is not the open intent - a dialog
//! that outlived its wait, or one that was replaced - is refused (`UPDATE_CANCELLED` for an update
//! prompt, `INVALID_REQUEST` otherwise) and changes nothing: it never clears the unsaved-settings
//! flag and never falls through into a quit.
//!
//! A confirmed exit is let through `ExitRequested` (its `code` is then `Some`), so the guard never
//! blocks the exit it asked for.
use std::{
    collections::VecDeque,
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

/// How many closed intents are remembered, to tell a late answer from an unknown one.
const RETIRED_KEPT: usize = 8;

/// The one open exit or update question.
struct OpenIntent {
    id: u64,
    reason: Reason,
    /// An update install waits for the answer here (only for `Reason::Update`).
    answer: Option<oneshot::Sender<Answer>>,
}

#[derive(Default)]
struct Intents {
    next: u64,
    open: Option<OpenIntent>,
    /// The latest closed intents (answered, expired or replaced) and what they were for.
    retired: VecDeque<(u64, Reason)>,
}

impl Intents {
    fn retire(&mut self, id: u64, reason: Reason) {
        if self.retired.len() == RETIRED_KEPT {
            self.retired.pop_front();
        }
        self.retired.push_back((id, reason));
    }

    /// Close the open intent (its waiting update install, if any, is called off by the dropped
    /// sender).
    fn close_open(&mut self) {
        if let Some(open) = self.open.take() {
            self.retire(open.id, open.reason);
        }
    }

    fn open_new(&mut self, reason: Reason, answer: Option<oneshot::Sender<Answer>>) -> u64 {
        self.close_open();
        self.next += 1;
        let id = self.next;
        self.open = Some(OpenIntent { id, reason, answer });
        id
    }
}

pub struct ExitControl {
    settings_dirty: AtomicBool,
    confirmed: AtomicBool,
    /// A "cancel and quit" is waiting for the job to stop.
    waiting: AtomicBool,
    intents: Mutex<Intents>,
}

impl Default for ExitControl {
    fn default() -> Self {
        Self {
            settings_dirty: AtomicBool::new(false),
            confirmed: AtomicBool::new(false),
            waiting: AtomicBool::new(false),
            intents: Mutex::new(Intents::default()),
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ExitControl {
    /// The intent for a quit prompt: the open quit prompt again, else a new one that replaces
    /// whatever else was open.
    fn begin_quit(&self) -> u64 {
        let mut intents = locked(&self.intents);
        match &intents.open {
            Some(open) if open.reason == Reason::Quit => open.id,
            _ => intents.open_new(Reason::Quit, None),
        }
    }

    /// The intent for an update prompt, with the install waiting for its answer. An update that is
    /// already waiting is not replaced.
    fn begin_update(&self, answer: oneshot::Sender<Answer>) -> Result<u64, IpcError> {
        let mut intents = locked(&self.intents);
        if intents
            .open
            .as_ref()
            .is_some_and(|open| open.reason == Reason::Update)
        {
            return Err(IpcError::new(
                code::UPDATE_BUSY,
                "An update is already waiting for an answer",
            ));
        }
        Ok(intents.open_new(Reason::Update, Some(answer)))
    }

    /// Take the open intent if it is `id`; anything else is refused without changing a thing.
    fn take_intent(&self, id: u64) -> Result<OpenIntent, IpcError> {
        let mut intents = locked(&self.intents);
        if intents.open.as_ref().is_some_and(|open| open.id == id) {
            let open = intents.open.take().expect("checked just above");
            intents.retire(open.id, open.reason);
            return Ok(open);
        }
        let was_update = intents
            .retired
            .iter()
            .any(|(retired, reason)| *retired == id && *reason == Reason::Update);
        Err(if was_update {
            IpcError::new(
                code::UPDATE_CANCELLED,
                "This update question is no longer open",
            )
        } else {
            IpcError::new(
                code::INVALID_REQUEST,
                "This exit question is no longer open",
            )
        })
    }

    /// The question timed out or was abandoned: close it if it is still the open one.
    fn expire(&self, id: u64) {
        let mut intents = locked(&self.intents);
        if intents.open.as_ref().is_some_and(|open| open.id == id) {
            intents.close_open();
        }
    }

    /// The answer to the open intent `id`. For a quit it only validates; for an update it hands the
    /// answer to the waiting install. The unsaved-settings flag is cleared only by a proceeding
    /// answer that was accepted.
    fn answer(&self, id: u64, answer: Answer) -> Result<Reason, IpcError> {
        let open = self.take_intent(id)?;
        match (open.reason, open.answer) {
            (Reason::Update, Some(sender)) => {
                if sender.send(answer).is_err() {
                    return Err(IpcError::new(
                        code::UPDATE_CANCELLED,
                        "The update is no longer waiting for an answer",
                    ));
                }
                if answer == Answer::Proceed {
                    // Settings the person saved or chose to discard no longer hold the install back.
                    self.settings_dirty.store(false, Ordering::SeqCst);
                }
                Ok(Reason::Update)
            }
            (Reason::Update, None) => Err(IpcError::new(
                code::UPDATE_CANCELLED,
                "The update is no longer waiting for an answer",
            )),
            (Reason::Quit, _) => {
                if answer == Answer::Proceed {
                    self.settings_dirty.store(false, Ordering::SeqCst);
                }
                Ok(Reason::Quit)
            }
        }
    }
}

/// What the dialog is about. `job` takes priority: settings cannot be saved while the core is busy.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Prompt {
    pub job: bool,
    pub dirty: bool,
    pub reason: Reason,
    /// The id of the question (R9): the answer must carry it. 0 until the prompt is announced.
    pub intent: u64,
}

pub fn prompt_for(job: bool, dirty: bool) -> Option<Prompt> {
    (job || dirty).then_some(Prompt {
        job,
        dirty,
        reason: Reason::Quit,
        intent: 0,
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

/// Tell the page. The prompt already carries its intent.
fn ask<R: Runtime>(app: &AppHandle<R>, prompt: Prompt) {
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
                let intent = control.begin_quit();
                ask(app, Prompt { intent, ..prompt });
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
    let intent = control.begin_update(sender)?;
    ask(Prompt {
        job: false,
        dirty: true,
        reason: Reason::Update,
        intent,
    });
    let answer = tokio::time::timeout(answer_wait, receiver).await;
    // Whatever happened, the question is closed: a late answer finds nothing to answer.
    control.expire(intent);
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

/// The person chose to quit (or, for `reason: "update"`, to go on with the install) in answer to the
/// question `intent`. A running job or update download is asked to stop first. An answer to a
/// question that is not the open one is refused and changes nothing (R9).
#[tauri::command]
pub fn exit_confirm(app: AppHandle, intent: u64) -> Result<(), IpcError> {
    let control = app.state::<ExitControl>();
    if control.answer(intent, Answer::Proceed)? == Reason::Update {
        return Ok(());
    }
    if control.waiting.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
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

/// The person chose to stay in answer to the question `intent`. An update install that waits for
/// the answer is called off; for a quit question this only closes it. A question that is not the
/// open one is refused.
#[tauri::command]
pub fn exit_cancel(control: State<'_, ExitControl>, intent: u64) -> Result<(), IpcError> {
    control.answer(intent, Answer::Stay).map(|_| ())
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

    fn quit_prompt(job: bool, dirty: bool) -> Prompt {
        Prompt {
            job,
            dirty,
            reason: Reason::Quit,
            intent: 0,
        }
    }

    #[test]
    fn nothing_running_and_nothing_unsaved_asks_nothing() {
        assert_eq!(prompt_for(false, false), None);
    }

    #[test]
    fn a_job_or_unsaved_settings_ask_and_the_job_comes_first() {
        assert_eq!(prompt_for(true, false), Some(quit_prompt(true, false)));
        assert_eq!(prompt_for(false, true), Some(quit_prompt(false, true)));
        assert_eq!(prompt_for(true, true), Some(quit_prompt(true, true)));
    }

    #[test]
    fn the_prompt_reaches_the_page_as_plain_flags_a_reason_and_an_intent() {
        let value = serde_json::to_value(Prompt {
            intent: 7,
            ..quit_prompt(true, false)
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"job": true, "dirty": false, "reason": "quit", "intent": 7})
        );
        let update = serde_json::to_value(Prompt {
            job: false,
            dirty: true,
            reason: Reason::Update,
            intent: 8,
        })
        .unwrap();
        assert_eq!(update["reason"], "update");
        assert_eq!(update["intent"], 8);
    }

    const SHORT: Duration = Duration::from_millis(60);

    /// Start an update authorisation that waits (unsaved settings) and return it with the prompt it
    /// raised.
    async fn waiting_update(
        control: &Arc<ExitControl>,
        wait: Duration,
    ) -> (
        tokio::task::JoinHandle<Result<(), IpcError>>,
        Arc<Mutex<Vec<Prompt>>>,
    ) {
        control.settings_dirty.store(true, Ordering::SeqCst);
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let waiter = {
            let (control, prompts) = (Arc::clone(control), Arc::clone(&prompts));
            tokio::spawn(async move {
                authorize_restart(
                    &control,
                    || false,
                    |prompt| prompts.lock().unwrap().push(prompt),
                    wait,
                )
                .await
            })
        };
        while prompts.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        (waiter, prompts)
    }

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
    async fn unsaved_settings_raise_the_dialog_with_the_update_reason_and_wait_for_the_answer() {
        for (answer, expected) in [
            (Answer::Proceed, None),
            (Answer::Stay, Some(code::UPDATE_CANCELLED)),
        ] {
            let control = Arc::new(ExitControl::default());
            let (waiter, prompts) = waiting_update(&control, Duration::from_secs(20)).await;
            // Not decided until the person answers.
            assert!(!waiter.is_finished());
            let prompt = prompts.lock().unwrap()[0];
            assert_eq!(
                (prompt.job, prompt.dirty, prompt.reason),
                (false, true, Reason::Update)
            );
            assert_ne!(prompt.intent, 0, "the question carries its id");
            control.answer(prompt.intent, answer).unwrap();
            let outcome = waiter.await.unwrap();
            assert_eq!(outcome.err().map(|error| error.code), expected);
            assert_eq!(
                control
                    .answer(prompt.intent, Answer::Proceed)
                    .unwrap_err()
                    .code,
                code::UPDATE_CANCELLED,
                "an answered question cannot be answered again"
            );
        }
    }

    #[tokio::test]
    async fn an_unanswered_question_calls_the_install_off_and_a_late_confirm_does_nothing() {
        let control = Arc::new(ExitControl::default());
        let (waiter, prompts) = waiting_update(&control, SHORT).await;
        let intent = prompts.lock().unwrap()[0].intent;
        let error = waiter.await.unwrap().unwrap_err();
        assert_eq!(error.code, code::UPDATE_CANCELLED);
        // The dialog is still on screen and the person confirms late (R9).
        control.settings_dirty.store(true, Ordering::SeqCst);
        let late = control.answer(intent, Answer::Proceed).unwrap_err();
        assert_eq!(late.code, code::UPDATE_CANCELLED);
        assert!(
            control.settings_dirty.load(Ordering::SeqCst),
            "a late answer never clears the unsaved-settings flag"
        );
    }

    #[test]
    fn an_answer_that_names_no_open_question_is_refused_and_changes_nothing() {
        let control = ExitControl::default();
        control.settings_dirty.store(true, Ordering::SeqCst);
        // Nothing was ever asked.
        for answer in [Answer::Proceed, Answer::Stay] {
            let error = control.answer(41, answer).unwrap_err();
            assert_eq!(error.code, code::INVALID_REQUEST);
        }
        assert!(control.settings_dirty.load(Ordering::SeqCst));
        // A quit question is open: another id is refused, and the open one is still answerable.
        let intent = control.begin_quit();
        assert!(control.answer(intent + 1, Answer::Proceed).is_err());
        assert!(control.settings_dirty.load(Ordering::SeqCst));
        assert_eq!(
            control.answer(intent, Answer::Proceed).unwrap(),
            Reason::Quit
        );
        assert!(
            !control.settings_dirty.load(Ordering::SeqCst),
            "only an accepted proceeding answer clears the flag"
        );
    }

    #[tokio::test]
    async fn a_quit_prompt_replaces_an_open_update_prompt_and_calls_the_install_off() {
        let control = Arc::new(ExitControl::default());
        let (waiter, prompts) = waiting_update(&control, Duration::from_secs(20)).await;
        let update_intent = prompts.lock().unwrap()[0].intent;
        let quit_intent = control.begin_quit();
        assert_ne!(quit_intent, update_intent);
        // The install was called off at once, without waiting for the answer window.
        let error = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("the replaced question ends the wait")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, code::UPDATE_CANCELLED);
        // A confirm for the replaced update dialog neither quits nor clears anything.
        control.settings_dirty.store(true, Ordering::SeqCst);
        assert_eq!(
            control
                .answer(update_intent, Answer::Proceed)
                .unwrap_err()
                .code,
            code::UPDATE_CANCELLED
        );
        assert!(control.settings_dirty.load(Ordering::SeqCst));
        // The quit question is the open one.
        assert_eq!(
            control.answer(quit_intent, Answer::Stay).unwrap(),
            Reason::Quit
        );
    }

    #[tokio::test]
    async fn an_update_prompt_replaces_an_open_quit_prompt_and_a_second_update_waits_its_turn() {
        let control = Arc::new(ExitControl::default());
        let quit_intent = control.begin_quit();
        let (waiter, prompts) = waiting_update(&control, Duration::from_secs(20)).await;
        let update_intent = prompts.lock().unwrap()[0].intent;
        // The quit dialog's confirm no longer reaches anything.
        let error = control.answer(quit_intent, Answer::Proceed).unwrap_err();
        assert_eq!(error.code, code::INVALID_REQUEST);
        // A second install is refused while the first waits.
        let (sender, _receiver) = oneshot::channel();
        assert_eq!(
            control.begin_update(sender).unwrap_err().code,
            code::UPDATE_BUSY
        );
        control.answer(update_intent, Answer::Proceed).unwrap();
        waiter.await.unwrap().unwrap();
    }

    #[test]
    fn asking_to_quit_again_reuses_the_open_quit_question() {
        let control = ExitControl::default();
        let first = control.begin_quit();
        assert_eq!(control.begin_quit(), first);
    }

    #[tokio::test]
    async fn a_job_that_started_during_the_question_still_refuses_the_install() {
        let control = Arc::new(ExitControl::default());
        control.settings_dirty.store(true, Ordering::SeqCst);
        let calls = Arc::new(AtomicUsize::new(0));
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let waiter = {
            let (control, calls, prompts) = (
                Arc::clone(&control),
                Arc::clone(&calls),
                Arc::clone(&prompts),
            );
            tokio::spawn(async move {
                authorize_restart(
                    &control,
                    // Idle at the first look, busy at the second.
                    || calls.fetch_add(1, Ordering::SeqCst) > 0,
                    |prompt| prompts.lock().unwrap().push(prompt),
                    Duration::from_secs(20),
                )
                .await
            })
        };
        while prompts.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let intent = prompts.lock().unwrap()[0].intent;
        control.answer(intent, Answer::Proceed).unwrap();
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
}

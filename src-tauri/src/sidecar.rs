//! Requests to the translation core: spawn it under supervision, send the request, read its JSONL
//! replies, and shut it down. The decisions are in plain types (`LineScanner`, `Exchange`,
//! `termination_error`) so they are tested without a child process; the process work is in
//! `core_process` (Job Object / process group).
//!
//! Two lanes share one process role (a fresh core per request, as before):
//!
//! * `Query` - short reads and settings changes;
//! * `Job` - scan, translate, resume, restore, recovery and backup maintenance. These can run for
//!   long, write to worlds, and are the ones the person may cancel and, when the core does not
//!   react, force-stop.
use std::{
    ffi::OsString,
    fs,
    ops::{Deref, DerefMut},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::{
    sync::mpsc,
    time::{timeout, timeout_at, Instant},
};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    core_process::{self, CoreEvent, ProcessControl, SpawnSpec, Stdin},
    diagnostics,
    error::{code, detail, IpcError},
    sidecar_paths, startup,
};

/// A reply larger than this is a protocol error, not something to buffer without limit.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// A progress event is a status line. A bigger one is a core bug, not something to forward.
const MAX_PROGRESS_BYTES: usize = 1024 * 1024;
/// Output that is not this request's protocol traffic (stray prints, other requests' messages) is
/// tolerated up to this much per request; a core that floods stdout is broken.
const MAX_STRAY_BYTES: usize = 1024 * 1024;
/// Everything a short request may produce on stdout, progress included.
const MAX_QUERY_BYTES: usize = 32 * 1024 * 1024;
/// Requests that write to a world or the backup store: after a protocol fault they are asked to
/// cancel and given time to stop before they are killed.
const WORLD_WRITERS: &[&str] = &[
    "translate.start",
    "translate.resume",
    "restore.start",
    "recovery.start",
    "jobs.recover",
    "backups.delete",
    "backups.prune",
];
/// Requests that run as a job: they hold the job slot, can be cancelled and force-stopped.
const JOB_REQUESTS: &[&str] = &[
    "scan.start",
    "translate.start",
    "translate.resume",
    "restore.start",
    "recovery.start",
    "jobs.recover",
    "backups.delete",
    "backups.prune",
];
/// A short request (every request that is not a job) must be answered within this time of its
/// being written; the core is stopped when it is not (R7). Jobs have no blanket timeout.
pub const QUERY_DEADLINE: Duration = Duration::from_secs(120);
const CANCEL_GRACE: Duration = Duration::from_secs(30);
/// How long the core may take to exit after its stdin is closed, before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// How long a killed core may take to be reported gone before the slot is kept occupied.
const KILL_WAIT: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 10 });
/// A request line that cannot be written in this time means the core is not reading.
const REQUEST_WRITE_LIMIT: Duration = Duration::from_secs(20);
/// The person may force-stop a job only this long after asking it to cancel.
pub const FORCE_STOP_AFTER_CANCEL: Duration = Duration::from_secs(30);
/// The most of a core output line that is looked at: lines are redacted and classified as complete
/// lines up to this size (H3).
const OUTPUT_LINE_BYTES: usize = 64 * 1024;

/// Environment variables that could hand the core a provider key behind Rust's back. The core never
/// reads them for the desktop app (Rust owns credentials), and they are blanked for the child anyway.
const SECRET_ENV: &[&str] = &[
    "POMI_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "COMET_API_KEY",
    "CUSTOM_API_KEY",
    "CUSTOM_OPENAI_API_KEY",
    "CUSTOM_ANTHROPIC_API_KEY",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
    Query,
    Job,
}

pub fn lane(kind: &str) -> Lane {
    if JOB_REQUESTS.contains(&kind) {
        Lane::Job
    } else {
        Lane::Query
    }
}

fn writes_world(kind: &str) -> bool {
    WORLD_WRITERS.contains(&kind)
}

/// Everything needed to start the core for one request.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub cwd: PathBuf,
    pub cancel_path: PathBuf,
}

impl Launch {
    fn spec(&self) -> SpawnSpec {
        SpawnSpec {
            program: self.program.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            cwd: Some(self.cwd.clone()),
        }
    }
}

/// The environment every core child gets: UTF-8 channels (SC-4), no provider keys from the outside,
/// and the app's own identity so the core reports the same version and build as the shell.
fn core_environment() -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = vec![
        // The JSONL channel is UTF-8 on every Windows code page.
        ("PYTHONUTF8".into(), "1".into()),
        ("PYTHONIOENCODING".into(), "utf-8".into()),
        ("POMI_APP_VERSION".into(), env!("CARGO_PKG_VERSION").into()),
        ("POMI_BUILD_SHA".into(), crate::BUILD_SHA.into()),
        ("POMI_BUILD_DATE".into(), crate::BUILD_DATE.into()),
    ];
    env.extend(
        SECRET_ENV
            .iter()
            .map(|name| ((*name).into(), OsString::new())),
    );
    env
}

/// The launch for this app: the resolved core, its data and report folders, and the cancel marker.
fn launch_for(app: &AppHandle) -> Result<Launch, IpcError> {
    let app_data = crate::app_data_root(app)?;
    let data_dir = sidecar_paths::core_data_dir(&app_data, &app.config().identifier)
        .map_err(|message| IpcError::new(code::INTERNAL, message))?;
    let report_dir = app_data.join("reports");
    fs::create_dir_all(&report_dir)
        .map_err(|_| IpcError::new(code::INTERNAL, "Cannot create the report directory"))?;
    let cancel_path = report_dir.join("active-operation.cancel");
    let resource_dir = tauri::Manager::path(app).resource_dir().ok();
    let command = sidecar_paths::resolve(
        resource_dir.as_deref(),
        sidecar_paths::dev_options().as_ref(),
    )
    .map_err(|_| {
        diagnostics::global().log(
            "ERROR",
            "core",
            "the translation core could not be resolved",
        );
        IpcError::new(
            code::CORE_SPAWN_FAILED,
            "Packaged translation core is unavailable",
        )
    })?;
    let (program, mut args, mut env) = command.program_and_args();
    args.extend(
        sidecar_paths::arguments(&data_dir, &report_dir, &cancel_path)
            .into_iter()
            .map(OsString::from),
    );
    env.extend(core_environment());
    Ok(Launch {
        program,
        args,
        env,
        cwd: report_dir,
        cancel_path,
    })
}

struct ActiveProcess {
    control: Arc<ProcessControl>,
    /// Dropping this closes the core's stdin.
    stdin: Option<Stdin>,
    cancel_path: PathBuf,
    /// When the person asked this job to cancel.
    cancel_requested: Option<std::time::Instant>,
    /// Set by a force-stop so the request reports it instead of a generic crash.
    forced: Arc<AtomicBool>,
}

/// What a force-stop did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceStopped {
    /// Nothing was running (the job ended on its own in the meantime).
    pub was_running: bool,
    /// The core did not end after its stdin closed and was killed.
    pub killed: bool,
}

/// Proof that maintenance work has the app to itself; see [`ActiveSidecar::maintenance`].
#[must_use = "the guard is what keeps requests out"]
pub struct MaintenanceGuard<'a> {
    _gate: tokio::sync::MutexGuard<'a, ()>,
}

#[derive(Default)]
pub struct ActiveSidecar {
    process: Arc<Mutex<Option<ActiveProcess>>>,
    pub request_gate: tauri::async_runtime::Mutex<()>,
}

fn lock_slot(
    slot: &Mutex<Option<ActiveProcess>>,
) -> std::sync::MutexGuard<'_, Option<ActiveProcess>> {
    // A panic elsewhere must not make every later request fail (RB-1).
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl ActiveSidecar {
    fn process(&self) -> std::sync::MutexGuard<'_, Option<ActiveProcess>> {
        lock_slot(&self.process)
    }

    /// A request is being served or a core process has not been seen to end.
    pub fn busy(&self) -> bool {
        self.request_gate.try_lock().is_err() || self.process().is_some()
    }

    /// Take the maintenance guard (R10): no request can start while it is held, and it exists only
    /// when no core is active, none is retained because its end was never observed, and no created
    /// child is waiting for cleanup. It is held for the whole mutation (credential reset, app reset,
    /// update install and restart).
    ///
    /// `BUSY` when a request holds the gate; `CORE_STATE_UNKNOWN` when a core (or an unsupervised
    /// child) is still retained after its request ended.
    pub fn maintenance(&self) -> Result<MaintenanceGuard<'_>, IpcError> {
        let gate = self.request_gate.try_lock().map_err(|_| {
            IpcError::new(
                code::BUSY,
                "Another PomiTranslate operation is still running",
            )
        })?;
        // The gate is ours, so no request can start or finish while the slot is looked at. A slot
        // that is still occupied belongs to a request that already ended: its core was not seen to
        // end. (`busy()` is not used here: it counts the gate we hold as busy.)
        if self.process().is_some() || core_process::leftovers_pending() {
            return Err(IpcError::new(
                code::CORE_STATE_UNKNOWN,
                "A translation core has not been confirmed stopped; nothing may change underneath it",
            ));
        }
        Ok(MaintenanceGuard { _gate: gate })
    }

    /// Free the slot, but only once the core's exit was observed - never because time passed.
    fn clear(slot: &Mutex<Option<ActiveProcess>>, pid: u32) {
        let mut slot = lock_slot(slot);
        if slot
            .as_ref()
            .is_some_and(|active| active.control.pid() == pid && active.control.has_exited())
        {
            if let Some(active) = slot.take() {
                let _ = fs::remove_file(active.cancel_path);
            }
        }
    }

    /// Ask the running operation to stop. False when none is running.
    pub fn request_cancel(&self) -> Result<bool, IpcError> {
        let mut active = self.process();
        let Some(process) = active.as_mut() else {
            return Ok(false);
        };
        fs::write(&process.cancel_path, b"cancel").map_err(|_| {
            IpcError::new(code::INTERNAL, "Could not write the cancellation marker")
        })?;
        process
            .cancel_requested
            .get_or_insert_with(std::time::Instant::now);
        Ok(true)
    }

    /// Kill the core now (quit-now after a stuck cancel). Safe when nothing is running. The app is
    /// on its way out, so the slot is released without waiting for the exit.
    pub fn kill_now(&self) {
        if let Some(process) = self.process().take() {
            process.control.kill_tree();
            let _ = fs::remove_file(process.cancel_path);
        }
        // A child that never made it under supervision gets one more try on the way out.
        core_process::reap_leftovers();
    }

    /// Stop a job that did not react to its cancel marker: close its stdin (a core that listens to
    /// it stops there), wait a moment, then kill the whole tree. Returns once the exit was
    /// observed; the slot is released only then. Refused until `min_after_cancel` has passed since
    /// the cancel request, so a healthy job is not killed at the first click.
    pub async fn force_stop(&self, min_after_cancel: Duration) -> Result<ForceStopped, IpcError> {
        let (control, stdin) = {
            let mut slot = self.process();
            let Some(active) = slot.as_mut() else {
                return Ok(ForceStopped {
                    was_running: false,
                    killed: false,
                });
            };
            let waited = active.cancel_requested.map(|at| at.elapsed());
            if waited.is_none_or(|waited| waited < min_after_cancel) {
                return Err(IpcError::new(
                    code::BUSY,
                    "The job has not been given time to stop after the cancel request",
                ));
            }
            active.forced.store(true, Ordering::SeqCst);
            (Arc::clone(&active.control), active.stdin.take())
        };
        drop(stdin);
        diagnostics::global().log("WARN", "core", "force-stopping the translation core");
        let mut killed = false;
        if control.wait_exit(EXIT_GRACE).await.is_none() {
            killed = true;
            control.kill_tree();
            control.wait_exit(KILL_WAIT).await;
        }
        if !control.has_exited() {
            return Err(if control.is_unknown() {
                IpcError::new(
                    code::CORE_STATE_UNKNOWN,
                    "The end of the translation core could not be observed; the operation slot stays occupied",
                )
            } else {
                IpcError::new(
                    code::CORE_STOPPED,
                    "The translation core could not be stopped; it is still running",
                )
            });
        }
        Self::clear(&self.process, control.pid());
        Ok(ForceStopped {
            was_running: true,
            killed,
        })
    }
}

// --- framing ----------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Scan {
    Line(Vec<u8>),
    /// A line grew past the limit. `message_type` is read from its first bytes when present.
    Oversize {
        message_type: Option<String>,
    },
}

/// Splits stdout into lines. A byte is looked at once: the scan resumes where the last chunk ended,
/// so a large reply arriving in small chunks does not cost a rescan per chunk (SC-8).
pub struct LineScanner {
    buffer: Vec<u8>,
    scanned: usize,
    discarding: bool,
    limit: usize,
}

impl LineScanner {
    pub fn new(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            scanned: 0,
            discarding: false,
            limit,
        }
    }

    pub fn push(&mut self, mut chunk: &[u8]) -> Vec<Scan> {
        let mut out = Vec::new();
        if self.discarding {
            // Skip the rest of an oversized line.
            match chunk.iter().position(|byte| *byte == b'\n') {
                Some(end) => {
                    chunk = &chunk[end + 1..];
                    self.discarding = false;
                }
                None => return out,
            }
        }
        self.buffer.extend_from_slice(chunk);
        while let Some(offset) = self.buffer[self.scanned..].iter().position(|b| *b == b'\n') {
            let end = self.scanned + offset;
            let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
            self.scanned = 0;
            if line.len() > self.limit {
                out.push(Scan::Oversize {
                    message_type: peek_type(&line),
                });
                continue;
            }
            while line.last().is_some_and(|byte| byte.is_ascii_whitespace()) {
                line.pop();
            }
            if !line.is_empty() {
                out.push(Scan::Line(line));
            }
        }
        self.scanned = self.buffer.len();
        if self.buffer.len() > self.limit {
            out.push(Scan::Oversize {
                message_type: peek_type(&self.buffer),
            });
            self.buffer.clear();
            self.scanned = 0;
            self.discarding = true;
        }
        out
    }

    /// The unfinished last line, if the stream ended without a newline.
    pub fn finish(&mut self) -> Option<Vec<u8>> {
        let mut line = std::mem::take(&mut self.buffer);
        self.scanned = 0;
        while line.last().is_some_and(|byte| byte.is_ascii_whitespace()) {
            line.pop();
        }
        (!line.is_empty()).then_some(line)
    }
}

/// `"type":"response.ok"` from the start of a line too large to parse.
fn peek_type(line: &[u8]) -> Option<String> {
    let head = &line[..line.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let after = text.split_once("\"type\"")?.1;
    let value = after
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let kind: String = value
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(64)
        .collect();
    (!kind.is_empty()).then_some(kind)
}

// --- message policy ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum Line {
    Hello,
    Progress(Value),
    Reply(Value),
    /// Another request's message.
    Ignore,
    /// This request's id with a type that does not end the exchange (an unknown event). Neither
    /// its type nor its content is kept.
    Unexpected,
    /// This request's id on a terminal type (`response.ok` / `response.error`) whose envelope is
    /// not valid: a protocol fault (R6), not a result and not something to wait out.
    Malformed,
    /// Not protocol output (after the handshake): classified by diagnostics and skipped, never
    /// fatal. Carries the line, bounded.
    Stray(String),
    Fatal(IpcError),
}

/// The error object of a terminal `response.error`: a stable code (`[A-Z0-9_]{1,64}`) and a message
/// text. Anything else cannot be told to the person and is a protocol fault.
fn valid_error(error: &Value) -> bool {
    let code_ok = error
        .get("code")
        .and_then(Value::as_str)
        .is_some_and(|code| {
            (1..=64).contains(&code.len())
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        });
    code_ok && error.get("message").is_some_and(Value::is_string)
}

/// A terminal reply must carry the protocol version, and `response.ok` its payload object or
/// `response.error` its error object with a code and a message (R6).
fn valid_reply(message: &Value, kind: &str) -> bool {
    message.get("v").and_then(Value::as_u64) == Some(1)
        && match kind {
            "response.ok" => message.get("payload").is_some_and(Value::is_object),
            _ => message.get("error").is_some_and(valid_error),
        }
}

pub fn classify_line(line: &[u8], saw_hello: bool, id: &str) -> Line {
    let parsed = serde_json::from_slice::<Value>(line)
        .ok()
        .filter(|message| message.get("type").and_then(Value::as_str).is_some());
    let Some(message) = parsed else {
        return if saw_hello {
            let bounded = &line[..line.len().min(OUTPUT_LINE_BYTES)];
            Line::Stray(String::from_utf8_lossy(bounded).into_owned())
        } else {
            Line::Fatal(IpcError::new(
                code::CORE_PROTOCOL,
                "Translation core returned invalid output before its handshake",
            ))
        };
    };
    let kind = message["type"].as_str().unwrap_or("");
    if kind == "system.hello" {
        let version = message
            .get("payload")
            .and_then(|value| value.get("protocolVersion"))
            .and_then(Value::as_u64);
        return if version == Some(1) {
            Line::Hello
        } else {
            Line::Fatal(IpcError::new(
                code::CORE_PROTOCOL,
                "Translation core protocol version does not match",
            ))
        };
    }
    if !saw_hello {
        return Line::Fatal(IpcError::new(
            code::CORE_PROTOCOL,
            "Translation core did not complete its handshake",
        ));
    }
    if message.get("id").and_then(Value::as_str) != Some(id) {
        return Line::Ignore;
    }
    if kind.ends_with(".progress") {
        Line::Progress(message)
    } else if matches!(kind, "response.ok" | "response.error") {
        // Only a valid terminal reply ends the exchange (H4); an invalid one is a fault (R6).
        if valid_reply(&message, kind) {
            Line::Reply(message)
        } else {
            Line::Malformed
        }
    } else {
        Line::Unexpected
    }
}

/// How the core's end maps to a stable code.
pub fn termination_error(code_: Option<i32>, signal: Option<i32>) -> IpcError {
    match (code_, signal) {
        (Some(0), None) | (None, None) => IpcError::new(
            code::CORE_STOPPED,
            "Translation core exited without returning a result",
        ),
        (code_, signal) => IpcError::new(
            code::CORE_CRASHED,
            format!(
                "Translation core ended abnormally (exit code {}, signal {})",
                code_.map_or("none".to_owned(), |c| c.to_string()),
                signal.map_or("none".to_owned(), |s| s.to_string())
            ),
        ),
    }
}

/// What one event asks the caller to do.
#[derive(Debug)]
pub enum Step {
    Progress(Value),
    /// Write the cancel marker: the core is to stop on its own, within `CANCEL_GRACE`.
    Cancel,
    Done(Result<Value, IpcError>),
}

/// The core's stderr, cut into complete lines before diagnostics sees any of it: a chunk boundary
/// can fall inside a secret, and classification needs the whole line (H3). The scanner keeps its
/// state for as long as the sink lives, shutdown included.
pub struct StderrSink {
    scanner: LineScanner,
}

impl StderrSink {
    pub fn new() -> Self {
        Self {
            scanner: LineScanner::new(OUTPUT_LINE_BYTES),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        for scan in self.scanner.push(bytes) {
            match scan {
                Scan::Line(line) => {
                    diagnostics::global().core_stderr(&String::from_utf8_lossy(&line));
                }
                // Too long to be a diagnostic line: counted as omitted, never kept.
                Scan::Oversize { .. } => diagnostics::global().core_stderr_omitted(),
            }
        }
    }

    /// The stream ended: the unfinished last line is a line too.
    pub fn finish(&mut self) {
        if let Some(rest) = self.scanner.finish() {
            diagnostics::global().core_stderr(&String::from_utf8_lossy(&rest));
        }
        diagnostics::global().end_core_output();
    }
}

impl Default for StderrSink {
    fn default() -> Self {
        Self::new()
    }
}

/// The reading side of one request, driven event by event.
pub struct Exchange {
    id: String,
    kind: String,
    lane: Lane,
    saw_hello: bool,
    scanner: LineScanner,
    stderr: StderrSink,
    /// Bytes of non-protocol output so far (stray lines, other requests' messages).
    stray_bytes: usize,
    /// Every stdout byte so far; bounds a short request as a whole.
    total_bytes: usize,
    /// Set after a protocol fault on a world writer: the fault is reported once the core stops.
    pending_fault: Option<IpcError>,
}

impl Exchange {
    pub fn new(id: &str, kind: &str) -> Self {
        Self {
            id: id.to_owned(),
            kind: kind.to_owned(),
            lane: lane(kind),
            saw_hello: false,
            scanner: LineScanner::new(MAX_LINE_BYTES),
            stderr: StderrSink::new(),
            stray_bytes: 0,
            total_bytes: 0,
            pending_fault: None,
        }
    }

    pub fn saw_hello(&self) -> bool {
        self.saw_hello
    }

    /// The stderr sink, which shutdown keeps feeding after the exchange itself ended.
    fn stderr_sink(&mut self) -> &mut StderrSink {
        &mut self.stderr
    }

    /// True while a faulted world writer is being given time to stop.
    #[cfg(test)]
    pub fn cancelling(&self) -> bool {
        self.pending_fault.is_some()
    }

    /// The error to report when the core did not stop in time.
    pub fn fault(&self) -> Option<IpcError> {
        self.pending_fault.clone()
    }

    pub fn on_event(&mut self, event: CoreEvent) -> Vec<Step> {
        match event {
            CoreEvent::Stdout(bytes) => self.on_stdout(&bytes),
            CoreEvent::Stderr(bytes) => {
                self.stderr.push(&bytes);
                vec![]
            }
            CoreEvent::Exited(info) => {
                self.stderr.finish();
                vec![Step::Done(Err(self.pending_fault.clone().unwrap_or_else(
                    || termination_error(info.code, info.signal),
                )))]
            }
            CoreEvent::Error => {
                // Waiting on the process failed: it may still be running. Not "stopped".
                diagnostics::global().log(
                    "ERROR",
                    "core",
                    "waiting on the translation core failed",
                );
                vec![Step::Done(Err(self.pending_fault.clone().unwrap_or_else(
                    || {
                        IpcError::new(
                            code::CORE_STATE_UNKNOWN,
                            "The end of the translation core could not be observed",
                        )
                    },
                )))]
            }
        }
    }

    /// A protocol fault: a world writer is asked to cancel first (it may be mid-write), anything
    /// else is stopped at once. True when the caller must stop reading.
    fn fault_step(&mut self, fault: IpcError, steps: &mut Vec<Step>) -> bool {
        if writes_world(&self.kind) && self.saw_hello {
            if self.pending_fault.is_none() {
                self.pending_fault = Some(fault);
                steps.push(Step::Cancel);
            }
            false
        } else {
            steps.push(Step::Done(Err(fault)));
            true
        }
    }

    fn on_stdout(&mut self, bytes: &[u8]) -> Vec<Step> {
        let mut steps = Vec::new();
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        if self.lane == Lane::Query && self.total_bytes > MAX_QUERY_BYTES {
            let fault = IpcError::new(
                code::CORE_PROTOCOL,
                "Translation core returned too much output",
            );
            self.fault_step(fault, &mut steps);
            return steps;
        }
        for scan in self.scanner.push(bytes) {
            match scan {
                Scan::Oversize { message_type } => {
                    let fault = oversize_fault(message_type.as_deref());
                    if self.fault_step(fault, &mut steps) {
                        return steps;
                    }
                }
                Scan::Line(line) => match classify_line(&line, self.saw_hello, &self.id) {
                    Line::Hello => self.saw_hello = true,
                    Line::Progress(message) => {
                        if line.len() > MAX_PROGRESS_BYTES {
                            let fault = oversize_fault(Some("progress"));
                            if self.fault_step(fault, &mut steps) {
                                return steps;
                            }
                        } else {
                            steps.push(Step::Progress(message));
                        }
                    }
                    Line::Reply(message) => {
                        steps.push(Step::Done(Ok(message)));
                        return steps;
                    }
                    Line::Ignore => {
                        if self.over_stray_budget(line.len(), &mut steps) {
                            return steps;
                        }
                    }
                    Line::Unexpected => {
                        // Neither the message nor its type name is logged: both come from the core.
                        diagnostics::global().log(
                            "WARN",
                            "core",
                            "ignored a message that does not end the request",
                        );
                        if self.over_stray_budget(line.len(), &mut steps) {
                            return steps;
                        }
                    }
                    Line::Stray(text) => {
                        diagnostics::global().core_stray_stdout(&text);
                        if self.over_stray_budget(line.len(), &mut steps) {
                            return steps;
                        }
                    }
                    Line::Malformed => {
                        let fault = IpcError::new(
                            code::CORE_PROTOCOL,
                            "Translation core sent a terminal reply that is not valid",
                        );
                        if self.fault_step(fault, &mut steps) {
                            return steps;
                        }
                    }
                    Line::Fatal(error) => {
                        steps.push(Step::Done(Err(error)));
                        return steps;
                    }
                },
            }
        }
        steps
    }

    fn over_stray_budget(&mut self, bytes: usize, steps: &mut Vec<Step>) -> bool {
        self.stray_bytes = self.stray_bytes.saturating_add(bytes);
        if self.stray_bytes <= MAX_STRAY_BYTES {
            return false;
        }
        let fault = IpcError::new(
            code::CORE_PROTOCOL,
            "Translation core wrote too much output outside the protocol",
        );
        self.fault_step(fault, steps)
    }
}

fn oversize_fault(message_type: Option<&str>) -> IpcError {
    IpcError::new(
        code::CORE_PROTOCOL,
        format!(
            "Translation core returned an oversized message (type {})",
            message_type.unwrap_or("unknown")
        ),
    )
}

// --- process control --------------------------------------------------------------------------

/// A request that may carry the API key, wiped on every exit path (CR-9). The key is wrapped the
/// moment it is injected, before anything that can fail (launch resolution, serialization), and the
/// same guard travels all the way into the serialized line (M5).
pub struct SecretRequest(Value);

impl SecretRequest {
    pub fn new(request: Value) -> Self {
        Self(request)
    }

    /// The request without the guard (for requests that never hold a key).
    pub fn into_value(mut self) -> Value {
        std::mem::take(&mut self.0)
    }
}

impl From<Value> for SecretRequest {
    fn from(request: Value) -> Self {
        Self(request)
    }
}

impl Deref for SecretRequest {
    type Target = Value;
    fn deref(&self) -> &Value {
        &self.0
    }
}

impl DerefMut for SecretRequest {
    fn deref_mut(&mut self) -> &mut Value {
        &mut self.0
    }
}

impl Drop for SecretRequest {
    fn drop(&mut self) {
        if let Some(Value::String(key)) = self
            .0
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .and_then(|payload| payload.get_mut("apiKey"))
        {
            key.zeroize();
            #[cfg(test)]
            wiped::record(key);
        }
    }
}

/// Test-only: what the guard saw of the key buffer right after wiping it.
#[cfg(test)]
pub(crate) mod wiped {
    use std::cell::RefCell;

    #[derive(Debug, PartialEq, Eq)]
    pub struct Wipe {
        /// Address of the key's heap buffer.
        pub address: usize,
        /// Every byte of the buffer's capacity is zero.
        pub all_zero: bool,
    }

    thread_local! {
        static WIPES: RefCell<Vec<Wipe>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) fn record(key: &String) {
        // SAFETY: the buffer is still allocated (the String was only cleared) and `zeroize` set
        // its whole capacity, spare bytes included, to zero.
        let bytes = unsafe { std::slice::from_raw_parts(key.as_ptr(), key.capacity()) };
        WIPES.with(|wipes| {
            wipes.borrow_mut().push(Wipe {
                address: key.as_ptr() as usize,
                all_zero: key.is_empty() && bytes.iter().all(|byte| *byte == 0),
            })
        });
    }

    pub fn take() -> Vec<Wipe> {
        WIPES.with(|wipes| std::mem::take(&mut *wipes.borrow_mut()))
    }
}

struct CountingWriter(usize);
impl std::io::Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The request as one line, in a buffer sized up front so growing it never strands a copy of the key.
fn request_line(request: &Value) -> Result<Zeroizing<Vec<u8>>, IpcError> {
    let invalid = || IpcError::new(code::INVALID_REQUEST, "Invalid request");
    let mut counter = CountingWriter(0);
    serde_json::to_writer(&mut counter, request).map_err(|_| invalid())?;
    let mut line = Zeroizing::new(Vec::with_capacity(counter.0 + 1));
    serde_json::to_writer(&mut *line, request).map_err(|_| invalid())?;
    line.push(b'\n');
    Ok(line)
}

/// Run one request against a fresh core process and shut it down afterwards.
pub async fn exchange(
    app: &AppHandle,
    state: &ActiveSidecar,
    request: impl Into<SecretRequest>,
) -> Result<Value, IpcError> {
    exchange_with(
        || launch_for(app),
        state,
        request,
        |message| {
            let _ = app.emit("pomi-progress", message);
        },
    )
    .await
}

/// [`exchange`] with the launch resolved by `resolve`. The request is taken into its wiping guard
/// first, so a failure to find the core cannot strand a plain copy of the key (M5).
async fn exchange_with(
    resolve: impl FnOnce() -> Result<Launch, IpcError>,
    state: &ActiveSidecar,
    request: impl Into<SecretRequest>,
    on_progress: impl Fn(&Value),
) -> Result<Value, IpcError> {
    let request = request.into();
    let launch = resolve()?;
    run(&launch, state, request, on_progress).await
}

/// [`exchange`] without the app: the core to start and the progress sink are passed in.
pub async fn run(
    launch: &Launch,
    state: &ActiveSidecar,
    request: impl Into<SecretRequest>,
    on_progress: impl Fn(&Value),
) -> Result<Value, IpcError> {
    run_with_deadline(launch, state, request, on_progress, QUERY_DEADLINE).await
}

/// [`run`] with the completion deadline of a short request as a parameter (so a test need not wait
/// two minutes).
async fn run_with_deadline(
    launch: &Launch,
    state: &ActiveSidecar,
    request: impl Into<SecretRequest>,
    on_progress: impl Fn(&Value),
    query_limit: Duration,
) -> Result<Value, IpcError> {
    let started = std::time::Instant::now();
    let request: SecretRequest = request.into();
    let kind = request
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::new(code::INVALID_REQUEST, "Missing request id"))?
        .to_owned();
    let deadlines = startup::StartupDeadlines::new(&kind);
    let line = request_line(&request)?;
    // The key now lives only in the line that is written; the Value copy is wiped.
    drop(request);

    let core_process::Spawned {
        pid,
        mut stdin,
        events: mut receiver,
        control,
    } = {
        let mut active = state.process();
        if active.is_some() {
            return Err(IpcError::new(
                code::BUSY,
                "Another PomiTranslate operation is still running",
            ));
        }
        let _ = fs::remove_file(&launch.cancel_path);
        let spawned = core_process::spawn(&launch.spec()).map_err(|error| {
            diagnostics::global().log_with(
                "ERROR",
                "core",
                "could not start the translation core",
                None,
                &[("os_error", i64::from(error.os_error().unwrap_or(0)))],
            );
            error.into_ipc()
        })?;
        *active = Some(ActiveProcess {
            control: Arc::clone(&spawned.control),
            stdin: None,
            cancel_path: launch.cancel_path.clone(),
            cancel_requested: None,
            forced: Arc::new(AtomicBool::new(false)),
        });
        spawned
    };
    diagnostics::global().log_with(
        "INFO",
        "core",
        "started the translation core",
        Some(&kind),
        &[("pid", i64::from(pid))],
    );
    let forced = state
        .process()
        .as_ref()
        .map(|active| Arc::clone(&active.forced))
        .unwrap_or_default();

    let sent = timeout(REQUEST_WRITE_LIMIT, stdin.send(line)).await;
    if !matches!(sent, Ok(Ok(()))) {
        control.kill_tree();
        shutdown(state, &control, &mut receiver, &mut StderrSink::new()).await;
        return Err(if control.is_unknown() {
            IpcError::new(
                code::CORE_STATE_UNKNOWN,
                "The end of the translation core could not be observed",
            )
        } else {
            IpcError::new(
                code::CORE_STOPPED,
                "Could not send the request to the translation core",
            )
        });
    }
    {
        // Held by the slot from here on, so a force-stop can close it.
        let mut active = state.process();
        match active.as_mut() {
            Some(active) => active.stdin = Some(stdin),
            None => drop(stdin),
        }
    }

    let mut session = Exchange::new(&id, &kind);
    let mut cancel_deadline: Option<Instant> = None;
    // Absolute, from the moment the request was written: chatter does not extend it (R7).
    let query_deadline = (lane(&kind) == Lane::Query).then(|| Instant::now() + query_limit);
    let result: Result<Value, IpcError> = 'events: loop {
        let wait_until = [cancel_deadline, query_deadline]
            .into_iter()
            .flatten()
            .min();
        let wait = async {
            match wait_until {
                Some(deadline) => timeout_at(deadline, receiver.recv()).await.map_err(|_| ()),
                None => Ok(receiver.recv().await),
            }
        };
        let event = match deadlines.receive(session.saw_hello(), wait).await {
            Err(startup_code) => {
                break Err(IpcError::new(
                    startup_code,
                    "The translation core did not answer in time",
                ))
            }
            Ok(Err(())) => {
                // Only a short request has a deadline without a cancel grace running.
                if cancel_deadline.is_none() && query_deadline.is_some() {
                    control.kill_tree();
                    break Err(IpcError::new(
                        code::CORE_TIMEOUT,
                        "The translation core did not answer in time",
                    ));
                }
                // The faulted writer did not stop in the grace period.
                break Err(session.fault().unwrap_or_else(|| {
                    IpcError::new(code::CORE_PROTOCOL, "Translation core did not stop")
                }));
            }
            Ok(Ok(event)) => event,
        };
        let Some(event) = event else {
            break Err(session.fault().unwrap_or_else(|| {
                IpcError::new(
                    code::CORE_STOPPED,
                    "Translation core stopped before it returned a result",
                )
            }));
        };
        for step in session.on_event(event) {
            match step {
                Step::Progress(message) => on_progress(&message),
                Step::Cancel => {
                    let _ = state.request_cancel();
                    cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
                }
                Step::Done(done) => break 'events done,
            }
        }
    };

    shutdown(state, &control, &mut receiver, session.stderr_sink()).await;
    let result = match result {
        Err(error)
            if forced.load(Ordering::SeqCst)
                && matches!(error.code, code::CORE_STOPPED | code::CORE_CRASHED) =>
        {
            Err(
                IpcError::new(code::CORE_STOPPED, "The job was stopped by force")
                    .with_detail(detail::JOB_FORCE_STOPPED),
            )
        }
        other => other,
    };
    let exit = control.exit_info();
    diagnostics::global().core_run(&diagnostics::RunRecord {
        request: &kind,
        duration_ms: started.elapsed().as_millis(),
        error: result.as_ref().err().map(|error| error.code),
        exit_code: exit.and_then(|info| info.code),
        signal: exit.and_then(|info| info.signal),
    });
    if let Err(error) = &result {
        diagnostics::global().log_error(&format!("core:{kind}"), error);
    }
    result
}

/// Send what the core wrote to stderr in its last moments to the diagnostics, through the same
/// line scanner as the rest of the request (a line can span the last chunks).
fn drain_stderr(receiver: &mut mpsc::Receiver<CoreEvent>, sink: &mut StderrSink) {
    while let Ok(event) = receiver.try_recv() {
        if let CoreEvent::Stderr(bytes) = event {
            sink.push(&bytes);
        }
    }
}

/// Wait for the end-of-process event (collecting stderr on the way), but at most `limit`. Whether the
/// core is gone is decided by `ProcessControl`, not by this wait.
async fn wait_for_end(
    receiver: &mut mpsc::Receiver<CoreEvent>,
    limit: Duration,
    sink: &mut StderrSink,
) {
    let deadline = Instant::now() + limit;
    loop {
        match timeout_at(deadline, receiver.recv()).await {
            Ok(Some(CoreEvent::Stderr(bytes))) => sink.push(&bytes),
            Ok(Some(CoreEvent::Stdout(_))) => {}
            Ok(Some(CoreEvent::Exited(_) | CoreEvent::Error) | None) | Err(_) => return,
        }
    }
}

/// Release the core: close its stdin so it can exit by itself, wait briefly, then kill the whole
/// tree. The slot is freed once the exit was observed. A core whose exit cannot be observed keeps
/// the slot (the world may still be being written) until it is. Everything it wrote to stderr goes
/// through `sink`, whose unfinished line is flushed at the end.
async fn shutdown(
    state: &ActiveSidecar,
    control: &Arc<ProcessControl>,
    receiver: &mut mpsc::Receiver<CoreEvent>,
    sink: &mut StderrSink,
) {
    let stdin = state
        .process()
        .as_mut()
        .and_then(|active| active.stdin.take());
    drop(stdin);
    if !control.has_exited() {
        wait_for_end(receiver, EXIT_GRACE, sink).await;
    }
    if !control.has_exited() {
        control.kill_tree();
        wait_for_end(receiver, KILL_WAIT, sink).await;
    }
    drain_stderr(receiver, sink);
    sink.finish();
    if control.has_exited() {
        ActiveSidecar::clear(&state.process, control.pid());
        return;
    }
    diagnostics::global().log_with(
        "ERROR",
        "core",
        "the translation core was not seen to end after being killed; the job slot stays occupied",
        None,
        &[
            ("pid", i64::from(control.pid())),
            ("wait_failed", i64::from(control.is_unknown())),
        ],
    );
    let (slot, control) = (Arc::clone(&state.process), Arc::clone(control));
    tokio::spawn(async move {
        // Keep watching: the slot is freed whenever the exit is finally seen.
        while control.wait_exit(Duration::from_secs(3600)).await.is_none() && !control.has_exited()
        {
        }
        ActiveSidecar::clear(&slot, control.pid());
    });
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod smoke_tests;

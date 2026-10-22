//! One request to the translation core: spawn it, send the request, read its JSONL replies, and shut
//! it down. The decisions are in plain types (`LineScanner`, `Exchange`, `termination_error`) so they
//! are tested without a child process.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::time::{timeout_at, Instant};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    diagnostics,
    error::{code, IpcError},
    sidecar_paths, startup,
};

/// A reply larger than this is a protocol error, not something to buffer without limit.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// Requests that write to a world or the backup store: after a protocol fault they are asked to
/// cancel and given time to stop before they are killed.
const LONG_WRITERS: &[&str] = &["translate.start", "translate.resume", "restore.start"];
const CANCEL_GRACE: Duration = Duration::from_secs(30);
/// How long the core may take to exit after its stdin is closed, before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(2);
/// Kept per unparseable line in the log.
const STRAY_LOG_CHARS: usize = 300;

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

struct ActiveProcess {
    pid: u32,
    /// Dropping this closes the core's stdin.
    stdin: Option<CommandChild>,
    cancel_path: PathBuf,
}

#[derive(Default)]
pub struct ActiveSidecar {
    process: Mutex<Option<ActiveProcess>>,
    pub request_gate: tauri::async_runtime::Mutex<()>,
}

impl ActiveSidecar {
    fn process(&self) -> std::sync::MutexGuard<'_, Option<ActiveProcess>> {
        // A panic elsewhere must not make every later request fail (RB-1).
        self.process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn busy(&self) -> bool {
        self.request_gate.try_lock().is_err()
    }

    /// Ask the running operation to stop. False when none is running.
    pub fn request_cancel(&self) -> Result<bool, IpcError> {
        let active = self.process();
        let Some(process) = active.as_ref() else {
            return Ok(false);
        };
        fs::write(&process.cancel_path, b"cancel").map_err(|_| {
            IpcError::new(code::INTERNAL, "Could not write the cancellation marker")
        })?;
        Ok(true)
    }

    /// Kill the core now (quit-now after a stuck cancel). Safe when nothing is running.
    pub fn kill_now(&self) {
        if let Some(process) = self.process().take() {
            terminate(process.pid);
            let _ = fs::remove_file(process.cancel_path);
        }
    }
}

// --- framing ----------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Scan {
    Line(Vec<u8>),
    /// A line grew past the limit. `message_type` is read from its first bytes when present.
    Oversize { message_type: Option<String> },
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
    let value = after.trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
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
    /// Another request's message, or a type this shell does not act on.
    Ignore,
    /// Not protocol output (after the handshake): logged and skipped, never fatal.
    Stray(String),
    Fatal(IpcError),
}

pub fn classify_line(line: &[u8], saw_hello: bool, id: &str) -> Line {
    let parsed = serde_json::from_slice::<Value>(line)
        .ok()
        .filter(|message| message.get("type").and_then(Value::as_str).is_some());
    let Some(message) = parsed else {
        return if saw_hello {
            Line::Stray(String::from_utf8_lossy(line).chars().take(STRAY_LOG_CHARS).collect())
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
    } else {
        Line::Reply(message)
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

/// The reading side of one request, driven event by event.
pub struct Exchange {
    id: String,
    kind: String,
    saw_hello: bool,
    scanner: LineScanner,
    stderr: LineScanner,
    /// Set after a protocol fault on a long writer: the fault is reported once the core stops.
    pending_fault: Option<IpcError>,
}

impl Exchange {
    pub fn new(id: &str, kind: &str) -> Self {
        Self {
            id: id.to_owned(),
            kind: kind.to_owned(),
            saw_hello: false,
            scanner: LineScanner::new(MAX_LINE_BYTES),
            stderr: LineScanner::new(64 * 1024),
            pending_fault: None,
        }
    }

    pub fn saw_hello(&self) -> bool {
        self.saw_hello
    }

    /// True while a faulted long writer is being given time to stop.
    #[cfg(test)]
    pub fn cancelling(&self) -> bool {
        self.pending_fault.is_some()
    }

    /// The error to report when the core did not stop in time.
    pub fn fault(&self) -> Option<IpcError> {
        self.pending_fault.clone()
    }

    pub fn on_event(&mut self, event: CommandEvent) -> Vec<Step> {
        match event {
            CommandEvent::Stdout(bytes) => self.on_stdout(&bytes),
            CommandEvent::Stderr(bytes) => {
                for scan in self.stderr.push(&bytes) {
                    if let Scan::Line(line) = scan {
                        diagnostics::global().core_stderr(&String::from_utf8_lossy(&line));
                    }
                }
                vec![]
            }
            CommandEvent::Terminated(payload) => {
                if let Some(rest) = self.stderr.finish() {
                    diagnostics::global().core_stderr(&String::from_utf8_lossy(&rest));
                }
                vec![Step::Done(Err(self
                    .pending_fault
                    .clone()
                    .unwrap_or_else(|| termination_error(payload.code, payload.signal))))]
            }
            CommandEvent::Error(message) => {
                diagnostics::global().log("ERROR", "core", &message);
                vec![Step::Done(Err(self
                    .pending_fault
                    .clone()
                    .unwrap_or_else(|| {
                        IpcError::new(code::CORE_STOPPED, "The translation core connection failed")
                    })))]
            }
            _ => vec![],
        }
    }

    fn on_stdout(&mut self, bytes: &[u8]) -> Vec<Step> {
        let mut steps = Vec::new();
        for scan in self.scanner.push(bytes) {
            match scan {
                Scan::Oversize { message_type } => {
                    let fault = IpcError::new(
                        code::CORE_PROTOCOL,
                        format!(
                            "Translation core returned an oversized message (type {})",
                            message_type.as_deref().unwrap_or("unknown")
                        ),
                    );
                    if LONG_WRITERS.contains(&self.kind.as_str()) && self.saw_hello {
                        if self.pending_fault.is_none() {
                            self.pending_fault = Some(fault);
                            steps.push(Step::Cancel);
                        }
                    } else {
                        steps.push(Step::Done(Err(fault)));
                        return steps;
                    }
                }
                Scan::Line(line) => match classify_line(&line, self.saw_hello, &self.id) {
                    Line::Hello => self.saw_hello = true,
                    Line::Progress(message) => steps.push(Step::Progress(message)),
                    Line::Reply(message) => {
                        steps.push(Step::Done(Ok(message)));
                        return steps;
                    }
                    Line::Ignore => {}
                    Line::Stray(snippet) => {
                        diagnostics::global().log("WARN", "core", &format!("ignored non-protocol stdout: {snippet}"));
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
}

// --- process control --------------------------------------------------------------------------

#[cfg(windows)]
fn terminate(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle != 0 {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

#[cfg(unix)]
fn terminate(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

/// Request bytes with the key in them, wiped on every exit path (CR-9).
struct SecretRequest(Value);

impl Drop for SecretRequest {
    fn drop(&mut self) {
        if let Some(Value::String(key)) = self
            .0
            .get_mut("payload")
            .and_then(Value::as_object_mut)
            .and_then(|payload| payload.get_mut("apiKey"))
        {
            key.zeroize();
        }
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

fn spawn_core(
    app: &AppHandle,
    data_dir: &Path,
    report_dir: &Path,
    cancel_path: &Path,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), IpcError> {
    let unavailable = |message: &str| IpcError::new(code::CORE_SPAWN_FAILED, message.to_owned());
    let mut command = app
        .shell()
        .sidecar("pomi-sidecar")
        .map_err(|_| unavailable("Packaged translation core is unavailable"))?
        .args(sidecar_paths::arguments(data_dir, report_dir, cancel_path))
        // The JSONL channel is UTF-8 on every Windows code page (SC-4).
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    for name in SECRET_ENV {
        command = command.env(name, "");
    }
    command
        .spawn()
        .map_err(|_| unavailable("Could not start the translation core"))
}

/// Run one request against a fresh core process and shut it down afterwards.
pub async fn exchange(
    app: &AppHandle,
    state: &ActiveSidecar,
    request: Value,
) -> Result<Value, IpcError> {
    let request = SecretRequest(request);
    let kind = request.0.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
    let id = request
        .0
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::new(code::INVALID_REQUEST, "Missing request id"))?
        .to_owned();
    let deadlines = startup::StartupDeadlines::new(&kind);
    let app_data = crate::app_data_root(app)?;
    let data_dir = sidecar_paths::core_data_dir(&app_data, &app.config().identifier)
        .map_err(|message| IpcError::new(code::INTERNAL, message))?;
    let report_dir = app_data.join("reports");
    fs::create_dir_all(&report_dir)
        .map_err(|_| IpcError::new(code::INTERNAL, "Cannot create the report directory"))?;
    let cancel_path = report_dir.join("active-operation.cancel");

    let mut receiver = {
        let mut active = state.process();
        if active.is_some() {
            return Err(IpcError::new(code::BUSY, "Another PomiTranslate operation is still running"));
        }
        let _ = fs::remove_file(&cancel_path);
        let line = request_line(&request.0)?;
        let (receiver, mut child) = spawn_core(app, &data_dir, &report_dir, &cancel_path)?;
        let pid = child.pid();
        if child.write(&line).is_err() {
            terminate(pid);
            return Err(IpcError::new(
                code::CORE_STOPPED,
                "Could not send the request to the translation core",
            ));
        }
        *active = Some(ActiveProcess {
            pid,
            stdin: Some(child),
            cancel_path: cancel_path.clone(),
        });
        receiver
    };
    // The key now lives only in the line that was written; the Value copy is wiped.
    drop(request);

    let mut session = Exchange::new(&id, &kind);
    let mut cancel_deadline: Option<Instant> = None;
    let mut exited = false;
    let result: Result<Value, IpcError> = 'events: loop {
        let wait = async {
            match cancel_deadline {
                Some(deadline) => timeout_at(deadline, receiver.recv()).await.map_err(|_| ()),
                None => Ok(receiver.recv().await),
            }
        };
        let event = match deadlines.receive(session.saw_hello(), wait).await {
            Err(startup_code) => break Err(IpcError::new(startup_code, "The translation core did not answer in time")),
            Ok(Err(())) => {
                // The faulted writer did not stop in the grace period.
                break Err(session.fault().unwrap_or_else(|| {
                    IpcError::new(code::CORE_PROTOCOL, "Translation core did not stop")
                }));
            }
            Ok(Ok(event)) => event,
        };
        let Some(event) = event else {
            break Err(session.fault().unwrap_or_else(|| {
                IpcError::new(code::CORE_STOPPED, "Translation core stopped before it returned a result")
            }));
        };
        if matches!(event, CommandEvent::Terminated(_) | CommandEvent::Error(_)) {
            exited = true;
        }
        for step in session.on_event(event) {
            match step {
                Step::Progress(message) => {
                    let _ = app.emit("pomi-progress", &message);
                }
                Step::Cancel => {
                    let _ = state.request_cancel();
                    cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
                }
                Step::Done(done) => break 'events done,
            }
        }
    };

    if let Err(error) = &result {
        diagnostics::global().log_error(&format!("core:{kind}"), error);
    }
    shutdown(state, &mut receiver, exited).await;
    result
}

/// Release the core: close its stdin so it can exit by itself (a one-file bundle then removes its
/// temporary files), wait briefly, and only then kill it.
async fn shutdown(
    state: &ActiveSidecar,
    receiver: &mut tauri::async_runtime::Receiver<CommandEvent>,
    mut exited: bool,
) {
    let Some(mut process) = state.process().take() else {
        return;
    };
    drop(process.stdin.take());
    if !exited {
        let deadline = Instant::now() + EXIT_GRACE;
        while let Ok(event) = timeout_at(deadline, receiver.recv()).await {
            match event {
                Some(CommandEvent::Terminated(_)) | Some(CommandEvent::Error(_)) | None => {
                    exited = true;
                    break;
                }
                Some(CommandEvent::Stderr(bytes)) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        diagnostics::global().core_stderr(line);
                    }
                }
                Some(_) => {}
            }
        }
    }
    if !exited {
        terminate(process.pid);
    }
    let _ = fs::remove_file(process.cancel_path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_shell::process::TerminatedPayload;

    fn lines(scans: Vec<Scan>) -> Vec<String> {
        scans
            .into_iter()
            .filter_map(|scan| match scan {
                Scan::Line(line) => Some(String::from_utf8(line).unwrap()),
                Scan::Oversize { .. } => None,
            })
            .collect()
    }

    #[test]
    fn a_message_split_across_chunks_is_reassembled() {
        let mut scanner = LineScanner::new(1024);
        assert_eq!(lines(scanner.push(b"{\"a\":1}\n{\"b\":")), ["{\"a\":1}"]);
        assert_eq!(lines(scanner.push(b"2}\r\n\n  \n")), ["{\"b\":2}"]);
        assert!(scanner.finish().is_none());
    }

    #[test]
    fn several_messages_in_one_chunk_come_out_in_order() {
        let mut scanner = LineScanner::new(1024);
        assert_eq!(lines(scanner.push(b"one\ntwo\nthree\n")), ["one", "two", "three"]);
    }

    #[test]
    fn scanning_resumes_where_the_last_chunk_ended() {
        let mut scanner = LineScanner::new(1 << 20);
        for _ in 0..1000 {
            assert!(scanner.push(&[b'x'; 100]).is_empty());
        }
        assert_eq!(scanner.scanned, 100_000, "no byte is looked at twice");
        let out = scanner.push(b"\n");
        assert_eq!(out.len(), 1);
        assert_eq!(scanner.scanned, 0);
    }

    #[test]
    fn an_oversized_line_is_reported_once_and_skipped_to_its_end() {
        let mut scanner = LineScanner::new(64);
        let mut head = br#"{"v":1,"id":"a","type":"response.ok","payload":""#.to_vec();
        head.extend_from_slice(&[b'x'; 100]);
        let first = scanner.push(&head);
        assert_eq!(
            first,
            [Scan::Oversize {
                message_type: Some("response.ok".into())
            }]
        );
        assert!(scanner.push(&[b'x'; 500]).is_empty(), "the rest of the line is dropped");
        let after = scanner.push(b"\"}\n{\"next\":1}\n");
        assert_eq!(lines(after), ["{\"next\":1}"]);
    }

    #[test]
    fn a_complete_oversized_line_in_one_chunk_is_reported_and_the_next_line_survives() {
        let mut scanner = LineScanner::new(32);
        let mut chunk = vec![b'y'; 200];
        chunk.push(b'\n');
        chunk.extend_from_slice(b"ok\n");
        let out = scanner.push(&chunk);
        assert_eq!(out.len(), 2);
        assert!(matches!(out[0], Scan::Oversize { message_type: None }));
        assert_eq!(out[1], Scan::Line(b"ok".to_vec()));
    }

    #[test]
    fn the_message_type_is_read_with_or_without_spaces() {
        assert_eq!(peek_type(br#"{"v": 1, "id": "x", "type": "progress.scan", "p": 1"#).as_deref(), Some("progress.scan"));
        assert_eq!(peek_type(b"no type here"), None);
    }

    const HELLO: &[u8] = b"{\"v\":1,\"id\":\"boot\",\"type\":\"system.hello\",\"payload\":{\"protocolVersion\":1}}\n";

    fn feed(exchange: &mut Exchange, bytes: &[u8]) -> Vec<Step> {
        exchange.on_event(CommandEvent::Stdout(bytes.to_vec()))
    }

    #[test]
    fn stray_output_after_the_handshake_is_ignored_and_the_reply_still_arrives() {
        let mut exchange = Exchange::new("req-1", "scan.start");
        assert!(feed(&mut exchange, HELLO).is_empty());
        assert!(exchange.saw_hello());
        for stray in [
            &b"DeprecationWarning: something noisy\n"[..],
            b"{not json\n",
            b"[1,2,3]\n",
            b"{\"no\":\"type\"}\n",
            "한글 로그 줄\n".as_bytes(),
        ] {
            assert!(feed(&mut exchange, stray).is_empty(), "{stray:?}");
        }
        let steps = feed(
            &mut exchange,
            b"{\"v\":1,\"id\":\"other\",\"type\":\"response.ok\"}\n{\"v\":1,\"id\":\"req-1\",\"type\":\"scan.progress\",\"payload\":{\"n\":1}}\n{\"v\":1,\"id\":\"req-1\",\"type\":\"response.ok\",\"payload\":{}}\n",
        );
        assert_eq!(steps.len(), 2);
        assert!(matches!(steps[0], Step::Progress(_)));
        assert!(matches!(&steps[1], Step::Done(Ok(reply)) if reply["type"] == "response.ok"));
    }

    #[test]
    fn output_before_the_handshake_must_be_the_handshake() {
        for first in [&b"garbage\n"[..], b"{\"v\":1,\"id\":\"req-1\",\"type\":\"response.ok\"}\n"] {
            let mut exchange = Exchange::new("req-1", "scan.start");
            let steps = feed(&mut exchange, first);
            assert!(
                matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL),
                "{first:?}"
            );
        }
        let mut exchange = Exchange::new("req-1", "scan.start");
        let steps = feed(
            &mut exchange,
            b"{\"v\":1,\"id\":\"b\",\"type\":\"system.hello\",\"payload\":{\"protocolVersion\":2}}\n",
        );
        assert!(matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL));
    }

    #[test]
    fn an_oversized_reply_kills_a_reader_but_cancels_a_writer_first() {
        let big = |exchange: &mut Exchange| {
            let mut line = br#"{"v":1,"id":"req-1","type":"response.ok","payload":""#.to_vec();
            line.extend_from_slice(&vec![b'x'; MAX_LINE_BYTES + 10]);
            feed(exchange, &line)
        };
        let mut reader = Exchange::new("req-1", "candidates.page");
        feed(&mut reader, HELLO);
        let steps = big(&mut reader);
        assert!(matches!(&steps[..], [Step::Done(Err(error))]
            if error.code == code::CORE_PROTOCOL && error.message.contains("response.ok")));

        let mut writer = Exchange::new("req-1", "translate.start");
        feed(&mut writer, HELLO);
        let steps = big(&mut writer);
        assert!(matches!(&steps[..], [Step::Cancel]));
        assert!(writer.cancelling());
        // The core stops after the cancel: the fault is what gets reported.
        let ended = writer.on_event(CommandEvent::Terminated(TerminatedPayload { code: Some(0), signal: None }));
        assert!(matches!(&ended[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL));
    }

    #[test]
    fn the_core_ending_maps_to_stable_codes() {
        assert_eq!(termination_error(Some(0), None).code, code::CORE_STOPPED);
        assert_eq!(termination_error(None, None).code, code::CORE_STOPPED);
        assert_eq!(termination_error(Some(3), None).code, code::CORE_CRASHED);
        assert_eq!(termination_error(None, Some(9)).code, code::CORE_CRASHED);
        let mut exchange = Exchange::new("r", "scan.start");
        feed(&mut exchange, HELLO);
        let steps = exchange.on_event(CommandEvent::Terminated(TerminatedPayload { code: Some(-1073741819), signal: None }));
        assert!(matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_CRASHED));
    }

    #[test]
    fn core_stderr_reaches_the_redacted_ring_without_keys() {
        diagnostics::global().reset();
        let mut exchange = Exchange::new("r", "scan.start");
        exchange.on_event(CommandEvent::Stderr(
            b"Traceback (most recent call last):\n  provider echoed Bearer sk-live-00112233445566778899aabb\n".to_vec(),
        ));
        let kept = diagnostics::global().stderr_lines().join("\n");
        assert!(kept.contains("Traceback"));
        assert!(!kept.contains("sk-live"), "{kept}");
    }

    #[test]
    fn the_secret_in_a_request_is_wiped_when_the_guard_drops() {
        let request = serde_json::json!({"v":1,"id":"x","type":"models.list","payload":{"apiKey":"fixture-key-1234567890"}});
        let line = request_line(&request).unwrap();
        assert!(String::from_utf8_lossy(&line).contains("fixture-key-1234567890"));
        assert_eq!(line.capacity(), line.len(), "sized exactly, so no regrown copy is left behind");
        let mut guard = SecretRequest(request);
        let key_ptr = guard.0["payload"]["apiKey"].as_str().unwrap().as_ptr();
        // Zeroizing in place keeps the buffer, so the bytes it held are now zero.
        if let Some(Value::String(key)) = guard.0["payload"].as_object_mut().and_then(|p| p.get_mut("apiKey")) {
            key.zeroize();
        }
        let _ = key_ptr;
        assert!(guard.0["payload"]["apiKey"].as_str().unwrap().is_empty());
    }
}

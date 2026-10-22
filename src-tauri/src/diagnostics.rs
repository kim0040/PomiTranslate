//! Bounded, redacted diagnostics: a rotating log file under the app's local data directory, a ring of
//! the translation core's last stderr lines, Rust-side error records and a crash record from the
//! panic hook (SC-7, NX-1).
//!
//! What leaves the machine is decided here (H3). The support export (`bundle`, and the same text
//! for "copy diagnostics") never contains free text. It is made of structured records - versions,
//! platform, error codes with times, request types with durations and exit codes, counts - and of the
//! core's stderr lines, which are redacted as complete lines and then *classified*: only lines of a
//! known diagnostic shape survive (a Python traceback header, a frame reduced to a module-relative
//! path, an exception class name without its message, a line of our own logger). Every other line -
//! world text a library echoed, provider input, an unusual key - is replaced by a count
//! (`[n lines omitted]`). The same classification applies to the log file, so neither holds it.
use std::{
    backtrace::Backtrace,
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::error::IpcError;

const FILE_NAME: &str = "pomi-translate.log";
/// The log rolls over at this size and keeps `KEEP_FILES` files in total (the live one plus rotated).
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const KEEP_FILES: usize = 5;
/// Last core stderr entries (kept lines and omitted-line counts) in memory and in the export.
pub const STDERR_RING_LINES: usize = 200;
/// Error codes (with when and where they happened) kept for the diagnostics bundle.
const ERROR_RING_LINES: usize = 100;
const RUN_RING_LINES: usize = 100;
const CRASH_RING_LINES: usize = 20;
/// A single kept line never exceeds this many characters.
const MAX_LINE_CHARS: usize = 2000;
/// A line of our own logger is short by contract; longer ones are cut after redaction.
const MAX_LOG_LINE_CHARS: usize = 300;
/// The prefix the translation core puts on the lines of its own logger. Only these lines (and the
/// fixed shapes in `classify`) are kept from the core's output.
pub const CORE_LOG_PREFIX: &str = "[pomi] ";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    Kept(String),
    Omitted(usize),
}

impl Entry {
    fn render(&self) -> String {
        match self {
            Self::Kept(line) => line.clone(),
            Self::Omitted(1) => "[1 line omitted]".to_owned(),
            Self::Omitted(count) => format!("[{count} lines omitted]"),
        }
    }
}

#[derive(Default)]
struct CoreOutput {
    ring: VecDeque<Entry>,
    /// Omitted lines not yet noted in the log file (one marker is written for a run of them).
    pending_omitted: usize,
    kept_total: usize,
    omitted_total: usize,
}

#[derive(Default)]
pub struct Diagnostics {
    dir: Mutex<Option<PathBuf>>,
    core: Mutex<CoreOutput>,
    errors: Mutex<VecDeque<String>>,
    runs: Mutex<VecDeque<String>>,
    crashes: Mutex<VecDeque<String>>,
    home: Mutex<Option<String>>,
}

static GLOBAL: OnceLock<Diagnostics> = OnceLock::new();

pub fn global() -> &'static Diagnostics {
    GLOBAL.get_or_init(Diagnostics::default)
}

fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    // Civil date from the Unix timestamp (UTC), so no date dependency is needed for a log prefix.
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

const KEYWORDS: &[&str] = &[
    "bearer",
    "authorization",
    "apikey",
    "api_key",
    "api-key",
    "x-api-key",
    "x-goog-api-key",
    "password",
    "secret",
    "token",
];
const KEY_PREFIXES: &[&str] = &["sk-", "sk_", "aiza", "xai-", "gsk_", "pk-", "rk-", "or-v1"];

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn looks_like_key(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    if token.len() >= 10 && KEY_PREFIXES.iter().any(|prefix| lower.starts_with(prefix)) {
        return true;
    }
    token.len() >= 24
        && token.chars().any(|c| c.is_ascii_digit())
        && token.chars().any(|c| c.is_ascii_alphabetic())
}

/// A whitespace-delimited word that is one secret even though punctuation splits it into several
/// tokens (`sk-abc.def`, `abc123/DEF456+ghi789==`).
fn looks_like_key_word(word: &str) -> bool {
    let core = word.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if core.len() < 10 {
        return false;
    }
    let lower = core.to_ascii_lowercase();
    if KEY_PREFIXES.iter().any(|prefix| lower.starts_with(prefix)) {
        return true;
    }
    let secretish =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=' | '~');
    // A relative path made of ordinary words is not a secret; base64 (`+`, `=`) is.
    let pathlike = core.contains('/') && !core.contains(['+', '=']);
    core.len() >= 20
        && core.chars().all(secretish)
        && core.chars().any(|c| c.is_ascii_digit())
        && core.chars().any(|c| c.is_ascii_alphabetic())
        && !pathlike
}

/// Replace key-shaped text, values that follow a credential keyword, and the person's home folder.
/// The whole text is scanned, so a secret is never cut in half by a later clip.
pub fn redact(text: &str, home: Option<&str>) -> String {
    let mut text = text.to_owned();
    if let Some(home) = home.filter(|home| home.len() > 3) {
        text = text.replace(home, "~");
        text = text.replace(&home.replace('\\', "/"), "~");
    }
    // Whole words first: a secret that punctuation splits (`sk-abc.def`) is taken as one piece
    // before the token pass could replace only its first half.
    let text = redact_words(&text);
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    let mut redact_next = false;
    let flush = |token: &mut String, out: &mut String, redact_next: &mut bool| {
        if token.is_empty() {
            return;
        }
        if looks_like_key(token) || (*redact_next && token.len() >= 6) {
            out.push_str("[REDACTED]");
        } else {
            out.push_str(token);
        }
        *redact_next = KEYWORDS.contains(&token.to_ascii_lowercase().as_str());
        token.clear();
    };
    for c in text.chars() {
        if is_token_char(c) {
            token.push(c);
        } else {
            flush(&mut token, &mut out, &mut redact_next);
            out.push(c);
        }
    }
    flush(&mut token, &mut out, &mut redact_next);
    out
}

/// Characters that end a "word" for the second pass: whitespace and the punctuation that wraps a
/// value in log text (`key=(abc)`, `"abc"`, `[abc],`).
fn ends_word(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`' | ',' | ';' | '<' | '>' | '|'
        )
}

/// The part of a word after a leading `name=`, which is where a value would start. `abc==` (base64
/// padding) is not a name.
fn value_start(word: &str) -> usize {
    match word.find('=') {
        Some(at)
            if at > 0
                && word[..at]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                && word[at + 1..].chars().any(|c| c.is_ascii_alphanumeric()) =>
        {
            at + 1
        }
        _ => 0,
    }
}

/// Second pass over whole words: a secret that punctuation split into pieces the token pass let
/// through is replaced as one piece, keeping the punctuation around it.
fn redact_words(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if word.is_empty() {
            return;
        }
        let from = value_start(word);
        let value = &word[from..];
        if looks_like_key_word(value) {
            let start = value
                .find(|c: char| c.is_ascii_alphanumeric())
                .unwrap_or(value.len());
            let end = value
                .rfind(|c: char| c.is_ascii_alphanumeric())
                .map_or(start, |at| at + 1);
            out.push_str(&word[..from + start]);
            out.push_str("[REDACTED]");
            out.push_str(&value[end..]);
        } else {
            out.push_str(word);
        }
        word.clear();
    };
    for c in text.chars() {
        if ends_word(c) {
            flush(&mut word, &mut out);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// The stricter rule for the lines of our own logger, which are kept as text: any run of letters,
/// digits, `_` and `-` of ten or more characters that mixes letters and digits is replaced. Logger
/// lines carry short words, counts and names, so little is lost; an odd secret that no shape rule
/// knows still usually has this shape.
fn redact_mixed_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        let mixed = token.len() >= 10
            && token.chars().any(|c| c.is_ascii_digit())
            && token.chars().any(|c| c.is_ascii_alphabetic());
        out.push_str(if mixed { "[REDACTED]" } else { token });
        token.clear();
    };
    for c in text.chars() {
        if is_token_char(c) {
            token.push(c);
        } else {
            flush(&mut token, &mut out);
            out.push(c);
        }
    }
    flush(&mut token, &mut out);
    out
}

fn clip_to(line: &str, limit: usize) -> String {
    let single = line.replace(['\r', '\n'], " ");
    if single.chars().count() <= limit {
        return single;
    }
    let mut clipped: String = single.chars().take(limit).collect();
    clipped.push('…');
    clipped
}

fn clip(line: &str) -> String {
    clip_to(line, MAX_LINE_CHARS)
}

/// Letters, digits and `._:-` only, at most `limit` characters; anything else is not an identifier
/// and is replaced by `?`. Used for names that come from outside the shell (request types).
fn identifier(text: &str, limit: usize) -> String {
    let clean: String = text
        .chars()
        .take(limit)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-') {
                c
            } else {
                '?'
            }
        })
        .collect();
    if clean.is_empty() {
        "?".to_owned()
    } else {
        clean
    }
}

fn push_bounded(ring: &Mutex<VecDeque<String>>, line: String, cap: usize) {
    let mut ring = lock(ring);
    if ring.len() == cap {
        ring.pop_front();
    }
    ring.push_back(line);
}

// --- classification of the core's output ----------------------------------------------------------

const CHAIN_LINES: &[&str] = &[
    "During handling of the above exception, another exception occurred:",
    "The above exception was the direct cause of the following exception:",
];
const EXCEPTION_SUFFIXES: &[&str] = &["Error", "Exception", "Warning", "Exit", "Interrupt"];
const EXCEPTION_NAMES: &[&str] = &[
    "KeyboardInterrupt",
    "StopIteration",
    "StopAsyncIteration",
    "GeneratorExit",
    "SystemExit",
];
/// Fixed messages the core prints on stderr (`mwt/desktop_entry.py`); the tail after the colon is
/// restricted to identifier-like text.
const FIXED_PREFIXES: &[&str] = &[
    "preferences were not saved: ",
    "protocol message had values that were replaced: ",
];

/// A path reduced to the part that names our code or a library, never the person's folders.
fn module_relative(path: &str) -> String {
    let normal = path.replace('\\', "/");
    let parts: Vec<&str> = normal.split('/').filter(|part| !part.is_empty()).collect();
    let tail = |from: usize| parts[from..].join("/");
    let reduced = if let Some(at) = parts.iter().rposition(|part| *part == "_internal") {
        tail(at + 1)
    } else if let Some(at) = parts.iter().rposition(|part| *part == "site-packages") {
        format!("site-packages/{}", tail(at + 1))
    } else if let Some(at) = parts
        .iter()
        .rposition(|part| part.eq_ignore_ascii_case("lib") || part.starts_with("python3"))
        .filter(|at| *at + 1 < parts.len())
    {
        let skip = usize::from(parts[at + 1].starts_with("python3"));
        format!("stdlib/{}", tail(at + 1 + skip))
    } else if let Some(at) = parts
        .iter()
        .position(|part| matches!(*part, "mwt" | "packaging"))
    {
        tail(at)
    } else {
        parts.last().copied().unwrap_or("").to_owned()
    };
    let safe =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-' | '<' | '>' | ':');
    if !reduced.is_empty() && reduced.chars().all(safe) {
        reduced
    } else {
        // Whatever remains is not module-shaped; keep only the file name's safe characters.
        let name: String = parts
            .last()
            .copied()
            .unwrap_or("")
            .chars()
            .map(|c| if safe(c) { c } else { '?' })
            .collect();
        if name.is_empty() {
            "?".to_owned()
        } else {
            name
        }
    }
}

/// `File "<path>", line N, in fn` with the path reduced; the source line printed under it is not
/// a frame and falls through to "omitted".
fn parse_frame(line: &str) -> Option<String> {
    let rest = line.strip_prefix("File \"")?;
    let (path, tail) = rest.rsplit_once("\", line ")?;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 9 {
        return None;
    }
    let after = &tail[digits.len()..];
    let function = match after.strip_prefix(", in ") {
        Some(name) => {
            let name = name.trim_end();
            let valid = !name.is_empty()
                && name.len() <= 80
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '<' | '>'));
            if !valid {
                return None;
            }
            Some(name)
        }
        None if after.trim().is_empty() => None,
        None => return None,
    };
    let mut out = format!("File \"{}\", line {digits}", module_relative(path));
    if let Some(function) = function {
        out.push_str(", in ");
        out.push_str(function);
    }
    Some(out)
}

/// `ValueError: message` becomes `ValueError: [message omitted]`; only the class name is kept.
fn parse_exception(line: &str) -> Option<String> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let (name, message) = match line.split_once(':') {
        Some((name, message)) => (name, Some(message)),
        None => (line, None),
    };
    if message.is_some_and(|message| !message.is_empty() && !message.starts_with(' ')) {
        return None;
    }
    let last = name.rsplit('.').next().unwrap_or("");
    let identifier_like = !name.is_empty()
        && name.len() <= 100
        && name.split('.').all(|part| {
            !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
    let exception = last.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && (EXCEPTION_NAMES.contains(&last)
            || EXCEPTION_SUFFIXES
                .iter()
                .any(|suffix| last.ends_with(suffix)));
    if !identifier_like || !exception {
        return None;
    }
    Some(match message {
        Some(message) if !message.trim().is_empty() => format!("{name}: [message omitted]"),
        _ => name.to_owned(),
    })
}

/// The kept form of an already redacted line, or `None` when its shape is not a known diagnostic.
fn classify(line: &str) -> Option<String> {
    let line = line.trim_end();
    let trimmed = line.trim_start();
    if trimmed == "Traceback (most recent call last):" || CHAIN_LINES.contains(&trimmed) {
        return Some(trimmed.to_owned());
    }
    if let Some(frame) = parse_frame(trimmed) {
        return Some(format!("  {frame}"));
    }
    if let Some(exception) = parse_exception(line) {
        return Some(exception);
    }
    if let Some(rest) = line.strip_prefix(CORE_LOG_PREFIX) {
        // Redacted whole, then cut: a secret is never left half-visible by the limit.
        return Some(format!(
            "{CORE_LOG_PREFIX}{}",
            clip_to(&redact_mixed_tokens(rest), MAX_LOG_LINE_CHARS)
        ));
    }
    for prefix in FIXED_PREFIXES {
        if let Some(rest) = line.strip_prefix(prefix) {
            let plain = rest.chars().all(|c| {
                c.is_ascii_alphanumeric()
                    || matches!(c, '_' | '.' | ',' | '\'' | '[' | ']' | ' ' | '-')
            });
            if plain && rest.len() <= 200 {
                return Some(line.to_owned());
            }
        }
    }
    None
}

/// Where a line of the core's output came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stderr,
    /// Output on stdout that was not protocol traffic.
    StrayStdout,
}

impl Channel {
    fn tag(self) -> &'static str {
        match self {
            Self::Stderr => "CORE",
            Self::StrayStdout => "CORE-STDOUT",
        }
    }
}

/// One finished request to the core, as structured data.
pub struct RunRecord<'a> {
    pub request: &'a str,
    pub duration_ms: u128,
    /// `None` when the request succeeded, else the error code.
    pub error: Option<&'static str>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

impl Diagnostics {
    /// Start writing files under `<dir>` (created if needed).
    pub fn set_dir(&self, dir: PathBuf) {
        let _ = fs::create_dir_all(&dir);
        *lock(&self.dir) = Some(dir);
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok();
        *lock(&self.home) = home;
    }

    fn scrub(&self, text: &str) -> String {
        clip(&redact(text, lock(&self.home).as_deref()))
    }

    fn append(&self, line: &str) {
        let Some(dir) = lock(&self.dir).clone() else {
            return;
        };
        let path = dir.join(FILE_NAME);
        if fs::metadata(&path).is_ok_and(|meta| meta.len() >= MAX_FILE_BYTES) {
            rotate(&dir);
        }
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(file, "{line}");
        }
    }

    /// One Rust-side event or error, for the local log file only: the export never carries it.
    pub fn log(&self, level: &str, source: &str, message: &str) {
        let line = format!("{} {level} {source} {}", timestamp(), self.scrub(message));
        self.append(&line);
    }

    pub fn log_error(&self, source: &str, error: &IpcError) {
        let detail = error.detail.map(|d| format!(" ({d})")).unwrap_or_default();
        self.log(
            "ERROR",
            source,
            &format!("{}{detail}: {}", error.code, error.message),
        );
        // The code alone (no message text) is what the export lists, so it cannot carry free text.
        push_bounded(
            &self.errors,
            format!(
                "{} {} {}{detail}",
                timestamp(),
                identifier(source, 64),
                error.code
            ),
            ERROR_RING_LINES,
        );
    }

    /// A line the translation core wrote to stderr.
    pub fn core_stderr(&self, line: &str) {
        self.core_line(Channel::Stderr, line);
    }

    /// A stdout line of the core that was not protocol traffic.
    pub fn core_stray_stdout(&self, line: &str) {
        self.core_line(Channel::StrayStdout, line);
    }

    /// The complete line is redacted first, then classified; only a known shape is kept and the rest
    /// is counted (H3).
    pub fn core_line(&self, channel: Channel, line: &str) {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            return;
        }
        let redacted = redact(line, lock(&self.home).as_deref());
        let mut core = lock(&self.core);
        match classify(&redacted) {
            Some(kept) => {
                let kept = clip(&kept);
                self.write_omitted_marker(&mut core);
                core.kept_total += 1;
                if core.ring.len() == STDERR_RING_LINES {
                    core.ring.pop_front();
                }
                core.ring.push_back(Entry::Kept(kept.clone()));
                self.append(&format!("{} {} {kept}", timestamp(), channel.tag()));
            }
            None => Self::note_omitted(&mut core),
        }
    }

    /// A line of the core's output that was dropped without being looked at (too long to be a
    /// diagnostic line).
    pub fn core_stderr_omitted(&self) {
        Self::note_omitted(&mut lock(&self.core));
    }

    fn note_omitted(core: &mut CoreOutput) {
        core.omitted_total += 1;
        core.pending_omitted += 1;
        match core.ring.back_mut() {
            Some(Entry::Omitted(count)) => *count += 1,
            _ => {
                if core.ring.len() == STDERR_RING_LINES {
                    core.ring.pop_front();
                }
                core.ring.push_back(Entry::Omitted(1));
            }
        }
    }

    fn write_omitted_marker(&self, core: &mut CoreOutput) {
        if core.pending_omitted > 0 {
            let marker = Entry::Omitted(core.pending_omitted).render();
            self.append(&format!("{} CORE {marker}", timestamp()));
            core.pending_omitted = 0;
        }
    }

    /// The core's output for this request ended: note the lines omitted since the last kept one.
    pub fn end_core_output(&self) {
        let mut core = lock(&self.core);
        self.write_omitted_marker(&mut core);
    }

    /// A finished request, as structured fields.
    pub fn core_run(&self, run: &RunRecord<'_>) {
        let number = |value: Option<i32>| value.map_or("none".to_owned(), |v| v.to_string());
        push_bounded(
            &self.runs,
            format!(
                "{} request={} duration_ms={} result={} exit_code={} signal={}",
                timestamp(),
                identifier(run.request, 48),
                run.duration_ms,
                run.error.unwrap_or("ok"),
                number(run.exit_code),
                number(run.signal),
            ),
            RUN_RING_LINES,
        );
    }

    /// A panic: the full (redacted) record goes to the log file; the export only learns that it
    /// happened and where in the shell's code.
    pub fn crash(&self, location: &str, detail: &str) {
        self.append(&format!(
            "{} CRASH {}",
            timestamp(),
            self.scrub(&format!("panic at {location}: {detail}"))
        ));
        push_bounded(
            &self.crashes,
            format!("{} panic at {}", timestamp(), module_relative(location)),
            CRASH_RING_LINES,
        );
    }

    /// Text for "copy diagnostics": the same content as the exported bundle.
    pub fn snapshot(&self) -> String {
        self.bundle(env!("CARGO_PKG_VERSION"))
    }

    /// The diagnostics export. No key, request, reply, world text or message text is ever put
    /// here: see the module comment for what it is made of.
    pub fn bundle(&self, app_version: &str) -> String {
        let mut text = format!(
            "PomiTranslate diagnostics\ngenerated: {}\napp version: {}\nbuild: {} ({})\nplatform: {} {}\n\n",
            timestamp(),
            identifier(app_version, 40),
            crate::BUILD_SHA,
            crate::BUILD_DATE,
            std::env::consts::OS,
            std::env::consts::ARCH,
        );
        let section = |text: &mut String, title: &str, ring: &Mutex<VecDeque<String>>| {
            text.push_str(&format!("-- {title} --\n"));
            for line in lock(ring).iter() {
                text.push_str(line);
                text.push('\n');
            }
            text.push('\n');
        };
        section(&mut text, "error codes (newest last)", &self.errors);
        section(
            &mut text,
            "translation core requests (newest last)",
            &self.runs,
        );
        section(&mut text, "crashes", &self.crashes);
        let core = lock(&self.core);
        text.push_str(&format!(
            "-- translation core stderr (known diagnostic shapes only; last {STDERR_RING_LINES} entries) --\n"
        ));
        for entry in core.ring.iter() {
            text.push_str(&entry.render());
            text.push('\n');
        }
        text.push_str(&format!(
            "\n-- counts --\ncore lines kept: {}\ncore lines omitted: {}\nerror records: {}\nrequests: {}\n",
            core.kept_total,
            core.omitted_total,
            lock(&self.errors).len(),
            lock(&self.runs).len(),
        ));
        text
    }

    #[cfg(test)]
    pub fn stderr_lines(&self) -> Vec<String> {
        lock(&self.core).ring.iter().map(Entry::render).collect()
    }

    #[cfg(test)]
    pub fn reset(&self) {
        *lock(&self.core) = CoreOutput::default();
        lock(&self.errors).clear();
        lock(&self.runs).clear();
        lock(&self.crashes).clear();
        *lock(&self.dir) = None;
        *lock(&self.home) = None;
    }

    #[cfg(test)]
    pub fn log_file_text(&self) -> String {
        let Some(dir) = lock(&self.dir).clone() else {
            return String::new();
        };
        let files = std::iter::once(dir.join(FILE_NAME))
            .chain((1..KEEP_FILES).map(|n| dir.join(format!("{FILE_NAME}.{n}"))));
        files
            .filter_map(|path| fs::read_to_string(path).ok())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// `pomi-diagnostics-YYYYMMDD.txt`, the suggested name of the exported bundle.
pub fn bundle_file_name() -> String {
    format!(
        "pomi-diagnostics-{}.txt",
        timestamp()[..10].replace('-', "")
    )
}

/// `pomi-translate.log.1` is the newest rotated file, `.4` the oldest; the oldest is dropped.
fn rotate(dir: &Path) {
    let numbered = |n: usize| dir.join(format!("{FILE_NAME}.{n}"));
    let _ = fs::remove_file(numbered(KEEP_FILES - 1));
    for n in (1..KEEP_FILES - 1).rev() {
        let _ = fs::rename(numbered(n), numbered(n + 1));
    }
    let _ = fs::rename(dir.join(FILE_NAME), numbered(1));
}

/// A panic is written to the log (redacted, with a backtrace) before the previous hook runs.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_default();
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let backtrace = Backtrace::force_capture().to_string().replace('\n', " | ");
        global().crash(&location, &format!("{message} | {backtrace}"));
        previous(info);
    }));
}

/// Test-only: tests that read the process-wide instance take turns.
#[cfg(test)]
pub fn serial() -> MutexGuard<'static, ()> {
    static TURN: Mutex<()> = Mutex::new(());
    lock(&TURN)
}

#[cfg(test)]
mod tests;

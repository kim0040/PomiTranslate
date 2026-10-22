//! Bounded, redacted diagnostics: a rotating log file under the app's local data directory, a ring of
//! the translation core's last stderr lines, Rust-side error records and a crash record from the
//! panic hook (SC-7, NX-1). Nothing here ever receives a stored API key; on top of that every line is
//! scrubbed for key-shaped text before it is kept, so a provider error echoing a key cannot land in a
//! file the person might send to support.
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
/// Last core stderr lines kept in memory and offered with "copy diagnostics".
pub const STDERR_RING_LINES: usize = 200;
const EVENT_RING_LINES: usize = 100;
/// Error codes (with when and where they happened) kept for the diagnostics bundle.
const ERROR_RING_LINES: usize = 100;
/// How much of the rotated log files the bundle carries (the newest part).
const LOG_TAIL_LINES: usize = 200;
/// A single kept line never exceeds this many characters.
const MAX_LINE_CHARS: usize = 2000;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Default)]
pub struct Diagnostics {
    dir: Mutex<Option<PathBuf>>,
    stderr: Mutex<VecDeque<String>>,
    events: Mutex<VecDeque<String>>,
    errors: Mutex<VecDeque<String>>,
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

/// Replace key-shaped text, values that follow a credential keyword, and the person's home folder.
pub fn redact(text: &str, home: Option<&str>) -> String {
    let mut text = text.to_owned();
    if let Some(home) = home.filter(|home| home.len() > 3) {
        text = text.replace(home, "~");
        text = text.replace(&home.replace('\\', "/"), "~");
    }
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

fn clip(line: &str) -> String {
    let single = line.replace(['\r', '\n'], " ");
    if single.chars().count() <= MAX_LINE_CHARS {
        return single;
    }
    let mut clipped: String = single.chars().take(MAX_LINE_CHARS).collect();
    clipped.push('…');
    clipped
}

fn push_bounded(ring: &Mutex<VecDeque<String>>, line: String, cap: usize) {
    let mut ring = lock(ring);
    if ring.len() == cap {
        ring.pop_front();
    }
    ring.push_back(line);
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

    /// One Rust-side event or error.
    pub fn log(&self, level: &str, source: &str, message: &str) {
        let line = format!("{} {level} {source} {}", timestamp(), self.scrub(message));
        push_bounded(&self.events, line.clone(), EVENT_RING_LINES);
        self.append(&line);
    }

    pub fn log_error(&self, source: &str, error: &IpcError) {
        let detail = error.detail.map(|d| format!(" ({d})")).unwrap_or_default();
        self.log(
            "ERROR",
            source,
            &format!("{}{detail}: {}", error.code, error.message),
        );
        // The code alone (no message text) is what the bundle lists, so it cannot carry free text.
        push_bounded(
            &self.errors,
            format!("{} {} {}{detail}", timestamp(), clip(source), error.code),
            ERROR_RING_LINES,
        );
    }

    /// A line the translation core wrote to stderr.
    pub fn core_stderr(&self, line: &str) {
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        let kept = self.scrub(line);
        push_bounded(&self.stderr, kept.clone(), STDERR_RING_LINES);
        self.append(&format!("{} CORE {kept}", timestamp()));
    }

    pub fn crash(&self, message: &str) {
        let record = format!("{} CRASH {}", timestamp(), self.scrub(message));
        push_bounded(&self.events, record.clone(), EVENT_RING_LINES);
        self.append(&record);
    }

    /// Text for "copy diagnostics": versions, platform, recent events and the core's last stderr.
    pub fn snapshot(&self) -> String {
        let mut text = format!(
            "PomiTranslate {} (build {}, {})\nplatform: {} {}\n\n-- recent events --\n",
            env!("CARGO_PKG_VERSION"),
            crate::BUILD_SHA,
            crate::BUILD_DATE,
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        for line in lock(&self.events).iter() {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("\n-- translation core stderr (last lines) --\n");
        for line in lock(&self.stderr).iter() {
            text.push_str(line);
            text.push('\n');
        }
        text
    }

    /// The diagnostics bundle: what "copy diagnostics" shows plus the error codes with their times and
    /// the tail of the rotated log. Everything is scrubbed again on the way out, so a line that
    /// reached a log file before a redaction rule existed is still cleaned. No key, request, reply or
    /// world text is ever collected here.
    pub fn bundle(&self, app_version: &str) -> String {
        let mut text = format!(
            "PomiTranslate diagnostics\ngenerated: {}\napp version: {app_version}\nbuild: {} ({})\nplatform: {} {}\n\n",
            timestamp(),
            crate::BUILD_SHA,
            crate::BUILD_DATE,
            std::env::consts::OS,
            std::env::consts::ARCH,
        );
        text.push_str("-- error codes (newest last) --\n");
        for line in lock(&self.errors).iter() {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("\n-- recent events --\n");
        for line in lock(&self.events).iter() {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("\n-- translation core stderr (last 200 lines) --\n");
        for line in lock(&self.stderr).iter() {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("\n-- log tail --\n");
        for line in self.log_tail(LOG_TAIL_LINES) {
            text.push_str(&self.scrub(&line));
            text.push('\n');
        }
        text
    }

    /// The newest `count` lines across the live log and its rotated files.
    fn log_tail(&self, count: usize) -> Vec<String> {
        let Some(dir) = lock(&self.dir).clone() else {
            return vec![];
        };
        let mut newest_first: Vec<String> = Vec::new();
        let files = std::iter::once(dir.join(FILE_NAME))
            .chain((1..KEEP_FILES).map(|n| dir.join(format!("{FILE_NAME}.{n}"))));
        for path in files {
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            newest_first.extend(content.lines().rev().map(str::to_owned));
            if newest_first.len() >= count {
                break;
            }
        }
        newest_first.truncate(count);
        newest_first.reverse();
        newest_first
    }

    #[cfg(test)]
    pub fn stderr_lines(&self) -> Vec<String> {
        lock(&self.stderr).iter().cloned().collect()
    }

    #[cfg(test)]
    pub fn reset(&self) {
        lock(&self.stderr).clear();
        lock(&self.events).clear();
        lock(&self.errors).clear();
        *lock(&self.dir) = None;
        *lock(&self.home) = None;
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
        global().crash(&format!("panic at {location}: {message} | {backtrace}"));
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_shaped_text_and_values_after_credential_words_are_redacted() {
        let text = "request failed: Bearer abcDEF123456789 key sk-or-v1-0123456789abcdef0123 \
                    AIzaSyA1234567890123456789012345 x-api-key: hunter2hunter2 \
                    token=short 12345678901234567890abcdefghij";
        let clean = redact(text, None);
        for secret in [
            "abcDEF123456789",
            "sk-or-v1-0123456789abcdef0123",
            "AIzaSyA1234567890123456789012345",
            "hunter2hunter2",
            "12345678901234567890abcdefghij",
        ] {
            assert!(!clean.contains(secret), "{secret} leaked: {clean}");
        }
        assert!(clean.contains("request failed"), "{clean}");
        assert!(
            clean.contains("token=short"),
            "short values stay readable: {clean}"
        );
    }

    #[test]
    fn ordinary_words_numbers_and_the_home_folder_are_handled() {
        let clean = redact(
            "Scanning C:\\Users\\kim\\Worlds\\Roguefire: 12 files, region r.0.0.mca",
            Some("C:\\Users\\kim"),
        );
        assert_eq!(
            clean,
            "Scanning ~\\Worlds\\Roguefire: 12 files, region r.0.0.mca"
        );
    }

    #[test]
    fn long_lines_are_clipped_and_newlines_flattened() {
        let line = clip(&format!("a\nb{}", "x".repeat(5000)));
        assert!(line.chars().count() <= MAX_LINE_CHARS + 1);
        assert!(!line.contains('\n'));
    }

    #[test]
    fn the_stderr_ring_keeps_only_the_last_lines_and_redacts() {
        let diag = Diagnostics::default();
        for n in 0..(STDERR_RING_LINES + 25) {
            diag.core_stderr(&format!("line {n}"));
        }
        diag.core_stderr("provider said: Bearer sk-live-00112233445566778899");
        let lines = diag.stderr_lines();
        assert_eq!(lines.len(), STDERR_RING_LINES);
        assert_eq!(lines[0], "line 26");
        assert!(
            !lines.last().unwrap().contains("sk-live"),
            "{}",
            lines.last().unwrap()
        );
        assert!(diag.snapshot().contains("line 30"));
    }

    #[test]
    fn the_log_file_rotates_at_the_size_limit_and_keeps_five_files() {
        let dir = tempfile::tempdir().unwrap();
        let diag = Diagnostics::default();
        diag.set_dir(dir.path().to_path_buf());
        let line = "x".repeat(1500);
        for _ in 0..(MAX_FILE_BYTES as usize / 1500 * 7) {
            diag.core_stderr(&line);
        }
        let mut names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "pomi-translate.log",
                "pomi-translate.log.1",
                "pomi-translate.log.2",
                "pomi-translate.log.3",
                "pomi-translate.log.4"
            ]
        );
        for name in &names {
            let size = fs::metadata(dir.path().join(name)).unwrap().len();
            assert!(size <= MAX_FILE_BYTES + 2000, "{name} is {size} bytes");
        }
    }

    #[test]
    fn the_bundle_lists_error_codes_with_times_the_log_tail_and_no_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let diag = Diagnostics::default();
        diag.set_dir(dir.path().to_path_buf());
        diag.log_error(
            "core:scan.start",
            &IpcError::new(
                "CORE_CRASHED",
                "exit 3 while holding sk-abcdef0123456789abcdef",
            ),
        );
        diag.core_stderr("Traceback: provider echoed Bearer sk-live-00112233445566778899");
        // A line written to the file before a rule existed is cleaned when the bundle is made.
        fs::write(
            dir.path().join(FILE_NAME),
            "2026-01-01T00:00:00Z INFO app token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1\nsecond line\n",
        )
        .unwrap();
        let bundle = diag.bundle("9.9.9");
        assert!(bundle.contains("app version: 9.9.9"));
        assert!(bundle.contains(&format!("build: {}", crate::BUILD_SHA)));
        assert!(bundle.contains("platform: "));
        assert!(bundle.contains("core:scan.start CORE_CRASHED"), "{bundle}");
        assert!(bundle.contains("second line"));
        assert!(bundle.contains("-- translation core stderr (last 200 lines) --"));
        for secret in [
            "sk-abcdef0123456789abcdef",
            "sk-live-00112233445566778899",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
        ] {
            assert!(!bundle.contains(secret), "{secret} leaked:\n{bundle}");
        }
        // The error list carries codes and times, never the message text.
        let errors = bundle.split("-- recent events --").next().unwrap();
        assert!(!errors.contains("exit 3"), "{errors}");
    }

    #[test]
    fn the_suggested_bundle_name_is_dated_text() {
        let name = bundle_file_name();
        assert!(
            name.starts_with("pomi-diagnostics-") && name.ends_with(".txt"),
            "{name}"
        );
        assert_eq!(name.len(), "pomi-diagnostics-20261023.txt".len());
    }

    #[test]
    fn a_crash_record_lands_in_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let diag = Diagnostics::default();
        diag.set_dir(dir.path().to_path_buf());
        diag.crash("panic at lib.rs:1: boom with key sk-abcdef0123456789abcdef");
        let log = fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(log.contains("CRASH") && log.contains("boom"));
        assert!(!log.contains("sk-abcdef0123456789abcdef"));
    }
}

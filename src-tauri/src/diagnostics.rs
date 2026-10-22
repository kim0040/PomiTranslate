//! Bounded diagnostics: a rotating log file under the app's local data directory, a ring of the
//! translation core's last stderr lines, Rust-side error records and a crash record from the panic
//! hook (SC-7, NX-1).
//!
//! No free text, by construction (R1). Nothing a person, a provider, a world or a library wrote can
//! reach the log file or the support export, because nothing here copies text through:
//!
//! * Rust's own events are a compile-time message (`&'static str`) with a source *component* from a
//!   fixed list and numbers. Errors are logged by their stable code only, never by their message.
//!   A renderer-supplied request type is logged only when it is in the known request list, else it is
//!   `[unknown request]`.
//! * The core's stderr and stray stdout are *classified* line by line, and a line is rebuilt from
//!   known pieces only: the traceback header, a frame whose file is one of our own modules (any other
//!   frame is `[frame]`), an exception class from an allow-list (any other is `[exception]`, and the
//!   message is always `[message omitted]`), and three fixed notices. Every other `[pomi] ` line is
//!   `[pomi] [message omitted]`; every other line is only counted (`[n lines omitted]`).
//!
//! The support export (`bundle`, and the same text for "copy diagnostics") is made of these records,
//! versions, platform, codes with times, request types with durations and exit codes, and counts. The
//! log file holds the same kinds of records.
use std::{
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
/// The prefix the translation core puts on the lines of its own logger. The text after it is never
/// kept (except one fixed sentence, see `classify`).
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
/// and is replaced by `?`. Used for the app's own version string.
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

/// The components that write to the log. Anything else is `[component]`.
const COMPONENTS: &[&str] = &[
    "app",
    "core",
    "credentials",
    "credential_import",
    "credential_reset_storage",
    "native_reset",
    "sidecar_request",
    "update_check",
    "update_install",
    "force_stop_active",
    "navigation",
];
/// Non-request parts a source may carry after the component.
const SUB_SOURCES: &[&str] = &["ledger", "bootstrap"];

/// A request type as it may be written: only a type of the known request list, else
/// `[unknown request]` (the type may come from the page, which is not trusted with the log).
fn request_label(request: &str) -> &str {
    if crate::ALLOWED_REQUESTS.contains(&request) {
        request
    } else {
        "[unknown request]"
    }
}

/// `component` or `component:part`, reduced to known names.
fn source_label(source: &str) -> String {
    let (component, part) = match source.split_once(':') {
        Some((component, part)) => (component, Some(part)),
        None => (source, None),
    };
    let component = if COMPONENTS.contains(&component) {
        component
    } else {
        "[component]"
    };
    match part {
        None => component.to_owned(),
        Some(part) if SUB_SOURCES.contains(&part) => format!("{component}:{part}"),
        Some(part) => format!("{component}:{}", request_label(part)),
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
const TRACEBACK_HEADER: &str = "Traceback (most recent call last):";
/// The one `[pomi] ` sentence that is kept as it is (`mwt/desktop_entry.py`): the whole line, nothing
/// before or after it.
const STDIN_CLOSED_LINE: &str = "stdin closed while a request was running; cancelling";
/// The other two fixed notices the core prints on stderr (`mwt/desktop_entry.py`).
const PREFS_NOT_SAVED: &str = "preferences were not saved";
const VALUES_REPLACED: &str = "protocol message had values that were replaced";
/// The flag names `_plain()` in `mwt/desktop_entry.py` can put in `values that were replaced`.
const REPLACED_FLAGS: &[&str] = &["non_finite_number"];

/// The core's own source files, as `module_relative` writes them: `mwt/*.py` and the three modules
/// next to it. A frame in any other file (a library, the standard library, anything unknown) is
/// reported as `[frame]`. `tests::the_module_list_covers_the_core_sources` keeps this list in step
/// with the Python tree.
const CORE_MODULES: &[&str] = &[
    "mwt/__init__.py",
    "mwt/__main__.py",
    "mwt/backup_admin.py",
    "mwt/desktop_entry.py",
    "mwt/desktop_legacy_import.py",
    "mwt/desktop_prompt.py",
    "mwt/desktop_provider.py",
    "mwt/desktop_resource_packs.py",
    "mwt/desktop_settings.py",
    "mwt/desktop_usage.py",
    "mwt/discovery.py",
    "mwt/durable.py",
    "mwt/extract.py",
    "mwt/journal.py",
    "mwt/layout.py",
    "mwt/locking.py",
    "mwt/nbtio.py",
    "mwt/notices.py",
    "mwt/reasoning.py",
    "mwt/region.py",
    "mwt/review_drafts.py",
    "mwt/safety.py",
    "mwt/secrets.py",
    "mwt/snbt.py",
    "mwt/support_matrix.py",
    "mwt/tokens.py",
    "mwt/userdata.py",
    "mc_world_translator.py",
    "llm_backends.py",
    "webui_server.py",
];

/// Python's built-in exception classes (printed without a module).
const BUILTIN_EXCEPTIONS: &[&str] = &[
    "BaseException",
    "BaseExceptionGroup",
    "Exception",
    "ExceptionGroup",
    "ArithmeticError",
    "AssertionError",
    "AttributeError",
    "BlockingIOError",
    "BrokenPipeError",
    "BufferError",
    "ChildProcessError",
    "ConnectionAbortedError",
    "ConnectionError",
    "ConnectionRefusedError",
    "ConnectionResetError",
    "EOFError",
    "EncodingWarning",
    "EnvironmentError",
    "FileExistsError",
    "FileNotFoundError",
    "FloatingPointError",
    "GeneratorExit",
    "IOError",
    "ImportError",
    "IndentationError",
    "IndexError",
    "InterruptedError",
    "IsADirectoryError",
    "KeyError",
    "KeyboardInterrupt",
    "LookupError",
    "MemoryError",
    "ModuleNotFoundError",
    "NameError",
    "NotADirectoryError",
    "NotImplementedError",
    "OSError",
    "OverflowError",
    "PermissionError",
    "ProcessLookupError",
    "PythonFinalizationError",
    "RecursionError",
    "ReferenceError",
    "ResourceWarning",
    "RuntimeError",
    "RuntimeWarning",
    "StopAsyncIteration",
    "StopIteration",
    "SyntaxError",
    "SystemError",
    "SystemExit",
    "TabError",
    "TimeoutError",
    "TypeError",
    "UnboundLocalError",
    "UnicodeDecodeError",
    "UnicodeEncodeError",
    "UnicodeError",
    "UnicodeTranslateError",
    "UserWarning",
    "ValueError",
    "Warning",
    "ZeroDivisionError",
];

/// The exception classes the core's own modules define (found with `class X(...)` in `mwt/`,
/// `mc_world_translator.py`, `llm_backends.py` and `webui_server.py`; kept in step by
/// `tests::the_exception_list_covers_the_core_sources`). Python prints them bare or as
/// `<module>.<Class>`.
const CORE_EXCEPTIONS: &[&str] = &[
    "BackupAdminError",
    "BackupError",
    "ChunkTooLarge",
    "CommittedWriteError",
    "DiskFull",
    "ExternalPackUnavailable",
    "ExternalTargetError",
    "JournalError",
    "JournalWriteFailed",
    "MinecraftWorldInUse",
    "ModelCatalogError",
    "NbtError",
    "PlanInvalidated",
    "ProviderError",
    "ProviderUnavailable",
    "RegionError",
    "RegionLayoutUnsafe",
    "ReviewDraftError",
    "SnbtError",
    "TargetChanged",
    "TargetLocked",
    "TranslationCancelled",
    "UnsupportedCompression",
    "UsageUnavailable",
    "WorldChanged",
    "WorldWriteLocked",
    "_DeadlineExceeded",
];

/// Standard-library exception classes that reach the core's tracebacks with their module name.
const STDLIB_EXCEPTIONS: &[&str] = &[
    "json.decoder.JSONDecodeError",
    "urllib.error.URLError",
    "urllib.error.HTTPError",
    "http.client.HTTPException",
    "http.client.RemoteDisconnected",
    "ssl.SSLError",
    "sqlite3.Error",
    "sqlite3.OperationalError",
    "zipfile.BadZipFile",
    "subprocess.CalledProcessError",
    "subprocess.TimeoutExpired",
    "concurrent.futures.TimeoutError",
    "asyncio.CancelledError",
    "queue.Empty",
];

/// A class in the allow-list: a built-in, a class of the core's own modules (bare, or behind the
/// dotted name of one of those modules), or one of the listed standard-library classes.
fn allowed_exception(name: &str) -> bool {
    if BUILTIN_EXCEPTIONS.contains(&name)
        || CORE_EXCEPTIONS.contains(&name)
        || STDLIB_EXCEPTIONS.contains(&name)
    {
        return true;
    }
    let Some((module, class)) = name.rsplit_once('.') else {
        return false;
    };
    CORE_EXCEPTIONS.contains(&class)
        && CORE_MODULES.iter().any(|file| {
            file.strip_suffix(".py")
                .is_some_and(|stem| stem.replace('/', ".") == module)
        })
}

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

/// A Python function name as it prints in a frame: identifiers (dotted for a qualified name) or one
/// of the synthetic `<...>` names.
fn python_function(name: &str) -> bool {
    const SYNTHETIC: &[&str] = &[
        "<module>",
        "<lambda>",
        "<listcomp>",
        "<dictcomp>",
        "<setcomp>",
        "<genexpr>",
    ];
    SYNTHETIC.contains(&name)
        || (!name.is_empty()
            && name.len() <= 80
            && name.split('.').all(|part| {
                let mut chars = part.chars();
                chars
                    .next()
                    .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            }))
}

/// `File "<path>", line N, in fn`: kept (path reduced) only when the file is one of our modules and
/// the function name is an identifier; any other frame is `[frame]`. `None` when the line is not a
/// frame at all (the source line printed under a frame is not one and is only counted).
fn parse_frame(line: &str) -> Option<String> {
    let rest = line.strip_prefix("File \"")?;
    let (path, tail) = rest.rsplit_once("\", line ")?;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 9 {
        return None;
    }
    let after = &tail[digits.len()..];
    let function = match after.strip_prefix(", in ") {
        Some(name) => Some(name.trim_end()),
        None if after.trim().is_empty() => None,
        None => return None,
    };
    let file = module_relative(path);
    if !CORE_MODULES.contains(&file.as_str()) || function.is_some_and(|name| !python_function(name))
    {
        return Some("[frame]".to_owned());
    }
    let mut out = format!("File \"{file}\", line {digits}");
    if let Some(function) = function {
        out.push_str(", in ");
        out.push_str(function);
    }
    Some(out)
}

/// `ValueError: message` becomes `ValueError: [message omitted]`; an exception class that is not in
/// the allow-list is `[exception]`. The message is never kept.
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
    // The shape of an exception line; whether the class is a known one is decided separately.
    const SUFFIXES: &[&str] = &["Error", "Exception", "Warning", "Exit", "Interrupt"];
    const SHAPED_NAMES: &[&str] = &[
        "KeyboardInterrupt",
        "StopIteration",
        "StopAsyncIteration",
        "GeneratorExit",
        "SystemExit",
    ];
    let exception = last.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && (SHAPED_NAMES.contains(&last) || SUFFIXES.iter().any(|suffix| last.ends_with(suffix)));
    if !identifier_like || !exception {
        return None;
    }
    let shown = if allowed_exception(name) {
        name
    } else {
        "[exception]"
    };
    Some(match message {
        Some(message) if !message.trim().is_empty() => format!("{shown}: [message omitted]"),
        _ => shown.to_owned(),
    })
}

/// `preferences were not saved: <X>`: the class name only when it is an allow-listed exception.
fn parse_prefs_not_saved(body: &str) -> Option<String> {
    let rest = body.strip_prefix(PREFS_NOT_SAVED)?;
    if rest.is_empty() {
        return Some(PREFS_NOT_SAVED.to_owned());
    }
    let class = rest.strip_prefix(": ")?;
    Some(if allowed_exception(class) {
        format!("{PREFS_NOT_SAVED}: {class}")
    } else {
        PREFS_NOT_SAVED.to_owned()
    })
}

/// `protocol message had values that were replaced: ['non_finite_number']`: the list only when every
/// item is a flag name the core can produce.
fn parse_values_replaced(body: &str) -> Option<String> {
    let rest = body.strip_prefix(VALUES_REPLACED)?;
    if rest.is_empty() {
        return Some(VALUES_REPLACED.to_owned());
    }
    let list = rest.strip_prefix(": [")?.strip_suffix(']')?;
    let all_known = list
        .split(", ")
        .filter(|item| !item.is_empty())
        .all(|item| {
            item.strip_prefix('\'')
                .and_then(|item| item.strip_suffix('\''))
                .is_some_and(|name| REPLACED_FLAGS.contains(&name))
        });
    Some(if all_known {
        format!("{VALUES_REPLACED}: [{list}]")
    } else {
        VALUES_REPLACED.to_owned()
    })
}

/// The kept form of a line of the core's output, or `None` when its shape is not a known diagnostic
/// (it is then only counted). The result is built from known pieces; nothing of the input text
/// beyond them is copied.
fn classify(line: &str) -> Option<String> {
    let line = line.trim_end();
    let (prefixed, body) = match line.strip_prefix(CORE_LOG_PREFIX) {
        Some(body) => (true, body),
        None => (false, line),
    };
    if prefixed && body == STDIN_CLOSED_LINE {
        return Some(line.to_owned());
    }
    if let Some(notice) = parse_prefs_not_saved(body).or_else(|| parse_values_replaced(body)) {
        return Some(if prefixed {
            format!("{CORE_LOG_PREFIX}{notice}")
        } else {
            notice
        });
    }
    if prefixed {
        return Some(format!("{CORE_LOG_PREFIX}[message omitted]"));
    }
    let trimmed = line.trim_start();
    if trimmed == TRACEBACK_HEADER || CHAIN_LINES.contains(&trimmed) {
        return Some(trimmed.to_owned());
    }
    if let Some(frame) = parse_frame(trimmed) {
        return Some(format!("  {frame}"));
    }
    parse_exception(line)
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

    /// One Rust-side event, for the local log file only. The message is a compile-time constant, so
    /// no runtime text can reach the file through it; `source` is reduced to a known component.
    pub fn log(&self, level: &'static str, source: &str, message: &'static str) {
        self.log_with(level, source, message, None, &[]);
    }

    /// [`Self::log`] with the request type (written only when it is a known one) and numbers.
    pub fn log_with(
        &self,
        level: &'static str,
        source: &str,
        message: &'static str,
        request: Option<&str>,
        numbers: &[(&'static str, i64)],
    ) {
        let mut line = format!("{} {level} {} {message}", timestamp(), source_label(source));
        if let Some(request) = request {
            line.push_str(&format!(" request={}", request_label(request)));
        }
        for (name, value) in numbers {
            line.push_str(&format!(" {name}={value}"));
        }
        self.append(&line);
    }

    /// An error by its stable code (and detail code) only: its message is free text and is never
    /// written, neither to the file nor to the export.
    pub fn log_error(&self, source: &str, error: &IpcError) {
        let detail = error.detail.map(|d| format!(" ({d})")).unwrap_or_default();
        let source = source_label(source);
        self.append(&format!(
            "{} ERROR {source} {}{detail}",
            timestamp(),
            error.code
        ));
        push_bounded(
            &self.errors,
            format!("{} {source} {}{detail}", timestamp(), error.code),
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
                request_label(run.request),
                run.duration_ms,
                run.error.unwrap_or("ok"),
                number(run.exit_code),
                number(run.signal),
            ),
            RUN_RING_LINES,
        );
    }

    /// A panic: only its place in the shell's code (a compile-time `file:line`) is recorded, in the
    /// log file and in the export. The panic message and the backtrace are free text and are not.
    pub fn crash(&self, location: &str) {
        let place = module_relative(location);
        self.append(&format!("{} CRASH panic at {place}", timestamp()));
        push_bounded(
            &self.crashes,
            format!("{} panic at {place}", timestamp()),
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

/// A panic is recorded (where, nothing more) before the previous hook runs.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_default();
        global().crash(&location);
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

use super::*;

/// Strings that look like what a person might paste as a Custom provider key: no vendor prefix,
/// odd characters, and spelled so the shape rules may or may not catch them.
const CUSTOM_KEYS: &[&str] = &[
    "Zq9xK2mP7vL4nR8tB3wY5cH1dF6gJ0aa",
    "custom-gateway-token-7f3a9c21b8e4d605",
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "k3y/with+base64==Payload0123456789abc",
    "hunter2hunter2",
    "correct-horse-battery-staple-9",
];

fn set_up() -> (Diagnostics, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let diag = Diagnostics::default();
    diag.set_dir(dir.path().to_path_buf());
    (diag, dir)
}

/// Everything a support person could be handed: the export, the copy text and the log files.
fn everything(diag: &Diagnostics) -> String {
    format!("{}\n{}", diag.bundle("9.9.9"), diag.log_file_text())
}

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
fn a_secret_that_punctuation_splits_into_pieces_is_replaced_as_one_word() {
    for (text, secret) in [
        ("key=(sk-abcdefghijk.lmnopqrstuv),", "lmnopqrstuv"),
        ("\"sk-abcdefghijk.lmnopqrstuv\"", "abcdefghijk"),
        ("using sk-proj-abcd1234.efgh5678-ijkl9012!", "efgh5678"),
        (
            "tail: k3y/with+base64==Payload0123456789abc.",
            "Payload0123456789abc",
        ),
    ] {
        let clean = redact(text, None);
        assert!(!clean.contains(secret), "{secret} leaked: {clean}");
        assert!(clean.contains("[REDACTED]"), "{clean}");
    }
}

#[test]
fn ordinary_words_numbers_paths_and_the_home_folder_are_handled() {
    let clean = redact(
        "Scanning C:\\Users\\kim\\Worlds\\Roguefire: 12 files, region r.0.0.mca",
        Some("C:\\Users\\kim"),
    );
    assert_eq!(
        clean,
        "Scanning ~\\Worlds\\Roguefire: 12 files, region r.0.0.mca"
    );
    let module = "site-packages/urllib3/connectionpool.py";
    assert_eq!(redact(module, None), module);
}

#[test]
fn long_lines_are_clipped_and_newlines_flattened() {
    let line = clip(&format!("a\nb{}", "x".repeat(5000)));
    assert!(line.chars().count() <= MAX_LINE_CHARS + 1);
    assert!(!line.contains('\n'));
}

#[test]
fn only_known_diagnostic_shapes_are_kept_and_the_rest_is_counted() {
    let diag = Diagnostics::default();
    for line in [
        "The villagers of Oakhaven gather at dawn to trade wheat.",
        "Traceback (most recent call last):",
        "  File \"C:\\Users\\someone\\secret folder\\mwt\\extract.py\", line 12, in run",
        "    translate(\"WORLD-TEXT-IN-SOURCE\")",
        "  File \"/opt/pomi/_internal/site-packages/requests/api.py\", line 59, in get",
        "ValueError: WORLD-TEXT-IN-MESSAGE",
        "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='private.example')",
        "KeyboardInterrupt",
        "[pomi] stage=scan files=3",
        "Oops, it broke: here is some more of the story of the world",
    ] {
        diag.core_stderr(line);
    }
    assert_eq!(
        diag.stderr_lines(),
        [
            "[1 line omitted]",
            "Traceback (most recent call last):",
            "  File \"mwt/extract.py\", line 12, in [fn]",
            "[1 line omitted]",
            "  [frame]",
            "ValueError: [message omitted]",
            "[exception]: [message omitted]",
            "KeyboardInterrupt",
            "[pomi] [message omitted]",
            "[1 line omitted]",
        ]
    );
}

#[test]
fn the_fixed_notices_keep_their_text_and_nothing_a_line_adds_to_them() {
    let diag = Diagnostics::default();
    for line in [
        "[pomi] stdin closed while a request was running; cancelling",
        "[pomi] stdin closed while a request was running; cancelling with more words",
        "preferences were not saved: OSError",
        "preferences were not saved: SomeLibraryError",
        "protocol message had values that were replaced: ['non_finite_number']",
        "protocol message had values that were replaced: ['non_finite_number', 'a story']",
    ] {
        diag.core_stderr(line);
    }
    assert_eq!(
        diag.stderr_lines(),
        [
            "[pomi] stdin closed while a request was running; cancelling",
            "[pomi] [message omitted]",
            "preferences were not saved: OSError",
            "preferences were not saved",
            "protocol message had values that were replaced: ['non_finite_number']",
            "protocol message had values that were replaced",
        ]
    );
}

#[test]
fn consecutive_omitted_lines_are_one_entry_and_the_ring_is_bounded() {
    let diag = Diagnostics::default();
    for n in 0..50 {
        diag.core_stderr(&format!("free text line {n}"));
    }
    assert_eq!(diag.stderr_lines(), ["[50 lines omitted]"]);
    for n in 0..(STDERR_RING_LINES + 25) {
        diag.core_stderr(&format!("  File \"mwt/extract.py\", line {n}, in run"));
    }
    let lines = diag.stderr_lines();
    assert_eq!(lines.len(), STDERR_RING_LINES);
    assert_eq!(lines[0], "  File \"mwt/extract.py\", line 25, in [fn]");
    assert!(diag.bundle("1.0.0").contains("line 224, in [fn]"));
}

#[test]
fn arbitrary_key_like_strings_never_reach_the_ring_the_log_or_the_export() {
    let (diag, _dir) = set_up();
    for key in CUSTOM_KEYS {
        for line in [
            key.to_string(),
            format!("provider rejected {key} as invalid"),
            format!("key=({key}),"),
            format!("\"{key}\""),
            format!("[pomi] request failed for {key}"),
            format!("[pomi] key=({key}),"),
            format!("[pomi] \"{key}\"."),
            format!("ValueError: bad key {key}"),
            format!("Authorization: Bearer {key}"),
        ] {
            diag.core_stderr(&line);
            diag.core_stray_stdout(&line);
        }
    }
    diag.end_core_output();
    let all = everything(&diag);
    for key in CUSTOM_KEYS {
        assert!(!all.contains(key), "{key} leaked:\n{all}");
    }
    assert!(all.contains("[message omitted]"), "{all}");
}

const SECRET: &str = "violet-lantern-castle-rose";
/// A secret (or a world token) that is a valid Python identifier and a valid class-name prefix.
const IDENTIFIER_SECRET: &str = "violetlanterncastlerose";
const SENTENCE: &str = "The baker of Oakhaven sold violet bread to the miners at dawn";

#[test]
fn the_secret_and_a_world_sentence_reach_neither_the_log_file_nor_the_export_by_any_path() {
    let (diag, _dir) = set_up();
    // The request is one of the page's, so its type is untrusted too.
    let hostile_request = format!("scan.start-{SECRET}");
    for text in [SECRET, SENTENCE] {
        for line in [
            // Plain output and the prefix.
            text.to_owned(),
            format!("[pomi] {text}"),
            format!("  {text}"),
            // The fixed notices followed by more.
            format!("[pomi] stdin closed while a request was running; cancelling {text}"),
            format!("[pomi] stdin closed while a request was running; cancelling: {text}"),
            format!("preferences were not saved: {text}"),
            format!("[pomi] preferences were not saved: {text}"),
            format!("protocol message had values that were replaced: ['{text}']"),
            format!(
                "protocol message had values that were replaced: ['non_finite_number', '{text}']"
            ),
            // A frame's file and function.
            format!("  File \"/x/mwt/{text}.py\", line 3, in run"),
            format!("  File \"/x/{text}/extract.py\", line 3, in run"),
            format!("  File \"/x/mwt/extract.py\", line 3, in {text}"),
            format!("  File \"{text}\", line 3, in run"),
            format!("  File \"/x/mwt/extract.py\", line 3, in run {text}"),
            // An exception class and message.
            format!("{text}Error: {text}"),
            format!("mwt.journal.{text}Error: {text}"),
            format!("ValueError: {text}"),
            format!("Traceback (most recent call last): {text}"),
        ] {
            diag.core_stderr(&line);
            diag.core_stray_stdout(&line);
        }
    }
    // Output split mid-word into two reads (the sink in `sidecar` joins what the pipe splits).
    diag.core_stderr(&format!("{} {}", &SECRET[..8], &SECRET[8..]));
    diag.end_core_output();
    // The shell's own messages: an error's message, the source and the request it names.
    for text in [SECRET, SENTENCE] {
        diag.log_error(
            "native_reset",
            &IpcError::new("RESET_FAILED", format!("could not remove {text}")),
        );
        diag.log_error(
            &format!("sidecar_request:{text}"),
            &IpcError::new("BUSY", text),
        );
        diag.log_error(&format!("{text}:{text}"), &IpcError::new("BUSY", text));
        diag.log_with(
            "ERROR",
            &format!("core:{text}"),
            "a fixed message",
            Some(text),
            &[("pid", 7)],
        );
        diag.core_run(&RunRecord {
            request: text,
            duration_ms: 3,
            error: None,
            exit_code: Some(0),
            signal: None,
        });
    }
    diag.log_with(
        "ERROR",
        "sidecar_request",
        "a fixed message",
        Some(&hostile_request),
        &[],
    );
    let all = everything(&diag);
    assert!(all.contains("[message omitted]"), "{all}");
    assert!(all.contains("[unknown request]"), "{all}");
    assert!(!all.contains("scan.start-"), "{all}");
    for word in [
        SECRET, "violet", "lantern", "castle", "baker", "Oakhaven", "miners", "bread",
    ] {
        assert!(!all.contains(word), "{word} leaked:\n{all}");
    }
}

#[test]
fn an_identifier_shaped_secret_reaches_neither_the_log_file_nor_the_export_through_any_core_line() {
    let (diag, _dir) = set_up();
    let word = IDENTIFIER_SECRET;
    for line in [
        // A frame of an allow-listed module keeps its path and line number, never its function.
        format!("  File \"mwt/desktop_entry.py\", line 42, in {word}"),
        format!("  File \"/x/mwt/extract.py\", line 7, in {word}.{word}"),
        format!("  File \"mwt/journal.py\", line 9, in <module>{word}"),
        format!("  File \"mwt/{word}.py\", line 3, in run"),
        // An exception class that is not allow-listed, with and without a module and a message.
        format!("{word}Error: {word}"),
        format!("mwt.journal.{word}Error: {word}"),
        format!("{word}Error"),
        // The fixed notices followed by the word, and the [pomi] prefix.
        format!("[pomi] {word}"),
        format!("[pomi] stdin closed while a request was running; cancelling{word}"),
        format!("preferences were not saved: {word}Error"),
        format!("preferences were not saved: {word}"),
        format!("protocol message had values that were replaced: ['{word}']"),
        format!("ValueError: {word}"),
        word.to_owned(),
    ] {
        diag.core_stderr(&line);
        diag.core_stray_stdout(&line);
    }
    diag.end_core_output();
    let (file, export) = (diag.log_file_text(), diag.bundle("9.9.9"));
    for (what, text) in [("log file", &file), ("export", &export)] {
        assert!(
            !text.contains(word),
            "{what} leaked {word}:
{text}"
        );
        assert!(
            !text.contains("violet"),
            "{what}:
{text}"
        );
        assert!(
            !text.contains("lantern"),
            "{what}:
{text}"
        );
    }
    // What is kept is the module, the line and a fixed marker, plus allow-listed class names.
    assert!(
        file.contains("File \"mwt/desktop_entry.py\", line 42, in [fn]"),
        "{file}"
    );
    assert!(
        export.contains("File \"mwt/desktop_entry.py\", line 42, in [fn]"),
        "{export}"
    );
    assert!(file.contains("ValueError: [message omitted]"), "{file}");
    assert!(export.contains("ValueError: [message omitted]"), "{export}");
}

#[test]
fn the_exception_classes_of_the_new_core_modules_and_the_counter_are_known_to_the_filter() {
    let (diag, _dir) = set_up();
    for class in ["GlossaryError", "mwt.glossary.GlossaryError"] {
        diag.core_stderr(&format!("{class}: x"));
    }
    let lines = diag.stderr_lines();
    assert_eq!(
        lines,
        [
            "GlossaryError: [message omitted]",
            "mwt.glossary.GlossaryError: [message omitted]",
        ]
    );
    // `_UnreadableCounter` is not shaped like a printed exception line (like `_DeadlineExceeded`),
    // but it is a class of the core, so the allow-list names it.
    assert!(allowed_exception("_UnreadableCounter"));
    assert!(allowed_exception("mwt.journal._UnreadableCounter"));
    for module in ["mwt/glossary.py", "mwt/format_residue.py"] {
        diag.core_stderr(&format!("  File \"/x/{module}\", line 4, in f"));
    }
    assert!(diag
        .stderr_lines()
        .iter()
        .any(|line| line == "  File \"mwt/glossary.py\", line 4, in [fn]"));
    assert!(diag
        .stderr_lines()
        .iter()
        .any(|line| line == "  File \"mwt/format_residue.py\", line 4, in [fn]"));
}

#[test]
fn a_key_straddling_the_clip_limit_is_redacted_before_the_line_is_cut() {
    let (diag, _dir) = set_up();
    let key = "sk-or-v1-ABCDEF0123456789abcdef0123456789";
    // The key starts a few characters before the 300 character limit of a logger line.
    for pad in [270, 280, 290, 295, 299] {
        diag.core_stderr(&format!("{CORE_LOG_PREFIX}{} {key} tail", "a".repeat(pad)));
        diag.core_stderr(&format!("ValueError: {} {key} tail", "a".repeat(pad)));
    }
    let all = everything(&diag);
    for fragment in ["sk-or", "ABCDEF", "0123456789abcdef", "v1-"] {
        assert!(!all.contains(fragment), "{fragment} leaked:\n{all}");
    }
}

#[test]
fn the_log_file_keeps_only_known_shapes_and_counts_the_rest() {
    let (diag, _dir) = set_up();
    diag.core_stderr("a story about the world with a secret ending");
    diag.core_stderr("[pomi] stage=scan");
    diag.core_stderr("another story");
    diag.end_core_output();
    let log = diag.log_file_text();
    assert!(log.contains("CORE [1 line omitted]"), "{log}");
    assert!(log.contains("CORE [pomi] [message omitted]"), "{log}");
    assert!(!log.contains("story"), "{log}");
    assert!(!log.contains("stage=scan"), "{log}");
}

#[test]
fn the_log_file_rotates_at_the_size_limit_and_keeps_five_files() {
    let dir = tempfile::tempdir().unwrap();
    let diag = Diagnostics::default();
    diag.set_dir(dir.path().to_path_buf());
    // Messages are compile-time text in the product; a test needs one long enough.
    let line: &'static str = Box::leak("x".repeat(1500).into_boxed_str());
    for _ in 0..(MAX_FILE_BYTES as usize / 1500 * 7) {
        diag.log("INFO", "app", line);
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
fn the_export_is_structured_metadata_only_and_never_a_log_tail_or_a_message() {
    let (diag, dir) = set_up();
    diag.log_error(
        "core:scan.start",
        &IpcError::new(
            "CORE_CRASHED",
            "exit 3 while holding sk-abcdef0123456789abcdef in /home/someone/My World",
        ),
    );
    diag.log("INFO", "app", "opened a world");
    diag.core_run(&RunRecord {
        request: "scan.start",
        duration_ms: 1234,
        error: Some("CORE_CRASHED"),
        exit_code: Some(3),
        signal: None,
    });
    diag.core_run(&RunRecord {
        request: "bad request name with spaces & symbols",
        duration_ms: 5,
        error: None,
        exit_code: Some(0),
        signal: None,
    });
    diag.crash("src/lib.rs:42");
    diag.core_stderr("Traceback: provider echoed Bearer sk-live-00112233445566778899");
    // A line left in the file by an older version is not exported either.
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
    assert!(
        bundle.contains(
            "request=scan.start duration_ms=1234 result=CORE_CRASHED exit_code=3 signal=none"
        ),
        "{bundle}"
    );
    assert!(bundle.contains("request=[unknown request]"), "{bundle}");
    assert!(bundle.contains("panic at lib.rs:42"), "{bundle}");
    assert!(bundle.contains("core lines omitted: 1"), "{bundle}");
    for forbidden in [
        "sk-abcdef0123456789abcdef",
        "sk-live-00112233445566778899",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
        "second line",
        "opened a world",
        "My World",
        "exit 3 while",
        "recent events",
        "bad request name",
    ] {
        assert!(!bundle.contains(forbidden), "{forbidden} leaked:\n{bundle}");
    }
}

#[test]
fn the_copy_text_is_the_export() {
    let _turn = serial();
    global().reset();
    global().log_error("app", &IpcError::new("CORE_CRASHED", "m"));
    let copied = global().snapshot();
    assert!(copied.contains("app CORE_CRASHED"));
    assert!(!copied.contains("recent events"));
    global().reset();
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
fn a_crash_record_holds_only_its_place_in_the_log_and_in_the_export() {
    let (diag, dir) = set_up();
    diag.crash("src/lib.rs:1");
    let log = fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
    assert!(log.contains("CRASH panic at lib.rs:1"), "{log}");
    assert!(diag.bundle("1.0.0").contains("panic at lib.rs:1"));
}

#[test]
fn module_relative_paths_never_keep_the_persons_folders() {
    for (path, expected) in [
        ("C:\\Users\\someone\\app\\mwt\\scan.py", "mwt/scan.py"),
        (
            "/Users/x/Pomi.app/Contents/_internal/mwt/io.py",
            "mwt/io.py",
        ),
        (
            "/home/x/.venv/lib/python3.12/site-packages/httpx/_client.py",
            "site-packages/httpx/_client.py",
        ),
        (
            "/usr/lib/python3.12/json/decoder.py",
            "stdlib/json/decoder.py",
        ),
        ("D:\\private\\notes.py", "notes.py"),
    ] {
        let reduced = module_relative(path);
        assert!(
            !reduced.contains("someone") && !reduced.contains("private"),
            "{reduced}"
        );
        assert_eq!(reduced, expected, "{path}");
    }
}

// --- the allow-lists follow the Python sources ---------------------------------------------------

fn repo_file(relative: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative)
}

/// The core's source files, as `module_relative` writes them.
fn core_sources_on_disk() -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(repo_file("mwt"))
        .expect("the Python sources are next to src-tauri")
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".py"))
        .map(|name| format!("mwt/{name}"))
        .collect();
    found.extend(
        [
            "mc_world_translator.py",
            "llm_backends.py",
            "webui_server.py",
        ]
        .map(str::to_owned),
    );
    found.sort();
    found
}

/// Allow-list entries whose Python source may be absent from the tree the tests run on (a branch
/// that has not merged the glossary core yet). Everything else must match the sources exactly.
const MAY_BE_ABSENT_MODULES: &[&str] = &["mwt/glossary.py", "mwt/format_residue.py"];
const MAY_BE_ABSENT_EXCEPTIONS: &[&str] = &["GlossaryError"];

#[test]
fn the_module_list_covers_exactly_the_core_sources() {
    let mut listed: Vec<String> = CORE_MODULES.iter().map(|name| (*name).to_owned()).collect();
    listed.sort();
    let mut expected = core_sources_on_disk();
    // Entries that are on the list but not on disk are fine only when they are the tolerated ones.
    for name in MAY_BE_ABSENT_MODULES {
        if !expected.iter().any(|found| found == name) {
            expected.push((*name).to_owned());
        }
    }
    expected.sort();
    assert_eq!(
        listed, expected,
        "a Python module was added or removed: update CORE_MODULES"
    );
}

#[test]
fn the_exception_list_covers_every_exception_class_the_core_defines() {
    let mut known: std::collections::BTreeSet<String> = BUILTIN_EXCEPTIONS
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let mut defined: Vec<(String, Vec<String>)> = Vec::new();
    for file in core_sources_on_disk() {
        let text = fs::read_to_string(repo_file(&file)).unwrap();
        for line in text.lines() {
            let Some(rest) = line.strip_prefix("class ") else {
                continue;
            };
            let Some((name, bases)) = rest.split_once('(') else {
                continue;
            };
            let bases = bases.split(')').next().unwrap_or("");
            defined.push((
                name.trim().to_owned(),
                bases
                    .split(',')
                    .map(|base| base.trim().rsplit('.').next().unwrap_or("").to_owned())
                    .collect(),
            ));
        }
    }
    // A class is an exception when a base is one; classes may be defined before their bases.
    let mut ours: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    loop {
        let before = known.len();
        for (name, bases) in &defined {
            if bases.iter().any(|base| known.contains(base)) {
                known.insert(name.clone());
                ours.insert(name.clone());
            }
        }
        if known.len() == before {
            break;
        }
    }
    ours.retain(|name| !BUILTIN_EXCEPTIONS.contains(&name.as_str()));
    for name in MAY_BE_ABSENT_EXCEPTIONS {
        ours.insert((*name).to_owned());
    }
    let listed: std::collections::BTreeSet<String> = CORE_EXCEPTIONS
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(
        listed, ours,
        "an exception class was added or removed in the Python sources: update CORE_EXCEPTIONS"
    );
}

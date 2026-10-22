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
        "  File \"C:\\Users\\someone\\secret folder\\mwt\\scan.py\", line 12, in run",
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
            "  File \"mwt/scan.py\", line 12, in run",
            "[1 line omitted]",
            "  File \"site-packages/requests/api.py\", line 59, in get",
            "ValueError: [message omitted]",
            "requests.exceptions.ConnectionError: [message omitted]",
            "KeyboardInterrupt",
            "[pomi] stage=scan files=3",
            "[1 line omitted]",
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
        diag.core_stderr(&format!("[pomi] line {n}"));
    }
    let lines = diag.stderr_lines();
    assert_eq!(lines.len(), STDERR_RING_LINES);
    assert_eq!(lines[0], "[pomi] line 25");
    assert!(diag.bundle("1.0.0").contains("[pomi] line 224"));
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

#[test]
fn a_key_straddling_the_clip_limit_is_redacted_before_the_line_is_cut() {
    let (diag, _dir) = set_up();
    let key = "sk-or-v1-ABCDEF0123456789abcdef0123456789";
    // The key starts a few characters before the 300 character limit of a logger line.
    for pad in [270, 280, 290, 295, 299] {
        diag.core_stderr(&format!("{CORE_LOG_PREFIX}{} {key} tail", "a".repeat(pad)));
    }
    let all = everything(&diag);
    for fragment in ["sk-or", "ABCDEF", "0123456789abcdef", "v1-"] {
        assert!(!all.contains(fragment), "{fragment} leaked:\n{all}");
    }
}

#[test]
fn the_log_file_keeps_scrubbed_core_lines_but_no_omitted_text() {
    let (diag, _dir) = set_up();
    diag.core_stderr("a story about the world with a secret ending");
    diag.core_stderr("[pomi] stage=scan");
    diag.core_stderr("another story");
    diag.end_core_output();
    let log = diag.log_file_text();
    assert!(log.contains("CORE [1 line omitted]"), "{log}");
    assert!(log.contains("CORE [pomi] stage=scan"), "{log}");
    assert!(!log.contains("story"), "{log}");
}

#[test]
fn the_log_file_rotates_at_the_size_limit_and_keeps_five_files() {
    let dir = tempfile::tempdir().unwrap();
    let diag = Diagnostics::default();
    diag.set_dir(dir.path().to_path_buf());
    let line = "x".repeat(1500);
    for _ in 0..(MAX_FILE_BYTES as usize / 1500 * 7) {
        diag.log("INFO", "test", &line);
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
    diag.log("INFO", "app", "opened the world My Secret Castle");
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
    diag.crash("src/lib.rs:42", "boom with key sk-abcdef0123456789abcdef");
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
    assert!(
        bundle.contains("request=bad?request?name?with?spaces"),
        "{bundle}"
    );
    assert!(bundle.contains("panic at lib.rs:42"), "{bundle}");
    assert!(bundle.contains("core lines omitted: 1"), "{bundle}");
    for forbidden in [
        "sk-abcdef0123456789abcdef",
        "sk-live-00112233445566778899",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
        "second line",
        "My Secret Castle",
        "My World",
        "exit 3 while",
        "boom",
        "recent events",
    ] {
        assert!(!bundle.contains(forbidden), "{forbidden} leaked:\n{bundle}");
    }
}

#[test]
fn the_copy_text_is_the_export() {
    let _turn = serial();
    global().reset();
    global().log_error("x", &IpcError::new("CORE_CRASHED", "m"));
    let copied = global().snapshot();
    assert!(copied.contains("x CORE_CRASHED"));
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
fn a_crash_record_lands_in_the_log_but_only_its_place_in_the_export() {
    let (diag, dir) = set_up();
    diag.crash("src/lib.rs:1", "boom with key sk-abcdef0123456789abcdef");
    let log = fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
    assert!(log.contains("CRASH") && log.contains("boom"));
    assert!(!log.contains("sk-abcdef0123456789abcdef"));
    let export = diag.bundle("1.0.0");
    assert!(export.contains("panic at lib.rs:1") && !export.contains("boom"));
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

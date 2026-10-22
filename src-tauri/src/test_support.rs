//! Test-only: a tiny helper program that plays the translation core (or a misbehaving one), built
//! with the same `rustc` that builds the tests. It lives in a folder whose name has spaces and
//! Korean letters, so every spawn in the tests also proves such install paths work.
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::{Duration, Instant},
};

use crate::{core_process::SpawnSpec, sidecar::Launch};

const SOURCE: &str = r###"
use std::io::{BufRead, Read, Write};

fn out(line: &str) {
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    stdout.write_all(line.as_bytes()).unwrap();
    stdout.write_all(b"\n").unwrap();
    stdout.flush().unwrap();
}

/// One write to stderr, so lines are never split by output from the other pipe.
fn note(text: &str) {
    let _ = std::io::stderr().write_all(text.as_bytes());
}

fn hello() {
    out(r#"{"v":1,"id":"boot","type":"system.hello","payload":{"protocolVersion":1}}"#);
}

fn id_of(line: &str) -> String {
    let rest = line.split("\"id\":\"").nth(1).unwrap_or("");
    rest.split('"').next().unwrap_or("").to_owned()
}

fn read_request() -> String {
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).unwrap();
    line
}

fn sleep_forever() -> ! {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

fn reply(id: &str, payload: &str) {
    out(&format!(r#"{{"v":1,"id":"{id}","type":"response.ok","payload":{payload}}}"#));
}

fn spawn_sleeper() -> u32 {
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("sleep")
        .spawn()
        .unwrap();
    child.id()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    match mode {
        "echo" => {
            hello();
            for line in std::io::stdin().lock().lines() {
                let line = line.unwrap();
                reply(&id_of(&line), &format!(r#"{{"len":{}}}"#, line.len()));
            }
        }
        "env" => {
            hello();
            let line = read_request();
            let get = |name: &str| std::env::var(name).unwrap_or_else(|_| "<unset>".into());
            reply(
                &id_of(&line),
                &format!(
                    r#"{{"utf8":"{}","io":"{}","version":"{}","sha":"{}","date":"{}","openai":"{}","custom":"{}","path_set":{}}}"#,
                    get("PYTHONUTF8"), get("PYTHONIOENCODING"), get("POMI_APP_VERSION"),
                    get("POMI_BUILD_SHA"), get("POMI_BUILD_DATE"), get("OPENAI_API_KEY"),
                    get("POMI_TEST_CUSTOM"), std::env::var("PATH").is_ok()
                ),
            );
        }
        "args" => {
            for arg in &args[2..] {
                note(&format!("ARG[{}]
", arg));
            }
            hello();
            let line = read_request();
            reply(&id_of(&line), "{}");
        }
        "progress" => {
            hello();
            let line = read_request();
            let id = id_of(&line);
            for n in 1..=3 {
                out(&format!(r#"{{"v":1,"id":"{id}","type":"scan.progress","payload":{{"n":{n}}}}}"#));
            }
            reply(&id, "{}");
        }
        "stall" => {
            // Reads the request, then never answers and ignores the end of its stdin.
            note(&format!("PID={};
", std::process::id()));
            hello();
            let _ = read_request();
            sleep_forever();
        }
        "stall-with-grandchild" => {
            note(&format!("GRANDCHILD={};
", spawn_sleeper()));
            hello();
            let _ = read_request();
            sleep_forever();
        }
        "leave-grandchild" => {
            // Starts a sleeper and exits at once: the sleeper outlives its parent.
            note(&format!("GRANDCHILD={};
", spawn_sleeper()));
            hello();
            let line = read_request();
            reply(&id_of(&line), "{}");
        }
        "sleep" => sleep_forever(),
        "exit" => {
            let code: i32 = args.get(2).and_then(|c| c.parse().ok()).unwrap_or(0);
            std::process::exit(code);
        }
        "burst" => {
            // Writes a lot to both pipes and exits straight away.
            let size: usize = args.get(2).and_then(|c| c.parse().ok()).unwrap_or(0);
            let chunk = vec![b'x'; 1000];
            let mut stdout = std::io::stdout().lock();
            let mut stderr = std::io::stderr().lock();
            for _ in 0..size / 1000 {
                stdout.write_all(&chunk).unwrap();
                stderr.write_all(&chunk).unwrap();
            }
            stdout.write_all(b"END\n").unwrap();
            stderr.write_all(b"END\n").unwrap();
        }
        "noise" => {
            // Hello, then more non-protocol text than the shell tolerates, then a reply.
            hello();
            let line = read_request();
            let junk = "this is not protocol output ".repeat(30);
            for _ in 0..2000 {
                out(&junk);
            }
            reply(&id_of(&line), "{}");
        }
        "unknown-event" => {
            // Same-id messages that are not a valid terminal reply, before the real one (H4).
            hello();
            let line = read_request();
            let id = id_of(&line);
            out(&format!(r#"{{"v":1,"id":"{id}","type":"job.surprise","payload":{{"text":"WORLD-TEXT-IN-EVENT"}}}}"#));
            out(&format!(r#"{{"v":1,"id":"{id}","type":"response.ok"}}"#));
            out(&format!(r#"{{"v":2,"id":"{id}","type":"response.error","error":{{}}}}"#));
            reply(&id, r#"{"done":true}"#);
        }
        "stderr-mix" => {
            // Diagnostic lines of every kind on stderr, then a normal reply (H3).
            hello();
            let line = read_request();
            let id = id_of(&line);
            note("The villagers of Oakhaven gather at dawn to trade wheat.\n");
            note("my custom key is Zq9xK2mP7vL4nR8tB3wY5cH1dF6gJ0aa\n");
            note("Traceback (most recent call last):\n");
            note("  File \"C:\\Users\\someone\\secret folder\\mwt\\scan.py\", line 12, in run\n");
            note("    translate(\"WORLD-TEXT-IN-SOURCE\")\n");
            note("ValueError: WORLD-TEXT-IN-MESSAGE\n");
            note("[pomi] stage=scan files=3\n");
            note("[pomi] part one sk-or-v1-ab");
            std::thread::sleep(std::time::Duration::from_millis(80));
            note("cdef0123456789abcdef0123 end\n");
            reply(&id, "{}");
        }
        "idle-until-eof" => {
            // Stops only because its stdin ended.
            hello();
            let mut sink = Vec::new();
            let _ = std::io::stdin().lock().read_to_end(&mut sink);
            note("EOF-SEEN
");
        }
        _ => std::process::exit(3),
    }
}
"###;

/// The helper program, compiled once per test run.
pub fn helper() -> &'static Path {
    static HELPER: OnceLock<PathBuf> = OnceLock::new();
    HELPER.get_or_init(|| {
        let dir = std::env::temp_dir()
            .join(format!("포미 테스트 helper {}", std::process::id()))
            .join("core with spaces");
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("helper.rs");
        std::fs::write(&source, SOURCE).unwrap();
        let exe = dir.join(if cfg!(windows) {
            "pomi-sidecar.exe"
        } else {
            "pomi-sidecar"
        });
        let output = Command::new("rustc")
            .args(["--edition", "2021", "-C", "opt-level=0", "-o"])
            .arg(&exe)
            .arg(&source)
            .output()
            .expect("rustc is needed to build the test helper");
        assert!(
            output.status.success(),
            "the test helper did not compile:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        exe
    })
}

pub fn spec(mode: &str, extra: &[&str]) -> SpawnSpec {
    let mut args: Vec<OsString> = vec![mode.into()];
    args.extend(extra.iter().map(OsString::from));
    SpawnSpec {
        program: helper().to_path_buf(),
        args,
        env: vec![],
        cwd: None,
    }
}

/// A launch of the helper in `mode`, with its own scratch folder for the cancel marker.
pub fn launch(mode: &str, scratch: &Path) -> Launch {
    Launch {
        program: helper().to_path_buf(),
        args: vec![mode.into()],
        env: vec![
            ("PYTHONUTF8".into(), "1".into()),
            ("OPENAI_API_KEY".into(), OsString::new()),
        ],
        cwd: scratch.to_path_buf(),
        cancel_path: scratch.join("active-operation.cancel"),
    }
}

#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: plain queries on a handle opened and closed here.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            // No such process (invalid parameter); anything else (access denied) means it exists.
            return std::io::Error::last_os_error().raw_os_error() != Some(87);
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// True once `pid` is gone, waiting up to `limit`.
pub async fn gone_within(pid: u32, limit: Duration) -> bool {
    let started = Instant::now();
    while process_alive(pid) {
        if started.elapsed() >= limit {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    true
}

/// `KEY=<digits>` printed by the helper on stderr, found in the events read so far.
pub fn find_number(text: &str, key: &str) -> Option<u32> {
    let rest = text.split(&format!("{key}=")).nth(1)?;
    rest.chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

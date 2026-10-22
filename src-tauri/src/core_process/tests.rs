//! Process-level tests against a real child (the helper in `test_support`, in a folder with spaces
//! and Korean letters).
use std::time::Duration;

use tokio::time::timeout;
use zeroize::Zeroizing;

use super::*;
use crate::test_support::{find_number, gone_within, helper, process_alive, spec};

const LONG: Duration = Duration::from_secs(20);

fn line(text: &str) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(format!("{text}\n").into_bytes())
}

/// Everything the child wrote until it ended: (stdout, stderr, how it ended).
async fn collect(events: &mut mpsc::Receiver<CoreEvent>) -> (String, String, Option<ExitInfo>) {
    let (mut out, mut err, mut exit) = (Vec::new(), Vec::new(), None);
    timeout(LONG, async {
        while let Some(event) = events.recv().await {
            match event {
                CoreEvent::Stdout(bytes) => out.extend(bytes),
                CoreEvent::Stderr(bytes) => err.extend(bytes),
                CoreEvent::Exited(info) => {
                    exit = Some(info);
                    break;
                }
                CoreEvent::Error(message) => panic!("waiting failed: {message}"),
            }
        }
    })
    .await
    .expect("the child ended in time");
    (
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
        exit,
    )
}

/// Read until every needle has shown up on stderr or stdout (the two pipes are not ordered
/// against each other).
async fn read_until_all(events: &mut mpsc::Receiver<CoreEvent>, needles: &[&str]) -> String {
    let mut seen = String::new();
    timeout(LONG, async {
        while let Some(event) = events.recv().await {
            if let CoreEvent::Stdout(bytes) | CoreEvent::Stderr(bytes) = event {
                seen.push_str(&String::from_utf8_lossy(&bytes));
                if needles.iter().all(|needle| seen.contains(needle)) {
                    return;
                }
            }
        }
        panic!("the child ended before {needles:?} appeared; saw {seen:?}");
    })
    .await
    .unwrap_or_else(|_| panic!("{needles:?} never appeared; saw {seen:?}"));
    seen
}

async fn read_until(events: &mut mpsc::Receiver<CoreEvent>, needle: &str) -> String {
    read_until_all(events, &[needle]).await
}

#[tokio::test]
async fn a_child_in_a_unicode_folder_with_spaces_talks_over_its_pipes_and_ends() {
    assert!(helper().to_string_lossy().contains("core with spaces"));
    assert!(helper().to_string_lossy().contains("포미"));
    let mut child = spawn(&spec("echo", &[])).unwrap();
    assert_eq!(child.pid, child.control.pid());
    read_until(&mut child.events, "system.hello").await;
    child
        .stdin
        .send(line(r#"{"id":"r1","type":"x"}"#))
        .await
        .unwrap();
    read_until(&mut child.events, r#""id":"r1""#).await;
    // The end of stdin is what stops this child.
    drop(child.stdin);
    let (_, _, exit) = collect(&mut child.events).await;
    assert_eq!(
        exit,
        Some(ExitInfo {
            code: Some(0),
            signal: None
        })
    );
    assert_eq!(child.control.wait_exit(Duration::from_secs(1)).await, exit);
    assert!(child.control.has_exited());
}

#[tokio::test]
async fn arguments_with_spaces_quotes_and_backslashes_arrive_unchanged() {
    let tricky = [
        "plain",
        "with space",
        r#"say "hi""#,
        r"C:\my dir\",
        "",
        "한글 경로\\월드",
        "--flag=a b",
    ];
    let mut child = spawn(&spec("args", &tricky)).unwrap();
    let mut err = read_until_all(&mut child.events, &["system.hello", "ARG[--flag=a b]"]).await;
    child.stdin.send(line(r#"{"id":"a"}"#)).await.unwrap();
    drop(child.stdin);
    err.push_str(&collect(&mut child.events).await.1);
    for (index, expected) in tricky.iter().enumerate() {
        assert!(
            err.contains(&format!("ARG[{expected}]")),
            "argument {index} {expected:?} changed; stderr was {err:?}"
        );
    }
}

#[tokio::test]
async fn environment_overrides_apply_and_the_rest_is_inherited() {
    let mut command = spec("env", &[]);
    command.env = vec![
        ("PYTHONUTF8".into(), "1".into()),
        ("POMI_APP_VERSION".into(), "9.8.7".into()),
        ("OPENAI_API_KEY".into(), "".into()),
        ("POMI_TEST_CUSTOM".into(), "값 with space".into()),
    ];
    let mut child = spawn(&command).unwrap();
    read_until(&mut child.events, "system.hello").await;
    child.stdin.send(line(r#"{"id":"e"}"#)).await.unwrap();
    let seen = read_until(&mut child.events, r#""id":"e""#).await;
    for expected in [
        r#""utf8":"1""#,
        r#""version":"9.8.7""#,
        r#""openai":"""#,
        r#""path_set":true"#,
        "값 with space",
    ] {
        assert!(seen.contains(expected), "missing {expected} in {seen}");
    }
}

#[tokio::test]
async fn the_exit_code_is_reported() {
    let mut child = spawn(&spec("exit", &["7"])).unwrap();
    let (_, _, exit) = collect(&mut child.events).await;
    assert_eq!(exit.unwrap().code, Some(7));
}

#[tokio::test]
async fn everything_written_before_the_exit_arrives_before_the_end_is_announced() {
    let mut child = spawn(&spec("burst", &["3000000"])).unwrap();
    let (out, err, exit) = collect(&mut child.events).await;
    assert!(exit.is_some());
    assert!(
        out.ends_with("END\n") && out.len() == 3_000_004,
        "stdout {} bytes",
        out.len()
    );
    assert!(
        err.ends_with("END\n") && err.len() == 3_000_004,
        "stderr {} bytes",
        err.len()
    );
}

#[tokio::test]
async fn a_program_that_does_not_exist_fails_to_start() {
    let mut command = spec("echo", &[]);
    command.program = helper().with_file_name("does-not-exist.exe");
    assert!(spawn(&command).is_err());
}

#[tokio::test]
async fn a_child_that_ignores_the_end_of_stdin_is_killed_and_its_exit_observed() {
    let mut child = spawn(&spec("stall", &[])).unwrap();
    let seen = read_until_all(&mut child.events, &["system.hello", "PID=", ";"]).await;
    let pid = find_number(&seen, "PID").expect("the child's pid");
    child.stdin.send(line(r#"{"id":"s"}"#)).await.unwrap();
    drop(child.stdin);
    // It does not react to the end of its stdin.
    assert_eq!(
        child.control.wait_exit(Duration::from_millis(500)).await,
        None
    );
    assert!(process_alive(pid));
    child.control.kill_tree();
    assert!(child.control.wait_exit(LONG).await.is_some());
    assert!(gone_within(pid, LONG).await);
}

#[tokio::test]
async fn killing_the_tree_kills_what_the_child_started() {
    let mut child = spawn(&spec("stall-with-grandchild", &[])).unwrap();
    let seen = read_until_all(&mut child.events, &["system.hello", "GRANDCHILD=", ";"]).await;
    let grandchild = find_number(&seen, "GRANDCHILD").expect("the grandchild's pid");
    assert!(process_alive(grandchild));
    child.control.kill_tree();
    assert!(child.control.wait_exit(LONG).await.is_some());
    assert!(
        gone_within(grandchild, LONG).await,
        "the grandchild survived the kill of its parent's tree"
    );
}

#[tokio::test]
async fn what_a_child_leaves_behind_when_it_exits_is_swept() {
    let mut child = spawn(&spec("leave-grandchild", &[])).unwrap();
    let seen = read_until_all(&mut child.events, &["system.hello", "GRANDCHILD=", ";"]).await;
    let grandchild = find_number(&seen, "GRANDCHILD")
        .unwrap_or_else(|| panic!("the grandchild's pid in {seen:?}"));
    child.stdin.send(line(r#"{"id":"l"}"#)).await.unwrap();
    let (_, _, exit) = collect(&mut child.events).await;
    assert!(exit.is_some());
    assert!(
        gone_within(grandchild, LONG).await,
        "a leftover process outlived its parent"
    );
}

#[tokio::test]
async fn dropping_the_control_of_a_running_child_stops_it() {
    let mut child = spawn(&spec("stall", &[])).unwrap();
    let seen = read_until_all(&mut child.events, &["system.hello", "PID=", ";"]).await;
    let pid = find_number(&seen, "PID").expect("the child's pid");
    assert!(process_alive(pid));
    // Windows: the last job handle closes; Unix: the group is killed.
    let Spawned {
        control,
        events,
        stdin,
        ..
    } = child;
    drop(control);
    assert!(
        gone_within(pid, LONG).await,
        "the child outlived its supervision"
    );
    drop((events, stdin));
}

#[tokio::test]
async fn a_core_that_waits_for_the_end_of_stdin_stops_when_it_arrives() {
    let mut child = spawn(&spec("idle-until-eof", &[])).unwrap();
    read_until(&mut child.events, "system.hello").await;
    assert_eq!(
        child.control.wait_exit(Duration::from_millis(300)).await,
        None
    );
    drop(child.stdin);
    let (_, err, exit) = collect(&mut child.events).await;
    assert_eq!(exit.unwrap().code, Some(0));
    assert!(err.contains("EOF-SEEN"));
}

#[tokio::test]
async fn killing_twice_or_after_the_end_is_harmless() {
    let mut child = spawn(&spec("exit", &["0"])).unwrap();
    let (_, _, exit) = collect(&mut child.events).await;
    assert!(exit.is_some());
    child.control.kill_tree();
    child.control.kill_tree();
    assert!(child.control.has_exited());
}

// --- a failed wait is not an exit (M4) ----------------------------------------------------------

#[tokio::test]
async fn a_failed_wait_is_not_an_exit_the_state_is_unknown_and_the_tree_is_stopped_again() {
    fault::fail_waits(u32::MAX);
    let mut child = spawn(&spec("sleep", &[])).unwrap();
    let pid = child.pid;
    let first = timeout(LONG, child.events.recv()).await.unwrap();
    assert!(
        matches!(first, Some(CoreEvent::Error(_))),
        "the failure is reported: {first:?}"
    );
    assert!(child.control.is_unknown());
    assert_eq!(child.control.state(), ProcessState::Unknown);
    // The watcher stops the tree again, so the process really is gone ...
    assert!(gone_within(pid, LONG).await);
    // ... yet nobody claims to have seen it end: the slot would stay occupied.
    assert!(child
        .control
        .wait_exit(Duration::from_millis(300))
        .await
        .is_none());
    assert!(!child.control.has_exited());
    assert_eq!(child.control.exit_info(), None);
}

#[tokio::test]
async fn the_observation_is_retried_until_the_exit_is_seen() {
    fault::fail_waits(3);
    let mut child = spawn(&spec("sleep", &[])).unwrap();
    let mut saw_error = false;
    let exit = timeout(LONG, async {
        while let Some(event) = child.events.recv().await {
            match event {
                CoreEvent::Error(_) => saw_error = true,
                CoreEvent::Exited(info) => return Some(info),
                _ => {}
            }
        }
        None
    })
    .await
    .unwrap();
    assert!(saw_error, "the failed attempts were reported");
    assert!(exit.is_some(), "the exit was finally seen");
    assert!(child.control.has_exited());
    assert!(gone_within(child.pid, LONG).await);
}

// --- the dev interpreter is found like a shell would (M2) ---------------------------------------

/// The helper copied to `<dir>/<stem>` (with `.exe` on Windows), so a bare name finds it.
fn helper_on_a_path(stem: &str) -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("pomi 개발 path ")
        .tempdir()
        .unwrap();
    let name = if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_owned()
    };
    std::fs::copy(helper(), dir.path().join(name)).unwrap();
    dir
}

#[tokio::test]
async fn a_bare_program_name_is_found_through_path_and_really_starts() {
    let dir = helper_on_a_path("pomi-dev-core");
    let command = SpawnSpec {
        program: PathBuf::from("pomi-dev-core"),
        args: vec!["echo".into()],
        env: vec![("PATH".into(), dir.path().as_os_str().to_owned())],
        cwd: None,
    };
    let mut child = spawn(&command).unwrap();
    read_until(&mut child.events, "system.hello").await;
    drop(child.stdin);
    let (_, _, exit) = collect(&mut child.events).await;
    assert_eq!(exit.and_then(|info| info.code), Some(0));
}

#[tokio::test]
async fn a_bare_name_that_is_nowhere_on_path_does_not_start() {
    let dir = tempfile::tempdir().unwrap();
    let command = SpawnSpec {
        program: PathBuf::from("pomi-no-such-core"),
        args: vec![],
        env: vec![("PATH".into(), dir.path().as_os_str().to_owned())],
        cwd: None,
    };
    assert!(spawn(&command).is_err());
}

#[cfg(windows)]
mod windows_launch {
    use std::{ffi::OsString, path::Path};

    use super::*;
    use platform::{fault, resolve_in, Step};

    fn paths(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[test]
    fn a_name_without_an_extension_gets_one_from_pathext_and_the_first_directory_wins() {
        let (first, second) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::write(second.path().join("tool.exe"), b"x").unwrap();
        std::fs::write(second.path().join("tool.cmd"), b"x").unwrap();
        let path_var = paths(&[first.path(), second.path()]);
        let pathext = OsString::from(".COM;.EXE;.BAT;.CMD");
        let found = resolve_in(Path::new("tool"), Some(&path_var), Some(&pathext)).unwrap();
        assert_eq!(found, second.path().join("tool.exe"));
        std::fs::write(first.path().join("tool.exe"), b"x").unwrap();
        let found = resolve_in(Path::new("tool"), Some(&path_var), Some(&pathext)).unwrap();
        assert_eq!(found, first.path().join("tool.exe"));
    }

    #[test]
    fn scripts_are_not_programs_and_a_missing_name_is_an_error_not_a_guess() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("only.cmd"), b"x").unwrap();
        let path_var = paths(&[dir.path()]);
        let pathext = OsString::from(".COM;.EXE;.BAT;.CMD");
        for name in ["only", "absent"] {
            let error = resolve_in(Path::new(name), Some(&path_var), Some(&pathext)).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{name}");
        }
        assert!(resolve_in(Path::new("only"), None, None).is_err());
    }

    #[test]
    fn a_directory_in_the_name_is_a_path_and_is_not_searched() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("run.exe"), b"x").unwrap();
        let given = dir.path().join("sub").join("run");
        let found = resolve_in(&given, Some(&OsString::new()), None).unwrap();
        assert_eq!(found, dir.path().join("sub").join("run.exe"));
        // A name with a folder part never falls back to PATH.
        let path_var = paths(&[dir.path().join("sub").as_path()]);
        assert!(resolve_in(Path::new("other\\run"), Some(&path_var), None).is_err());
    }

    #[tokio::test]
    async fn the_real_python_of_this_machine_starts_when_there_is_one() {
        let works = std::process::Command::new("python")
            .args(["-c", "print(12345)"])
            .output()
            .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains("12345"));
        if !works {
            eprintln!("skipped: no working `python` on PATH");
            return;
        }
        let command = SpawnSpec {
            program: PathBuf::from("python"),
            args: vec!["-c".into(), "print('dev-mode-ok')".into()],
            env: vec![],
            cwd: None,
        };
        let mut child = spawn(&command).unwrap();
        read_until(&mut child.events, "dev-mode-ok").await;
    }

    /// A child that could not be put under supervision is terminated and gone, not left running.
    async fn spawn_failing_at(step: Step) -> u32 {
        fault::fail(step, 1);
        assert!(spawn(&spec("sleep", &[])).is_err());
        let pid = fault::last_pid();
        assert_ne!(pid, 0);
        pid
    }

    #[tokio::test]
    async fn a_failed_job_assignment_leaves_no_running_child() {
        let pid = spawn_failing_at(Step::Assign).await;
        assert!(gone_within(pid, LONG).await);
    }

    #[tokio::test]
    async fn a_failed_resume_leaves_no_running_child() {
        let pid = spawn_failing_at(Step::Resume).await;
        assert!(gone_within(pid, LONG).await);
    }

    #[tokio::test]
    async fn a_failed_termination_is_retried_until_it_works() {
        fault::fail(Step::Terminate, 2);
        let pid = spawn_failing_at(Step::Assign).await;
        fault::fail(Step::Terminate, 0);
        assert!(gone_within(pid, LONG).await);
    }

    #[tokio::test]
    async fn a_termination_that_never_works_leaves_the_child_suspended_not_running() {
        fault::fail(Step::Terminate, 1000);
        let pid = spawn_failing_at(Step::Assign).await;
        fault::fail(Step::Terminate, 0);
        // It stays suspended (it never ran), and nobody pretends it is gone.
        assert!(process_alive(pid), "the unsupervised child is still there");
        // Clean up the stuck child.
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
        assert!(gone_within(pid, LONG).await);
    }
}

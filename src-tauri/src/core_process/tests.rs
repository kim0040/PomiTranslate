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

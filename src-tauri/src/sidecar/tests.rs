use std::time::Duration;

use super::*;
use crate::{
    core_process::ExitInfo,
    test_support::{gone_within, launch, process_alive},
};

fn lines(scans: Vec<Scan>) -> Vec<String> {
    scans
        .into_iter()
        .filter_map(|scan| match scan {
            Scan::Line(line) => Some(String::from_utf8(line).unwrap()),
            Scan::Oversize { .. } => None,
        })
        .collect()
}

fn exited(code: Option<i32>, signal: Option<i32>) -> CoreEvent {
    CoreEvent::Exited(ExitInfo { code, signal })
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
    assert_eq!(
        lines(scanner.push(b"one\ntwo\nthree\n")),
        ["one", "two", "three"]
    );
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
    assert!(
        scanner.push(&[b'x'; 500]).is_empty(),
        "the rest of the line is dropped"
    );
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
    assert_eq!(
        peek_type(br#"{"v": 1, "id": "x", "type": "progress.scan", "p": 1"#).as_deref(),
        Some("progress.scan")
    );
    assert_eq!(peek_type(b"no type here"), None);
}

const HELLO: &[u8] =
    b"{\"v\":1,\"id\":\"boot\",\"type\":\"system.hello\",\"payload\":{\"protocolVersion\":1}}\n";

fn feed(exchange: &mut Exchange, bytes: &[u8]) -> Vec<Step> {
    exchange.on_event(CoreEvent::Stdout(bytes.to_vec()))
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
    for first in [
        &b"garbage\n"[..],
        b"{\"v\":1,\"id\":\"req-1\",\"type\":\"response.ok\"}\n",
    ] {
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

    for writer_kind in [
        "translate.start",
        "restore.start",
        "backups.delete",
        "backups.prune",
        "recovery.start",
    ] {
        let mut writer = Exchange::new("req-1", writer_kind);
        feed(&mut writer, HELLO);
        let steps = big(&mut writer);
        assert!(matches!(&steps[..], [Step::Cancel]), "{writer_kind}");
        assert!(writer.cancelling());
        // The core stops after the cancel: the fault is what gets reported.
        let ended = writer.on_event(exited(Some(0), None));
        assert!(
            matches!(&ended[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL)
        );
    }
}

#[test]
fn a_progress_event_larger_than_a_status_line_is_a_protocol_fault() {
    let progress = |exchange: &mut Exchange, size: usize| {
        let mut line = br#"{"v":1,"id":"r","type":"scan.progress","payload":""#.to_vec();
        line.extend_from_slice(&vec![b'x'; size]);
        line.extend_from_slice(b"\"}\n");
        feed(exchange, &line)
    };
    let mut scan = Exchange::new("r", "scan.start");
    feed(&mut scan, HELLO);
    assert!(matches!(
        &progress(&mut scan, 1000)[..],
        [Step::Progress(_)]
    ));
    let steps = progress(&mut scan, MAX_PROGRESS_BYTES + 10);
    assert!(matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL));
    // A reply may be larger than a progress event: the line limit is what bounds it.
    let mut reply = Exchange::new("r", "candidates.page");
    feed(&mut reply, HELLO);
    let mut line = br#"{"v":1,"id":"r","type":"response.ok","payload":{"text":""#.to_vec();
    line.extend_from_slice(&vec![b'x'; MAX_PROGRESS_BYTES * 2]);
    line.extend_from_slice(b"\"}}\n");
    assert!(matches!(&feed(&mut reply, &line)[..], [Step::Done(Ok(_))]));
}

#[test]
fn a_core_that_floods_stdout_with_non_protocol_text_is_stopped() {
    let mut exchange = Exchange::new("r", "candidates.page");
    feed(&mut exchange, HELLO);
    let junk = format!("{}\n", "not protocol ".repeat(80)).into_bytes();
    let mut steps = Vec::new();
    for _ in 0..(MAX_STRAY_BYTES / junk.len() + 5) {
        steps = feed(&mut exchange, &junk);
        if !steps.is_empty() {
            break;
        }
    }
    assert!(
        matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL),
        "{steps:?}"
    );
}

#[test]
fn a_short_request_is_bounded_as_a_whole_but_a_job_is_not() {
    let progress = br#"{"v":1,"id":"r","type":"scan.progress","payload":{"n":1}}"#;
    let mut chunk = progress.to_vec();
    chunk.push(b'\n');
    let mut query = Exchange::new("r", "candidates.page");
    feed(&mut query, HELLO);
    query.total_bytes = MAX_QUERY_BYTES - 10;
    let steps = feed(&mut query, &chunk);
    assert!(matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL));

    let mut job = Exchange::new("r", "scan.start");
    feed(&mut job, HELLO);
    job.total_bytes = MAX_QUERY_BYTES * 4;
    assert!(matches!(&feed(&mut job, &chunk)[..], [Step::Progress(_)]));
}

#[test]
fn the_core_ending_maps_to_stable_codes() {
    assert_eq!(termination_error(Some(0), None).code, code::CORE_STOPPED);
    assert_eq!(termination_error(None, None).code, code::CORE_STOPPED);
    assert_eq!(termination_error(Some(3), None).code, code::CORE_CRASHED);
    assert_eq!(termination_error(None, Some(9)).code, code::CORE_CRASHED);
    let mut exchange = Exchange::new("r", "scan.start");
    feed(&mut exchange, HELLO);
    let steps = exchange.on_event(exited(Some(-1073741819), None));
    assert!(matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_CRASHED));
}

#[test]
fn core_stderr_reaches_the_ring_only_as_known_shapes_without_keys() {
    let _turn = diagnostics::serial();
    diagnostics::global().reset();
    let mut exchange = Exchange::new("r", "scan.start");
    exchange.on_event(CoreEvent::Stderr(
        b"Traceback (most recent call last):
  provider echoed Bearer sk-live-00112233445566778899aabb
[pomi] using sk-live-00112233445566778899aabb
"
        .to_vec(),
    ));
    let kept = diagnostics::global().stderr_lines().join(
        "
",
    );
    assert!(kept.contains("Traceback"));
    assert!(kept.contains("[1 line omitted]"), "{kept}");
    assert!(!kept.contains("sk-live"), "{kept}");
    assert!(!kept.contains("provider echoed"), "{kept}");
    diagnostics::global().reset();
}

#[test]
fn the_secret_in_a_request_is_wiped_when_the_guard_drops() {
    wiped::take();
    let request = serde_json::json!({"v":1,"id":"x","type":"models.list","payload":{"apiKey":"fixture-key-1234567890"}});
    let line = request_line(&request).unwrap();
    assert!(String::from_utf8_lossy(&line).contains("fixture-key-1234567890"));
    assert_eq!(
        line.capacity(),
        line.len(),
        "sized exactly, so no regrown copy is left behind"
    );
    let guard = SecretRequest::new(request);
    assert_eq!(guard["payload"]["apiKey"], "fixture-key-1234567890");
    drop(guard);
    let wipes = wiped::take();
    assert_eq!(wipes.len(), 1, "{wipes:?}");
    assert!(wipes[0].all_zero, "{wipes:?}");
}

#[test]
fn requests_that_run_as_jobs_are_exactly_the_ones_that_write_or_scan() {
    for kind in [
        "scan.start",
        "translate.start",
        "translate.resume",
        "restore.start",
        "recovery.start",
        "jobs.recover",
        "backups.delete",
        "backups.prune",
    ] {
        assert_eq!(lane(kind), Lane::Job, "{kind}");
    }
    for kind in [
        "app.bootstrap",
        "settings.set",
        "candidates.page",
        "estimate.get",
        "backups.list",
        "models.list",
        "review.draft.get",
        "review.draft.set",
        "review.draft.clear",
        "unknown.thing",
    ] {
        assert_eq!(lane(kind), Lane::Query, "{kind}");
    }
    // A scan only reads; everything else that runs as a job writes to a world or the backup store.
    for kind in JOB_REQUESTS {
        assert_eq!(writes_world(kind), *kind != "scan.start", "{kind}");
    }
}

// --- with a real child ------------------------------------------------------------------------

fn request(id: &str, kind: &str) -> Value {
    serde_json::json!({"v": 1, "id": id, "type": kind, "payload": {}})
}

/// The request is written and the core is serving it (its stdin is held by the slot).
async fn wait_until_serving(state: &ActiveSidecar) {
    while !state
        .process()
        .as_ref()
        .is_some_and(|active| active.stdin.is_some())
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("pomi 시험 ")
        .tempdir()
        .unwrap()
}

#[tokio::test]
async fn a_request_round_trips_and_the_slot_is_free_again() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let reply = run(
        &launch("echo", dir.path()),
        &state,
        request("r1", "estimate.get"),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(reply["id"], "r1");
    assert_eq!(reply["type"], "response.ok");
    assert!(!state.busy());
}

#[tokio::test]
async fn progress_is_forwarded_in_order() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let seen = Mutex::new(Vec::new());
    let reply = run(
        &launch("progress", dir.path()),
        &state,
        request("p1", "scan.start"),
        |message| {
            seen.lock()
                .unwrap()
                .push(message["payload"]["n"].as_u64().unwrap());
        },
    )
    .await
    .unwrap();
    assert_eq!(reply["type"], "response.ok");
    assert_eq!(*seen.lock().unwrap(), [1, 2, 3]);
}

#[tokio::test]
async fn the_core_gets_utf8_the_app_identity_and_no_provider_keys() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    // Even if the person's environment has a key, the core is started with it blanked.
    let mut start = launch("env", dir.path());
    start.env.extend(core_environment());
    let reply = run(&start, &state, request("e1", "estimate.get"), |_| {})
        .await
        .unwrap();
    let payload = &reply["payload"];
    assert_eq!(payload["utf8"], "1");
    assert_eq!(payload["io"], "utf-8");
    assert_eq!(payload["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(payload["sha"], crate::BUILD_SHA);
    assert_eq!(payload["date"], crate::BUILD_DATE);
    assert_eq!(payload["openai"], "");
}

#[tokio::test]
async fn a_second_request_while_one_runs_is_refused_as_busy() {
    let (state, dir) = (Arc::new(ActiveSidecar::default()), scratch());
    let first = {
        let (state, start) = (Arc::clone(&state), launch("stall", dir.path()));
        tokio::spawn(
            async move { run(&start, &state, request("a", "translate.start"), |_| {}).await },
        )
    };
    wait_until_serving(&state).await;
    let second = run(
        &launch("echo", dir.path()),
        &state,
        request("b", "estimate.get"),
        |_| {},
    )
    .await;
    assert_eq!(second.unwrap_err().code, code::BUSY);
    // Clean up the stalled one.
    state.request_cancel().unwrap();
    let stopped = state.force_stop(Duration::ZERO).await.unwrap();
    assert!(stopped.was_running);
    assert_eq!(first.await.unwrap().unwrap_err().code, code::CORE_STOPPED);
}

#[tokio::test]
async fn a_core_that_will_not_stop_is_force_stopped_and_the_request_says_so() {
    let (state, dir) = (Arc::new(ActiveSidecar::default()), scratch());
    let job = {
        let (state, start) = (
            Arc::clone(&state),
            launch("stall-with-grandchild", dir.path()),
        );
        tokio::spawn(
            async move { run(&start, &state, request("j", "translate.start"), |_| {}).await },
        )
    };
    wait_until_serving(&state).await;
    // Not yet asked to cancel: a force-stop is refused.
    let refused = state.force_stop(Duration::ZERO).await.unwrap_err();
    assert_eq!(refused.code, code::BUSY);
    assert!(state.busy(), "a refused force-stop leaves the job alone");

    assert!(state.request_cancel().unwrap());
    assert!(
        dir.path().join("active-operation.cancel").exists(),
        "the cancel marker is written as before"
    );
    // Too early after the cancel request for the production wait.
    assert_eq!(
        state
            .force_stop(FORCE_STOP_AFTER_CANCEL)
            .await
            .unwrap_err()
            .code,
        code::BUSY
    );

    let stopped = state.force_stop(Duration::ZERO).await.unwrap();
    assert_eq!(
        stopped,
        ForceStopped {
            was_running: true,
            killed: true
        }
    );
    // The request finished with a truthful reason, and nothing is left running or reserved.
    let error = job.await.unwrap().unwrap_err();
    assert_eq!(error.code, code::CORE_STOPPED);
    assert_eq!(error.detail, Some(detail::JOB_FORCE_STOPPED));
    assert!(!state.busy());
    assert!(
        !dir.path().join("active-operation.cancel").exists(),
        "the marker is removed with the job"
    );
}

#[tokio::test]
async fn force_stop_with_nothing_running_does_nothing() {
    let state = ActiveSidecar::default();
    assert_eq!(
        state.force_stop(Duration::ZERO).await.unwrap(),
        ForceStopped {
            was_running: false,
            killed: false
        }
    );
    assert!(!state.request_cancel().unwrap());
}

#[tokio::test]
async fn the_slot_is_freed_only_after_the_exit_was_observed() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let start = launch("stall", dir.path());
    let spawned = core_process::spawn(&start.spec()).unwrap();
    let pid = spawned.pid;
    *state.process() = Some(ActiveProcess {
        control: Arc::clone(&spawned.control),
        stdin: None,
        cancel_path: start.cancel_path.clone(),
        cancel_requested: None,
        forced: Arc::new(AtomicBool::new(false)),
    });
    // Still running: asking to clear the slot (as a timer would) changes nothing.
    ActiveSidecar::clear(&state.process, pid);
    assert!(state.busy(), "a running core keeps the slot");
    spawned.control.kill_tree();
    assert!(spawned
        .control
        .wait_exit(Duration::from_secs(20))
        .await
        .is_some());
    ActiveSidecar::clear(&state.process, pid);
    assert!(!state.busy());
    assert!(gone_within(pid, Duration::from_secs(5)).await);
}

#[tokio::test]
async fn quitting_kills_the_running_core_at_once() {
    let (state, dir) = (Arc::new(ActiveSidecar::default()), scratch());
    let job = {
        let (state, start) = (
            Arc::clone(&state),
            launch("stall-with-grandchild", dir.path()),
        );
        tokio::spawn(
            async move { run(&start, &state, request("q", "translate.start"), |_| {}).await },
        )
    };
    wait_until_serving(&state).await;
    let pid = state
        .process()
        .as_ref()
        .map(|active| active.control.pid())
        .unwrap();
    assert!(process_alive(pid));
    state.kill_now();
    assert!(gone_within(pid, Duration::from_secs(20)).await);
    let error = job.await.unwrap().unwrap_err();
    assert_eq!(error.code, code::CORE_CRASHED, "{error:?}");
}

#[tokio::test]
async fn a_core_flooding_stdout_is_stopped_and_gone() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let error = run(
        &launch("noise", dir.path()),
        &state,
        request("n", "estimate.get"),
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, code::CORE_PROTOCOL);
    assert!(!state.busy());
}

#[tokio::test]
async fn a_core_that_cannot_be_started_is_a_spawn_error_and_leaves_no_slot() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let mut start = launch("echo", dir.path());
    start.program = dir.path().join("missing core.exe");
    let error = run(&start, &state, request("m", "estimate.get"), |_| {})
        .await
        .unwrap_err();
    assert_eq!(error.code, code::CORE_SPAWN_FAILED);
    assert!(!state.busy());
}

// --- H4: only a valid terminal reply ends an exchange -------------------------------------------

#[test]
fn a_same_id_event_of_another_type_is_ignored_and_the_real_result_still_arrives() {
    let mut exchange = Exchange::new("req-1", "translate.start");
    feed(&mut exchange, HELLO);
    for unexpected in [
        &br#"{"v":1,"id":"req-1","type":"job.surprise","payload":{"text":"x"}}"#[..],
        br#"{"v":1,"id":"req-1","type":"status.note"}"#,
        br#"{"v":1,"id":"req-1","type":7}"#,
    ] {
        let mut line = unexpected.to_vec();
        line.push(b'\n');
        assert!(
            feed(&mut exchange, &line).is_empty(),
            "{}",
            String::from_utf8_lossy(unexpected)
        );
    }
    let steps = feed(
        &mut exchange,
        b"{\"v\":1,\"id\":\"req-1\",\"type\":\"response.ok\",\"payload\":{\"saved\":3}}\n",
    );
    assert!(matches!(&steps[..], [Step::Done(Ok(reply))] if reply["payload"]["saved"] == 3));
}

/// Terminal replies that carry the request id but are not valid (R6).
fn malformed_terminals() -> Vec<Vec<u8>> {
    let long_code = "A".repeat(65);
    vec![
        br#"{"v":1,"id":"r","type":"response.ok"}"#.to_vec(),
        br#"{"v":2,"id":"r","type":"response.ok","payload":{}}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.ok","payload":null}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.ok","payload":"text"}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.ok","payload":[1,2]}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error"}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":"text"}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":{}}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":{"message":"m"}}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":{"code":"X"}}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":{"code":"X","message":3}}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":{"code":"","message":"m"}}"#.to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":{"code":"lower","message":"m"}}"#
            .to_vec(),
        br#"{"v":1,"id":"r","type":"response.error","error":{"code":"HAS SPACE","message":"m"}}"#
            .to_vec(),
        format!(
            r#"{{"v":1,"id":"r","type":"response.error","error":{{"code":"{long_code}","message":"m"}}}}"#
        )
        .into_bytes(),
    ]
}

#[test]
fn a_malformed_terminal_reply_stops_a_query_and_cancels_a_writer() {
    for body in malformed_terminals() {
        let mut line = body.clone();
        line.push(b'\n');
        let shown = String::from_utf8_lossy(&body).into_owned();

        let mut query = Exchange::new("r", "estimate.get");
        feed(&mut query, HELLO);
        let steps = feed(&mut query, &line);
        assert!(
            matches!(&steps[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL),
            "{shown}: {steps:?}"
        );

        let mut writer = Exchange::new("r", "translate.start");
        feed(&mut writer, HELLO);
        let steps = feed(&mut writer, &line);
        assert!(matches!(&steps[..], [Step::Cancel]), "{shown}: {steps:?}");
        assert!(writer.cancelling(), "{shown}");
        let ended = writer.on_event(exited(Some(0), None));
        assert!(
            matches!(&ended[..], [Step::Done(Err(error))] if error.code == code::CORE_PROTOCOL),
            "{shown}"
        );
    }
}

#[test]
fn a_valid_error_reply_and_an_object_reply_end_the_exchange() {
    for body in [
        &br#"{"v":1,"id":"r","type":"response.error","error":{"code":"X","message":"m"}}"#[..],
        br#"{"v":1,"id":"r","type":"response.error","error":{"code":"WORLD_LOCKED_2","message":""}}"#,
        br#"{"v":1,"id":"r","type":"response.ok","payload":{}}"#,
        br#"{"v":1,"id":"r","type":"response.ok","payload":{"items":[1,2]}}"#,
    ] {
        let mut exchange = Exchange::new("r", "estimate.get");
        feed(&mut exchange, HELLO);
        let mut line = body.to_vec();
        line.push(b'\n');
        assert!(
            matches!(&feed(&mut exchange, &line)[..], [Step::Done(Ok(_))]),
            "{}",
            String::from_utf8_lossy(body)
        );
    }
}

#[test]
fn an_unexpected_event_is_logged_without_its_type_or_content() {
    let _turn = diagnostics::serial();
    let dir = tempfile::tempdir().unwrap();
    diagnostics::global().reset();
    diagnostics::global().set_dir(dir.path().to_path_buf());
    let mut exchange = Exchange::new("r", "translate.start");
    feed(&mut exchange, HELLO);
    feed(
        &mut exchange,
        br#"{"v":1,"id":"r","type":"job.surprise-violet-lantern-castle-rose","payload":{"text":"WORLD-TEXT-IN-EVENT sk-or-v1-abcdef0123456789abcdef"}}
"#,
    );
    let log = diagnostics::global().log_file_text();
    assert!(log.contains("ignored a message"), "{log}");
    for leaked in [
        "job.surprise",
        "violet-lantern-castle-rose",
        "WORLD-TEXT-IN-EVENT",
        "sk-or-v1",
    ] {
        assert!(!log.contains(leaked), "{leaked} leaked:\n{log}");
    }
    diagnostics::global().reset();
}

// --- R6 / R7 with a real child --------------------------------------------------------------------

#[tokio::test]
async fn a_malformed_terminal_reply_from_a_real_core_stops_a_query_at_once() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let started = std::time::Instant::now();
    let error = run(
        &launch("malformed-terminal", dir.path()),
        &state,
        request("q1", "estimate.get"),
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, code::CORE_PROTOCOL);
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(!state.busy(), "the core is gone");
}

#[tokio::test]
async fn a_malformed_terminal_reply_from_a_real_writer_gets_the_cooperative_cancel_first() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let started = std::time::Instant::now();
    let reply = run(
        &launch("malformed-then-cancel", dir.path()),
        &state,
        request("w1", "translate.start"),
        |_| {},
    )
    .await
    .unwrap();
    // The helper answers only once the cancel marker exists, so this reply is the proof that the
    // writer was asked to cancel instead of being killed mid-write; the answer to that cancel is
    // the job's result, as for any other cancel.
    assert_eq!(reply["payload"]["cancelled"], true);
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
    assert!(!state.busy());
}

#[tokio::test]
async fn a_short_request_that_is_not_answered_in_time_stops_the_core_with_a_timeout() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let started = std::time::Instant::now();
    let error = run_with_deadline(
        &launch("stall", dir.path()),
        &state,
        request("q1", "candidates.page"),
        |_| {},
        Duration::from_millis(500),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, code::CORE_TIMEOUT);
    assert!(started.elapsed() < Duration::from_secs(20));
    assert!(!state.busy(), "the core was stopped and its end seen");
    // The slot is free: the next request starts.
    let ok = run(
        &launch("echo", dir.path()),
        &state,
        request("q2", "estimate.get"),
        |_| {},
    )
    .await;
    assert!(ok.is_ok());
}

#[tokio::test]
async fn the_deadline_covers_model_lists_and_connection_checks_but_not_world_jobs() {
    for kind in ["models.list", "provider.usage", "prompt.enhance"] {
        assert_eq!(lane(kind), Lane::Query, "{kind}");
    }
    for kind in JOB_REQUESTS {
        assert_eq!(lane(kind), Lane::Job, "{kind}");
    }
    let (state, dir) = (ActiveSidecar::default(), scratch());
    // The same slow core: a query is cut off, a job is let finish.
    let query = run_with_deadline(
        &launch("slow-reply", dir.path()),
        &state,
        request("q1", "models.list"),
        |_| {},
        Duration::from_millis(300),
    )
    .await;
    assert_eq!(query.unwrap_err().code, code::CORE_TIMEOUT);
    let job = run_with_deadline(
        &launch("slow-reply", dir.path()),
        &state,
        request("j1", "scan.start"),
        |_| {},
        Duration::from_millis(300),
    )
    .await;
    assert!(job.is_ok(), "a world job has no blanket timeout: {job:?}");
}

#[tokio::test]
async fn a_same_id_unknown_event_before_the_real_result_does_not_kill_the_child() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    // A writer: the old behaviour treated the first same-id message as the reply and ended the
    // request, so the real result was lost and the core was killed.
    let reply = run(
        &launch("unknown-event", dir.path()),
        &state,
        request("w1", "translate.start"),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(reply["payload"]["done"], true);
    assert!(!state.busy());
}

// --- H3: what the core writes on stderr ---------------------------------------------------------

#[test]
fn stderr_lines_are_classified_as_whole_lines_across_chunk_boundaries() {
    let _turn = diagnostics::serial();
    let dir = tempfile::tempdir().unwrap();
    diagnostics::global().reset();
    diagnostics::global().set_dir(dir.path().to_path_buf());
    let mut sink = StderrSink::new();
    // A secret split across three chunks, then a world-text line, then an unfinished last line.
    sink.push(b"[pomi] key sk-or-v1-abcd");
    sink.push(b"ef0123456789abc");
    sink.push(b"def0123 done\nThe villagers of Oakhaven trade wheat.\n[pomi] last wo");
    sink.finish();
    let all = format!(
        "{}\n{}",
        diagnostics::global().snapshot(),
        diagnostics::global().log_file_text()
    );
    for leaked in [
        "sk-or",
        "abcdef",
        "0123456789abc",
        "villagers",
        "Oakhaven",
        "REDACTED",
        "last wo",
        "key ",
    ] {
        assert!(!all.contains(leaked), "{leaked} leaked:\n{all}");
    }
    // Both prefixed lines are one fixed shape, and the unfinished one is flushed as a whole line.
    assert!(
        all.matches("[pomi] [message omitted]").count() >= 2,
        "{all}"
    );
    assert!(all.contains("[1 line omitted]"), "{all}");
    diagnostics::global().reset();
}

#[test]
fn stray_stdout_is_never_logged_as_text() {
    let _turn = diagnostics::serial();
    let dir = tempfile::tempdir().unwrap();
    diagnostics::global().reset();
    diagnostics::global().set_dir(dir.path().to_path_buf());
    let mut exchange = Exchange::new("r", "scan.start");
    feed(&mut exchange, HELLO);
    feed(
        &mut exchange,
        "한글 로그 줄 sk-or-v1-abcdef0123456789abcdef\n".as_bytes(),
    );
    feed(&mut exchange, b"DeprecationWarning: something noisy\n");
    let log = diagnostics::global().log_file_text();
    for leaked in ["한글", "sk-or", "noisy"] {
        assert!(!log.contains(leaked), "{leaked} leaked:\n{log}");
    }
    diagnostics::global().reset();
}

// The turn is held across the run on purpose: the test reads the process-wide diagnostics, and its
// runtime has a single thread.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_core_writing_every_kind_of_stderr_leaves_only_known_shapes_in_the_log_and_the_export() {
    let _turn = diagnostics::serial();
    let (state, dir) = (ActiveSidecar::default(), scratch());
    let logs = tempfile::tempdir().unwrap();
    diagnostics::global().reset();
    diagnostics::global().set_dir(logs.path().to_path_buf());
    run(
        &launch("stderr-mix", dir.path()),
        &state,
        request("s1", "scan.start"),
        |_| {},
    )
    .await
    .unwrap();
    let all = format!(
        "{}\n{}",
        diagnostics::global().snapshot(),
        diagnostics::global().log_file_text()
    );
    for leaked in [
        "villagers",
        "Oakhaven",
        "Zq9xK2mP7vL4nR8tB3wY5cH1dF6gJ0aa",
        "WORLD-TEXT-IN-SOURCE",
        "WORLD-TEXT-IN-MESSAGE",
        "someone",
        "secret folder",
        "sk-or-v1-ab",
        "cdef0123456789",
        "stage=scan",
    ] {
        assert!(!all.contains(leaked), "{leaked} leaked:\n{all}");
    }
    for kept in [
        "Traceback (most recent call last):",
        "File \"mwt/extract.py\", line 12, in run",
        "ValueError: [message omitted]",
        "[pomi] [message omitted]",
        "request=scan.start",
    ] {
        assert!(all.contains(kept), "{kept} missing:\n{all}");
    }
    diagnostics::global().reset();
}

// --- M5: the key is wiped whatever happens before the core is started --------------------------

fn request_with_key() -> Value {
    serde_json::json!({
        "v": 1, "id": "k1", "type": "models.list",
        "payload": {"provider": "custom", "apiKey": "fixture-key-1234567890-abcdef"}
    })
}

#[tokio::test]
async fn a_launch_that_cannot_be_resolved_still_wipes_the_key_buffer() {
    let state = ActiveSidecar::default();
    wiped::take();
    let error = exchange_with(
        || Err(IpcError::new(code::CORE_SPAWN_FAILED, "no core here")),
        &state,
        request_with_key(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, code::CORE_SPAWN_FAILED);
    let wipes = wiped::take();
    assert_eq!(wipes.len(), 1, "{wipes:?}");
    assert!(
        wipes[0].all_zero,
        "the whole capacity of the key buffer is zero: {wipes:?}"
    );
}

#[tokio::test]
async fn the_key_buffer_is_wiped_after_a_normal_exchange_and_after_a_busy_refusal() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    wiped::take();
    run(
        &launch("echo", dir.path()),
        &state,
        request_with_key(),
        |_| {},
    )
    .await
    .unwrap();
    assert!(wiped::take().iter().all(|wipe| wipe.all_zero));

    // Refused because the slot is taken: the request is dropped without ever being serialized.
    let spawned = core_process::spawn(&launch("sleep", dir.path()).spec()).unwrap();
    *state.process() = Some(ActiveProcess {
        control: Arc::clone(&spawned.control),
        stdin: None,
        cancel_path: dir.path().join("c"),
        cancel_requested: None,
        forced: Arc::new(AtomicBool::new(false)),
    });
    let error = run(
        &launch("echo", dir.path()),
        &state,
        request_with_key(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, code::BUSY);
    let wipes = wiped::take();
    assert_eq!(wipes.len(), 1, "{wipes:?}");
    assert!(wipes[0].all_zero);
    spawned.control.kill_tree();
}

// --- M4: a wait that fails is not an exit -------------------------------------------------------

#[tokio::test]
async fn a_failed_wait_keeps_the_slot_until_the_exit_is_finally_seen() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    core_process::fault::fail_waits(3);
    let reply = run(
        &launch("echo", dir.path()),
        &state,
        request("m1", "estimate.get"),
        |_| {},
    )
    .await;
    // The failed attempts stopped the core before it could answer, so the request fails - but the
    // slot is released only because the exit was finally seen, never on a guess.
    assert!(
        matches!(&reply, Err(error) if matches!(error.code, code::CORE_STATE_UNKNOWN | code::CORE_STOPPED)),
        "{reply:?}"
    );
    assert!(!state.busy(), "the exit was seen, so the slot was released");
}

#[tokio::test]
async fn a_wait_that_keeps_failing_leaves_the_slot_occupied_and_says_why() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    core_process::fault::fail_waits(u32::MAX);
    let start = launch("stall", dir.path());
    let spawned = core_process::spawn(&start.spec()).unwrap();
    let (pid, control) = (spawned.pid, Arc::clone(&spawned.control));
    *state.process() = Some(ActiveProcess {
        control: Arc::clone(&control),
        stdin: None,
        cancel_path: start.cancel_path.clone(),
        cancel_requested: None,
        forced: Arc::new(AtomicBool::new(false)),
    });
    // Let the first failure happen.
    while !control.is_unknown() {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    ActiveSidecar::clear(&state.process, pid);
    assert!(state.busy(), "an unknown state keeps the slot");
    state.request_cancel().unwrap();
    let error = state.force_stop(Duration::ZERO).await.unwrap_err();
    assert_eq!(error.code, code::CORE_STATE_UNKNOWN);
    assert!(state.busy(), "still occupied after the refused force-stop");
    assert!(gone_within(pid, Duration::from_secs(20)).await);
    drop(spawned);
}

#[tokio::test]
async fn a_run_whose_wait_fails_forever_reports_the_state_as_unknown_and_keeps_the_slot() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    core_process::fault::fail_waits(u32::MAX);
    let outcome = run(
        &launch("stall", dir.path()),
        &state,
        request("m2", "estimate.get"),
        |_| {},
    )
    .await;
    let error = outcome.unwrap_err();
    assert_eq!(error.code, code::CORE_STATE_UNKNOWN, "{error:?}");
    assert!(state.busy(), "nothing was released on a guess");
}

// --- R8: a created child that could not be confirmed gone ----------------------------------------

/// A stand-in for a created child whose termination is not confirmed: it is gone after `after`
/// more attempts to reap it.
struct StuckChild {
    after: u32,
}

impl core_process::Leftover for StuckChild {
    fn reap(&mut self) -> bool {
        if self.after == 0 {
            return true;
        }
        self.after -= 1;
        false
    }
}

#[tokio::test]
async fn no_core_starts_while_a_created_child_is_not_confirmed_gone_and_the_state_is_unknown() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    core_process::retain_leftover(Box::new(StuckChild { after: 2 }));
    for _ in 0..2 {
        let error = run(
            &launch("echo", dir.path()),
            &state,
            request("m1", "estimate.get"),
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, code::CORE_STATE_UNKNOWN, "{error:?}");
        assert!(!state.busy(), "no core is running, so no slot is held");
    }
    assert!(core_process::leftovers_pending());
    // The child is finally reaped: the next request starts normally.
    let reply = run(
        &launch("echo", dir.path()),
        &state,
        request("m2", "estimate.get"),
        |_| {},
    )
    .await;
    assert!(reply.is_ok(), "{reply:?}");
    assert!(!core_process::leftovers_pending());
}

#[test]
fn a_spawn_that_failed_without_a_leftover_is_a_plain_spawn_error() {
    assert!(!core_process::leftovers_pending());
    let error = core_process::SpawnError::Failed(std::io::Error::other("x")).into_ipc();
    assert_eq!(error.code, code::CORE_SPAWN_FAILED);
    let error = core_process::SpawnError::CleanupUnconfirmed.into_ipc();
    assert_eq!(error.code, code::CORE_STATE_UNKNOWN);
}

// --- R10: one maintenance guard ----------------------------------------------------------------------

#[tokio::test]
async fn maintenance_holds_the_gate_and_is_refused_while_a_request_holds_it() {
    let state = ActiveSidecar::default();
    {
        let _request = state.request_gate.try_lock().unwrap();
        assert_eq!(state.maintenance().err().unwrap().code, code::BUSY);
    }
    let guard = state.maintenance().unwrap();
    assert!(
        state.request_gate.try_lock().is_err(),
        "no request can start while maintenance holds the gate"
    );
    assert_eq!(
        state.maintenance().err().unwrap().code,
        code::BUSY,
        "and no second maintenance either"
    );
    drop(guard);
    assert!(state.request_gate.try_lock().is_ok());
}

#[tokio::test]
async fn maintenance_is_refused_while_a_core_is_retained_because_its_end_was_never_seen() {
    let (state, dir) = (ActiveSidecar::default(), scratch());
    core_process::fault::fail_waits(u32::MAX);
    let error = run(
        &launch("stall", dir.path()),
        &state,
        request("m1", "estimate.get"),
        |_| {},
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, code::CORE_STATE_UNKNOWN);
    // A credential reset, an app reset and an update install all take this guard: none of them may
    // change what the core might still be using.
    let refused = state.maintenance().err().expect("refused");
    assert_eq!(refused.code, code::CORE_STATE_UNKNOWN);
    assert!(
        state.request_gate.try_lock().is_ok(),
        "the refusal does not keep the gate"
    );
    state.kill_now();
}

#[tokio::test]
async fn maintenance_is_refused_while_a_created_child_is_not_confirmed_gone() {
    let state = ActiveSidecar::default();
    core_process::retain_leftover(Box::new(StuckChild { after: 0 }));
    let refused = state.maintenance().err().expect("refused");
    assert_eq!(refused.code, code::CORE_STATE_UNKNOWN);
    // `kill_now` takes one more look at it, which is what frees it here.
    state.kill_now();
    assert!(state.maintenance().is_ok());
}

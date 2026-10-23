//! Smoke tests against the real packaged core. They are `#[ignore]`d: they need a built onedir core
//! and a synthetic world, and they take a few seconds each. Run them with
//!
//! ```text
//! POMI_SMOKE_SIDECAR=<...>/pomi-sidecar/pomi-sidecar.exe POMI_SMOKE_WORLD=<copy of a synthetic world> \
//!   cargo test --lib smoke_ -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The world is only ever scanned (read-only); the test compares a SHA-256 of every file before and
//! after. Never point `POMI_SMOKE_WORLD` at a real world.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::*;
use crate::test_support::{gone_within, process_alive};

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is not set")))
}

/// A launch of the real core with its own data, report and cancel folders under `scratch`.
fn real_launch(scratch: &Path) -> Launch {
    let (data, reports) = (scratch.join("데이터 data"), scratch.join("reports"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&reports).unwrap();
    let cancel = reports.join("active-operation.cancel");
    let mut args: Vec<OsString> = sidecar_paths::arguments(&data, &reports, &cancel)
        .into_iter()
        .map(OsString::from)
        .collect();
    args.shrink_to_fit();
    Launch {
        program: env_path("POMI_SMOKE_SIDECAR"),
        args,
        env: core_environment(),
        cwd: reports,
        cancel_path: cancel,
    }
}

fn request(id: &str, kind: &str, payload: Value) -> Value {
    json!({"v": 1, "id": id, "type": kind, "payload": payload})
}

/// (relative path, bytes) of every file under `root`; the worlds used here are a few KiB. The
/// SHA-256 baseline comparison is done by the script that drives these tests.
fn tree_bytes(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(relative, std::fs::read(&path).unwrap());
            }
        }
    }
    out
}

async fn wait_for_pid(state: &ActiveSidecar) -> u32 {
    let started = Instant::now();
    loop {
        if let Some(active) = state.process().as_ref() {
            return active.control.pid();
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no core was started"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Freeze a process so it can neither answer nor react to the end of its stdin.
#[cfg(windows)]
pub(crate) fn suspend(pid: u32) {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Threading::OpenProcess,
    };
    #[link(name = "ntdll")]
    extern "system" {
        fn NtSuspendProcess(process: HANDLE) -> i32;
    }
    const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
    // SAFETY: a handle opened and closed here; NtSuspendProcess only reads it.
    unsafe {
        let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        assert!(
            handle != 0,
            "cannot open pid {pid}: {}",
            std::io::Error::last_os_error()
        );
        let status = NtSuspendProcess(handle);
        CloseHandle(handle);
        assert_eq!(status, 0, "NtSuspendProcess failed: {status:#x}");
    }
}

#[cfg(unix)]
pub(crate) fn suspend(pid: u32) {
    // SAFETY: SIGSTOP to a process this test started.
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGSTOP) }, 0);
}

#[tokio::test]
#[ignore = "needs the built core (POMI_SMOKE_SIDECAR)"]
async fn smoke_spawn_hello_and_bootstrap() {
    let scratch = tempfile::Builder::new()
        .prefix("pomi smoke ")
        .tempdir()
        .unwrap();
    let launch = real_launch(scratch.path());
    let state = ActiveSidecar::default();
    let started = Instant::now();
    // The shell adds `credentialOwner: rust` to these requests (CREDENTIAL_OWNER_REQUESTS), so the
    // core never reads the OS keychain; without it a Linux box with no Secret Service fails the boot.
    let reply = run(
        &launch,
        &state,
        request(
            "smoke-boot",
            "app.bootstrap",
            json!({"credentialOwner": "rust"}),
        ),
        |_| {},
    )
    .await
    .expect("app.bootstrap");
    println!(
        "app.bootstrap (spawn + hello + reply + exit): {} ms",
        started.elapsed().as_millis()
    );
    assert_eq!(reply["type"], "response.ok", "{reply}");
    assert!(!state.busy(), "the slot is free after the core exited");
    let again = run(
        &launch,
        &state,
        request(
            "smoke-boot-2",
            "app.bootstrap",
            json!({"credentialOwner": "rust"}),
        ),
        |_| {},
    )
    .await;
    assert!(
        again.is_ok(),
        "a second core starts after the first: {again:?}"
    );
}

#[tokio::test]
#[ignore = "needs the built core (POMI_SMOKE_SIDECAR) and a synthetic world (POMI_SMOKE_WORLD)"]
async fn smoke_scan_a_synthetic_world_without_changing_it() {
    let world = env_path("POMI_SMOKE_WORLD");
    let before = tree_bytes(&world);
    let scratch = tempfile::Builder::new()
        .prefix("pomi smoke ")
        .tempdir()
        .unwrap();
    let launch = real_launch(scratch.path());
    let state = ActiveSidecar::default();
    let progress = std::sync::atomic::AtomicUsize::new(0);
    let reply = run(
        &launch,
        &state,
        request(
            "smoke-scan",
            "scan.start",
            json!({"worldDir": world, "credentialOwner": "rust"}),
        ),
        |_| {
            progress.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        },
    )
    .await
    .expect("scan.start");
    println!(
        "scan.start: type={} candidateCount={} progressMessages={}",
        reply["type"],
        reply["payload"]["candidateCount"],
        progress.load(std::sync::atomic::Ordering::Relaxed)
    );
    assert_eq!(reply["type"], "response.ok", "{reply}");
    assert!(
        reply["payload"]["candidateCount"].as_u64().unwrap_or(0) >= 1,
        "{reply}"
    );
    assert_eq!(
        tree_bytes(&world),
        before,
        "a scan must not change the world"
    );
    assert!(!state.busy());
}

#[tokio::test]
#[ignore = "needs the built core (POMI_SMOKE_SIDECAR) and a synthetic world (POMI_SMOKE_WORLD)"]
async fn smoke_cancel_a_running_scan_writes_the_marker_and_the_job_ends() {
    let world = env_path("POMI_SMOKE_WORLD");
    let before = tree_bytes(&world);
    let scratch = tempfile::Builder::new()
        .prefix("pomi smoke ")
        .tempdir()
        .unwrap();
    let launch = real_launch(scratch.path());
    let state = Arc::new(ActiveSidecar::default());
    let job = {
        let (state, launch, world) = (Arc::clone(&state), launch.clone(), world.clone());
        tokio::spawn(async move {
            run(
                &launch,
                &state,
                request(
                    "smoke-cancel",
                    "scan.start",
                    json!({"worldDir": world, "credentialOwner": "rust"}),
                ),
                |_| {},
            )
            .await
        })
    };
    wait_for_pid(&state).await;
    let asked = state.request_cancel().expect("request_cancel");
    println!("request_cancel while running -> {asked}");
    assert!(asked, "a running job accepts a cancel request");
    let outcome = tokio::time::timeout(Duration::from_secs(60), job)
        .await
        .expect("the job ends")
        .unwrap();
    // A tiny world may finish before the marker is looked at; either way the job ends by itself.
    println!(
        "cancelled scan ended with: {}",
        match &outcome {
            Ok(reply) => format!("reply {}", reply["type"]),
            Err(error) => format!("error {}", error.code),
        }
    );
    assert!(
        !state.busy(),
        "the slot is cleared once the exit is observed"
    );
    assert!(
        !launch.cancel_path.exists(),
        "the marker is removed with the job"
    );
    assert_eq!(tree_bytes(&world), before);
}

#[tokio::test]
#[ignore = "needs the built core (POMI_SMOKE_SIDECAR); Windows or Unix"]
async fn smoke_force_stop_a_core_that_cannot_react() {
    let scratch = tempfile::Builder::new()
        .prefix("pomi smoke ")
        .tempdir()
        .unwrap();
    let launch = real_launch(scratch.path());
    let state = Arc::new(ActiveSidecar::default());
    let world = scratch.path().join("no-such-world");
    let job = {
        let (state, launch) = (Arc::clone(&state), launch.clone());
        tokio::spawn(async move {
            run(
                &launch,
                &state,
                request(
                    "smoke-stall",
                    "scan.start",
                    json!({"worldDir": world, "credentialOwner": "rust"}),
                ),
                |_| {},
            )
            .await
        })
    };
    let pid = wait_for_pid(&state).await;
    // Python needs ~0.4 s to start; freezing it now means it never answers and never sees the EOF.
    suspend(pid);
    assert!(process_alive(pid));
    assert!(state.request_cancel().expect("request_cancel"));
    let started = Instant::now();
    let stopped = state.force_stop(Duration::ZERO).await.expect("force_stop");
    println!(
        "force_stop of a frozen real core: {stopped:?} in {} ms",
        started.elapsed().as_millis()
    );
    assert_eq!(
        stopped,
        ForceStopped {
            was_running: true,
            killed: true
        }
    );
    assert!(
        gone_within(pid, Duration::from_secs(10)).await,
        "the frozen core is gone"
    );
    let error = job.await.unwrap().unwrap_err();
    println!("the request reported: {} / {:?}", error.code, error.detail);
    assert_eq!(error.code, code::CORE_STOPPED);
    assert_eq!(error.detail, Some(detail::JOB_FORCE_STOPPED));
    assert!(!state.busy());
}

/// The parent half of the orphan proof. It starts the real core, freezes it (so only the Job Object
/// can end it, not the end of its stdin), writes the pid to `POMI_SMOKE_PIDFILE` and then waits to
/// be killed from outside with `taskkill /F`, which gives it no chance to clean up.
#[tokio::test]
#[ignore = "driven by the orphan check script"]
async fn smoke_orphan_parent_waits_to_be_killed() {
    let scratch = tempfile::Builder::new()
        .prefix("pomi smoke ")
        .tempdir()
        .unwrap();
    let launch = real_launch(scratch.path());
    let child = core_process::spawn(&launch.spec()).expect("spawn the real core");
    suspend(child.pid);
    std::fs::write(env_path("POMI_SMOKE_PIDFILE"), child.pid.to_string()).unwrap();
    tokio::time::sleep(Duration::from_secs(600)).await;
    drop(child);
}

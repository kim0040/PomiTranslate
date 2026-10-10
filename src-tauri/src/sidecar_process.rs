//! One sidecar child process: stdout chunks, a deadline-bounded request write, and a staged stop.
//!
//! The packaged core is a PyInstaller one-file binary. Its bootloader extracts the program into a
//! `_MEI*` folder, runs the real interpreter as a child and deletes the folder only when that child
//! exits on its own. Killing the bootloader leaks the folder, and on POSIX it also orphans the
//! interpreter, which then keeps running. So the shell never kills first: it closes stdin (the core
//! exits after its one request), waits, asks with SIGTERM (the POSIX bootloader forwards it and the
//! core turns it into a cooperative cancel), and kills only after both waits pass.
use shared_child::SharedChild;
use std::{
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, ExitStatus, Stdio},
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::{mpsc, oneshot};

pub enum Output {
    Chunk(Vec<u8>),
    Closed,
}

pub struct Spawned {
    pub child: Arc<SharedChild>,
    pub stdin: Option<ChildStdin>,
    pub output: mpsc::Receiver<Output>,
}

/// Start the command with piped stdio. stdout arrives as raw chunks; stderr is drained and
/// dropped because it can carry private world paths and provider errors.
pub fn spawn(mut command: Command) -> std::io::Result<Spawned> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = Arc::new(SharedChild::spawn(&mut command)?);
    let stdin = child.take_stdin();
    let (sender, output) = mpsc::channel(32);
    if let Some(mut stdout) = child.take_stdout() {
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if sender
                            .blocking_send(Output::Chunk(buffer[..read].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = sender.blocking_send(Output::Closed);
        });
    }
    if let Some(mut stderr) = child.take_stderr() {
        std::thread::spawn(move || {
            let mut sink = [0u8; 8192];
            loop {
                match stderr.read(&mut sink) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
    }
    Ok(Spawned {
        child,
        stdin,
        output,
    })
}

#[derive(Debug, PartialEq)]
pub enum WriteFailure {
    Failed,
    TimedOut,
}

/// Write the whole request and close stdin, without blocking the async runtime. A child that
/// never reads cannot hold the caller past `limit`; the writer thread ends when the child stops.
pub async fn write_and_close(
    stdin: ChildStdin,
    line: zeroize::Zeroizing<Vec<u8>>,
    limit: Duration,
) -> Result<(), WriteFailure> {
    let (done, result) = oneshot::channel();
    std::thread::spawn(move || {
        let mut stdin = stdin;
        let outcome = stdin.write_all(&line).and_then(|()| stdin.flush());
        drop(stdin);
        drop(line);
        let _ = done.send(outcome.is_ok());
    });
    match tokio::time::timeout(limit, result).await {
        Ok(Ok(true)) => Ok(()),
        Ok(_) => Err(WriteFailure::Failed),
        Err(_) => Err(WriteFailure::TimedOut),
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StopPlan {
    /// Time to exit on its own (stdin is closed; a cancel file may have been written).
    pub natural: Duration,
    /// Time to finish after SIGTERM. Windows has no SIGTERM, so this is added to `natural` there.
    pub terminate: Duration,
    /// Time to be reaped after a hard kill.
    pub after_kill: Duration,
}

/// After the final response the core is idle and exits as soon as it sees stdin closed. This wait
/// runs in the background, so it is generous: the bootloader may still be deleting its extraction
/// folder (slow under on-access virus scanning), and a kill then would leak part of it.
pub const AFTER_RESPONSE: StopPlan = StopPlan {
    natural: Duration::from_secs(15),
    terminate: Duration::from_secs(5),
    after_kill: Duration::from_secs(2),
};

/// A timeout, bad message or protocol error can interrupt real work. The cancel file and SIGTERM
/// let a write reach a safe stopping point before the kill.
pub const ABNORMAL: StopPlan = StopPlan {
    natural: Duration::from_secs(3),
    terminate: Duration::from_secs(10),
    after_kill: Duration::from_secs(2),
};

/// The child closed stdout on its own; it is already exiting.
pub const ALREADY_STOPPING: StopPlan = StopPlan {
    natural: Duration::from_secs(2),
    terminate: Duration::from_secs(3),
    after_kill: Duration::from_secs(2),
};

#[derive(Debug)]
pub enum Stopped {
    /// The process ended before any kill from this shell.
    Exited(ExitStatus),
    /// This shell killed it. A one-file bootloader killed this way can leave its child running.
    Killed,
    /// It could not be confirmed gone.
    Unconfirmed,
}

impl Stopped {
    /// True only when nothing of the core can still be running. A one-file bootloader waits for its
    /// child before it exits, so its own exit (other than SIGKILL from someone else) confirms both.
    pub fn confirmed(&self) -> bool {
        match self {
            Self::Exited(status) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal() != Some(libc::SIGKILL)
                }
                #[cfg(not(unix))]
                {
                    let _ = status;
                    true
                }
            }
            Self::Killed | Self::Unconfirmed => false,
        }
    }
}

pub fn stop_blocking(child: &SharedChild, plan: StopPlan) -> Stopped {
    #[cfg(unix)]
    let natural = plan.natural;
    #[cfg(not(unix))]
    let natural = plan.natural + plan.terminate;
    if let Ok(Some(status)) = child.wait_timeout(natural) {
        return Stopped::Exited(status);
    }
    #[cfg(unix)]
    {
        use shared_child::unix::SharedChildExt;
        if child.send_signal(libc::SIGTERM).is_ok() {
            if let Ok(Some(status)) = child.wait_timeout(plan.terminate) {
                return Stopped::Exited(status);
            }
        }
    }
    let _ = child.kill();
    match child.wait_timeout(plan.after_kill) {
        Ok(Some(_)) => Stopped::Killed,
        _ => Stopped::Unconfirmed,
    }
}

/// Run the staged stop on a plain thread and await it without blocking the async runtime.
pub async fn stop(child: Arc<SharedChild>, plan: StopPlan) -> Stopped {
    let (done, result) = oneshot::channel();
    std::thread::spawn(move || {
        let _ = done.send(stop_blocking(&child, plan));
    });
    result.await.unwrap_or(Stopped::Unconfirmed)
}

/// Settle the cancel file after a stop. It is removed only when the core is confirmed gone; while
/// any part of it may still run, the file stays so that part stops at its next cancel check.
pub fn settle_cancel_file(cancel_path: &Path, stopped: &Stopped) {
    if stopped.confirmed() {
        let _ = std::fs::remove_file(cancel_path);
    } else {
        let _ = std::fs::write(cancel_path, b"cancel");
    }
}

/// Each process gets its own cancel file, so settling one process can never remove or create the
/// cancel request of the next one.
pub fn cancel_file(report_dir: &Path) -> Result<PathBuf, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut nonce = [0u8; 8];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "Secure randomness is unavailable")?;
    let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(report_dir.join(format!("active-operation-{suffix}.cancel")))
}

fn older_than(path: &Path, age: Duration) -> bool {
    path.symlink_metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|elapsed| elapsed >= age)
}

/// Remove cancel files left behind by processes that could not be confirmed gone, once they are
/// old enough that the process has long reached a cancel check.
pub fn sweep_cancel_files(report_dir: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(report_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let path = entry.path();
        if name.starts_with("active-operation")
            && name.ends_with(".cancel")
            && entry.file_type().is_ok_and(|kind| kind.is_file())
            && older_than(&path, age)
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The one-file bootloader extracts into this app-owned folder instead of the shared system temp
/// folder (`TMPDIR` on POSIX, `TMP`/`TEMP` on Windows). A folder leaked by a hard kill can then be
/// found and removed without touching any other program's `_MEI*` folder.
pub fn extraction_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("sidecar-tmp")
}

pub fn use_extraction_dir(command: &mut Command, dir: &Path) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        command.env("TMPDIR", dir);
    }
    #[cfg(windows)]
    {
        command.env("TMP", dir).env("TEMP", dir);
    }
}

/// Remove extraction folders that no running core can own: called at app start, before this
/// instance starts any core, and limited to folders old enough that an orphan of a crashed earlier
/// instance has finished its cooperative stop.
pub fn sweep_extractions(dir: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with("_MEI")
            && entry.file_type().is_ok_and(|kind| kind.is_dir())
            && older_than(&path, age)
        {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    const FAST: StopPlan = StopPlan {
        natural: Duration::from_millis(1500),
        terminate: Duration::from_millis(1500),
        after_kill: Duration::from_secs(2),
    };

    #[test]
    fn a_core_that_exits_on_closed_stdin_is_never_signalled() {
        runtime().block_on(async {
            // Records any SIGTERM it receives; exits normally when stdin reaches EOF.
            let dir = tempfile::tempdir().unwrap();
            let marker = dir.path().join("terminated");
            let script = format!(
                "trap 'touch \"{}\"; exit 3' TERM; echo ready; cat >/dev/null; exit 0",
                marker.display()
            );
            let mut spawned = spawn(shell(&script)).unwrap();
            assert!(matches!(spawned.output.recv().await, Some(Output::Chunk(_))));
            let stdin = spawned.stdin.take().unwrap();
            write_and_close(stdin, zeroize::Zeroizing::new(b"{}\n".to_vec()), Duration::from_secs(5))
                .await
                .unwrap();
            let stopped = stop(spawned.child.clone(), FAST).await;
            assert!(matches!(&stopped, Stopped::Exited(status) if status.success()), "{stopped:?}");
            assert!(stopped.confirmed());
            assert!(!marker.exists(), "a cooperative core must not receive SIGTERM");
        });
    }

    #[test]
    fn a_busy_core_gets_sigterm_before_any_kill_and_is_confirmed_gone() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("terminated");
        let script = format!(
            "trap 'touch \"{}\"; exit 0' TERM; while true; do sleep 0.05; done",
            marker.display()
        );
        let spawned = spawn(shell(&script)).unwrap();
        drop(spawned.stdin);
        std::thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        let stopped = stop_blocking(&spawned.child, FAST);
        assert!(matches!(stopped, Stopped::Exited(_)), "{stopped:?}");
        assert!(stopped.confirmed());
        assert!(marker.exists(), "SIGTERM is the second stage");
        assert!(started.elapsed() >= FAST.natural, "natural exit gets its full wait first");
    }

    #[test]
    fn a_core_that_ignores_sigterm_is_killed_and_not_reported_as_confirmed() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = dir.path().join("active-operation-test.cancel");
        let spawned = spawn(shell("trap '' TERM; while true; do sleep 0.05; done")).unwrap();
        drop(spawned.stdin);
        std::thread::sleep(Duration::from_millis(200));
        let stopped = stop_blocking(&spawned.child, FAST);
        assert!(matches!(stopped, Stopped::Killed), "{stopped:?}");
        assert!(!stopped.confirmed());
        settle_cancel_file(&cancel, &stopped);
        assert!(cancel.is_file(), "an unconfirmed stop keeps the cancel request in place");
        let clean = Stopped::Exited(std::process::Command::new("/usr/bin/true").status().unwrap());
        settle_cancel_file(&cancel, &clean);
        assert!(!cancel.exists(), "a confirmed stop removes it");
    }

    #[test]
    fn a_child_that_never_reads_cannot_hold_the_request_write() {
        runtime().block_on(async {
            let mut spawned = spawn(shell("sleep 30")).unwrap();
            let stdin = spawned.stdin.take().unwrap();
            // Larger than any pipe buffer, so the write must block.
            let line = zeroize::Zeroizing::new(vec![b'x'; 4 * 1024 * 1024]);
            let started = Instant::now();
            assert_eq!(
                write_and_close(stdin, line, Duration::from_millis(300)).await,
                Err(WriteFailure::TimedOut)
            );
            assert!(started.elapsed() < Duration::from_secs(5));
            let _ = spawned.child.kill();
            let _ = spawned.child.wait();
        });
    }

    #[test]
    fn closed_stdout_is_reported_once_the_child_stops() {
        runtime().block_on(async {
            let mut spawned = spawn(shell("echo one; exit 0")).unwrap();
            let mut chunks = Vec::new();
            loop {
                match spawned.output.recv().await {
                    Some(Output::Chunk(bytes)) => chunks.extend(bytes),
                    Some(Output::Closed) | None => break,
                }
            }
            assert_eq!(chunks, b"one\n");
        });
    }

    #[test]
    fn cancel_files_are_unique_and_only_old_ones_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let first = cancel_file(dir.path()).unwrap();
        let second = cancel_file(dir.path()).unwrap();
        assert_ne!(first, second);
        assert!(first.file_name().unwrap().to_string_lossy().starts_with("active-operation-"));
        std::fs::write(&first, b"cancel").unwrap();
        std::fs::write(dir.path().join("unrelated.cancel"), b"keep").unwrap();
        sweep_cancel_files(dir.path(), Duration::from_secs(3600));
        assert!(first.exists(), "a fresh cancel file may belong to a running core");
        sweep_cancel_files(dir.path(), Duration::ZERO);
        assert!(!first.exists());
        assert!(dir.path().join("unrelated.cancel").exists());
    }

    #[test]
    fn only_old_extraction_folders_in_the_app_folder_are_swept() {
        let dir = tempfile::tempdir().unwrap();
        let extraction = extraction_dir(dir.path());
        let mut command = shell("true");
        use_extraction_dir(&mut command, &extraction);
        assert!(extraction.is_dir());
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "TMPDIR" && value == Some(extraction.as_os_str())));
        std::fs::create_dir_all(extraction.join("_MEI12345/lib")).unwrap();
        std::fs::create_dir_all(extraction.join("keep-me")).unwrap();
        sweep_extractions(&extraction, Duration::from_secs(3600));
        assert!(extraction.join("_MEI12345").exists());
        sweep_extractions(&extraction, Duration::ZERO);
        assert!(!extraction.join("_MEI12345").exists());
        assert!(extraction.join("keep-me").exists());
    }
}

//! The translation core as a supervised child process.
//!
//! Every core child is started so that it can be stopped *as a tree* and so that it cannot outlive
//! the app:
//!
//! * Windows: a Job Object per child with `KILL_ON_JOB_CLOSE`; the process is created suspended,
//!   assigned to the job and only then resumed (see `core_process_windows`). Closing the last job
//!   handle - which also happens when the app process dies - kills the whole tree.
//! * Linux/macOS: a new process group per child (`killpg` on force-stop); on Linux additionally
//!   `PR_SET_PDEATHSIG` (see `core_process_unix`). macOS has no such call: there the core relies on
//!   the end of its stdin (the shell's death closes the pipe), which the core treats as "cancel and
//!   exit" (`docs/build.md`, "Process supervision").
//!
//! The rest of the shell sees only [`Spawned`]: piped stdio as events, a [`ProcessControl`] to kill
//! the tree and to observe the exit. A slot that tracks a child is cleared only after
//! [`ProcessControl::wait_exit`] returned, never because a timer ran out (Sol S4). A wait that
//! *fails* is not an exit either: the state becomes "unknown", the tree is stopped again and the
//! observation retried (M4).
use std::{
    ffi::OsString,
    future::Future,
    io,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Weak},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::{mpsc, watch},
    task::JoinHandle,
    time::{sleep, timeout},
};

#[cfg(unix)]
#[path = "core_process_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "core_process_windows.rs"]
mod platform;

/// Size of one read from a pipe.
const PIPE_CHUNK: usize = 64 * 1024;
/// How long output already written by a child that exited is still collected. A grandchild that
/// kept a pipe open must not hold the reader up.
const DRAIN_AFTER_EXIT: Duration = Duration::from_secs(2);
/// Chunks queued between the pipe readers and the request loop. A slow consumer slows the child
/// down (the pipe fills) instead of growing memory.
const EVENT_QUEUE: usize = 64;
/// Fast attempts (each stops the tree again first) to observe the end of a child whose wait failed.
const MAX_OBSERVE_ATTEMPTS: u32 = 12;

/// Pause before the next observation attempt; later attempts wait longer, up to a cap. After
/// `MAX_OBSERVE_ATTEMPTS` the child is only watched, at the cap.
fn observe_backoff(attempt: u32) -> Duration {
    let (base, cap) = if cfg!(test) { (5, 40) } else { (100, 5_000) };
    Duration::from_millis((base << attempt.min(8)).min(cap))
}

/// Test-only: make the next waits on the next spawned child fail, to prove that a failed wait is
/// never taken for an exit.
#[cfg(test)]
pub(crate) mod fault {
    use std::cell::Cell;

    thread_local! {
        static WAIT_FAILURES: Cell<u32> = const { Cell::new(0) };
    }

    /// The next spawned child's first `count` waits fail (`u32::MAX`: all of them).
    pub fn fail_waits(count: u32) {
        WAIT_FAILURES.with(|cell| cell.set(count));
    }

    pub(super) fn take_wait_failures() -> u32 {
        WAIT_FAILURES.with(|cell| cell.replace(0))
    }
}

/// How a child ended. Windows reports only a code (an NTSTATUS such as 0xC0000005 shows up as a
/// negative `i32`); Unix reports a code or the signal that killed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// What is known about a child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Running,
    /// Waiting on the child failed: it may be running or gone. Never treated as an exit.
    Unknown,
    Exited(ExitInfo),
}

#[derive(Debug)]
pub enum CoreEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    /// Sent once, after the child ended and what it had written was collected.
    Exited(ExitInfo),
    /// Waiting for the child failed; the child's state is unknown (it may still be running).
    Error(String),
}

/// What to run. `env` entries override the inherited environment; an empty value blanks a variable.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub cwd: Option<PathBuf>,
}

pub use platform::Stdin;
type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Wait = Pin<Box<dyn Future<Output = io::Result<ExitInfo>> + Send>>;
/// Starts one observation of the child's end; it can be called again after a failure.
type WaitFn = Box<dyn Fn() -> Wait + Send + Sync>;

/// The platform's way to stop a child tree. Dropping it must also stop the tree if the child is
/// still running (Windows: the job handle closes; Unix: the group is killed).
pub(crate) trait TreeKiller: Send + Sync {
    /// Kill the child and everything it started. Safe to call repeatedly.
    fn kill(&self) -> io::Result<()>;
    /// The leader was reaped: whatever it left behind is killed as well, and the group is no
    /// longer signalled afterwards (its id may be reused).
    fn sweep(&self);
}

/// What a platform's `spawn` returns.
pub(crate) struct RawSpawn {
    pub pid: u32,
    pub stdin: Stdin,
    pub stdout: Reader,
    pub stderr: Reader,
    pub killer: Arc<dyn TreeKiller>,
    pub wait: WaitFn,
}

/// A running (or just ended) core child.
pub struct Spawned {
    pub pid: u32,
    pub stdin: Stdin,
    pub events: mpsc::Receiver<CoreEvent>,
    pub control: Arc<ProcessControl>,
}

/// Kill and observe a child. Cloneable through `Arc`; dropping the last clone stops a child that
/// is still running.
pub struct ProcessControl {
    pid: u32,
    state: watch::Receiver<ProcessState>,
    killer: Arc<dyn TreeKiller>,
}

impl ProcessControl {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn state(&self) -> ProcessState {
        *self.state.borrow()
    }

    /// How the child ended, once that was observed.
    pub fn exit_info(&self) -> Option<ExitInfo> {
        match self.state() {
            ProcessState::Exited(info) => Some(info),
            _ => None,
        }
    }

    pub fn has_exited(&self) -> bool {
        self.exit_info().is_some()
    }

    /// Waiting on the child failed and its end has not been seen since.
    pub fn is_unknown(&self) -> bool {
        self.state() == ProcessState::Unknown
    }

    /// Kill the child and its descendants. The exit is observed with [`Self::wait_exit`].
    pub fn kill_tree(&self) {
        if let Err(error) = self.killer.kill() {
            crate::diagnostics::global().log(
                "ERROR",
                "core",
                &format!(
                    "could not stop the translation core (pid {}): {error}",
                    self.pid
                ),
            );
        }
    }

    /// The exit of the child, once it was observed within `limit`.
    pub async fn wait_exit(&self, limit: Duration) -> Option<ExitInfo> {
        let mut state = self.state.clone();
        let observed = async {
            loop {
                if let ProcessState::Exited(info) = *state.borrow_and_update() {
                    return Some(info);
                }
                if state.changed().await.is_err() {
                    // The watcher is gone (runtime shutdown): whatever it last saw is all there is.
                    return match *state.borrow() {
                        ProcessState::Exited(info) => Some(info),
                        _ => None,
                    };
                }
            }
        };
        timeout(limit, observed).await.unwrap_or(None)
    }
}

fn pump(
    mut reader: Reader,
    tx: mpsc::Sender<CoreEvent>,
    wrap: fn(Vec<u8>) -> CoreEvent,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buffer = vec![0u8; PIPE_CHUNK];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if tx.send(wrap(buffer[..read].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
    })
}

/// Start the child. Needs a running tokio runtime (the pipe readers and the exit watcher are
/// tasks). Fails closed: a child that could not be placed under supervision is not left running.
pub fn spawn(spec: &SpawnSpec) -> io::Result<Spawned> {
    let raw = platform::spawn(spec)?;
    let (tx, events) = mpsc::channel(EVENT_QUEUE);
    let (state_tx, state_rx) = watch::channel(ProcessState::Running);
    let out = pump(raw.stdout, tx.clone(), CoreEvent::Stdout);
    let err = pump(raw.stderr, tx.clone(), CoreEvent::Stderr);
    let killer = Arc::clone(&raw.killer);
    let weak: Weak<dyn TreeKiller> = Arc::downgrade(&raw.killer);
    let wait = raw.wait;
    #[cfg(test)]
    let mut injected_failures = fault::take_wait_failures();
    tokio::spawn(async move {
        let mut attempt = 0u32;
        let info = loop {
            #[cfg(test)]
            let result = if injected_failures > 0 {
                injected_failures -= 1;
                Err(io::Error::other("injected wait failure"))
            } else {
                wait().await
            };
            #[cfg(not(test))]
            let result = wait().await;
            match result {
                Ok(info) => break info,
                Err(error) => {
                    // Not an exit: the child may still be running. Say so, stop the tree again
                    // (bounded) and look again; the slot stays occupied meanwhile.
                    attempt += 1;
                    let _ = state_tx.send(ProcessState::Unknown);
                    if attempt <= MAX_OBSERVE_ATTEMPTS {
                        crate::diagnostics::global().log(
                            "ERROR",
                            "core",
                            &format!(
                                "could not observe the end of the translation core (attempt {attempt}): {error}"
                            ),
                        );
                    }
                    if attempt == 1 {
                        let _ = tx.send(CoreEvent::Error(error.to_string())).await;
                    }
                    if attempt <= MAX_OBSERVE_ATTEMPTS {
                        if let Some(killer) = weak.upgrade() {
                            if let Err(error) = killer.kill() {
                                crate::diagnostics::global().log(
                                    "ERROR",
                                    "core",
                                    &format!("could not stop the translation core again: {error}"),
                                );
                            }
                        }
                    }
                    sleep(observe_backoff(attempt)).await;
                }
            }
        };
        // The leader was reaped, so the tree never outlives it. (Only now: a failed wait reaped
        // nothing.) A control that was dropped already stopped it.
        if let Some(killer) = weak.upgrade() {
            killer.sweep();
        }
        let _ = state_tx.send(ProcessState::Exited(info));
        // What the child had already written is delivered before the end is announced.
        let (mut out, mut err) = (out, err);
        if timeout(DRAIN_AFTER_EXIT, async {
            let _ = (&mut out).await;
            let _ = (&mut err).await;
        })
        .await
        .is_err()
        {
            out.abort();
            err.abort();
        }
        let _ = tx.send(CoreEvent::Exited(info)).await;
    });
    Ok(Spawned {
        pid: raw.pid,
        stdin: raw.stdin,
        events,
        control: Arc::new(ProcessControl {
            pid: raw.pid,
            state: state_rx,
            killer,
        }),
    })
}

#[cfg(test)]
mod tests;

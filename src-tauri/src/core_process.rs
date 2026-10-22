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
//! [`ProcessControl::wait_exit`] returned, never because a timer ran out (Sol S4).
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
    time::timeout,
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

/// How a child ended. Windows reports only a code (an NTSTATUS such as 0xC0000005 shows up as a
/// negative `i32`); Unix reports a code or the signal that killed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug)]
pub enum CoreEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    /// Sent once, after the child ended and what it had written was collected.
    Exited(ExitInfo),
    /// Waiting for the child failed; the child's state is unknown.
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
    pub wait: Wait,
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
    exit: watch::Receiver<Option<ExitInfo>>,
    killer: Arc<dyn TreeKiller>,
}

impl ProcessControl {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        *self.exit.borrow()
    }

    pub fn has_exited(&self) -> bool {
        self.exit_info().is_some()
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
        let mut exit = self.exit.clone();
        let observed = async {
            loop {
                if let Some(info) = *exit.borrow_and_update() {
                    return Some(info);
                }
                if exit.changed().await.is_err() {
                    // The watcher is gone (runtime shutdown): whatever it last saw is all there is.
                    return *exit.borrow();
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
    let (exit_tx, exit_rx) = watch::channel(None);
    let out = pump(raw.stdout, tx.clone(), CoreEvent::Stdout);
    let err = pump(raw.stderr, tx.clone(), CoreEvent::Stderr);
    let killer = Arc::clone(&raw.killer);
    let weak: Weak<dyn TreeKiller> = Arc::downgrade(&raw.killer);
    let wait = raw.wait;
    tokio::spawn(async move {
        let result = wait.await;
        // The tree never outlives its leader. A control that was dropped already stopped it.
        if let Some(killer) = weak.upgrade() {
            killer.sweep();
        }
        let info = match result {
            Ok(info) => info,
            Err(error) => {
                let _ = tx.send(CoreEvent::Error(error.to_string())).await;
                ExitInfo {
                    code: None,
                    signal: None,
                }
            }
        };
        let _ = exit_tx.send(Some(info));
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
            exit: exit_rx,
            killer,
        }),
    })
}

#[cfg(test)]
mod tests;

//! Linux/macOS: the core runs in its own process group so a force-stop reaches everything it
//! started. Linux also asks the kernel to kill the core when the app dies; macOS has no such call
//! and relies on the core noticing the end of its stdin.
use std::{io, os::unix::process::ExitStatusExt, process::Stdio, sync::Mutex};

use tokio::{
    io::AsyncWriteExt,
    process::{ChildStdin, Command},
};
use zeroize::Zeroizing;

use super::{ExitInfo, RawSpawn, SpawnSpec, TreeKiller};

/// The core's stdin. Closing it (dropping this) is the shell's "stop" signal.
pub struct Stdin(ChildStdin);

impl Stdin {
    /// Write the request line. The line is wiped when it is dropped, whatever the outcome.
    pub async fn send(&mut self, line: Zeroizing<Vec<u8>>) -> io::Result<()> {
        self.0.write_all(&line).await?;
        self.0.flush().await
    }
}

struct ProcessGroup {
    pgid: libc::pid_t,
    /// True once the leader was reaped. From then on the group id may belong to somebody else, so
    /// it is never signalled again.
    reaped: Mutex<bool>,
}

impl ProcessGroup {
    fn signal_group(&self, signal: libc::c_int) -> io::Result<()> {
        let reaped = self
            .reaped
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *reaped {
            return Ok(());
        }
        // SAFETY: plain syscall; the leader has not been reaped, so the group id is still ours.
        if unsafe { libc::killpg(self.pgid, signal) } == -1 {
            let error = io::Error::last_os_error();
            // ESRCH: nothing is left in the group.
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
}

impl TreeKiller for ProcessGroup {
    fn kill(&self) -> io::Result<()> {
        self.signal_group(libc::SIGKILL)
    }

    fn sweep(&self) {
        let mut reaped = self
            .reaped
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*reaped {
            // SAFETY: as above; the leader has just been waited for, nothing else can have taken
            // the id yet because members of the group (if any) keep it reserved.
            unsafe {
                libc::killpg(self.pgid, libc::SIGKILL);
            }
            *reaped = true;
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        let _ = self.signal_group(libc::SIGKILL);
    }
}

pub(super) fn spawn(spec: &SpawnSpec) -> io::Result<RawSpawn> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        // A group of its own: `killpg` then stops the core and anything it started.
        .process_group(0);
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    for (name, value) in &spec.env {
        command.env(name, value);
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: only async-signal-safe calls (prctl, getppid) run between fork and exec.
        let parent = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(
                    libc::PR_SET_PDEATHSIG,
                    libc::SIGKILL as libc::c_ulong,
                    0,
                    0,
                    0,
                ) == -1
                {
                    return Err(io::Error::last_os_error());
                }
                // The parent may have died between fork and the prctl above, and the signal is
                // never delivered for a death that already happened: check who the parent is.
                if libc::getppid() != parent {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("the core exited before it was supervised"))?;
    let take = |what: &str| io::Error::new(io::ErrorKind::BrokenPipe, format!("no {what} pipe"));
    let stdin = child.stdin.take().ok_or_else(|| take("stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| take("stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| take("stderr"))?;
    let killer = std::sync::Arc::new(ProcessGroup {
        pgid: pid as libc::pid_t,
        reaped: Mutex::new(false),
    });
    Ok(RawSpawn {
        pid,
        stdin: Stdin(stdin),
        stdout: Box::new(stdout),
        stderr: Box::new(stderr),
        killer,
        wait: Box::pin(async move {
            let status = child.wait().await?;
            Ok(ExitInfo {
                code: status.code(),
                signal: status.signal(),
            })
        }),
    })
}

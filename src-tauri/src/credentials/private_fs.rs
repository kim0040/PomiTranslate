//! User-only files for the credential vault. Every function reports why it failed as a kind
//! (`Permissions`, `Io`, `Busy`) so the vault can answer with a stable code instead of English text.
#[cfg(windows)]
#[path = "private_fs_windows.rs"]
mod windows;

#[cfg(windows)]
pub use windows::{check, directory, open, pin_directory, DirPin, Lock};

use std::{
    fs, io,
    path::Path,
    thread,
    time::{Duration, Instant},
};

#[cfg(not(windows))]
use std::fs::{File, OpenOptions};

#[cfg(unix)]
use std::os::{
    fd::AsRawFd,
    unix::fs::{MetadataExt, OpenOptionsExt},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsErrorKind {
    /// Wrong owner, mode, ACL, link or file type.
    Permissions,
    /// The file system refused or failed.
    Io,
    /// Another holder keeps the lock past the wait limit.
    Busy,
}

#[derive(Debug)]
pub struct FsError {
    pub kind: FsErrorKind,
    pub message: String,
}

impl FsError {
    pub fn permissions(message: impl Into<String>) -> Self {
        Self {
            kind: FsErrorKind::Permissions,
            message: message.into(),
        }
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self {
            kind: FsErrorKind::Io,
            message: message.into(),
        }
    }
    pub fn busy(message: impl Into<String>) -> Self {
        Self {
            kind: FsErrorKind::Busy,
            message: message.into(),
        }
    }
}

impl From<&str> for FsError {
    fn from(message: &str) -> Self {
        Self::io(message)
    }
}

/// How long a caller waits for the vault lock before it answers `VAULT_LOCKED`.
pub const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(15);

/// Poll `try_lock` until it succeeds or the wait ends.
pub(super) fn wait_for_lock(
    mut try_lock: impl FnMut() -> io::Result<bool>,
    wait: Duration,
) -> Result<(), FsError> {
    let deadline = Instant::now() + wait;
    loop {
        match try_lock() {
            Ok(true) => return Ok(()),
            Ok(false) => {
                if Instant::now() >= deadline {
                    return Err(FsError::busy(
                        "Credential storage is locked by another operation",
                    ));
                }
                thread::sleep(LOCK_POLL);
            }
            Err(_) => return Err(FsError::io("Cannot lock credential storage")),
        }
    }
}

/// `fs::rename` with a short retry: on Windows an antivirus scan or the indexer can hold a file for
/// a moment right after it was written (RB-4).
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let mut delay = Duration::from_millis(20);
    let mut last = None;
    for _ in 0..6 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let transient =
                    cfg!(windows) && matches!(error.raw_os_error(), Some(5) | Some(32) | Some(33));
                last = Some(error);
                if !transient {
                    break;
                }
                thread::sleep(delay);
                delay *= 2;
            }
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("rename failed")))
}

/// Make a rename or a delete inside `directory` durable. Windows has no directory fsync.
pub fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(directory)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn check(path: &Path, directory: bool) -> Result<(), FsError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| FsError::io("Cannot inspect credential file permissions"))?;
    if metadata.file_type().is_symlink()
        || metadata.is_dir() != directory
        || (!directory && !metadata.is_file())
    {
        return Err(FsError::permissions(
            "Credential path must be a regular file or private directory, never a symlink",
        ));
    }
    #[cfg(unix)]
    {
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != if directory { 0o700 } else { 0o600 }
            || (!directory && metadata.nlink() != 1)
        {
            return Err(FsError::permissions(
                "Credential files require user-only permissions and ownership",
            ));
        }
    }
    #[cfg(not(unix))]
    return Err(FsError::permissions(
        "Local credential storage requires verified native file permissions on this platform",
    ));
    #[allow(unreachable_code)]
    Ok(())
}

/// A directory that was validated and is held by identity (device and inode) across a sensitive
/// sequence; see the Windows twin for the purpose (H1). `confirm` before every rename below it.
#[cfg(not(windows))]
pub struct DirPin {
    _handle: File,
    #[cfg(unix)]
    identity: (u64, u64),
}

#[cfg(not(windows))]
pub fn pin_directory(path: &Path) -> Result<DirPin, FsError> {
    check(path, true)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC);
    let handle = options
        .open(path)
        .map_err(|_| FsError::io("Cannot inspect credential directory"))?;
    #[cfg(unix)]
    {
        let metadata = handle
            .metadata()
            .map_err(|_| FsError::io("Cannot inspect credential directory"))?;
        Ok(DirPin {
            _handle: handle,
            identity: (metadata.dev(), metadata.ino()),
        })
    }
    #[cfg(not(unix))]
    Ok(DirPin { _handle: handle })
}

#[cfg(not(windows))]
impl DirPin {
    pub fn confirm(&self, path: &Path) -> Result<(), FsError> {
        check(path, true)?;
        #[cfg(unix)]
        {
            let metadata = fs::symlink_metadata(path)
                .map_err(|_| FsError::io("Cannot inspect credential directory"))?;
            if (metadata.dev(), metadata.ino()) != self.identity {
                return Err(FsError::permissions(
                    "The credential directory was replaced while it was in use",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
pub fn directory(path: &Path) -> Result<(), FsError> {
    if !path
        .try_exists()
        .map_err(|_| FsError::io("Cannot inspect credential directory"))?
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let result = fs::DirBuilder::new().mode(0o700).create(path);
            if let Err(error) = result {
                if error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(FsError::io("Cannot create private credential directory"));
                }
            }
        }
        #[cfg(not(unix))]
        return Err(FsError::permissions(
            "Local credential storage requires verified native file permissions on this platform",
        ));
    }
    check(path, true)
}

#[cfg(not(windows))]
pub fn open(path: &Path, create: bool) -> Result<File, FsError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create {
        options.create_new(true);
    }
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let file = options
        .open(path)
        .map_err(|_| FsError::io("Cannot open private credential file"))?;
    check(path, false)?;
    #[cfg(unix)]
    {
        let metadata = file
            .metadata()
            .map_err(|_| FsError::io("Cannot inspect credential file"))?;
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o600
            || metadata.nlink() != 1
        {
            return Err(FsError::permissions("Credential file permissions changed"));
        }
    }
    Ok(file)
}

#[cfg(not(windows))]
pub struct Lock(File);
#[cfg(not(windows))]
impl Lock {
    pub fn acquire(path: &Path, wait: Duration) -> Result<Self, FsError> {
        // The only shared coordination file contains no secrets.
        let file = match open(path, true) {
            Ok(file) => file,
            Err(_) if path.exists() => open(path, false)?,
            Err(error) => return Err(error),
        };
        #[cfg(unix)]
        wait_for_lock(
            || {
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                    return Ok(true);
                }
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::WouldBlock {
                    Ok(false)
                } else {
                    Err(error)
                }
            },
            wait,
        )?;
        #[cfg(not(unix))]
        let _ = wait;
        Ok(Self(file))
    }
}
#[cfg(not(windows))]
impl Drop for Lock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

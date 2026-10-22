//! Windows: every core child lives in a Job Object created for it.
//!
//! The child is created *suspended*, assigned to the job through the process handle and resumed
//! through the primary-thread handle that `CreateProcessW` returned. No instruction of the child
//! runs before it is in the job, so nothing it starts can escape the job - a race that "spawn, then
//! assign" cannot rule out (Sol S1). Any failure on the way terminates the suspended process.
//!
//! The job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and its only handle is owned by the returned
//! [`TreeKiller`], is not inheritable and closes when the app exits or crashes: the tree dies with
//! the app. Only the three pipe ends meant for the child are inherited (an explicit handle list),
//! so no other handle of the app leaks into it.
//!
//! The pipes are anonymous pipes read and written through blocking calls on tokio's blocking pool
//! (`tokio::fs::File`): tokio's own `Command` would give async pipes but not the thread handle.
use std::{
    ffi::{c_void, OsStr, OsString},
    io, mem,
    os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, RawHandle},
    },
    path::Path,
    ptr,
    sync::Arc,
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
        WAIT_OBJECT_0,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
            InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
            UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
            PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
        },
    },
};
use zeroize::Zeroizing;

use super::{ExitInfo, RawSpawn, SpawnSpec, TreeKiller};

/// `ProcThreadAttributeValue(ProcThreadAttributeHandleList, FALSE, TRUE, FALSE)`.
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
/// A command line longer than this is refused by `CreateProcessW`.
const MAX_COMMAND_LINE_UNITS: usize = 32_766;
const PIPE_BUFFER: u32 = 64 * 1024;

/// The core's stdin. Closing it (dropping this) is the shell's "stop" signal.
pub struct Stdin(Arc<std::fs::File>);

impl Stdin {
    /// Write the request line on the blocking pool. The line moves into the blocking call and is
    /// wiped there when it is done, even if the caller stopped waiting (no copy is made).
    pub async fn send(&mut self, line: Zeroizing<Vec<u8>>) -> io::Result<()> {
        let file = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            (&*file).write_all(&line)
        })
        .await
        .map_err(io::Error::other)?
    }
}

/// A handle that is closed when dropped.
struct Owned(HANDLE);

// SAFETY: a kernel handle value can be used and closed from any thread.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

impl Owned {
    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(self) -> HANDLE {
        let raw = self.0;
        mem::forget(self);
        raw
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: the handle is owned by this value and closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn last_error(what: &str) -> io::Error {
    let error = io::Error::last_os_error();
    io::Error::new(error.kind(), format!("{what}: {error}"))
}

/// The job. Dropping the last handle kills whatever is still inside.
struct Job(Owned);

impl Job {
    fn create() -> io::Result<Self> {
        // SAFETY: null attributes and name: an unnamed job with a non-inheritable handle.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle == 0 {
            return Err(last_error("CreateJobObjectW"));
        }
        let job = Owned(handle);
        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid "no limits" value.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a live structure of the size passed.
        let set = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                ptr::addr_of!(limits).cast::<c_void>(),
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            return Err(last_error("SetInformationJobObject"));
        }
        Ok(Self(job))
    }

    fn assign(&self, process: HANDLE) -> io::Result<()> {
        // SAFETY: both handles are valid and owned by the caller.
        if unsafe { AssignProcessToJobObject(self.0.raw(), process) } == 0 {
            return Err(last_error("AssignProcessToJobObject"));
        }
        Ok(())
    }
}

impl TreeKiller for Job {
    fn kill(&self) -> io::Result<()> {
        // SAFETY: the job handle is valid for the life of `self`.
        if unsafe { TerminateJobObject(self.0.raw(), 1) } == 0 {
            return Err(last_error("TerminateJobObject"));
        }
        Ok(())
    }

    fn sweep(&self) {
        // The leader ended; anything it left in the job goes with it.
        let _ = self.kill();
    }
}

/// A created-but-not-yet-running process. Dropped while still armed, it is terminated: a child
/// that could not be placed in the job never runs.
struct Suspended {
    process: Owned,
    thread: Owned,
    armed: bool,
}

impl Suspended {
    /// The child runs: from here the handles are only held, not guarded.
    fn into_running(mut self) -> (Owned, Owned) {
        self.armed = false;
        let process = mem::replace(&mut self.process, Owned(0));
        let thread = mem::replace(&mut self.thread, Owned(0));
        (process, thread)
    }
}

impl Drop for Suspended {
    fn drop(&mut self) {
        if self.armed {
            // SAFETY: the process handle is valid and owned.
            unsafe {
                TerminateProcess(self.process.raw(), 1);
            }
        }
    }
}

fn pipe() -> io::Result<(Owned, Owned)> {
    let (mut read, mut write): (HANDLE, HANDLE) = (0, 0);
    // SAFETY: valid out-pointers; null attributes make both ends non-inheritable.
    if unsafe { CreatePipe(&mut read, &mut write, ptr::null(), PIPE_BUFFER) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    Ok((Owned(read), Owned(write)))
}

fn make_inheritable(handle: &Owned) -> io::Result<()> {
    // SAFETY: valid handle owned by the caller.
    if unsafe { SetHandleInformation(handle.raw(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0
    {
        return Err(last_error("SetHandleInformation"));
    }
    Ok(())
}

/// A one-entry attribute list restricting inheritance to the listed handles.
struct HandleList {
    list: Vec<usize>,
    /// Kept alive: the attribute list refers to this memory, it does not copy it.
    _handles: Vec<HANDLE>,
}

impl HandleList {
    fn new(handles: &[HANDLE]) -> io::Result<Self> {
        let mut size = 0usize;
        // SAFETY: the documented size query; it fails with ERROR_INSUFFICIENT_BUFFER by design.
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
        }
        if size == 0 {
            return Err(last_error("InitializeProcThreadAttributeList (size)"));
        }
        let mut list = vec![0usize; size.div_ceil(mem::size_of::<usize>())];
        // SAFETY: `list` is at least `size` bytes and pointer-aligned.
        if unsafe { InitializeProcThreadAttributeList(list.as_mut_ptr().cast(), 1, 0, &mut size) }
            == 0
        {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        let handles = handles.to_vec();
        let this = Self {
            list,
            _handles: handles,
        };
        // SAFETY: the list was initialised above; the value outlives the list (same struct).
        let updated = unsafe {
            UpdateProcThreadAttribute(
                this.pointer(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                this._handles.as_ptr().cast(),
                mem::size_of_val(this._handles.as_slice()),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if updated == 0 {
            // `this` is dropped here and deletes the initialised list.
            return Err(last_error("UpdateProcThreadAttribute"));
        }
        Ok(this)
    }

    fn pointer(&self) -> *mut c_void {
        self.list.as_ptr().cast_mut().cast()
    }
}

impl Drop for HandleList {
    fn drop(&mut self) {
        // SAFETY: the list was initialised by `new`; it is deleted once.
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

/// One argument quoted the way `CommandLineToArgvW` and the C runtime read it back.
fn append_argument(out: &mut Vec<u16>, argument: &OsStr, force_quotes: bool) -> io::Result<()> {
    let wide: Vec<u16> = argument.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "argument contains a NUL",
        ));
    }
    let needs_quotes = force_quotes
        || wide.is_empty()
        || wide
            .iter()
            .any(|unit| matches!(*unit, 0x20 | 0x09 | 0x0A | 0x0B | 0x22));
    if !needs_quotes {
        out.extend(wide);
        return Ok(());
    }
    let slashes = |count: usize| std::iter::repeat_n(u16::from(b'\\'), count);
    out.push(u16::from(b'"'));
    let mut backslashes = 0usize;
    for unit in wide {
        if unit == u16::from(b'\\') {
            backslashes += 1;
            continue;
        }
        if unit == u16::from(b'"') {
            // Backslashes in front of a quote are doubled, and the quote itself is escaped.
            out.extend(slashes(backslashes * 2 + 1));
        } else {
            out.extend(slashes(backslashes));
        }
        backslashes = 0;
        out.push(unit);
    }
    // Backslashes in front of the closing quote are doubled so they do not escape it.
    out.extend(slashes(backslashes * 2));
    out.push(u16::from(b'"'));
    Ok(())
}

fn command_line(program: &Path, args: &[OsString]) -> io::Result<Vec<u16>> {
    let mut line = Vec::new();
    append_argument(&mut line, program.as_os_str(), true)?;
    for argument in args {
        line.push(u16::from(b' '));
        append_argument(&mut line, argument, false)?;
    }
    if line.len() > MAX_COMMAND_LINE_UNITS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command line is too long",
        ));
    }
    line.push(0);
    Ok(line)
}

/// The child's environment: ours with `overrides` applied (names compare case-insensitively on
/// Windows), as the sorted `NAME=value\0...\0\0` block `CreateProcessW` expects.
fn environment_block(overrides: &[(OsString, OsString)]) -> io::Result<Vec<u16>> {
    let mut merged: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    for (name, value) in overrides {
        let upper = name.to_string_lossy().to_uppercase();
        merged.retain(|(existing, _)| existing.to_string_lossy().to_uppercase() != upper);
        merged.push((name.clone(), value.clone()));
    }
    merged.sort_by_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (name, value) in merged {
        let entry: Vec<u16> = name
            .encode_wide()
            .chain([u16::from(b'=')])
            .chain(value.encode_wide())
            .collect();
        // Names starting with '=' (per-drive working directories) are kept as they are.
        if entry.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "environment entry contains a NUL",
            ));
        }
        block.extend(entry);
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains a NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

fn file_from(handle: Owned) -> tokio::fs::File {
    // SAFETY: the handle is a valid pipe end whose ownership moves into the file.
    tokio::fs::File::from_std(unsafe {
        std::fs::File::from_raw_handle(handle.into_raw() as RawHandle)
    })
}

pub(super) fn spawn(spec: &SpawnSpec) -> io::Result<RawSpawn> {
    let application = wide_path(&spec.program)?;
    let mut command = command_line(&spec.program, &spec.args)?;
    let environment = environment_block(&spec.env)?;
    let directory = spec.cwd.as_deref().map(wide_path).transpose()?;

    let job = Job::create()?;
    let (stdin_read, stdin_write) = pipe()?;
    let (stdout_read, stdout_write) = pipe()?;
    let (stderr_read, stderr_write) = pipe()?;
    for child_end in [&stdin_read, &stdout_write, &stderr_write] {
        make_inheritable(child_end)?;
    }
    let inherited = HandleList::new(&[stdin_read.raw(), stdout_write.raw(), stderr_write.raw()])?;

    // SAFETY: all-zero is a valid initial STARTUPINFOEXW / PROCESS_INFORMATION.
    let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
    startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin_read.raw();
    startup.StartupInfo.hStdOutput = stdout_write.raw();
    startup.StartupInfo.hStdError = stderr_write.raw();
    startup.lpAttributeList = inherited.pointer();
    let mut information: PROCESS_INFORMATION = unsafe { mem::zeroed() };

    // SAFETY: every pointer refers to a live buffer that is NUL-terminated where required; the
    // command line buffer is mutable as the API demands.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            directory.as_ref().map_or(ptr::null(), |path| path.as_ptr()),
            ptr::addr_of!(startup.StartupInfo),
            &mut information,
        )
    };
    if created == 0 {
        return Err(last_error("CreateProcessW"));
    }
    let suspended = Suspended {
        process: Owned(information.hProcess),
        thread: Owned(information.hThread),
        armed: true,
    };
    // The child has its own copies of its pipe ends now.
    drop((stdin_read, stdout_write, stderr_write, inherited));

    job.assign(suspended.process.raw())?;
    // SAFETY: the primary thread handle returned by CreateProcessW, still suspended.
    if unsafe { ResumeThread(suspended.thread.raw()) } == u32::MAX {
        return Err(last_error("ResumeThread"));
    }
    let pid = information.dwProcessId;
    let (process, thread) = suspended.into_running();
    drop(thread);

    Ok(RawSpawn {
        pid,
        stdin: Stdin(Arc::new(
            // SAFETY: the handle is a valid pipe end whose ownership moves into the file.
            unsafe { std::fs::File::from_raw_handle(stdin_write.into_raw() as RawHandle) },
        )),
        stdout: Box::new(file_from(stdout_read)),
        stderr: Box::new(file_from(stderr_read)),
        killer: Arc::new(job),
        wait: Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                // SAFETY: the process handle stays valid until `process` drops with this closure.
                if unsafe { WaitForSingleObject(process.raw(), INFINITE) } != WAIT_OBJECT_0 {
                    return Err(last_error("WaitForSingleObject"));
                }
                let mut code = 0u32;
                // SAFETY: as above, with a valid out-pointer.
                if unsafe { GetExitCodeProcess(process.raw(), &mut code) } == 0 {
                    return Err(last_error("GetExitCodeProcess"));
                }
                Ok(ExitInfo {
                    code: Some(code as i32),
                    signal: None,
                })
            })
            .await
            .map_err(io::Error::other)?
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quoted(program: &str, args: &[&str]) -> String {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        let line = command_line(Path::new(program), &args).unwrap();
        String::from_utf16(&line[..line.len() - 1]).unwrap()
    }

    #[test]
    fn arguments_are_quoted_the_way_the_c_runtime_reads_them() {
        assert_eq!(
            quoted("C:\\a b\\x.exe", &["--jsonl", "plain"]),
            "\"C:\\a b\\x.exe\" --jsonl plain"
        );
        assert_eq!(quoted("x.exe", &["with space"]), "\"x.exe\" \"with space\"");
        assert_eq!(quoted("x.exe", &[""]), "\"x.exe\" \"\"");
        assert_eq!(
            quoted("x.exe", &["say \"hi\""]),
            "\"x.exe\" \"say \\\"hi\\\"\""
        );
        // Backslashes only matter in front of a quote, and before the closing one.
        assert_eq!(quoted("x.exe", &["C:\\dir\\"]), "\"x.exe\" C:\\dir\\");
        assert_eq!(
            quoted("x.exe", &["C:\\my dir\\"]),
            "\"x.exe\" \"C:\\my dir\\\\\""
        );
        assert_eq!(quoted("x.exe", &["a\\\"b"]), "\"x.exe\" \"a\\\\\\\"b\"");
        assert_eq!(
            quoted("x.exe", &["한글 경로\\월드"]),
            "\"x.exe\" \"한글 경로\\월드\""
        );
    }

    #[test]
    fn nul_and_overlong_command_lines_are_refused() {
        assert!(command_line(Path::new("x.exe"), &[OsString::from("a\0b")]).is_err());
        assert!(command_line(Path::new("x.exe"), &[OsString::from("a".repeat(40_000))]).is_err());
    }

    #[test]
    fn the_environment_block_applies_overrides_case_insensitively_and_is_terminated() {
        let block = environment_block(&[
            (OsString::from("pomi_test_var"), OsString::from("one")),
            (OsString::from("POMI_TEST_VAR"), OsString::from("two")),
            (OsString::from("POMI_BLANK"), OsString::new()),
        ])
        .unwrap();
        assert_eq!(&block[block.len() - 2..], [0, 0]);
        let text = String::from_utf16_lossy(&block);
        let entries: Vec<&str> = text.split('\0').filter(|entry| !entry.is_empty()).collect();
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.to_uppercase().starts_with("POMI_TEST_VAR="))
                .count(),
            1
        );
        assert!(entries.contains(&"POMI_TEST_VAR=two"));
        assert!(entries.contains(&"POMI_BLANK="));
    }
}

use std::{
    ffi::c_void,
    fs::File,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, RawHandle},
    },
    path::Path,
    ptr::{null, null_mut},
    slice,
    time::Duration,
};

use super::{wait_for_lock, FsError};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_LOCK_VIOLATION,
        GENERIC_READ,
        GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, PSID,
    },
    Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
    },
    Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
        GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, ACE_HEADER, ACL,
        ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED,
        TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, GetFileInformationByHandle, GetFileType, LockFileEx,
        UnlockFileEx, BY_HANDLE_FILE_INFORMATION, CREATE_NEW, FILE_ATTRIBUTE_DEVICE,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK,
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, OPEN_EXISTING, READ_CONTROL,
    },
    System::{
        Threading::{GetCurrentProcess, OpenProcessToken},
        IO::OVERLAPPED,
    },
};

// ACCESS_ALLOWED_ACE_TYPE is the WinNT ACE type value; this avoids enabling the
// otherwise-unused System_SystemServices feature for a single constant.
const ACCESS_ALLOWED_ACE_TYPE_VALUE: u8 = 0;
const SID_REVISION_VALUE: u8 = 1;
const SID_MAX_SUB_AUTHORITIES: usize = 15;
const ACCESS_ALLOWED_ACE_SID_OFFSET: usize = 8;
const SID_HEADER_SIZE: usize = 8;
// FILE_SHARE_DELETE lets the key file be renamed into place even if a scanner still has it open;
// the vault also closes its own handle before every rename.
const SECURITY_SHARE_MODE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct CurrentUser {
    _token: OwnedHandle,
    token_user: Vec<usize>,
    token_user_bytes: usize,
}

impl CurrentUser {
    fn open() -> Result<Self, String> {
        let mut raw_token: HANDLE = 0;
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0
            || raw_token == 0
            || raw_token == INVALID_HANDLE_VALUE
        {
            return Err("Cannot inspect the current Windows user".into());
        }
        let token = OwnedHandle(raw_token);

        let mut required_bytes = 0u32;
        let first_call =
            unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required_bytes) };
        if first_call != 0
            || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER
            || required_bytes as usize <= size_of::<TOKEN_USER>()
        {
            return Err("Cannot inspect the current Windows user".into());
        }

        let word_count = (required_bytes as usize).div_ceil(size_of::<usize>());
        let mut token_user = vec![0usize; word_count];
        let mut returned_bytes = 0u32;
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                token_user.as_mut_ptr().cast::<c_void>(),
                required_bytes,
                &mut returned_bytes,
            )
        } == 0
            || returned_bytes as usize > token_user.len() * size_of::<usize>()
            || returned_bytes as usize <= size_of::<TOKEN_USER>()
        {
            return Err("Cannot inspect the current Windows user".into());
        }

        let user = Self {
            _token: token,
            token_user,
            token_user_bytes: returned_bytes as usize,
        };
        if !user.sid_is_in_token_buffer() {
            return Err("The current Windows user SID is invalid".into());
        }
        Ok(user)
    }

    fn sid(&self) -> PSID {
        unsafe { (*self.token_user.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }

    fn sid_is_in_token_buffer(&self) -> bool {
        let base = self.token_user.as_ptr() as usize;
        let Some(buffer_end) = base.checked_add(self.token_user_bytes) else {
            return false;
        };
        let minimum_sid_address = match base.checked_add(size_of::<TOKEN_USER>()) {
            Some(address) => address,
            None => return false,
        };
        let sid_address = self.sid() as usize;
        if sid_address < minimum_sid_address || sid_address >= buffer_end {
            return false;
        }
        let available = buffer_end - sid_address;
        if available < SID_HEADER_SIZE {
            return false;
        }
        let sid = self.sid().cast::<u8>();
        unsafe {
            if *sid != SID_REVISION_VALUE {
                return false;
            }
            let count = *sid.add(1) as usize;
            count <= SID_MAX_SUB_AUTHORITIES
                && SID_HEADER_SIZE + count * size_of::<u32>() <= available
        }
    }
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn security_descriptor(directory: bool) -> Result<LocalAllocation, String> {
    let user = CurrentUser::open()?;
    let mut sid_string: *mut u16 = null_mut();
    if unsafe { ConvertSidToStringSidW(user.sid(), &mut sid_string) } == 0 || sid_string.is_null() {
        return Err("Cannot create private credential permissions".into());
    }
    let sid_allocation = LocalAllocation(sid_string.cast::<c_void>());
    let mut sid_length = 0usize;
    unsafe {
        while *sid_string.add(sid_length) != 0 {
            sid_length += 1;
        }
    }
    let sid = String::from_utf16(unsafe { slice::from_raw_parts(sid_string, sid_length) })
        .map_err(|_| "Cannot create private credential permissions")?;
    drop(sid_allocation);

    let ace_flags = if directory { "OICI" } else { "" };
    let sddl = format!("O:{sid}D:P(A;{ace_flags};FA;;;{sid})");
    let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut raw_descriptor: PSECURITY_DESCRIPTOR = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut raw_descriptor,
            null_mut(),
        )
    } == 0
        || raw_descriptor.is_null()
    {
        return Err("Cannot create private credential permissions".into());
    }
    Ok(LocalAllocation(raw_descriptor))
}

fn create_attributes(descriptor: &LocalAllocation) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    }
}

fn open_inspection_handle(path: &Path, directory: bool) -> Result<OwnedHandle, String> {
    let path_wide = wide_path(path);
    let mut flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if directory {
        flags |= FILE_FLAG_BACKUP_SEMANTICS;
    }
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            SECURITY_SHARE_MODE,
            null(),
            OPEN_EXISTING,
            flags,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle == 0 {
        return Err("Cannot inspect credential file permissions".into());
    }
    Ok(OwnedHandle(handle))
}

fn inspect_handle(handle: HANDLE, directory: bool) -> Result<(), String> {
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return Err("Credential path must be a regular file or private directory".into());
    }

    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err("Cannot inspect credential file permissions".into());
    }
    let attributes = information.dwFileAttributes;
    let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    if attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0
        || is_directory != directory
        || (!directory && information.nNumberOfLinks != 1)
    {
        return Err(
            "Credential path must be a regular file or private directory, never a link".into(),
        );
    }

    inspect_security(handle, directory)
}

fn inspect_security(handle: HANDLE, directory: bool) -> Result<(), String> {
    let user = CurrentUser::open()?;
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    let descriptor_allocation = if descriptor.is_null() {
        None
    } else {
        Some(LocalAllocation(descriptor))
    };
    if status != 0 || owner.is_null() || dacl.is_null() {
        return Err("Cannot inspect credential file permissions".into());
    }
    let Some(_descriptor) = descriptor_allocation else {
        return Err("Cannot inspect credential file permissions".into());
    };
    if unsafe { EqualSid(owner, user.sid()) } == 0 {
        return Err("Credential files require current-user ownership".into());
    }

    let mut present = 0;
    let mut defaulted = 0;
    let mut actual_dacl: *mut ACL = null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(descriptor, &mut present, &mut actual_dacl, &mut defaulted)
    } == 0
        || present == 0
        || actual_dacl.is_null()
        || actual_dacl != dacl
    {
        return Err("Credential files require a current-user-only access list".into());
    }

    if directory {
        let mut control = 0u16;
        let mut revision = 0u32;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err("Credential directories require protected user-only permissions".into());
        }
    }

    let mut acl_information: ACL_SIZE_INFORMATION = unsafe { zeroed() };
    if unsafe {
        GetAclInformation(
            actual_dacl,
            (&mut acl_information as *mut ACL_SIZE_INFORMATION).cast::<c_void>(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || acl_information.AceCount == 0
    {
        return Err("Credential files require a current-user-only access list".into());
    }

    for index in 0..acl_information.AceCount {
        let mut ace: *mut c_void = null_mut();
        if unsafe { GetAce(actual_dacl, index, &mut ace) } == 0 || ace.is_null() {
            return Err("Cannot inspect credential file permissions".into());
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        let ace_size = header.AceSize as usize;
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE_VALUE
            || ace_size < ACCESS_ALLOWED_ACE_SID_OFFSET + SID_HEADER_SIZE
        {
            return Err("Credential files require a current-user-only access list".into());
        }
        if directory && u32::from(header.AceFlags) != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) {
            return Err("Credential directories require inheritable user-only permissions".into());
        }

        let ace_sid = unsafe { ace.cast::<u8>().add(ACCESS_ALLOWED_ACE_SID_OFFSET) };
        let sid_subauthority_count = unsafe { *ace_sid.add(1) as usize };
        let sid_size = SID_HEADER_SIZE + sid_subauthority_count * size_of::<u32>();
        if unsafe { *ace_sid } != SID_REVISION_VALUE
            || sid_subauthority_count > SID_MAX_SUB_AUTHORITIES
            || sid_size > ace_size - ACCESS_ALLOWED_ACE_SID_OFFSET
            || unsafe { EqualSid(user.sid(), ace_sid.cast::<c_void>()) } == 0
        {
            return Err("Credential files require a current-user-only access list".into());
        }
    }
    Ok(())
}

pub fn check(path: &Path, directory: bool) -> Result<(), FsError> {
    let handle = open_inspection_handle(path, directory).map_err(FsError::io)?;
    inspect_handle(handle.0, directory).map_err(FsError::permissions)
}

pub fn directory(path: &Path) -> Result<(), FsError> {
    if !path
        .try_exists()
        .map_err(|_| FsError::io("Cannot inspect credential directory"))?
    {
        let descriptor = security_descriptor(true).map_err(FsError::io)?;
        let attributes = create_attributes(&descriptor);
        let path_wide = wide_path(path);
        unsafe {
            // A concurrent creator is handled by the following handle-based validation.
            CreateDirectoryW(path_wide.as_ptr(), &attributes);
        }
    }
    check(path, true)
}

pub fn open(path: &Path, create: bool) -> Result<File, FsError> {
    let descriptor = if create {
        Some(security_descriptor(false).map_err(FsError::io)?)
    } else {
        None
    };
    let attributes = descriptor.as_ref().map(create_attributes);
    let attributes_ptr = attributes.as_ref().map_or(null(), |attributes| {
        attributes as *const SECURITY_ATTRIBUTES
    });
    let path_wide = wide_path(path);
    let disposition = if create { CREATE_NEW } else { OPEN_EXISTING };
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            SECURITY_SHARE_MODE,
            attributes_ptr,
            disposition,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE || handle == 0 {
        return Err(FsError::io("Cannot open private credential file"));
    }

    let file = unsafe { File::from_raw_handle(handle as RawHandle) };
    inspect_handle(file.as_raw_handle() as HANDLE, false)
        .map_err(|_| FsError::permissions("Credential file permissions or ownership are unsafe"))?;
    Ok(file)
}

pub struct Lock {
    file: File,
    overlapped: OVERLAPPED,
}

impl Lock {
    pub fn acquire(path: &Path, wait: Duration) -> Result<Self, FsError> {
        let file = match open(path, true) {
            Ok(file) => file,
            Err(_error) if path.try_exists().unwrap_or(false) => open(path, false)?,
            Err(error) => return Err(error),
        };
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        wait_for_lock(
            || {
                let locked = unsafe {
                    LockFileEx(
                        file.as_raw_handle() as HANDLE,
                        LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                        0,
                        1,
                        0,
                        &mut overlapped,
                    )
                };
                if locked != 0 {
                    Ok(true)
                } else if unsafe { GetLastError() } == ERROR_LOCK_VIOLATION {
                    Ok(false)
                } else {
                    Err(std::io::Error::last_os_error())
                }
            },
            wait,
        )?;
        Ok(Self { file, overlapped })
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            UnlockFileEx(
                self.file.as_raw_handle() as HANDLE,
                0,
                1,
                0,
                &mut self.overlapped,
            );
        }
    }
}

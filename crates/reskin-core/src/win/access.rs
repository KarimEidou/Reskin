//! Whether Reskin can change an item in place, where it lives, and the
//! link-safe file access of the elevated helper.
//!
//! # The elevated helper's files
//!
//! An elevated process that writes where a standard user can plant a
//! junction, a symbolic link or a hard link can be steered into writing
//! somewhere else. So the helper (see `docs/ARCHITECTURE.md`, "Elevation"):
//!
//! * creates and writes files only inside `%ProgramData%\Reskin`
//!   ([`AdminDir`]). It creates each folder of that tree owned by
//!   Administrators with a protected DACL (SYSTEM and Administrators full
//!   control, Users read), accepts an existing one only when it is a real
//!   folder (not a reparse point) owned by Administrators or SYSTEM, and
//!   then locks its DACL down again (an earlier Reskin left it writable for
//!   Users, as `%ProgramData%` makes every new folder);
//! * holds a handle on every folder of the tree while it works, without
//!   `FILE_SHARE_DELETE`, so none can be renamed or replaced meanwhile, and
//!   checks each one's final path;
//! * opens every file with `FILE_FLAG_OPEN_REPARSE_POINT` and refuses
//!   reparse points, folders, hard-linked files and files whose final path
//!   is not directly in the folder it expects; creates files with
//!   `CREATE_NEW` (never overwriting) and deletes through the handle, so a
//!   planted link is removed rather than followed;
//! * edits a Public Desktop shortcut only after the same checks against
//!   the Public Desktop folder ([`TrustedDir::check_file`]);
//! * reads its job once, without following a link, up to a size limit
//!   ([`read_plain_file`]).
//!
//! The unelevated app reads what the helper wrote only from files owned by
//! Administrators or SYSTEM ([`read_admin_file`]).

use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_LOCK_VIOLATION,
    ERROR_SHARING_VIOLATION, GENERIC_READ, GENERIC_WRITE, HANDLE, WIN32_ERROR,
};
use windows::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAceEx, CONTAINER_INHERIT_ACE,
    CreateWellKnownSid, DACL_SECURITY_INFORMATION, GetKernelObjectSecurity, GetLengthSid,
    GetSecurityDescriptorOwner, InitializeAcl, InitializeSecurityDescriptor, IsWellKnownSid,
    OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
    SECURITY_MAX_SID_SIZE, SetKernelObjectSecurity, SetSecurityDescriptorControl,
    SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, WELL_KNOWN_SID_TYPE,
    WinBuiltinAdministratorsSid, WinBuiltinUsersSid, WinLocalSystemSid,
};
use windows::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW, DELETE, FILE_ADD_FILE,
    FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_CREATION_DISPOSITION, FILE_DISPOSITION_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_NAME_NORMALIZED, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_MODE, FILE_SHARE_NONE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_TYPE_DISK, FileDispositionInfo, GETFINALPATHNAMEBYHANDLE_FLAGS, GetFileAttributesW,
    GetFileInformationByHandle, GetFileType, GetFinalPathNameByHandleW, INVALID_FILE_ATTRIBUTES,
    OPEN_EXISTING, READ_CONTROL, SetFileInformationByHandle, VOLUME_NAME_DOS, WRITE_DAC,
};
use windows::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
use windows::core::Owned;

use super::known;
use super::util::{ResultExt, from_wide, path_starts_with_ci, pcwstr, wide, with_context};
use crate::model::{Access, ItemLocation};
use crate::store::io_error;
use crate::{Error, Result, job, paths};

/// Result of opening a path for writing.
enum Probe {
    Ok,
    Denied,
    /// Somebody has it open without sharing: we have the rights, it is
    /// merely busy right now.
    Busy,
    Failed,
}

fn open_for_write(path: &Path, directory: bool) -> Probe {
    let w = wide(path);
    let (access, flags) = if directory {
        // Customising a folder means creating desktop.ini inside it.
        (FILE_ADD_FILE.0, FILE_FLAG_BACKUP_SEMANTICS)
    } else {
        (GENERIC_WRITE.0, FILE_FLAGS_AND_ATTRIBUTES(0))
    };
    // SAFETY: valid path; the handle is closed immediately by Owned.
    let opened = unsafe {
        CreateFileW(
            pcwstr(&w),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            flags,
            None,
        )
    };
    match opened {
        Ok(handle) => {
            drop(unsafe { Owned::new(handle) });
            Probe::Ok
        }
        Err(e) => match WIN32_ERROR::from_error(&e) {
            Some(ERROR_ACCESS_DENIED) => Probe::Denied,
            Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION) => Probe::Busy,
            _ => Probe::Failed,
        },
    }
}

/// Probes whether the current user can modify `path` in place: opens it
/// with `GENERIC_WRITE` (a folder with `FILE_ADD_FILE`, plus its existing
/// `desktop.ini`) and closes it again without writing.
///
/// Access denied to a `.lnk` / `.url` file directly on the Public Desktop
/// → [`Access::NeedsElevation`]: those, and only those, are what the
/// elevated helper changes ([`job::is_elevation_target`], the rule its job
/// validation applies too, so an approved UAC prompt never ends in a
/// refused job). Denied anywhere else, the read-only attribute, a missing
/// path or any other failure → [`Access::ReadOnly`].
pub fn probe_writable(path: &Path) -> Access {
    let w = wide(path);
    // SAFETY: valid NUL-terminated path.
    let attrs = unsafe { GetFileAttributesW(pcwstr(&w)) };
    if attrs == INVALID_FILE_ATTRIBUTES {
        return Access::ReadOnly;
    }
    let directory = attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
    // On folders the read-only bit only tells Explorer to read desktop.ini.
    if !directory && attrs & FILE_ATTRIBUTE_READONLY.0 != 0 {
        return Access::ReadOnly;
    }
    let mut probe = open_for_write(path, directory);
    if directory && matches!(probe, Probe::Ok) {
        let ini = path.join("desktop.ini");
        if ini.exists() {
            probe = open_for_write(&ini, false);
        }
    }
    match probe {
        Probe::Ok | Probe::Busy => Access::Writable,
        Probe::Denied if is_elevation_target(path) => Access::NeedsElevation,
        Probe::Denied | Probe::Failed => Access::ReadOnly,
    }
}

/// Probes whether the current user can create files in the folder `dir`
/// (`FILE_ADD_FILE`), e.g. a new shortcut on the desktop.
pub fn probe_creatable(dir: &Path) -> Access {
    match open_for_write(dir, true) {
        Probe::Ok | Probe::Busy => Access::Writable,
        Probe::Denied | Probe::Failed => Access::ReadOnly,
    }
}

/// A `.lnk` / `.url` file directly on the Public Desktop.
fn is_elevation_target(path: &Path) -> bool {
    known::public_desktop().is_ok_and(|desktop| {
        job::is_elevation_target(&path.to_string_lossy(), &desktop.to_string_lossy())
    })
}

/// Classifies where `path` lives by case-insensitive prefix against the
/// known folders. Start-menu matching covers the whole `Start Menu` folder
/// (the parent of `Programs`); anything under `%SystemRoot%` is `System`.
pub fn location_of(path: &Path) -> ItemLocation {
    let parent = |p: std::path::PathBuf| p.parent().map(Path::to_path_buf);
    let candidates = [
        (known::taskbar_pins().ok(), ItemLocation::TaskbarPin),
        (known::desktop().ok(), ItemLocation::UserDesktop),
        (known::public_desktop().ok(), ItemLocation::PublicDesktop),
        (
            known::start_menu().ok().and_then(parent),
            ItemLocation::StartMenu,
        ),
        (
            known::common_start_menu().ok().and_then(parent),
            ItemLocation::StartMenu,
        ),
        (known::windows_dir().ok(), ItemLocation::System),
    ];
    candidates
        .into_iter()
        .find_map(|(base, loc)| base.filter(|b| path_starts_with_ci(path, b)).map(|_| loc))
        .unwrap_or(ItemLocation::Other)
}

// ---------------------------------------------------------------------------
// The elevated helper's files (see the module docs)
// ---------------------------------------------------------------------------

/// A well-known SID in a buffer large enough for any SID.
fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> Result<Vec<u64>> {
    let mut buf = vec![0u64; (SECURITY_MAX_SID_SIZE as usize).div_ceil(8)];
    let mut len = SECURITY_MAX_SID_SIZE;
    // SAFETY: `buf` holds SECURITY_MAX_SID_SIZE bytes, as `len` says.
    unsafe { CreateWellKnownSid(kind, None, Some(PSID(buf.as_mut_ptr().cast())), &mut len) }
        .ctx("build a well-known SID")?;
    Ok(buf)
}

fn psid(sid: &[u64]) -> PSID {
    PSID(sid.as_ptr() as *mut c_void)
}

/// The security of everything the helper creates: owner Administrators;
/// SYSTEM and Administrators full control, Users read (inherited by
/// everything inside); nothing inherited from the parent.
struct AdminSecurity {
    sd: SECURITY_DESCRIPTOR,
    /// The ACL and SIDs `sd` points into (heap buffers: they stay put when
    /// the value moves).
    _acl: Vec<u64>,
    _sids: [Vec<u64>; 3],
}

impl AdminSecurity {
    fn new() -> Result<AdminSecurity> {
        let system = well_known_sid(WinLocalSystemSid)?;
        let admins = well_known_sid(WinBuiltinAdministratorsSid)?;
        let users = well_known_sid(WinBuiltinUsersSid)?;
        let aces = [
            (&system, FILE_ALL_ACCESS.0),
            (&admins, FILE_ALL_ACCESS.0),
            (&users, (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE).0),
        ];
        // An ACCESS_ALLOWED_ACE ends with the first DWORD of its SID.
        let ace_base = size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>();
        let size = size_of::<ACL>()
            + aces
                .iter()
                // SAFETY: valid SIDs built above.
                .map(|(sid, _)| ace_base + unsafe { GetLengthSid(psid(sid)) } as usize)
                .sum::<usize>();
        let mut acl = vec![0u64; size.div_ceil(8)];
        let pacl = acl.as_mut_ptr().cast::<ACL>();
        let mut sd = SECURITY_DESCRIPTOR::default();
        let psd = PSECURITY_DESCRIPTOR((&raw mut sd).cast());
        // SAFETY (whole block): `acl` holds `size` bytes; the SIDs and the
        // ACL outlive `sd`, which only points at them.
        unsafe {
            InitializeAcl(pacl, size as u32, ACL_REVISION).ctx("build an ACL")?;
            for (sid, mask) in aces {
                AddAccessAllowedAceEx(
                    pacl,
                    ACL_REVISION,
                    OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                    mask,
                    psid(sid),
                )
                .ctx("add an access rule")?;
            }
            InitializeSecurityDescriptor(psd, SECURITY_DESCRIPTOR_REVISION)
                .ctx("build a security descriptor")?;
            SetSecurityDescriptorOwner(psd, Some(psid(&admins)), false).ctx("set the owner")?;
            SetSecurityDescriptorDacl(psd, true, Some(pacl), false).ctx("set the DACL")?;
            SetSecurityDescriptorControl(psd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)
                .ctx("protect the DACL")?;
        }
        Ok(AdminSecurity {
            sd,
            _acl: acl,
            _sids: [system, admins, users],
        })
    }

    fn descriptor(&self) -> PSECURITY_DESCRIPTOR {
        PSECURITY_DESCRIPTOR((&raw const self.sd).cast_mut().cast())
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor().0,
            bInheritHandle: false.into(),
        }
    }
}

/// How [`open`] opens a path.
struct OpenAs {
    access: u32,
    share: FILE_SHARE_MODE,
    disposition: FILE_CREATION_DISPOSITION,
    /// Follow a link at the path's own name (only for trusted folders).
    follow: bool,
}

/// Opens `path` (a folder too) as `how` says, creating it with `security`
/// when `how.disposition` creates.
fn open(path: &Path, how: &OpenAs, security: Option<&AdminSecurity>) -> Result<File> {
    let w = wide(path);
    // Backup semantics are what lets CreateFileW open folders (and folder
    // links); without the backup privilege enabled, which Reskin never
    // enables, they bypass no access check.
    let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
    if !how.follow {
        flags |= FILE_FLAG_OPEN_REPARSE_POINT;
    }
    let attributes = security.map(AdminSecurity::attributes);
    // SAFETY: valid NUL-terminated path; `attributes` outlives the call.
    let handle = unsafe {
        CreateFileW(
            pcwstr(&w),
            how.access,
            how.share,
            attributes.as_ref().map(|a| a as *const SECURITY_ATTRIBUTES),
            how.disposition,
            flags,
            None,
        )
    };
    match handle {
        // SAFETY: a fresh handle that the File now owns.
        Ok(h) => Ok(unsafe { File::from_raw_handle(h.0) }),
        Err(e) if matches!(WIN32_ERROR::from_error(&e), Some(ERROR_FILE_EXISTS)) => {
            Err(Error::Other(format!("{} already exists", path.display())))
        }
        Err(e) => Err(with_context(e, format!("open {}", path.display()))),
    }
}

fn handle(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}

fn file_info(file: &File, path: &Path) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: valid handle and out struct.
    unsafe { GetFileInformationByHandle(handle(file), &mut info) }
        .ctx(format!("inspect {}", path.display()))?;
    Ok(info)
}

/// `GetFinalPathNameByHandleW` (`\\?\C:\…`).
fn final_path(file: &File, path: &Path) -> Result<String> {
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: valid handle; the buffer's length is passed along.
        let n = unsafe {
            GetFinalPathNameByHandleW(
                handle(file),
                &mut buf,
                GETFINALPATHNAMEBYHANDLE_FLAGS(FILE_NAME_NORMALIZED.0 | VOLUME_NAME_DOS.0),
            )
        } as usize;
        if n == 0 {
            return Err(with_context(
                windows_core::Error::from_win32(),
                format!("resolve {}", path.display()),
            ));
        }
        if n < buf.len() {
            return Ok(from_wide(&buf[..n]));
        }
        // Too small: `n` is the length needed, terminator included.
        buf.resize(n, 0);
    }
}

fn is_link(info: &BY_HANDLE_FILE_INFORMATION) -> bool {
    info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
}

fn is_folder(info: &BY_HANDLE_FILE_INFORMATION) -> bool {
    info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0
}

/// Refuses anything but a plain file — no reparse point, no folder, a
/// single name — whose final path is `expected` (when given).
fn check_plain(file: &File, path: &Path, expected: Option<&str>) -> Result<()> {
    let info = file_info(file, path)?;
    let refuse = |why: &str| {
        Err(Error::AccessDenied(format!(
            "{} {why}; refusing to use it",
            path.display()
        )))
    };
    if is_link(&info) {
        return refuse("is a link");
    }
    if is_folder(&info) {
        return refuse("is a folder");
    }
    if info.nNumberOfLinks != 1 {
        return refuse("has other names (hard links)");
    }
    if let Some(expected) = expected {
        let actual = final_path(file, path)?;
        if !job::final_path_matches(expected, &actual) {
            return refuse(&format!("leads to {actual}"));
        }
    }
    Ok(())
}

/// Whether the object behind `file` (opened with `READ_CONTROL`) is owned
/// by Administrators or SYSTEM.
fn owned_by_admins(file: &File, path: &Path) -> Result<bool> {
    let what = || format!("read the owner of {}", path.display());
    let mut needed = 0u32;
    // SAFETY: a size query (no buffer); it fails with
    // ERROR_INSUFFICIENT_BUFFER and reports the size needed.
    let _ = unsafe {
        GetKernelObjectSecurity(
            handle(file),
            OWNER_SECURITY_INFORMATION.0,
            None,
            0,
            &mut needed,
        )
    };
    if needed == 0 {
        return Err(with_context(windows_core::Error::from_win32(), what()));
    }
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    let sd = PSECURITY_DESCRIPTOR(buf.as_mut_ptr().cast());
    let mut owner = PSID::default();
    let mut defaulted = windows_core::BOOL::default();
    // SAFETY: `buf` holds `needed` bytes; `owner` points into it and is
    // only used while it lives.
    unsafe {
        GetKernelObjectSecurity(
            handle(file),
            OWNER_SECURITY_INFORMATION.0,
            Some(sd),
            needed,
            &mut needed,
        )
        .ctx(what())?;
        GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted).ctx(what())?;
        Ok(!owner.is_invalid()
            && (IsWellKnownSid(owner, WinBuiltinAdministratorsSid).as_bool()
                || IsWellKnownSid(owner, WinLocalSystemSid).as_bool()))
    }
}

/// Reads at most `max` bytes of `file`; more is an error.
fn read_capped(mut file: File, path: &Path, max: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut file)
        .take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(e, "reading", path))?;
    if bytes.len() as u64 > max {
        return Err(Error::Other(format!(
            "{} is larger than {max} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

/// Deletes the file (or link, or empty folder) behind `file`, which was
/// opened with `DELETE` access: the name goes, never what a link leads to.
fn delete_by_handle(file: &File, path: &Path) -> Result<()> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: valid handle; `info` is a FILE_DISPOSITION_INFO of the size given.
    unsafe {
        SetFileInformationByHandle(
            handle(file),
            FileDispositionInfo,
            (&raw const info).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .ctx(format!("delete {}", path.display()))
}

/// Opens an existing entry of a folder without following it; `None` when
/// there is none.
fn open_entry(path: &Path, access: u32) -> Result<Option<File>> {
    let how = OpenAs {
        access: access | FILE_READ_ATTRIBUTES.0,
        share: FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        disposition: OPEN_EXISTING,
        follow: false,
    };
    match open(path, &how, None) {
        Ok(file) => Ok(Some(file)),
        Err(Error::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// A folder the elevated helper trusts, resolved once and held open (so
/// it cannot be renamed or replaced) while the value lives: the files it
/// handles must lie directly in it by their final paths.
pub struct TrustedDir {
    path: PathBuf,
    final_path: String,
    /// This folder (last) and the folders above it that were checked.
    _held: Vec<File>,
}

impl TrustedDir {
    /// `dir`, which only administrators can change (the Public Desktop,
    /// `%ProgramData%`), opened wherever an administrator may have moved it.
    pub fn open(dir: &Path) -> Result<TrustedDir> {
        let how = OpenAs {
            access: FILE_READ_ATTRIBUTES.0,
            share: FILE_SHARE_READ | FILE_SHARE_WRITE,
            disposition: OPEN_EXISTING,
            follow: true,
        };
        let held = open(dir, &how, None)?;
        if !is_folder(&file_info(&held, dir)?) {
            return Err(Error::Other(format!("{} is not a folder", dir.display())));
        }
        Ok(TrustedDir {
            path: dir.to_path_buf(),
            final_path: final_path(&held, dir)?,
            _held: vec![held],
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `name` inside this folder, and the final path it must have.
    fn entry(&self, name: &str) -> Result<(PathBuf, String)> {
        if !job::is_plain_file_name(name) {
            return Err(Error::Other(format!("{name:?} is not a plain file name")));
        }
        Ok((self.path.join(name), format!("{}\\{name}", self.final_path)))
    }

    /// Checks, before a shell object edits it in place, that `path` is a
    /// plain file directly in this folder: not a link (to be followed by
    /// the edit), not a hard link (whose other names would change too).
    pub fn check_file(&self, path: &Path) -> Result<()> {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Error::Other(format!("{} has no file name", path.display())))?;
        if !paths::is_directly_under(&path.to_string_lossy(), &self.path.to_string_lossy()) {
            return Err(Error::AccessDenied(format!(
                "{} is not directly in {}",
                path.display(),
                self.path.display()
            )));
        }
        let (entry, expected) = self.entry(name)?;
        let file =
            open_entry(&entry, 0)?.ok_or_else(|| Error::NotFound(entry.display().to_string()))?;
        check_plain(&file, &entry, Some(&expected))
    }
}

/// A folder of the elevated helper's own tree (`%ProgramData%\Reskin\…`),
/// created or verified and locked down as the module docs describe, and
/// held open while the value lives.
pub struct AdminDir {
    dir: TrustedDir,
    security: AdminSecurity,
}

impl AdminDir {
    /// `base\parts[0]\parts[1]…`, e.g. `%ProgramData%` + `["Reskin",
    /// "icons"]`. `base` is trusted as [`TrustedDir::open`] trusts a folder;
    /// every part below it is created when missing (owner Administrators,
    /// protected DACL) and otherwise must be a real folder owned by
    /// Administrators or SYSTEM, whose DACL is then reset. Each part's
    /// final path must continue its parent's.
    pub fn open(base: &Path, parts: &[&str]) -> Result<AdminDir> {
        let security = AdminSecurity::new()?;
        let mut dir = TrustedDir::open(base)?;
        for part in parts {
            let (path, expected) = dir.entry(part)?;
            let folder = admin_folder(&path, &security)?;
            let actual = final_path(&folder, &path)?;
            if !job::final_path_matches(&expected, &actual) {
                return Err(Error::AccessDenied(format!(
                    "{} leads to {actual}; refusing to use it",
                    path.display()
                )));
            }
            dir.path = path;
            dir.final_path = actual;
            dir._held.push(folder);
        }
        Ok(AdminDir { dir, security })
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// The content of the plain file `name`, which must be owned by
    /// Administrators or SYSTEM (at most `max` bytes); `None` when there is
    /// no entry by that name.
    pub fn read(&self, name: &str, max: u64) -> Result<Option<Vec<u8>>> {
        let (path, expected) = self.dir.entry(name)?;
        let Some(file) = open_entry(&path, GENERIC_READ.0 | READ_CONTROL.0)? else {
            return Ok(None);
        };
        check_plain(&file, &path, Some(&expected))?;
        if !owned_by_admins(&file, &path)? {
            return Err(Error::AccessDenied(format!(
                "{} does not belong to an administrator",
                path.display()
            )));
        }
        read_capped(file, &path, max).map(Some)
    }

    /// Creates the file `name` holding `bytes`. It must not exist
    /// (`CREATE_NEW`, never through a link); a failed write removes it.
    pub fn create(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let (path, expected) = self.dir.entry(name)?;
        let how = OpenAs {
            access: GENERIC_WRITE.0 | DELETE.0 | FILE_READ_ATTRIBUTES.0,
            share: FILE_SHARE_NONE,
            disposition: CREATE_NEW,
            follow: false,
        };
        let mut file = open(&path, &how, Some(&self.security))?;
        let written = check_plain(&file, &path, Some(&expected)).and_then(|()| {
            file.write_all(bytes)
                .and_then(|()| file.sync_all())
                .map_err(|e| io_error(e, "writing", &path))
        });
        if written.is_err() {
            let _ = delete_by_handle(&file, &path);
        }
        written
    }

    /// Makes `name` hold `bytes`: a plain file of an administrator's with
    /// exactly these bytes is kept; whatever else goes by that name (a
    /// link, a hard link, other bytes, a file of another account's) is
    /// deleted first and the file created anew.
    pub fn put(&self, name: &str, bytes: &[u8]) -> Result<()> {
        if matches!(self.read(name, bytes.len() as u64), Ok(Some(existing)) if existing == bytes) {
            return Ok(());
        }
        self.remove(name)?;
        self.create(name, bytes)
    }

    /// Deletes the entry `name` — the link itself when it is one. `false`
    /// when there was none.
    pub fn remove(&self, name: &str) -> Result<bool> {
        let (path, expected) = self.dir.entry(name)?;
        let Some(file) = open_entry(&path, DELETE.0)? else {
            return Ok(false);
        };
        let actual = final_path(&file, &path)?;
        if !job::final_path_matches(&expected, &actual) {
            return Err(Error::AccessDenied(format!(
                "{} leads to {actual}; refusing to delete it",
                path.display()
            )));
        }
        delete_by_handle(&file, &path)?;
        Ok(true)
    }

    /// The entries directly inside that are files (not links or folders),
    /// with how long ago each was last written.
    pub fn files(&self) -> Result<Vec<(String, Duration)>> {
        let path = self.path();
        let now = SystemTime::now();
        let mut out = Vec::new();
        for entry in std::fs::read_dir(path).map_err(|e| io_error(e, "listing", path))? {
            let entry = entry.map_err(|e| io_error(e, "listing", path))?;
            // Neither call follows a link on Windows.
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.file_type().is_file() {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let age = meta
                .modified()
                .ok()
                .and_then(|m| now.duration_since(m).ok())
                .unwrap_or_default();
            out.push((name, age));
        }
        Ok(out)
    }
}

/// Creates the folder `path` of the helper's tree, or checks and locks
/// down the one that exists, and returns it held open without
/// `FILE_SHARE_DELETE`.
fn admin_folder(path: &Path, security: &AdminSecurity) -> Result<File> {
    let w = wide(path);
    let attributes = security.attributes();
    // SAFETY: valid NUL-terminated path; `attributes` outlives the call.
    let created = match unsafe { CreateDirectoryW(pcwstr(&w), Some(&raw const attributes)) } {
        Ok(()) => true,
        Err(e) if matches!(WIN32_ERROR::from_error(&e), Some(ERROR_ALREADY_EXISTS)) => false,
        Err(e) => return Err(with_context(e, format!("create {}", path.display()))),
    };
    let how = OpenAs {
        access: READ_CONTROL.0 | WRITE_DAC.0 | FILE_READ_ATTRIBUTES.0,
        share: FILE_SHARE_READ | FILE_SHARE_WRITE,
        disposition: OPEN_EXISTING,
        follow: false,
    };
    let folder = open(path, &how, None)?;
    let info = file_info(&folder, path)?;
    if is_link(&info) {
        return Err(Error::AccessDenied(format!(
            "{} is a link; refusing to use it",
            path.display()
        )));
    }
    if !is_folder(&info) {
        return Err(Error::AccessDenied(format!(
            "{} is not a folder",
            path.display()
        )));
    }
    if !owned_by_admins(&folder, path)? {
        return Err(Error::AccessDenied(format!(
            "{} belongs to another account; delete it so that Reskin can create it again",
            path.display()
        )));
    }
    if !created {
        // SAFETY: valid handle opened with WRITE_DAC; a valid descriptor.
        unsafe {
            SetKernelObjectSecurity(
                handle(&folder),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                security.descriptor(),
            )
        }
        .ctx(format!("lock down {}", path.display()))?;
    }
    Ok(folder)
}

/// Reads the file at `path` for the elevated helper (its job): opened
/// without following a link at that name, refused unless it is a plain file
/// on disk with a single name, and at most `max` bytes.
pub fn read_plain_file(path: &Path, max: u64) -> Result<Vec<u8>> {
    let how = OpenAs {
        access: GENERIC_READ.0 | FILE_READ_ATTRIBUTES.0,
        share: FILE_SHARE_READ,
        disposition: OPEN_EXISTING,
        follow: false,
    };
    let file = open(path, &how, None)?;
    // SAFETY: valid handle.
    if unsafe { GetFileType(handle(&file)) } != FILE_TYPE_DISK {
        return Err(Error::AccessDenied(format!(
            "{} is not a file on disk",
            path.display()
        )));
    }
    check_plain(&file, path, None)?;
    read_capped(file, path, max)
}

/// How the unelevated app reads what the elevated helper wrote: the plain
/// file at `path` (at most `max` bytes), only when it is owned by
/// Administrators or SYSTEM, so no other account can have put it there.
/// `None` when there is no file.
pub fn read_admin_file(path: &Path, max: u64) -> Result<Option<Vec<u8>>> {
    let Some(file) = open_entry(path, GENERIC_READ.0 | READ_CONTROL.0)? else {
        return Ok(None);
    };
    check_plain(&file, path, None)?;
    if !owned_by_admins(&file, path)? {
        return Err(Error::AccessDenied(format!(
            "{} does not belong to an administrator",
            path.display()
        )));
    }
    read_capped(file, path, max).map(Some)
}

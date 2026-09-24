//! Whether Reskin can change an item in place, and where it lives.

use std::path::Path;

use windows::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION, GENERIC_WRITE, WIN32_ERROR,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ADD_FILE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_READONLY,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GetFileAttributesW, INVALID_FILE_ATTRIBUTES, OPEN_EXISTING,
};
use windows::core::Owned;

use super::known;
use super::util::{path_starts_with_ci, pcwstr, wide};
use crate::model::{Access, ItemLocation};

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
/// Access denied under the Public Desktop, the common Start menu or
/// ProgramData → [`Access::NeedsElevation`]; denied elsewhere, the
/// read-only attribute, a missing path or any other failure →
/// [`Access::ReadOnly`].
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
        Probe::Denied if needs_elevation_location(path) => Access::NeedsElevation,
        Probe::Denied | Probe::Failed => Access::ReadOnly,
    }
}

/// Machine-wide locations where the elevated helper can make changes.
fn needs_elevation_location(path: &Path) -> bool {
    let common_start = known::common_start_menu()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    [
        known::public_desktop().ok(),
        common_start,
        known::program_data().ok(),
    ]
    .into_iter()
    .flatten()
    .any(|base| path_starts_with_ci(path, &base))
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

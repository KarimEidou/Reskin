//! Folder icons (`desktop.ini`, `[.ShellClassInfo]`).
//!
//! Setting goes through `SHGetSetFolderCustomSettings(FCSM_ICONFILE,
//! FCS_FORCEWRITE)`, which writes `desktop.ini`, marks it hidden + system
//! and flags the folder so Explorer reads it (should the API not persist
//! the icon, `IconResource` is written directly instead). The API has no
//! documented way to *remove* an icon, so clearing deletes the
//! `IconResource` / `IconFile` / `IconIndex` keys with
//! `WritePrivateProfileStringW` (which preserves the file's encoding) and
//! removes a `desktop.ini` left without any key, un-flagging the folder.
//! Every change is verified by reading it back. Callers notify Explorer
//! afterwards ([`super::notify::item_updated`]).

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_SYSTEM,
    FILE_FLAGS_AND_ATTRIBUTES, GetFileAttributesW, INVALID_FILE_ATTRIBUTES, SetFileAttributesW,
};
use windows::Win32::System::WindowsProgramming::WritePrivateProfileStringW;
use windows::Win32::UI::Shell::{
    FCS_FORCEWRITE, FCSM_ICONFILE, PathMakeSystemFolderW, PathUnmakeSystemFolderW,
    SHFOLDERCUSTOMSETTINGS, SHGetSetFolderCustomSettings,
};
use windows::core::{PCWSTR, PWSTR, w};

use super::util::{
    ComScope, ResultExt, parse_icon_location, paths_equal_ci, pcwstr, resolve_icon_path, wide,
};
use crate::urlini::UrlFile;
use crate::{Error, Result};

const SECTION: &str = ".ShellClassInfo";
const ICON_KEYS: [&str; 3] = ["IconResource", "IconFile", "IconIndex"];

fn desktop_ini(folder: &Path) -> PathBuf {
    folder.join("desktop.ini")
}

fn ensure_folder(path: &Path) -> Result<()> {
    if path.is_dir() {
        Ok(())
    } else {
        Err(Error::NotFound(format!(
            "{} is not a folder",
            path.display()
        )))
    }
}

fn settings(icon_file: PWSTR, capacity: u32, index: i32) -> SHFOLDERCUSTOMSETTINGS {
    SHFOLDERCUSTOMSETTINGS {
        dwSize: size_of::<SHFOLDERCUSTOMSETTINGS>() as u32,
        dwMask: FCSM_ICONFILE,
        pszIconFile: icon_file,
        cchIconFile: capacity,
        iIconIndex: index,
        ..Default::default()
    }
}

/// The folder's custom icon as stored in `desktop.ini` (raw: may contain
/// `%VARS%` or be relative to the folder) and its index; `None` when the
/// folder has no custom icon.
///
/// `desktop.ini` is read directly: it is the only place the setting lives,
/// and `SHGetSetFolderCustomSettings(FCS_READ)` can answer from the shell's
/// cache after the file changed (Windows CI showed a cleared icon still
/// being reported).
pub fn read_folder_icon(path: &Path) -> Result<Option<(String, i32)>> {
    ensure_folder(path)?;
    read_ini_icon(path)
}

fn read_ini_icon(folder: &Path) -> Result<Option<(String, i32)>> {
    let bytes = match std::fs::read(desktop_ini(folder)) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let ini = UrlFile::parse(&bytes);
    if let Some(found) = ini
        .get(SECTION, "IconResource")
        .and_then(parse_icon_location)
    {
        return Ok(Some(found));
    }
    Ok(ini
        .get(SECTION, "IconFile")
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(|f| {
            let index = ini
                .get(SECTION, "IconIndex")
                .and_then(|i| i.trim().parse().ok())
                .unwrap_or(0);
            (f.to_owned(), index)
        }))
}

/// Sets (`Some((icon, index))`) or clears (`None`) a folder's custom icon.
pub fn set_folder_icon(path: &Path, icon: Option<(&Path, i32)>) -> Result<()> {
    ensure_folder(path)?;
    let _com = ComScope::enter()?;
    match icon {
        Some((icon, index)) => set_icon(path, icon, index),
        None => clear_icon(path),
    }
}

fn shows(path: &Path, icon: &Path, index: i32) -> Result<bool> {
    Ok(read_folder_icon(path)?.is_some_and(|(file, i)| {
        i == index
            && paths_equal_ci(
                resolve_icon_path(&file, Some(path)).as_os_str(),
                icon.as_os_str(),
            )
    }))
}

fn set_icon(path: &Path, icon: &Path, index: i32) -> Result<()> {
    let mut icon_w = wide(icon);
    // cchIconFile is ignored when writing.
    let mut fcs = settings(PWSTR(icon_w.as_mut_ptr()), 0, index);
    let w = wide(path);
    // SAFETY: `icon_w` outlives the call.
    let api = unsafe { SHGetSetFolderCustomSettings(&mut fcs, pcwstr(&w), FCS_FORCEWRITE) }
        .ctx(format!("customise folder {}", path.display()));
    if api.is_ok() && shows(path, icon, index)? {
        return Ok(());
    }
    write_ini_icon(path, icon, index).map_err(|e| match api {
        Err(api @ Error::AccessDenied(_)) => api,
        _ => e,
    })?;
    if shows(path, icon, index)? {
        Ok(())
    } else {
        Err(Error::Other(format!(
            "{} did not keep the new icon",
            path.display()
        )))
    }
}

/// Fallback writer: `IconResource=path,index` in a Unicode desktop.ini,
/// hidden + system, and the folder flagged as customised.
fn write_ini_icon(folder: &Path, icon: &Path, index: i32) -> Result<()> {
    let ini = desktop_ini(folder);
    if !ini.exists() {
        // A UTF-16LE BOM makes the profile API write Unicode text.
        std::fs::write(&ini, [0xFF, 0xFE])?;
    }
    with_writable(&ini, |ini_w| {
        let mut location = icon.as_os_str().to_owned();
        location.push(format!(",{index}"));
        let value = wide(location);
        let section = wide(SECTION);
        // SAFETY: NUL-terminated strings that outlive the calls.
        unsafe {
            WritePrivateProfileStringW(
                pcwstr(&section),
                w!("IconResource"),
                pcwstr(&value),
                pcwstr(ini_w),
            )
            .ctx("write desktop.ini")?;
            // Older spellings would compete with IconResource.
            for key in [w!("IconFile"), w!("IconIndex")] {
                WritePrivateProfileStringW(pcwstr(&section), key, PCWSTR::null(), pcwstr(ini_w))
                    .ctx("write desktop.ini")?;
            }
        }
        Ok(())
    })?;
    let ini_w = wide(&ini);
    let folder_w = wide(folder);
    // SAFETY: valid NUL-terminated paths.
    unsafe {
        let attrs = GetFileAttributesW(pcwstr(&ini_w));
        let attrs = if attrs == INVALID_FILE_ATTRIBUTES {
            0
        } else {
            attrs
        };
        SetFileAttributesW(
            pcwstr(&ini_w),
            FILE_FLAGS_AND_ATTRIBUTES(attrs) | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM,
        )
        .ctx("hide desktop.ini")?;
        if !PathMakeSystemFolderW(pcwstr(&folder_w)).as_bool() {
            return Err(Error::Other(format!(
                "could not mark {} as a customised folder",
                folder.display()
            )));
        }
    }
    Ok(())
}

/// Runs `f` with desktop.ini's read-only attribute lifted (restored after).
fn with_writable(ini: &Path, f: impl FnOnce(&[u16]) -> Result<()>) -> Result<()> {
    let w = wide(ini);
    // SAFETY: valid NUL-terminated path.
    let attrs = unsafe { GetFileAttributesW(pcwstr(&w)) };
    let read_only = attrs != INVALID_FILE_ATTRIBUTES && attrs & FILE_ATTRIBUTE_READONLY.0 != 0;
    if read_only {
        // SAFETY: as above.
        unsafe {
            SetFileAttributesW(
                pcwstr(&w),
                FILE_FLAGS_AND_ATTRIBUTES(attrs & !FILE_ATTRIBUTE_READONLY.0),
            )
        }
        .ctx("make desktop.ini writable")?;
    }
    let result = f(&w);
    if read_only && std::fs::metadata(ini).is_ok() {
        // SAFETY: as above.
        let _ = unsafe { SetFileAttributesW(pcwstr(&w), FILE_FLAGS_AND_ATTRIBUTES(attrs)) };
    }
    result
}

fn clear_icon(path: &Path) -> Result<()> {
    let w = wide(path);
    let ini = desktop_ini(path);
    if ini.exists() {
        with_writable(&ini, |ini_w| {
            let section = wide(SECTION);
            for key in ICON_KEYS {
                let key = wide(key);
                // SAFETY: NUL-terminated strings; a NULL value deletes the key.
                unsafe {
                    WritePrivateProfileStringW(
                        pcwstr(&section),
                        pcwstr(&key),
                        PCWSTR::null(),
                        pcwstr(ini_w),
                    )
                }
                .ctx("update desktop.ini")?;
            }
            // SAFETY: all-NULL call flushes the profile cache for this file.
            let _ = unsafe {
                WritePrivateProfileStringW(
                    PCWSTR::null(),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    pcwstr(ini_w),
                )
            };
            Ok(())
        })?;
        if read_ini_icon(path)?.is_some() {
            // The profile API left a key behind (odd spellings, duplicate
            // sections): rewrite the file ourselves, keeping its encoding.
            rewrite_without_icon(&ini)?;
        }
        if UrlFile::parse(&std::fs::read(&ini)?).is_empty() {
            // Nothing else customises the folder: drop desktop.ini and the
            // folder's "read desktop.ini" flag.
            let ini_w = wide(&ini);
            // SAFETY: valid NUL-terminated paths.
            unsafe {
                let _ = SetFileAttributesW(pcwstr(&ini_w), FILE_ATTRIBUTE_NORMAL);
                std::fs::remove_file(&ini)?;
                let _ = PathUnmakeSystemFolderW(pcwstr(&w));
            }
        }
    }
    match read_folder_icon(path)? {
        None => Ok(()),
        Some((file, _)) => Err(Error::Other(format!(
            "{} still has the icon {file}",
            path.display()
        ))),
    }
}

/// Removes every icon key from `desktop.ini` by rewriting it. The file is
/// hidden + system, and `CREATE_ALWAYS` refuses to replace such files, so
/// its attributes are cleared for the write and put back afterwards.
fn rewrite_without_icon(ini: &Path) -> Result<()> {
    let mut parsed = UrlFile::parse(&std::fs::read(ini)?);
    for key in ICON_KEYS {
        while parsed.remove(SECTION, key) {}
    }
    let ini_w = wide(ini);
    // SAFETY: valid NUL-terminated path.
    let attrs = unsafe { GetFileAttributesW(pcwstr(&ini_w)) };
    // SAFETY: as above.
    unsafe { SetFileAttributesW(pcwstr(&ini_w), FILE_ATTRIBUTE_NORMAL) }
        .ctx("make desktop.ini writable")?;
    let written = std::fs::write(ini, parsed.to_bytes());
    if attrs != INVALID_FILE_ATTRIBUTES {
        // SAFETY: as above.
        let _ = unsafe { SetFileAttributesW(pcwstr(&ini_w), FILE_FLAGS_AND_ATTRIBUTES(attrs)) };
    }
    written?;
    Ok(())
}

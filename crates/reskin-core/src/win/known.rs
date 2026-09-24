//! Known folders (`SHGetKnownFolderPath`). None of these need COM.

use std::path::PathBuf;

use windows::Win32::UI::Shell::{
    FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_LocalAppData, FOLDERID_ProgramData,
    FOLDERID_Programs, FOLDERID_PublicDesktop, FOLDERID_RoamingAppData, FOLDERID_Windows,
    KF_FLAG_DEFAULT, SHGetKnownFolderPath,
};
use windows::core::GUID;

use super::util::{ResultExt, take_co_string};
use crate::Result;

fn known_folder(id: &GUID, what: &str) -> Result<PathBuf> {
    // SAFETY: valid GUID; the returned string is CoTaskMemAlloc'ed and
    // freed by take_co_string.
    let path = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None) }
        .ctx(format!("locate the {what} folder"))?;
    Ok(PathBuf::from(unsafe { take_co_string(path) }))
}

/// The user's desktop (`FOLDERID_Desktop`).
pub fn desktop() -> Result<PathBuf> {
    known_folder(&FOLDERID_Desktop, "desktop")
}

/// The all-users desktop, `C:\Users\Public\Desktop` (`FOLDERID_PublicDesktop`).
pub fn public_desktop() -> Result<PathBuf> {
    known_folder(&FOLDERID_PublicDesktop, "public desktop")
}

/// `C:\ProgramData` (`FOLDERID_ProgramData`).
pub fn program_data() -> Result<PathBuf> {
    known_folder(&FOLDERID_ProgramData, "ProgramData")
}

/// The user's Start-menu programs, `…\Start Menu\Programs` (`FOLDERID_Programs`).
pub fn start_menu() -> Result<PathBuf> {
    known_folder(&FOLDERID_Programs, "Start menu")
}

/// The all-users Start-menu programs (`FOLDERID_CommonPrograms`).
pub fn common_start_menu() -> Result<PathBuf> {
    known_folder(&FOLDERID_CommonPrograms, "common Start menu")
}

/// `%APPDATA%` (`FOLDERID_RoamingAppData`).
pub fn roaming_app_data() -> Result<PathBuf> {
    known_folder(&FOLDERID_RoamingAppData, "roaming AppData")
}

/// `%LOCALAPPDATA%` (`FOLDERID_LocalAppData`).
pub fn local_app_data() -> Result<PathBuf> {
    known_folder(&FOLDERID_LocalAppData, "local AppData")
}

/// `%SystemRoot%` (`FOLDERID_Windows`).
pub fn windows_dir() -> Result<PathBuf> {
    known_folder(&FOLDERID_Windows, "Windows")
}

/// Pinned taskbar shortcuts:
/// `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar`.
pub fn taskbar_pins() -> Result<PathBuf> {
    Ok(roaming_app_data()?
        .join("Microsoft")
        .join("Internet Explorer")
        .join("Quick Launch")
        .join("User Pinned")
        .join("TaskBar"))
}

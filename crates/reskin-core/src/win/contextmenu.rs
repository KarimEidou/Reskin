//! The Explorer context-menu verb "Reskin this icon" (per user, HKCU).
//!
//! For each of `lnkfile`, `InternetShortcut` and `Directory`:
//!
//! ```text
//! HKCU\Software\Classes\<class>\shell\Reskin
//!     MUIVerb = Reskin this icon
//!     Icon    = "C:\…\reskin.exe",0
//!     \command
//!         (Default) = "C:\…\reskin.exe" --edit "%1"
//! ```

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use windows::Win32::System::Registry::{HKEY_CURRENT_USER, KEY_READ, REG_SZ};

use super::util::{RegKey, delete_tree, eq_ci};
use crate::Result;

/// Menu text of the verb.
pub const VERB_LABEL: &str = "Reskin this icon";

const CLASSES: [&str; 3] = ["lnkfile", "InternetShortcut", "Directory"];

fn verb_key(class: &str) -> String {
    format!(r"Software\Classes\{class}\shell\Reskin")
}

fn command_key(class: &str) -> String {
    format!(r"{}\command", verb_key(class))
}

fn quoted(exe: &Path) -> OsString {
    let mut s = OsString::from("\"");
    s.push(exe.as_os_str());
    s.push("\"");
    s
}

fn command_for(exe: &Path) -> OsString {
    let mut cmd = quoted(exe);
    cmd.push(" --edit \"%1\"");
    cmd
}

/// Registers the verb for shortcuts, Internet Shortcuts and folders,
/// launching `exe --edit "<path>"`. Re-installing overwrites (e.g. after
/// the exe moved).
pub fn install(exe: &Path) -> Result<()> {
    let mut icon = quoted(exe);
    icon.push(",0");
    let command = command_for(exe);
    for class in CLASSES {
        let verb = RegKey::create(HKEY_CURRENT_USER, &verb_key(class))?;
        verb.set_string("MUIVerb", VERB_LABEL, REG_SZ)?;
        verb.set_string("Icon", &icon, REG_SZ)?;
        RegKey::create(HKEY_CURRENT_USER, &command_key(class))?.set_string("", &command, REG_SZ)?;
    }
    Ok(())
}

/// Removes the verb from all three classes (absent keys are fine).
pub fn uninstall() -> Result<()> {
    for class in CLASSES {
        delete_tree(HKEY_CURRENT_USER, &verb_key(class))?;
    }
    Ok(())
}

fn installed_command(class: &str) -> Option<String> {
    RegKey::open(HKEY_CURRENT_USER, &command_key(class), KEY_READ)
        .ok()
        .flatten()?
        .string("")
        .ok()
        .flatten()
        .filter(|c| !c.trim().is_empty())
}

/// The verb is registered for all three classes.
pub fn is_installed() -> bool {
    CLASSES.iter().all(|c| installed_command(c).is_some())
}

/// The verb is registered for all three classes and launches `exe`
/// (so a moved or reinstalled app can re-register itself).
pub fn is_installed_for(exe: &Path) -> bool {
    let expected = command_for(exe);
    CLASSES.iter().all(|c| {
        installed_command(c).is_some_and(|cmd| eq_ci(OsStr::new(&cmd), expected.as_os_str()))
    })
}

/// The executable the shortcut-class verb launches, when registered in
/// the form [`install`] writes (`"<exe>" --edit "%1"`).
pub fn installed_exe() -> Option<PathBuf> {
    let command = installed_command(CLASSES[0])?;
    let rest = command.strip_prefix('"')?;
    let (exe, args) = rest.split_once('"')?;
    (args.trim_start().starts_with("--edit") && !exe.is_empty()).then(|| PathBuf::from(exe))
}

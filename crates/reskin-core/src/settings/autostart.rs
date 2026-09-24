//! "Start with Windows": the per-user `Run` entry that starts Reskin at
//! sign-in, and the flag Task Manager keeps next to it.
//!
//! ```text
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Run
//!     Reskin = "C:\…\reskin.exe" --autostart
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run
//!     Reskin = 03 00 00 00 <FILETIME>      (turned off; 02 00 … = on)
//! ```
//!
//! The command quotes the executable: an unquoted path containing a space
//! (`C:\Program Files\…`, `C:\Users\Jane Doe\…`) is split at the space and
//! may start something else. Task Manager (and Settings › Apps › Startup)
//! turn an entry off by flagging it in `StartupApproved` and leave the `Run`
//! value alone; [`StartupEntry::Disabled`] reports that. Only [`enable`] and
//! [`disable`] — the user's own choice in Reskin — override it.

use std::ffi::{OsStr, OsString};
use std::path::Path;

/// Flag Windows passes Reskin when it starts it at sign-in.
pub const AUTOSTART_ARG: &str = "--autostart";

/// Name of Reskin's values under `Run` and `StartupApproved\Run`.
pub const ENTRY_NAME: &str = "Reskin";

/// State of a `Run` entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupEntry {
    /// No `Run` value.
    Missing,
    /// Windows runs it at sign-in.
    Enabled,
    /// Present, but turned off in Task Manager / Settings › Apps › Startup.
    Disabled,
}

impl StartupEntry {
    /// From the `Run` value's presence and the `StartupApproved` flags.
    pub fn from_values(run_value: bool, approval: Option<&[u8]>) -> StartupEntry {
        match (run_value, approval.is_none_or(is_approved)) {
            (false, _) => StartupEntry::Missing,
            (true, true) => StartupEntry::Enabled,
            (true, false) => StartupEntry::Disabled,
        }
    }
}

/// `"<exe>" --autostart`: the `Run` value that starts `exe` at sign-in.
pub fn run_command(exe: &Path) -> OsString {
    let mut cmd = OsString::from("\"");
    cmd.push(exe.as_os_str());
    cmd.push("\" ");
    cmd.push(AUTOSTART_ARG);
    cmd
}

/// Whether a `Run` value already is [`run_command`]`(exe)` (paths compare
/// case-insensitively, like Windows does).
pub fn is_run_command_for(value: &OsStr, exe: &Path) -> bool {
    value.to_string_lossy().to_lowercase() == run_command(exe).to_string_lossy().to_lowercase()
}

/// Reads Task Manager's `StartupApproved` flags: an odd first byte means
/// the user turned the entry off (`03`, followed by when); an even one
/// (`02`, `06`) or an empty value means on.
pub fn is_approved(flags: &[u8]) -> bool {
    flags.first().is_none_or(|b| b & 1 == 0)
}

#[cfg(windows)]
pub use self::registry::{disable, enable, repoint, state};

#[cfg(windows)]
mod registry {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;

    use windows::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_UNSUPPORTED_TYPE, WIN32_ERROR,
    };
    use windows::Win32::System::Registry::{
        HKEY_CURRENT_USER, REG_ROUTINE_FLAGS, REG_SZ, RRF_NOEXPAND, RRF_RT_REG_BINARY,
        RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW,
    };
    use windows::core::HSTRING;

    use super::{StartupEntry, is_run_command_for, run_command};
    use crate::{Error, Result};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    fn check(e: WIN32_ERROR, what: &str) -> Result<()> {
        e.ok()
            .map_err(|err| Error::Other(format!("{what}: {}", Error::from(err))))
    }

    /// Bytes of `HKCU\<key>\<name>` when it exists and has one of the
    /// `types`; `None` otherwise (also when `key` doesn't exist).
    fn read(key: &str, name: &str, types: REG_ROUTINE_FLAGS) -> Result<Option<Vec<u8>>> {
        let (key_w, name_w) = (HSTRING::from(key), HSTRING::from(name));
        let what = format!(r"read HKCU\{key}\{name}");
        loop {
            let mut len = 0u32;
            // SAFETY: a size query: no buffer, valid out pointer.
            let e = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    &key_w,
                    &name_w,
                    types,
                    None,
                    None,
                    Some(&mut len),
                )
            };
            if e == ERROR_FILE_NOT_FOUND || e == ERROR_UNSUPPORTED_TYPE {
                return Ok(None);
            }
            check(e, &what)?;
            let mut buf = vec![0u8; len as usize];
            // SAFETY: `buf` holds `len` bytes.
            let e = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    &key_w,
                    &name_w,
                    types,
                    None,
                    Some(buf.as_mut_ptr().cast()),
                    Some(&mut len),
                )
            };
            match e {
                // Changed between the two calls.
                ERROR_MORE_DATA => continue,
                ERROR_FILE_NOT_FOUND | ERROR_UNSUPPORTED_TYPE => return Ok(None),
                _ => check(e, &what)?,
            }
            buf.truncate(len as usize);
            return Ok(Some(buf));
        }
    }

    fn run_value(name: &str) -> Result<Option<OsString>> {
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        Ok(read(RUN_KEY, name, flags)?.map(|bytes| {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&u| u != 0)
                .collect();
            OsString::from_wide(&units)
        }))
    }

    fn write_run_value(name: &str, command: &OsStr) -> Result<()> {
        let data: Vec<u16> = command.encode_wide().chain([0]).collect();
        // SAFETY: `data` is a NUL-terminated UTF-16 string of the given size.
        let e = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                &HSTRING::from(name),
                REG_SZ.0,
                Some(data.as_ptr().cast()),
                (data.len() * 2) as u32,
            )
        };
        check(e, &format!(r"write HKCU\{RUN_KEY}\{name}"))
    }

    fn delete_value(key: &str, name: &str) -> Result<()> {
        // SAFETY: plain registry call with valid strings.
        let e = unsafe {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &HSTRING::from(name))
        };
        if e == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        check(e, &format!(r"delete HKCU\{key}\{name}"))
    }

    /// Whether Windows starts the entry `name` at sign-in.
    pub fn state(name: &str) -> Result<StartupEntry> {
        let run = run_value(name)?.is_some();
        let approval = read(APPROVED_KEY, name, RRF_RT_REG_BINARY)?;
        Ok(StartupEntry::from_values(run, approval.as_deref()))
    }

    /// Starts `exe --autostart` at sign-in, overriding an entry the user
    /// turned off in Task Manager (a missing approval flag means on).
    pub fn enable(name: &str, exe: &Path) -> Result<()> {
        write_run_value(name, &run_command(exe))?;
        delete_value(APPROVED_KEY, name)
    }

    /// Removes the entry and its approval flag (absent ones are fine).
    pub fn disable(name: &str) -> Result<()> {
        delete_value(RUN_KEY, name)?;
        delete_value(APPROVED_KEY, name)
    }

    /// Points an existing entry at `exe` (it moved, or an older Reskin
    /// wrote the path unquoted) without touching its approval flag. Returns
    /// whether the value was rewritten.
    pub fn repoint(name: &str, exe: &Path) -> Result<bool> {
        match run_value(name)? {
            Some(value) if !is_run_command_for(&value, exe) => {
                write_run_value(name, &run_command(exe))?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_quotes_the_exe_and_passes_the_flag() {
        for exe in [
            r"C:\Program Files\Reskin\reskin.exe",
            r"C:\Users\Jane Doe\Downloads\Reskin_1.0.0_x64_portable.exe",
            r"D:\reskin.exe",
        ] {
            let cmd = run_command(Path::new(exe));
            assert_eq!(cmd, OsString::from(format!("\"{exe}\" --autostart")));
            assert!(is_run_command_for(&cmd, Path::new(exe)));
        }
    }

    #[test]
    fn only_the_exact_quoted_command_counts_as_ours() {
        let exe = Path::new(r"C:\Program Files\Reskin\reskin.exe");
        let upper = OsString::from(r#""C:\PROGRAM FILES\RESKIN\RESKIN.EXE" --autostart"#);
        assert!(is_run_command_for(&upper, exe));
        for other in [
            // What tauri-plugin-autostart wrote: unquoted.
            r"C:\Program Files\Reskin\reskin.exe --autostart",
            r#""C:\Program Files\Reskin\reskin.exe""#,
            r#""C:\Old\reskin.exe" --autostart"#,
            "",
        ] {
            assert!(!is_run_command_for(OsStr::new(other), exe), "{other}");
        }
    }

    #[test]
    fn task_manager_flags() {
        let on = [2u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let off = [3u8, 0, 0, 0, 0x60, 0x2d, 0x1b, 0x9c, 0x4e, 0x2f, 0xdb, 0x01];
        assert!(is_approved(&on));
        assert!(is_approved(&[6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(!is_approved(&off));
        assert!(!is_approved(&[7, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        assert!(is_approved(&[]));

        assert_eq!(
            StartupEntry::from_values(false, None),
            StartupEntry::Missing
        );
        assert_eq!(
            StartupEntry::from_values(false, Some(&off)),
            StartupEntry::Missing
        );
        assert_eq!(StartupEntry::from_values(true, None), StartupEntry::Enabled);
        assert_eq!(
            StartupEntry::from_values(true, Some(&on)),
            StartupEntry::Enabled
        );
        assert_eq!(
            StartupEntry::from_values(true, Some(&off)),
            StartupEntry::Disabled
        );
    }
}

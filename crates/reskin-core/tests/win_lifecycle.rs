//! App lifecycle against the real HKCU and Explorer: the "Start with
//! Windows" entry (and Task Manager's flag next to it), and starting a
//! process unelevated through the shell or as the desktop user.
//!
//! Every test is `#[ignore]`d: they run on Windows CI with
//! `cargo test -- --include-ignored` (starting a process as the desktop
//! user needs administrator rights, which CI has). They use their own registry value
//! names and temp folders and remove them again, also when an assertion
//! fails (drop guards).
#![cfg(windows)]

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reskin_core::settings::autostart::{self, StartupEntry};
use reskin_core::win::elevate;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    HKEY_CURRENT_USER, REG_BINARY, REG_SZ, RRF_RT_ANY, RegDeleteKeyValueW, RegGetValueW,
    RegSetKeyValueW,
};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetShellWindow};
use windows::core::{HSTRING, PCWSTR, w};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

fn unique(tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("reskin-test-{tag}-{}-{nanos}", std::process::id())
}

/// Raw bytes of `HKCU\<key>\<name>`.
fn raw_value(key: &str, name: &str) -> Option<Vec<u8>> {
    let (key, name) = (HSTRING::from(key), HSTRING::from(name));
    let mut len = 0u32;
    // SAFETY: size query, valid out pointer.
    let e = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &name,
            RRF_RT_ANY,
            None,
            None,
            Some(&mut len),
        )
    };
    if e != ERROR_SUCCESS {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    // SAFETY: `buf` holds `len` bytes.
    let e = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &name,
            RRF_RT_ANY,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    (e == ERROR_SUCCESS).then(|| {
        buf.truncate(len as usize);
        buf
    })
}

fn run_value(name: &str) -> Option<OsString> {
    raw_value(RUN_KEY, name).map(|bytes| {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        OsString::from_wide(&units)
    })
}

/// Writes a `Run` value as another program (an older Reskin) would.
fn set_run_value(name: &str, command: &str) {
    let data: Vec<u16> = command.encode_utf16().chain([0]).collect();
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
    assert_eq!(e, ERROR_SUCCESS);
}

/// What Task Manager writes when the user turns an entry off.
fn turn_off_in_task_manager(name: &str) {
    let flags = [3u8, 0, 0, 0, 0x60, 0x2d, 0x1b, 0x9c, 0x4e, 0x2f, 0xdb, 0x01];
    // SAFETY: `flags` is a 12-byte buffer.
    let e = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(APPROVED_KEY),
            &HSTRING::from(name),
            REG_BINARY.0,
            Some(flags.as_ptr().cast()),
            flags.len() as u32,
        )
    };
    assert_eq!(e, ERROR_SUCCESS);
}

/// Removes a test entry and its flag.
struct Entry(String);

impl Drop for Entry {
    fn drop(&mut self) {
        for key in [RUN_KEY, APPROVED_KEY] {
            // Best effort: the value may be gone already.
            // SAFETY: plain registry call with valid strings.
            let _ = unsafe {
                RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(key),
                    &HSTRING::from(&*self.0),
                )
            };
        }
    }
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn start_with_windows_quotes_the_exe_and_respects_task_manager() {
    let entry = Entry(unique("autostart"));
    let name = entry.0.as_str();
    let exe = Path::new(r"C:\Program Files\Reskin Test\reskin.exe");
    assert_eq!(autostart::state(name).unwrap(), StartupEntry::Missing);
    // Nothing to point anywhere yet.
    assert!(!autostart::repoint(name, exe).unwrap());

    autostart::enable(name, exe).unwrap();
    assert_eq!(autostart::state(name).unwrap(), StartupEntry::Enabled);
    assert_eq!(
        run_value(name).unwrap(),
        OsString::from(r#""C:\Program Files\Reskin Test\reskin.exe" --autostart"#)
    );

    // Turned off in Task Manager: the Run value stays, the entry is off.
    turn_off_in_task_manager(name);
    assert_eq!(autostart::state(name).unwrap(), StartupEntry::Disabled);
    let flags = raw_value(APPROVED_KEY, name).unwrap();

    // The exe it starts is gone (moved, uninstalled): the running one
    // takes the entry over, which stays off.
    let moved = Path::new(r"D:\Apps\reskin.exe");
    assert!(autostart::repoint(name, moved).unwrap());
    assert!(!autostart::repoint(name, moved).unwrap());
    assert_eq!(
        run_value(name).unwrap(),
        OsString::from(r#""D:\Apps\reskin.exe" --autostart"#)
    );
    assert_eq!(raw_value(APPROVED_KEY, name).unwrap(), flags);
    assert_eq!(autostart::state(name).unwrap(), StartupEntry::Disabled);

    // Another copy that exists keeps the entry (this test binary stands in
    // for it); written unquoted by an older Reskin, it gets quoted.
    let other = std::env::current_exe().unwrap();
    let unquoted = format!("{} --autostart", other.display());
    set_run_value(name, &unquoted);
    assert!(autostart::repoint(name, moved).unwrap());
    assert_eq!(run_value(name).unwrap(), autostart::run_command(&other));
    assert!(!autostart::repoint(name, moved).unwrap());
    assert_eq!(run_value(name).unwrap(), autostart::run_command(&other));
    assert_eq!(raw_value(APPROVED_KEY, name).unwrap(), flags);

    // Turning it on in Reskin overrides Task Manager.
    autostart::enable(name, moved).unwrap();
    assert_eq!(autostart::state(name).unwrap(), StartupEntry::Enabled);
    assert_eq!(raw_value(APPROVED_KEY, name), None);

    autostart::disable(name).unwrap();
    assert_eq!(autostart::state(name).unwrap(), StartupEntry::Missing);
    assert_eq!(run_value(name), None);
    // Already gone: still fine.
    autostart::disable(name).unwrap();
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn a_process_starts_through_explorer() {
    // A headless session has no Explorer desktop to start anything through.
    // SAFETY: plain window lookup.
    if unsafe { FindWindowW(w!("Progman"), PCWSTR::null()) }.is_err() {
        return;
    }
    let dir: PathBuf = std::env::temp_dir().join(unique("unelevated"));
    let cmd = PathBuf::from(std::env::var_os("ComSpec").expect("ComSpec"));
    elevate::run_unelevated(
        &cmd,
        &[
            "/c".into(),
            "mkdir".into(),
            dir.to_string_lossy().into_owned(),
        ],
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !dir.is_dir() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let created = dir.is_dir();
    let _ = std::fs::remove_dir(&dir);
    assert!(created, "Explorer did not run {}", cmd.display());
}

#[test]
#[ignore = "Windows shell integration as administrator (run with --include-ignored)"]
fn a_process_runs_as_the_desktop_user_and_its_exit_code_comes_back() {
    // A headless session has no desktop shell to take the user from, and
    // an administrator's rights are what allow it (CI has them).
    // SAFETY: plain window lookup.
    if unsafe { GetShellWindow() }.is_invalid() {
        assert!(matches!(
            elevate::run_as_desktop_user(Path::new("cmd.exe"), &[]),
            Err(reskin_core::Error::NotFound(_))
        ));
        return;
    }
    let cmd = PathBuf::from(std::env::var_os("ComSpec").expect("ComSpec"));
    let dir: PathBuf = std::env::temp_dir().join(unique("desktop-user"));
    let started = Instant::now();
    let code = elevate::run_as_desktop_user(
        &cmd,
        &[
            "/c".into(),
            "mkdir".into(),
            dir.to_string_lossy().into_owned(),
            "&&".into(),
            "exit".into(),
            "7".into(),
        ],
    )
    .unwrap();
    // It was waited for: its work is done and its exit code is back.
    let created = dir.is_dir();
    let _ = std::fs::remove_dir(&dir);
    assert_eq!(code, 7);
    assert!(created, "{} did not run", cmd.display());
    assert!(started.elapsed() < Duration::from_secs(60));
}

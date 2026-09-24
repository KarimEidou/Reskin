//! Running the elevated helper (`reskin.exe --elevated-apply <job>`), and
//! leaving elevation behind.
//!
//! The app itself always runs unelevated; privileged writes (Public Desktop
//! shortcuts) go through a UAC-elevated child process. [`run_elevated`]
//! blocks for up to five minutes, so call it from a blocking worker
//! (`spawn_blocking`), not from the STA thread. An app started "as
//! administrator" ([`is_uac_elevated`]) starts itself again through
//! Explorer with [`run_unelevated`]: elevated, it would not get Explorer's
//! drags (UIPI drops them), and its shell writes would bypass the helper's
//! validation.

use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::path::Path;

use windows::Win32::Foundation::{
    ERROR_CANCELLED, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT, WIN32_ERROR,
};
use windows::Win32::Security::{
    GetTokenInformation, TOKEN_ELEVATION_TYPE, TOKEN_QUERY, TokenElevationType,
    TokenElevationTypeFull,
};
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, CoCreateInstance, IDispatch, IServiceProvider,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject,
};
use windows::Win32::System::Variant::{VARIANT, VT_BSTR, VT_I4, VariantClear};
use windows::Win32::UI::Shell::{
    CSIDL_DESKTOP, IShellBrowser, IShellDispatch2, IShellFolderViewDual, IShellWindows,
    SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, SID_STopLevelBrowser,
    SVGIO_BACKGROUND, SWC_DESKTOP, SWFO_NEEDDISPATCH, ShellExecuteExW, ShellWindows,
};
use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNORMAL};
use windows::core::{BSTR, Interface, Owned, PCWSTR, w};

use super::util::{ComScope, ResultExt, pcwstr, wide};
use crate::{Error, Result};

/// How long the elevated helper may run.
const HELPER_TIMEOUT_MS: u32 = 5 * 60 * 1000;

/// Quotes one argument so `CommandLineToArgvW` / the MSVC runtime parse it
/// back unchanged (backslashes are only special before a quote).
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return arg.to_owned();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                // Escape the pending backslashes and the quote itself.
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    // Backslashes before the closing quote must be doubled.
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// Joins arguments into one command line.
fn command_line(args: &[String]) -> String {
    args.iter()
        .map(|a| quote_arg(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Starts `exe args…` elevated (`ShellExecuteExW` verb `runas`, hidden
/// window), waits up to five minutes and returns its exit code.
/// The user declining the UAC prompt gives [`Error::Cancelled`].
pub fn run_elevated(exe: &Path, args: &[String]) -> Result<i32> {
    let _com = ComScope::enter()?;
    let file = wide(exe);
    let params = wide(command_line(args));
    let dir = exe.parent().map(wide);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        // No SEE_MASK_FLAG_NO_UI: the UAC prompt must be allowed to show.
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: w!("runas"),
        lpFile: pcwstr(&file),
        lpParameters: pcwstr(&params),
        lpDirectory: dir.as_deref().map_or(PCWSTR::null(), pcwstr),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    // SAFETY: every string outlives the call; `info` is fully initialised.
    if let Err(e) = unsafe { ShellExecuteExW(&mut info) } {
        if WIN32_ERROR::from_error(&e) == Some(ERROR_CANCELLED) {
            return Err(Error::Cancelled);
        }
        return Err(super::util::with_context(e, "start the elevated helper"));
    }
    if info.hProcess.is_invalid() {
        return Err(Error::Other(
            "the elevated helper started without a process handle".into(),
        ));
    }
    // SAFETY: SEE_MASK_NOCLOSEPROCESS hands us the process handle.
    let process: Owned<HANDLE> = unsafe { Owned::new(info.hProcess) };
    // SAFETY: valid process handle.
    match unsafe { WaitForSingleObject(*process, HELPER_TIMEOUT_MS) } {
        WAIT_OBJECT_0 => {}
        WAIT_TIMEOUT => {
            return Err(Error::Other(
                "the elevated helper did not finish within 5 minutes".into(),
            ));
        }
        _ => {
            return Err(super::util::with_context(
                windows_core::Error::from_win32(),
                "wait for the elevated helper",
            ));
        }
    }
    let mut code = 0u32;
    // SAFETY: valid process handle and out pointer.
    unsafe { GetExitCodeProcess(*process, &mut code) }.ctx("read the helper's exit code")?;
    Ok(code as i32)
}

/// Whether this process holds the full token of an administrator under
/// UAC ("Run as administrator", `TokenElevationTypeFull`), so the same user
/// also has an unelevated token. False for standard users, filtered
/// administrator tokens, and when UAC is off (then there is nothing to
/// fall back to, and Explorer runs with the same token anyway).
pub fn is_uac_elevated() -> bool {
    let mut token = HANDLE::default();
    // SAFETY: pseudo-handle of the current process, valid out pointer.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.is_err() {
        return false;
    }
    // SAFETY: we own the token handle now.
    let token = unsafe { Owned::new(token) };
    let mut kind = TOKEN_ELEVATION_TYPE::default();
    let mut len = 0u32;
    // SAFETY: `kind` is a TOKEN_ELEVATION_TYPE-sized buffer.
    unsafe {
        GetTokenInformation(
            *token,
            TokenElevationType,
            Some(&mut kind as *mut TOKEN_ELEVATION_TYPE as *mut c_void),
            size_of::<TOKEN_ELEVATION_TYPE>() as u32,
            &mut len,
        )
    }
    .is_ok()
        && kind == TokenElevationTypeFull
}

/// A `VARIANT` that frees its value on drop.
struct Variant(VARIANT);

impl Variant {
    fn i4(value: i32) -> Self {
        let mut v = VARIANT::default();
        // SAFETY: writing the active members of a zeroed VARIANT.
        unsafe {
            let inner = &mut v.Anonymous.Anonymous;
            inner.vt = VT_I4;
            inner.Anonymous.lVal = value;
        }
        Self(v)
    }

    fn bstr(value: &str) -> Self {
        let mut v = VARIANT::default();
        // SAFETY: writing the active members of a zeroed VARIANT; the BSTR
        // belongs to the VARIANT from here on (freed by VariantClear).
        unsafe {
            let inner = &mut v.Anonymous.Anonymous;
            inner.vt = VT_BSTR;
            inner.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(value));
        }
        Self(v)
    }
}

impl Drop for Variant {
    fn drop(&mut self) {
        // SAFETY: a VARIANT built by the constructors above.
        let _ = unsafe { VariantClear(&mut self.0) };
    }
}

/// Starts `exe args…` unelevated, the way the shell would: through the
/// desktop's `IShellDispatch2::ShellExecute`, which runs inside Explorer
/// (unelevated, with the user's own token). Returns once Explorer took the
/// request; the new process is not waited for.
pub fn run_unelevated(exe: &Path, args: &[String]) -> Result<()> {
    let _com = ComScope::enter()?;
    let file = BSTR::from(exe.to_string_lossy().as_ref());
    let dir = exe
        .parent()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (params, dir) = (Variant::bstr(&command_line(args)), Variant::bstr(&dir));
    let (verb, show) = (Variant::bstr("open"), Variant::i4(SW_SHOWNORMAL.0));
    // SAFETY (whole block): COM calls with valid arguments; every interface
    // and VARIANT outlives the calls that use it.
    unsafe {
        let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER)
            .ctx("create ShellWindows")?;
        let mut hwnd = 0i32;
        let desktop = windows
            .FindWindowSW(
                &Variant::i4(CSIDL_DESKTOP as i32).0,
                &VARIANT::default(),
                SWC_DESKTOP,
                &mut hwnd,
                SWFO_NEEDDISPATCH,
            )
            .ctx("find the desktop window")?;
        let provider: IServiceProvider = desktop.cast().ctx("desktop → IServiceProvider")?;
        let browser: IShellBrowser = provider
            .QueryService(&SID_STopLevelBrowser)
            .ctx("get the desktop browser")?;
        let view = browser.QueryActiveShellView().ctx("get the desktop view")?;
        let background: IDispatch = view
            .GetItemObject(SVGIO_BACKGROUND)
            .ctx("get the desktop's automation object")?;
        let folder_view: IShellFolderViewDual =
            background.cast().ctx("desktop → IShellFolderViewDual")?;
        let shell: IShellDispatch2 = folder_view
            .Application()
            .ctx("get the shell's automation object")?
            .cast()
            .ctx("shell → IShellDispatch2")?;
        shell
            .ShellExecute(&file, &params.0, &dir.0, &verb.0, &show.0)
            .ctx("start Reskin through Explorer")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_matches_commandlinetoargvw_rules() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("with space"), "\"with space\"");
        assert_eq!(quote_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_arg(r"C:\no\spaces"), r"C:\no\spaces");
        assert_eq!(
            command_line(&["--elevated-apply".into(), r"C:\Users\A B\job.json".into()]),
            r#"--elevated-apply "C:\Users\A B\job.json""#
        );
    }
}

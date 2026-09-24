//! Telling Explorer that icons changed.

use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::UI::Shell::{
    SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM, SHCNF_FLUSHNOWAIT, SHCNF_IDLIST, SHCNF_PATHW,
    SHChangeNotify,
};

use super::util::{system_dir, wide};
use crate::{Error, Result};

/// How long `ie4uinit -show` may take before it is abandoned.
const REBUILD_TIMEOUT: Duration = Duration::from_secs(10);

/// One item's icon changed (`SHCNE_UPDATEITEM`, path, no waiting for
/// Explorer to process it).
pub fn item_updated(path: &Path) {
    let w = wide(path);
    // SAFETY: `w` is a NUL-terminated path that outlives the call.
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEITEM,
            SHCNF_PATHW | SHCNF_FLUSHNOWAIT,
            Some(w.as_ptr() as *const c_void),
            None,
        )
    };
}

/// Icons may have changed everywhere (`SHCNE_ASSOCCHANGED`): used for
/// system icons and the "refresh desktop icons" command.
pub fn assoc_changed() {
    // SAFETY: SHCNE_ASSOCCHANGED takes no items.
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}

/// Runs `%SystemRoot%\System32\ie4uinit.exe -show` (no console window),
/// which makes Explorer re-read its icon cache, then broadcasts
/// [`assoc_changed`]. Waits at most 10 s. The tool's exit code carries no
/// meaning, so only a failure to start or a timeout is an error.
pub fn rebuild_icon_cache() -> Result<()> {
    let exe = system_dir().join("ie4uinit.exe");
    let mut child = Command::new(&exe)
        .arg("-show")
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::Other(format!("could not run {}: {e}", exe.display())))?;
    let deadline = Instant::now() + REBUILD_TIMEOUT;
    loop {
        match child.try_wait()? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Other(
                    "ie4uinit did not finish within 10 seconds".into(),
                ));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    assoc_changed();
    Ok(())
}

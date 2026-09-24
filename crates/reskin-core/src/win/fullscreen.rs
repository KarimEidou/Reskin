//! Detecting fullscreen apps / presentations (the box hides meanwhile).

use windows::Win32::UI::Shell::{
    QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
};

use super::util::ResultExt;
use crate::Result;

/// Whether a fullscreen app, a Direct3D fullscreen game or presentation
/// mode is active (`SHQueryUserNotificationState` in `QUNS_BUSY`,
/// `QUNS_RUNNING_D3D_FULL_SCREEN` or `QUNS_PRESENTATION_MODE`).
pub fn query_fullscreen_busy() -> Result<bool> {
    // SAFETY: no arguments.
    let state = unsafe { SHQueryUserNotificationState() }.ctx("query the notification state")?;
    Ok([
        QUNS_BUSY,
        QUNS_RUNNING_D3D_FULL_SCREEN,
        QUNS_PRESENTATION_MODE,
    ]
    .contains(&state))
}

/// [`query_fullscreen_busy`], treating a failed query as "not busy".
pub fn is_fullscreen_busy() -> bool {
    query_fullscreen_busy().unwrap_or(false)
}

use reskin_core::model::{BootInfo, BoxMetrics, WindowKind};
use tauri::{State, WebviewWindow};

use crate::hotkey;
use crate::state::AppState;

/// What a page needs to start. Pages call it again later (window focus) to
/// pick up what Windows changed since: accent, animation effects, hotkey.
#[tauri::command]
pub fn app_boot(window: WebviewWindow, state: State<'_, AppState>) -> BootInfo {
    let settings = state.settings();
    let kind = if window.label() == crate::windows::box_window::LABEL {
        WindowKind::Box
    } else {
        WindowKind::Editor
    };
    BootInfo {
        window: kind,
        version: env!("CARGO_PKG_VERSION").to_string(),
        box_metrics: BoxMetrics::for_size(settings.box_size),
        hotkey_error: hotkey::problem(&settings.hotkey),
        settings,
        system_reduced_motion: state.system_reduced_motion(),
        accent: reskin_core::win::wallpaper::accent_color(),
        build: crate::build_label(),
        smoke: state.smoke.enabled,
        first_run: state.first_run(),
        windows11: reskin_core::win::wallpaper::is_windows11(),
    }
}

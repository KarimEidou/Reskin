use reskin_core::model::{Settings, SmokeReport};
use tauri::{AppHandle, Manager, State};

use super::CmdResult;
use crate::state::AppState;

#[tauri::command]
pub fn smoke_ready(app: AppHandle, report: SmokeReport, state: State<'_, AppState>) {
    if state.smoke.enabled {
        crate::smoke::on_ready(&app, &state.smoke, report);
    }
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn settings_set(settings: Settings, state: State<'_, AppState>) -> CmdResult<Settings> {
    *state.settings.write().unwrap_or_else(|e| e.into_inner()) = settings.clone();
    Ok(settings)
}

#[tauri::command]
pub fn set_box_visible(app: AppHandle, visible: bool) -> CmdResult<()> {
    let w = app
        .get_webview_window(crate::windows::box_window::LABEL)
        .ok_or("box window missing")?;
    if visible { w.show() } else { w.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

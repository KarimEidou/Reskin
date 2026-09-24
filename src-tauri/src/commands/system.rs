use std::sync::OnceLock;

use reskin_core::model::{SmokeReport, WallpaperInfo};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use super::CmdResult;
use crate::state::AppState;
use crate::windows::{box_window, monitors, raw};
use crate::{actions, smoke};

const REPO: &str = "https://github.com/KarimEidou/Reskin";
/// Largest wallpaper file sent to the editor.
const MAX_WALLPAPER_BYTES: u64 = 48 * 1024 * 1024;

#[tauri::command]
pub fn smoke_ready(app: AppHandle, report: SmokeReport, state: State<'_, AppState>) {
    if state.smoke.enabled {
        smoke::on_ready(&app, &state.smoke, report);
    }
}

/// Raw bytes of the current wallpaper (for the "on your desktop" preview).
#[tauri::command]
pub async fn wallpaper() -> CmdResult<Response> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = reskin_core::win::wallpaper::wallpaper_path().ok_or("no wallpaper image")?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > MAX_WALLPAPER_BYTES {
            return Err("wallpaper image is too large".to_string());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wallpaper_info(app: AppHandle) -> CmdResult<WallpaperInfo> {
    // Size of the monitor the box lives on.
    let size = app
        .get_webview_window(box_window::LABEL)
        .and_then(|w| raw::rect(raw::hwnd_of(&w)))
        .and_then(|r| {
            let (cx, cy) = r.center();
            monitors::at_point(&app, cx, cy)
        })
        .map(|m| (m.rect.w as u32, m.rect.h as u32));
    tauri::async_runtime::spawn_blocking(move || {
        Ok(reskin_core::win::wallpaper::wallpaper_info(size))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn system_fonts() -> CmdResult<Vec<String>> {
    static FONTS: OnceLock<Vec<String>> = OnceLock::new();
    if let Some(f) = FONTS.get() {
        return Ok(f.clone());
    }
    let fonts = tauri::async_runtime::spawn_blocking(reskin_core::win::fonts::system_fonts)
        .await
        .map_err(|e| e.to_string())?;
    Ok(FONTS.get_or_init(|| fonts).clone())
}

#[tauri::command]
pub fn accent_color() -> Option<String> {
    reskin_core::win::wallpaper::accent_color()
}

#[tauri::command]
pub fn open_external(app: AppHandle, link: String) -> CmdResult<()> {
    let url = match link.as_str() {
        "releases" => format!("{REPO}/releases"),
        "repo" => REPO.to_string(),
        "license" => format!("{REPO}/blob/main/LICENSE"),
        other => return Err(format!("unknown link {other}")),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_box_visible(app: AppHandle, visible: bool) {
    actions::set_box_hidden(&app, !visible);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    actions::quit(&app);
}

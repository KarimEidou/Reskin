use reskin_core::model::{DragResult, EditorView, ItemId, SavedPos};
use tauri::{AppHandle, LogicalPosition, Manager, State, WebviewWindow};

use super::CmdResult;
use crate::state::AppState;
use crate::windows::{monitors, morph};
use crate::{items, menu};

/// Runs the native drag loop (JS calls this on pointerdown).
#[tauri::command]
pub async fn box_drag(app: AppHandle, state: State<'_, AppState>) -> CmdResult<DragResult> {
    let animator = state.animator.clone();
    let out = tauri::async_runtime::spawn_blocking(move || animator.drag())
        .await
        .map_err(|e| e.to_string())?
        .ok_or("box is not ready")?;
    if out.result == DragResult::Moved {
        let (x, y) = out.pos;
        let monitor = monitors::at_point(&app, x as f64, y as f64).and_then(|m| m.name);
        state.update_settings(&app, |s| {
            s.box_position = Some(SavedPos { x, y, monitor });
        });
    }
    Ok(out.result)
}

/// Right-click: native context menu at box-window CSS coordinates.
#[tauri::command]
pub fn box_menu(window: WebviewWindow, app: AppHandle, x: f64, y: f64) -> CmdResult<()> {
    let menu = menu::build(&app, true).map_err(|e| e.to_string())?;
    window
        .popup_menu_at(&menu, LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Opens the editor out of the box with previously inspected items.
#[tauri::command]
pub async fn open_editor(app: AppHandle, items: Vec<ItemId>, view: EditorView) -> CmdResult<()> {
    let infos = items::infos(&app.state::<AppState>(), &items)?;
    tauri::async_runtime::spawn_blocking(move || morph::open(&app, infos, view))
        .await
        .map_err(|e| e.to_string())?
}

//! Tray icon with the same menu as the box. Left-click toggles the box
//! (or opens the editor when the box is hidden by a fullscreen app).

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::{actions, menu};

pub const ID: &str = "reskin-tray";

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = menu::build(app, true)?;
    let mut builder = TrayIconBuilder::with_id(ID)
        .tooltip("Reskin")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                actions::toggle_box(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Refreshes the "Hide box / Show box" label.
pub fn refresh<R: Runtime>(app: &AppHandle<R>, box_visible: bool) {
    if let Some(tray) = app.tray_by_id(ID)
        && let Ok(menu) = menu::build(app, box_visible)
    {
        let _ = tray.set_menu(Some(menu));
    }
}

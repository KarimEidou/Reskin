//! The native menu shared by the box's right-click popup and the tray icon.

use reskin_core::model::{EditorView, SystemIconId};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

use crate::actions;

pub const OPEN: &str = "open";
pub const LIBRARY: &str = "library";
pub const RESTORE_ALL: &str = "restore-all";
pub const SETTINGS: &str = "settings";
pub const TOGGLE_BOX: &str = "toggle-box";
pub const QUIT: &str = "quit";
const SYS_PREFIX: &str = "sys:";

pub fn build<R: Runtime>(app: &AppHandle<R>, box_visible: bool) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, OPEN, "Open editor", true, None::<&str>)?;
    let library = MenuItem::with_id(app, LIBRARY, "Library", true, None::<&str>)?;
    let sys_items: Vec<MenuItem<R>> = SystemIconId::ALL
        .iter()
        .map(|id| {
            MenuItem::with_id(
                app,
                format!("{SYS_PREFIX}{}", id.slug()),
                id.label(),
                true,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<_>>()?;
    let sys_refs: Vec<&dyn IsMenuItem<R>> =
        sys_items.iter().map(|m| m as &dyn IsMenuItem<R>).collect();
    let system = Submenu::with_id_and_items(app, "system-icons", "System icons", true, &sys_refs)?;
    let restore = MenuItem::with_id(app, RESTORE_ALL, "Restore all icons…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, SETTINGS, "Settings", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        TOGGLE_BOX,
        if box_visible { "Hide box" } else { "Show box" },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, QUIT, "Quit Reskin", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &open, &library, &sep1, &system, &restore, &sep2, &settings, &toggle, &sep3, &quit,
        ],
    )
}

/// Handles a menu click (from the popup or the tray).
pub fn dispatch<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        OPEN => actions::open_editor(app, vec![], EditorView::Start),
        LIBRARY => actions::open_editor(app, vec![], EditorView::Library),
        SETTINGS => actions::open_editor(app, vec![], EditorView::Settings),
        RESTORE_ALL => actions::restore_all_interactive(app),
        TOGGLE_BOX => actions::toggle_box(app),
        QUIT => actions::quit(app),
        other => {
            if let Some(slug) = other.strip_prefix(SYS_PREFIX)
                && let Some(id) = SystemIconId::ALL.iter().find(|i| i.slug() == slug)
            {
                actions::open_system_icon(app, *id);
            }
        }
    }
}

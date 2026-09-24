//! High-level user actions shared by commands, the menu, the tray, the
//! hotkey and single-instance forwarding. Anything that runs a window
//! handoff blocks, so these spawn a thread.

use std::path::PathBuf;

use reskin_core::model::{
    BoxFlight, CollapseThen, EditorView, FlightPhase, ItemInfo, SystemIconId,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::state::AppState;
use crate::windows::{box_window, morph, raw};
use crate::{items, log, restore, tray};

fn spawn<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    f: impl FnOnce(AppHandle<R>) + Send + 'static,
) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name(format!("reskin-{name}"))
        .spawn(move || f(app));
}

/// Tells the box to shake with a message (e.g. after a failed open).
pub fn box_error<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let _ = app.emit_to(
        box_window::LABEL,
        "box:flight",
        BoxFlight {
            phase: FlightPhase::Error,
            icon: None,
            duration_ms: 480,
            message: Some(message.to_string()),
        },
    );
}

pub fn open_editor<R: Runtime>(app: &AppHandle<R>, items: Vec<ItemInfo>, view: EditorView) {
    spawn(app, "open", move |app| {
        if let Err(e) = morph::open(&app, items, view) {
            log::line(&format!("open editor failed: {e}"));
            box_error(&app, &e);
        }
    });
}

pub fn close_editor<R: Runtime>(app: &AppHandle<R>, then: CollapseThen) {
    spawn(app, "close", move |app| {
        if let Err(e) = morph::close(&app, then, None) {
            log::line(&format!("close editor failed: {e}"));
            morph::force_hide(&app);
        }
    });
}

/// Inspects paths (Explorer verb / second instance) and opens them.
pub fn open_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    spawn(app, "open-paths", move |app| {
        let infos = items::inspect_blocking(&app, &paths);
        if infos.is_empty() {
            box_error(&app, "Nothing Reskin can open there");
            return;
        }
        set_box_hidden(&app, false);
        if let Err(e) = morph::open(&app, infos, EditorView::Edit) {
            log::line(&format!("open paths failed: {e}"));
            box_error(&app, &e);
        }
    });
}

pub fn open_system_icon<R: Runtime>(app: &AppHandle<R>, id: SystemIconId) {
    spawn(
        app,
        "open-sys",
        move |app| match items::system_icon_blocking(&app, id) {
            Ok(info) => {
                if let Err(e) = morph::open(&app, vec![info], EditorView::Edit) {
                    box_error(&app, &e);
                }
            }
            Err(e) => {
                log::line(&format!("system icon {id:?}: {e}"));
                box_error(&app, &e);
            }
        },
    );
}

/// Hotkey / tray click: close the editor if open, else show/hide the box.
pub fn toggle_box<R: Runtime>(app: &AppHandle<R>) {
    spawn(app, "toggle", move |app| {
        let state = app.state::<AppState>();
        if state.morph.phase() == morph::Phase::Open {
            let _ = morph::close(&app, CollapseThen::Hide, None);
            return;
        }
        let visible = app
            .get_webview_window(box_window::LABEL)
            .map(|w| raw::is_visible(raw::hwnd_of(&w)))
            .unwrap_or(false);
        set_box_hidden(&app, visible);
    });
}

/// Shows or hides the box on the user's behalf (remembered until changed).
pub fn set_box_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    let state = app.state::<AppState>();
    state.set_box_hidden_by_user(hidden);
    if let Some(w) = app.get_webview_window(box_window::LABEL) {
        let h = raw::hwnd_of(&w);
        if hidden {
            raw::hide(h);
        } else if !state.hidden_for_fullscreen() {
            raw::show_no_activate(h);
            raw::set_topmost(h, true);
            let _ = app.emit_to(box_window::LABEL, "box:shown", ());
        }
    }
    tray::refresh(app, !hidden);
}

pub fn restore_all_interactive<R: Runtime>(app: &AppHandle<R>) {
    spawn(app, "restore-all", move |app| {
        let ok = app
            .dialog()
            .message(
                "Put every icon Reskin changed back to its original?\n\nYour saved designs in the Library are kept.",
            )
            .title("Restore all icons")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Restore all".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if !ok {
            return;
        }
        let report = restore::restore_all_blocking(&app);
        log::line(&format!("restore all: {report:?}"));
        let msg = if report.failed.is_empty() {
            format!("Restored {} icon(s).", report.restored)
        } else {
            format!(
                "Restored {} icon(s). {} could not be restored:\n{}",
                report.restored,
                report.failed.len(),
                report.failed.join("\n")
            )
        };
        app.dialog()
            .message(msg)
            .title("Restore all icons")
            .kind(if report.failed.is_empty() {
                MessageDialogKind::Info
            } else {
                MessageDialogKind::Warning
            })
            .blocking_show();
    });
}

pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    log::line("quit requested");
    app.exit(0);
}

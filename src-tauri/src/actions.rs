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
use crate::windows::rules::{self, Toggle};
use crate::windows::{box_window, morph, raw};
use crate::{items, log, restore};

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

/// Opens the editor (blocking); a failure shakes the box with the reason.
fn open_blocking<R: Runtime>(app: &AppHandle<R>, items: Vec<ItemInfo>, view: EditorView) {
    if let Err(e) = morph::open(app, items, view) {
        log::line(&format!("open editor failed: {e}"));
        box_error(app, &e);
    }
}

/// Closes the editor (blocking); a failed handoff still ends closed.
fn close_blocking<R: Runtime>(app: &AppHandle<R>, then: CollapseThen) {
    if let Err(e) = morph::close(app, then, None) {
        log::line(&format!("close editor failed: {e}"));
    }
}

pub fn open_editor<R: Runtime>(app: &AppHandle<R>, items: Vec<ItemInfo>, view: EditorView) {
    spawn(app, "open", move |app| open_blocking(&app, items, view));
}

pub fn close_editor<R: Runtime>(app: &AppHandle<R>, then: CollapseThen) {
    spawn(app, "close", move |app| close_blocking(&app, then));
}

/// Inspects paths (Explorer verb / second instance) and opens them.
pub fn open_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    spawn(app, "open-paths", move |app| {
        let infos = items::inspect_blocking(&app, &paths);
        if infos.is_empty() {
            box_error(&app, "Nothing Reskin can open there");
            return;
        }
        // The user asked for Reskin: bring the box back to open out of it.
        set_box_hidden(&app, false);
        open_blocking(&app, infos, EditorView::Edit);
    });
}

pub fn open_system_icon<R: Runtime>(app: &AppHandle<R>, id: SystemIconId) {
    spawn(
        app,
        "open-sys",
        move |app| match items::system_icon_blocking(&app, id) {
            Ok(info) => open_blocking(&app, vec![info], EditorView::Edit),
            Err(e) => {
                log::line(&format!("system icon {id:?}: {e}"));
                box_error(&app, &e);
            }
        },
    );
}

/// Hotkey / tray click: close the editor if open, else show/hide the box —
/// or, while a fullscreen app keeps the box hidden, open the editor.
pub fn toggle_box<R: Runtime>(app: &AppHandle<R>) {
    spawn(app, "toggle", move |app| {
        let state = app.state::<AppState>();
        let visible = app
            .get_webview_window(box_window::LABEL)
            .is_some_and(|w| raw::is_visible(raw::hwnd_of(&w)));
        match rules::toggle(state.morph.phase(), state.hidden_for_fullscreen(), visible) {
            Toggle::CloseEditor => close_blocking(&app, CollapseThen::Hide),
            Toggle::Nothing => {}
            Toggle::OpenEditor => open_blocking(&app, vec![], EditorView::Start),
            Toggle::SetHidden(hidden) => set_box_hidden(&app, hidden),
        }
    });
}

/// Shows or hides the box on the user's behalf (remembered until changed).
/// While the editor is open this only records the wish: the close honours
/// it. A fullscreen app keeps the box hidden either way.
pub fn set_box_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    app.state::<AppState>().set_box_hidden_by_user(hidden);
    morph::settle_box(app);
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

//! High-level user actions shared by commands, the menu, the tray, the
//! hotkey and single-instance forwarding. Anything that runs a window
//! handoff blocks, so these spawn a thread.

use std::path::PathBuf;

use reskin_core::model::{
    BoxFlight, CollapseThen, EditorView, FlightPhase, ItemInfo, RestoreReport, SystemIconId,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::state::AppState;
use crate::windows::morph::Phase;
use crate::windows::rules::{self, Toggle};
use crate::windows::{box_window, editor_window, morph, raw};
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

/// The editor page settled the apply that closed it (see `morph::apply_settled`).
pub fn apply_settled<R: Runtime>(app: &AppHandle<R>) {
    spawn(app, "apply-settled", |app| morph::apply_settled(&app));
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
/// it. A fullscreen app keeps the box hidden either way (hiding it ends
/// "Show box" over one).
pub fn set_box_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    app.state::<AppState>().set_box_hidden_by_user(hidden);
    morph::settle_box(app);
}

/// "Show box" (tray or box menu): shows the box, and keeps it on screen
/// over a fullscreen app until that app goes away or the user hides the
/// box again. An open editor closes into it.
pub fn show_box<R: Runtime>(app: &AppHandle<R>) {
    spawn(app, "show-box", move |app| show_box_blocking(&app));
}

fn show_box_blocking<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    state.show_box_anyway();
    if state.morph.phase() == Phase::Open {
        close_blocking(app, CollapseThen::Hide);
    } else {
        // Closed: it shows now; during a handoff, when that ends.
        morph::settle_box(app);
    }
}

/// What Reskin started again without paths does: the user is looking for
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Relaunch {
    /// The editor is open: bring it to the front.
    FocusEditor,
    /// Otherwise: show the box, as "Show box" does.
    ShowBox,
}

fn relaunch(phase: Phase) -> Relaunch {
    if phase == Phase::Open {
        Relaunch::FocusEditor
    } else {
        Relaunch::ShowBox
    }
}

/// Reskin was started again without paths (single-instance forwarding):
/// brings the open editor to the front, else shows the box.
pub fn bring_forward<R: Runtime>(app: &AppHandle<R>) {
    spawn(app, "forward", move |app| {
        match relaunch(app.state::<AppState>().morph.phase()) {
            Relaunch::FocusEditor => {
                // The box comes back with the editor's next close.
                app.state::<AppState>().set_box_hidden_by_user(false);
                if let Some(editor) = app.get_webview_window(editor_window::LABEL) {
                    let _ = editor.set_focus();
                }
            }
            Relaunch::ShowBox => show_box_blocking(&app),
        }
    });
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
        let (msg, complete) = restore_all_summary(&report);
        app.dialog()
            .message(msg)
            .title("Restore all icons")
            .kind(if complete {
                MessageDialogKind::Info
            } else {
                MessageDialogKind::Warning
            })
            .blocking_show();
    });
}

/// What Restore all tells the user once it ran, and whether every icon is
/// back: how many were restored, which could not be, and how many
/// Public-Desktop icons still wait for the administrator approval that
/// was declined.
fn restore_all_summary(report: &RestoreReport) -> (String, bool) {
    let mut msg = format!("Restored {} icon(s).", report.restored);
    if !report.failed.is_empty() {
        msg.push_str(&format!(
            "\n\n{} could not be restored:\n{}",
            report.failed.len(),
            report.failed.join("\n")
        ));
    }
    if report.needs_elevation > 0 {
        msg.push_str(&format!(
            "\n\n{} icon(s) on the Public Desktop are not back yet: they need administrator \
             approval, and Windows didn't get it. To put them back, choose Restore all icons… \
             again and select Yes when Windows asks.",
            report.needs_elevation
        ));
    }
    let complete = report.failed.is_empty() && report.needs_elevation == 0;
    (msg, complete)
}

pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    log::line("quit requested");
    crate::exit_with(app, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_launch_brings_the_open_editor_forward_else_shows_the_box() {
        assert_eq!(relaunch(Phase::Open), Relaunch::FocusEditor);
        assert_eq!(relaunch(Phase::Closed), Relaunch::ShowBox);
        // During a handoff the wish is recorded; the handoff shows (or
        // focuses) what the user asked for.
        assert_eq!(relaunch(Phase::Opening), Relaunch::ShowBox);
        assert_eq!(relaunch(Phase::Closing), Relaunch::ShowBox);
    }

    #[test]
    fn restore_all_says_what_is_not_back_and_how_to_get_it_back() {
        let report = |restored, failed: &[&str], needs_elevation| RestoreReport {
            restored,
            failed: failed.iter().map(|f| f.to_string()).collect(),
            needs_elevation,
        };
        let (msg, complete) = restore_all_summary(&report(3, &[], 0));
        assert_eq!(msg, "Restored 3 icon(s).");
        assert!(complete);

        let (msg, complete) = restore_all_summary(&report(1, &["App.lnk — read-only"], 0));
        assert!(!complete);
        assert!(msg.starts_with("Restored 1 icon(s)."), "{msg}");
        assert!(
            msg.contains("1 could not be restored:\nApp.lnk — read-only"),
            "{msg}"
        );
        assert!(!msg.contains("administrator"), "{msg}");

        // The administrator prompt was declined: those items are not
        // restored, and the dialog says how to finish.
        let (msg, complete) = restore_all_summary(&report(2, &[], 4));
        assert!(!complete);
        assert!(msg.starts_with("Restored 2 icon(s)."), "{msg}");
        assert!(
            msg.contains("4 icon(s) on the Public Desktop are not back yet"),
            "{msg}"
        );
        assert!(msg.contains("administrator approval"), "{msg}");
        assert!(msg.contains("Restore all icons… again"), "{msg}");

        let (msg, complete) = restore_all_summary(&report(0, &["Old.url — gone"], 1));
        assert!(!complete);
        assert!(msg.contains("1 could not be restored"), "{msg}");
        assert!(msg.contains("1 icon(s) on the Public Desktop"), "{msg}");
    }
}

//! settings_get / settings_set. Setting changes with OS side effects
//! (hotkey, autostart, Explorer verb, box size/skin) are applied here.

use reskin_core::model::{BoxMetrics, Settings};
use tauri::{AppHandle, LogicalSize, Manager, Runtime, State};
use tauri_plugin_autostart::ManagerExt;

use super::CmdResult;
use crate::state::AppState;
use crate::windows::box_window;
use crate::{hotkey, log};

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub async fn settings_set(app: AppHandle, settings: Settings) -> CmdResult<Settings> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let old = state.settings();
        // The box position is owned by the drag loop; never let a stale
        // copy from a page overwrite it.
        let mut incoming = settings;
        incoming.box_position = old.box_position.clone();
        let new = state.update_settings(&app, |s| *s = incoming);
        let errors = apply_side_effects(&app, &old, &new);
        if errors.is_empty() {
            Ok(new)
        } else {
            // Settings are saved; report what couldn't be applied.
            Err(errors.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Applies OS-level effects of a settings change. Returns user-facing
/// error messages for anything that failed.
pub fn apply_side_effects<R: Runtime>(
    app: &AppHandle<R>,
    old: &Settings,
    new: &Settings,
) -> Vec<String> {
    let mut errors = Vec::new();
    if old.hotkey != new.hotkey
        && let Err(e) = hotkey::apply(app, &accelerator(&new.hotkey))
    {
        errors.push(e);
    }
    if old.autostart != new.autostart {
        let al = app.autolaunch();
        let r = if new.autostart {
            al.enable()
        } else {
            al.disable()
        };
        if let Err(e) = r {
            errors.push(format!("Start with Windows: {e}"));
        }
    }
    if old.context_menu != new.context_menu {
        let r = if new.context_menu {
            std::env::current_exe()
                .map_err(|e| e.to_string())
                .and_then(|exe| {
                    reskin_core::win::contextmenu::install(&exe).map_err(|e| e.to_string())
                })
        } else {
            reskin_core::win::contextmenu::uninstall().map_err(|e| e.to_string())
        };
        if let Err(e) = r {
            errors.push(format!("Explorer menu: {e}"));
        }
    }
    if old.box_size != new.box_size {
        resize_box(app, new);
    }
    if old.compatibility_mode != new.compatibility_mode {
        // Transparency is fixed when a window is created: rebuild both at
        // the next editor close (or now, when the editor isn't open).
        let state = app.state::<crate::state::AppState>();
        if state.morph.phase() == crate::windows::morph::Phase::Closed {
            rebuild_windows(app, new);
        } else {
            state.request_window_rebuild();
        }
    }
    for e in &errors {
        log::line(&format!("settings: {e}"));
    }
    errors
}

/// Recreates the box (shown again unless hidden by the user) and drops the
/// editor so the next open builds it with the new mode.
pub fn rebuild_windows<R: Runtime>(app: &AppHandle<R>, s: &Settings) {
    let state = app.state::<crate::state::AppState>();
    if let Some(editor) = app.get_webview_window(crate::windows::editor_window::LABEL) {
        let _ = editor.destroy();
        state.mailbox.reset();
    }
    match box_window::recreate(app, s) {
        Ok(w) => {
            let h = crate::windows::raw::hwnd_of(&w);
            state.animator.set_hwnd(h);
            if !state.box_hidden_by_user() && !state.hidden_for_fullscreen() {
                crate::windows::raw::show_no_activate(h);
                crate::windows::raw::set_topmost(h, true);
            }
        }
        Err(e) => log::line(&format!("rebuilding the box failed: {e}")),
    }
}

/// Resizes the box window for a new size class, keeping its centre.
fn resize_box<R: Runtime>(app: &AppHandle<R>, s: &Settings) {
    use crate::windows::raw;
    let Some(w) = app.get_webview_window(box_window::LABEL) else {
        return;
    };
    let m = BoxMetrics::for_size(s.box_size);
    let scale = w.scale_factor().unwrap_or(1.0);
    let h = raw::hwnd_of(&w);
    let Some(old) = raw::rect(h) else {
        return;
    };
    let (cx, cy) = old.center();
    let side = (m.window * scale).round();
    let (x, y) = (
        (cx - side / 2.0).round() as i32,
        (cy - side / 2.0).round() as i32,
    );
    let _ = w.set_size(LogicalSize::new(m.window, m.window));
    let state = app.state::<crate::state::AppState>();
    state.animator.jump_to((x, y));
    if s.compatibility_mode {
        box_window::apply_compat_shape(&w, &m);
    }
    // The resting spot moves with the centre.
    if s.box_position.is_some() {
        state.update_settings(app, |st| {
            if let Some(p) = st.box_position.as_mut() {
                p.x = x;
                p.y = y;
            }
        });
    }
}

/// Converts the user-facing hotkey ("Ctrl+Alt+Shift+R") to the global
/// shortcut plugin's accelerator syntax; empty stays empty.
pub fn accelerator(hotkey: &str) -> String {
    match reskin_core::settings::parse_hotkey(hotkey) {
        Ok(Some(h)) => h.to_accelerator(),
        _ => String::new(),
    }
}

/// Startup: make OS state match the saved settings.
pub fn apply_at_startup<R: Runtime>(app: &AppHandle<R>, s: &Settings) {
    if let Err(e) = hotkey::apply(app, &accelerator(&s.hotkey)) {
        log::line(&format!("hotkey: {e}"));
    }
    let al = app.autolaunch();
    if al.is_enabled().unwrap_or(false) != s.autostart {
        let _ = if s.autostart {
            al.enable()
        } else {
            al.disable()
        };
    }
    if s.context_menu {
        // Re-point the verb at this exe (it may have moved after an update).
        if let Ok(exe) = std::env::current_exe() {
            let _ = reskin_core::win::contextmenu::install(&exe);
        }
    }
}

//! settings_get / settings_set. The settings that mirror OS state (hotkey,
//! "Start with Windows", Explorer verb) are applied before they are saved,
//! and a change Windows refuses is taken back, so the saved settings — and
//! what both pages are told — always match the OS. Window-level changes
//! (box size, compatibility mode, low-memory mode) follow once saved.

use std::path::PathBuf;

use reskin_core::model::{BoxMetrics, Settings};
use reskin_core::settings::autostart::{self, ENTRY_NAME, StartupEntry};
use reskin_core::settings::{SystemSettings, apply_system_change, reconcile_system_settings};
use reskin_core::win::contextmenu;
use tauri::{AppHandle, LogicalSize, Manager, Runtime, State};

use super::CmdResult;
use crate::state::AppState;
use crate::windows::morph::Phase;
use crate::windows::{box_window, editor_window, raw};
use crate::{hotkey, log};

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings()
}

/// Saves `settings`. When Windows refuses part of the change (a hotkey
/// another app holds, a registry write) the rest is saved without it, both
/// pages get the saved value, and the command fails with what was refused.
#[tauri::command]
pub async fn settings_set(app: AppHandle, settings: Settings) -> CmdResult<Settings> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _one_at_a_time = state.lock_settings_changes();
        let old = state.settings();
        let requested = reskin_core::settings::normalize(settings);
        let (accepted, errors) = apply_system_change(&mut Os { app: &app }, &old, requested);
        let new = state.update_settings(&app, |s| {
            // The box position is owned by the drag loop; never let a stale
            // copy from a page overwrite it.
            let position = s.box_position.take();
            *s = Settings {
                box_position: position,
                ..accepted
            };
        });
        apply_window_changes(&app, &old, &new);
        if errors.is_empty() {
            Ok(new)
        } else {
            for e in &errors {
                log::line(&format!("settings: {e}"));
            }
            Err(errors.join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Startup: makes the OS state and the saved settings agree (see
/// `reconcile_system_settings`). Runs off the main thread: registering the
/// hotkey waits for the event loop.
pub fn reconcile_at_startup<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let _one_at_a_time = state.lock_settings_changes();
    // An entry an older Reskin wrote unquoted, or whose exe is gone, is
    // repaired without changing whether it is on.
    if let Ok(exe) = std::env::current_exe()
        && let Err(e) = autostart::repoint(ENTRY_NAME, &exe)
    {
        log::line(&format!("settings: Start with Windows: {e}"));
    }
    let saved = state.settings();
    let (settings, errors) = reconcile_system_settings(&mut Os { app }, saved.clone());
    for e in &errors {
        log::line(&format!("settings at startup: {e}"));
    }
    if (settings.autostart, settings.context_menu) != (saved.autostart, saved.context_menu) {
        state.update_settings(app, |s| {
            s.autostart = settings.autostart;
            s.context_menu = settings.context_menu;
        });
    }
}

/// The Windows side of the settings that mirror OS state.
struct Os<'a, R: Runtime> {
    app: &'a AppHandle<R>,
}

fn current_exe() -> reskin_core::Result<PathBuf> {
    std::env::current_exe().map_err(Into::into)
}

impl<R: Runtime> SystemSettings for Os<'_, R> {
    fn hotkey(&self) -> String {
        hotkey::registered()
    }

    fn set_hotkey(&mut self, hotkey: &str) -> reskin_core::Result<()> {
        hotkey::apply(self.app, hotkey).map_err(reskin_core::Error::Other)
    }

    fn autostart(&self) -> reskin_core::Result<StartupEntry> {
        autostart::state(ENTRY_NAME)
    }

    fn set_autostart(&mut self, on: bool) -> reskin_core::Result<()> {
        if on {
            autostart::enable(ENTRY_NAME, &current_exe()?)
        } else {
            autostart::disable(ENTRY_NAME)
        }
    }

    fn context_menu(&self) -> bool {
        contextmenu::is_installed()
    }

    fn context_menu_usable(&self) -> bool {
        contextmenu::is_installed() && contextmenu::installed_exe().is_some_and(|exe| exe.is_file())
    }

    fn set_context_menu(&mut self, on: bool) -> reskin_core::Result<()> {
        if on {
            contextmenu::install(&current_exe()?)
        } else {
            contextmenu::uninstall()
        }
    }
}

/// Effects of a saved change on the windows and on first-run state.
fn apply_window_changes<R: Runtime>(app: &AppHandle<R>, old: &Settings, new: &Settings) {
    let state = app.state::<AppState>();
    if old.box_size != new.box_size {
        resize_box(app, new);
    }
    if old.compatibility_mode != new.compatibility_mode {
        // Transparency is fixed when a window is created: rebuild both at
        // the next editor close (or now, when the editor isn't open).
        if state.morph.phase() == Phase::Closed {
            rebuild_windows(app, new);
        } else {
            state.request_window_rebuild();
        }
    } else if new.low_memory && !old.low_memory && state.morph.phase() == Phase::Closed {
        // An open editor goes when it closes (morph::close); a hidden,
        // pre-warmed one goes now.
        drop_editor(app);
    }
    if new.onboarded {
        state.finish_first_run();
    }
}

/// Destroys the (hidden) editor; the next open builds a new one.
fn drop_editor<R: Runtime>(app: &AppHandle<R>) {
    if let Some(editor) = app.get_webview_window(editor_window::LABEL) {
        let _ = editor.destroy();
        app.state::<AppState>().mailbox.reset();
    }
}

/// Recreates the box (shown again unless hidden by the user) and drops the
/// editor so the next open builds it with the new mode.
pub fn rebuild_windows<R: Runtime>(app: &AppHandle<R>, s: &Settings) {
    let state = app.state::<AppState>();
    drop_editor(app);
    match box_window::recreate(app, s) {
        Ok(w) => {
            let h = raw::hwnd_of(&w);
            state.animator.set_hwnd(h);
            if !state.box_hidden_by_user() && !state.hidden_for_fullscreen() {
                raw::show_no_activate(h);
                raw::set_topmost(h, true);
            }
        }
        Err(e) => log::line(&format!("rebuilding the box failed: {e}")),
    }
}

/// Resizes the box window for a new size class, keeping its centre.
fn resize_box<R: Runtime>(app: &AppHandle<R>, s: &Settings) {
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
    let state = app.state::<AppState>();
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

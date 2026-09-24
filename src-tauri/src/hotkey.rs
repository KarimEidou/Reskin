//! Global hotkey (default Ctrl+Alt+Shift+R) that toggles the box.

use std::sync::Mutex;

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::actions;

/// The currently registered accelerator (so it can be unregistered).
static CURRENT: Mutex<Option<Shortcut>> = Mutex::new(None);

/// Registers `accelerator` (e.g. "Ctrl+Alt+Shift+R"), replacing the previous
/// one. Empty disables the hotkey.
pub fn apply<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut current = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = current.take() {
        let _ = gs.unregister(old);
    }
    let accelerator = accelerator.trim();
    if accelerator.is_empty() {
        return Ok(());
    }
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|e| format!("invalid hotkey \"{accelerator}\": {e}"))?;
    gs.on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            actions::toggle_box(app);
        }
    })
    .map_err(|e| format!("could not register \"{accelerator}\" (in use by another app?): {e}"))?;
    *current = Some(shortcut);
    Ok(())
}

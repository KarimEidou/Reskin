//! Global hotkey (default Ctrl+Alt+Shift+R) that toggles the box.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{actions, log};

#[derive(Default)]
struct Hotkeys {
    /// The registered hotkey (canonical form) and its shortcut.
    current: Option<(String, Shortcut)>,
    /// Why hotkeys could not be registered, by hotkey (the last attempt).
    failures: HashMap<String, String>,
}

/// Never held across plugin calls: those wait for the main thread, which
/// reads this state too (`app_boot`).
static STATE: LazyLock<Mutex<Hotkeys>> = LazyLock::new(Mutex::default);

fn state() -> MutexGuard<'static, Hotkeys> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Registers `hotkey` (canonical, e.g. "Ctrl+Alt+Shift+R"; "" = none) in
/// place of the current one. The new one is registered before the old one
/// is released, so when that fails the old one keeps working. Callers
/// serialise changes (`commands::settings` holds the settings lock).
pub fn apply<R: Runtime>(app: &AppHandle<R>, hotkey: &str) -> Result<(), String> {
    let current = state().current.clone();
    if current.as_ref().map_or("", |(h, _)| h.as_str()) == hotkey {
        return Ok(());
    }
    let gs = app.global_shortcut();
    let next = if hotkey.is_empty() {
        None
    } else {
        let shortcut = shortcut_for(hotkey)?;
        let registered = gs.on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                actions::toggle_box(app);
            }
        });
        if let Err(e) = registered {
            log::line(&format!("hotkey {hotkey}: {e}"));
            let why = format!("{hotkey} is already in use by another app");
            state().failures.insert(hotkey.to_owned(), why.clone());
            return Err(why);
        }
        Some((hotkey.to_owned(), shortcut))
    };
    if let Some((old, shortcut)) = current
        && let Err(e) = gs.unregister(shortcut)
    {
        log::line(&format!("releasing hotkey {old}: {e}"));
    }
    let mut s = state();
    s.failures.remove(hotkey);
    s.current = next;
    Ok(())
}

/// The plugin's shortcut for a canonical hotkey.
fn shortcut_for(hotkey: &str) -> Result<Shortcut, String> {
    let invalid = || format!("{hotkey} isn't a valid shortcut");
    let parsed = reskin_core::settings::parse_hotkey(hotkey)
        .ok()
        .flatten()
        .ok_or_else(invalid)?;
    parsed.to_accelerator().parse().map_err(|_| invalid())
}

/// The hotkey registered right now ("" = none).
pub fn registered() -> String {
    state()
        .current
        .as_ref()
        .map(|(h, _)| h.clone())
        .unwrap_or_default()
}

/// Why the saved hotkey doesn't work: the last attempt to register it
/// failed (another app holds it). `None` when it is registered or off.
pub fn problem(saved: &str) -> Option<String> {
    let s = state();
    if s.current.as_ref().is_some_and(|(h, _)| h == saved) {
        return None;
    }
    s.failures.get(saved).cloned()
}

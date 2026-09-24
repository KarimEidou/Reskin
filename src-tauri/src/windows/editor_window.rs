//! The editor window: transparent, frameless, created hidden off-screen and
//! "primed" (shown and hidden once) so WebView2 is fully initialised before
//! the first real open.

use reskin_core::model::{Settings, editor_size};
use tauri::{AppHandle, PhysicalPosition, Runtime, WebviewWindow, WebviewWindowBuilder};

use super::{webview2, window_config};

pub const LABEL: &str = "editor";

/// Far off-screen parking spot for the hidden editor.
pub const PARK: PhysicalPosition<i32> = PhysicalPosition {
    x: -32000,
    y: -32000,
};

pub fn create<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
) -> tauri::Result<WebviewWindow<R>> {
    let cfg = window_config(app, LABEL)?;
    let (w, h) = editor_size(settings.editor_size);
    let compat = settings.compatibility_mode;
    let window = WebviewWindowBuilder::from_config(app, &cfg)?
        .inner_size(w, h)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .transparent(!compat)
        .enable_clipboard_access()
        .on_page_load(|w, payload| {
            crate::log::line(&format!(
                "{} page {:?}: {}",
                w.label(),
                payload.event(),
                payload.url()
            ));
        })
        .build()?;
    webview2::tune(&window);
    prime(&window);
    Ok(window)
}

/// Shows and hides the window once while parked off-screen. Works around
/// wry/tauri issues with webviews that have never been visible (no
/// rendering, lost first input, focus glitches).
pub fn prime<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.set_position(PARK);
    let _ = window.show();
    let _ = window.hide();
    webview2::set_memory_low(window, true);
}

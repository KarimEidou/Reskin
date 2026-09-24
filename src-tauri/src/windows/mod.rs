//! The two windows (box and editor), the editor mailbox, and WebView2
//! tuning.

pub mod animator;
pub mod box_window;
pub mod editor_window;
pub mod mailbox;
pub mod monitors;
pub mod morph;
pub mod raw;
pub mod webview2;

use tauri::{AppHandle, Manager, Runtime, utils::config::WindowConfig};

/// The `"create": false` window declaration for `label` from tauri.conf.json.
pub fn window_config<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<WindowConfig> {
    app.config()
        .app
        .windows
        .iter()
        .find(|w| w.label == label)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)
}

/// Returns the window if it exists.
pub fn get<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window(label)
}

//! WebView2 tuning for both windows: no browser accelerators, context menu,
//! zoom, pinch or swipe navigation, and a low memory target while hidden.

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    ICoreWebView2_19, ICoreWebView2Settings3, ICoreWebView2Settings4, ICoreWebView2Settings5,
    ICoreWebView2Settings6,
};
use windows_core::Interface;

pub fn tune<R: Runtime>(window: &WebviewWindow<R>) {
    let debug = cfg!(debug_assertions);
    let res = window.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        let _ = settings.SetIsStatusBarEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);
        let _ = settings.SetAreDefaultContextMenusEnabled(debug);
        let _ = settings.SetAreDevToolsEnabled(debug);
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            // Editing keys (copy/paste/undo) are unaffected.
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(debug);
        }
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
            let _ = s4.SetIsGeneralAutofillEnabled(false);
            let _ = s4.SetIsPasswordAutosaveEnabled(false);
        }
        if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
            let _ = s5.SetIsPinchZoomEnabled(false);
        }
        if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() {
            let _ = s6.SetIsSwipeNavigationEnabled(false);
        }
    });
    if let Err(e) = res {
        crate::log::line(&format!("webview2 tune failed: {e}"));
    }
}

/// Lowers (or restores) WebView2's memory target. Called when the editor
/// hides / shows.
pub fn set_memory_low<R: Runtime>(window: &WebviewWindow<R>, low: bool) {
    let _ = window.with_webview(move |wv| unsafe {
        if let Ok(core) = wv.controller().CoreWebView2()
            && let Ok(c19) = core.cast::<ICoreWebView2_19>()
        {
            let _ = c19.SetMemoryUsageTargetLevel(if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            });
        }
    });
}

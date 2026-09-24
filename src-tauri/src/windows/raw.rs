//! Raw Win32 window operations used where tao's behaviour doesn't fit.
//!
//! The box is always shown with `SW_SHOWNOACTIVATE` (it must not steal
//! focus from the app the user is in), so every show/hide of the box goes
//! through here — never through tauri's `show()`/`hide()`, whose cached
//! visibility flag would then disagree with reality.

use reskin_core::model::Rect;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, HWND_NOTOPMOST, HWND_TOPMOST, IsWindowVisible, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos, ShowWindow,
};

pub fn hwnd(h: isize) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

pub fn hwnd_of<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) -> isize {
    w.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

pub fn show_no_activate(h: isize) {
    if h != 0 {
        unsafe {
            let _ = ShowWindow(hwnd(h), SW_SHOWNOACTIVATE);
        }
    }
}

pub fn hide(h: isize) {
    if h != 0 {
        unsafe {
            let _ = ShowWindow(hwnd(h), SW_HIDE);
        }
    }
}

pub fn is_visible(h: isize) -> bool {
    h != 0 && unsafe { IsWindowVisible(hwnd(h)) }.as_bool()
}

/// Puts the window at the top of the topmost band (or back to normal).
pub fn set_topmost(h: isize, topmost: bool) {
    if h != 0 {
        unsafe {
            let _ = SetWindowPos(
                hwnd(h),
                Some(if topmost {
                    HWND_TOPMOST
                } else {
                    HWND_NOTOPMOST
                }),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

/// Window rect in physical px.
pub fn rect(h: isize) -> Option<Rect> {
    if h == 0 {
        return None;
    }
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd(h), &mut r) }.ok()?;
    Some(Rect::new(
        r.left as f64,
        r.top as f64,
        (r.right - r.left) as f64,
        (r.bottom - r.top) as f64,
    ))
}

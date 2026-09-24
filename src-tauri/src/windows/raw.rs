//! Raw Win32 window operations used where tao's behaviour doesn't fit.
//!
//! The box is always shown with `SW_SHOWNOACTIVATE` (it must not steal
//! focus from the app the user is in), so every show/hide of the box goes
//! through here — never through tauri's `show()`/`hide()`, whose cached
//! visibility flag would then disagree with reality.

use reskin_core::model::Rect;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DwmSetWindowAttribute,
};
use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, HWND_NOTOPMOST, HWND_TOPMOST, IsWindowVisible, SW_HIDE, SW_SHOWNOACTIVATE,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetWindowPos, ShowWindow,
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

/// Shows the window without activating it, directly under `above` in the
/// z-order (a topmost window stays in the topmost band), so `above` keeps
/// covering it until it is hidden or moved.
pub fn show_below(h: isize, above: isize) {
    if h == 0 {
        return;
    }
    if above == 0 {
        show_no_activate(h);
        return;
    }
    unsafe {
        let _ = SetWindowPos(
            hwnd(h),
            Some(hwnd(above)),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
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

/// Compatibility mode: clip a window to a rounded rectangle (physical px,
/// window-relative). The system owns the region afterwards.
pub fn set_round_region(h: isize, r: Rect, radius: f64) {
    if h == 0 {
        return;
    }
    let d = (radius * 2.0).round() as i32;
    unsafe {
        let rgn = CreateRoundRectRgn(
            r.x.round() as i32,
            r.y.round() as i32,
            r.right().round() as i32 + 1,
            r.bottom().round() as i32 + 1,
            d,
            d,
        );
        if !rgn.is_invalid() {
            SetWindowRgn(hwnd(h), Some(rgn), true);
        }
    }
}

/// Asks DWM for Windows 11 rounded corners (no effect on Windows 10).
pub fn round_corners(h: isize) {
    if h == 0 {
        return;
    }
    let pref = DWMWCP_ROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd(h),
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        );
    }
}

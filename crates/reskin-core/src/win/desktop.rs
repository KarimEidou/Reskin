//! Locating an icon on the desktop (for the fly-to-icon flourish).
//!
//! `ShellWindows.FindWindowSW(CSIDL_DESKTOP, SWC_DESKTOP)` →
//! `QueryService(SID_STopLevelBrowser)` → `QueryActiveShellView` →
//! `IFolderView2`. Items are matched by their desktop-absolute parsing name,
//! positioned with `GetItemPosition` (client coordinates of the
//! `SysListView32`) mapped to the screen, and checked for occlusion by
//! walking the z-order above the desktop window.

use std::ffi::{OsStr, c_void};
use std::path::Path;

use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONULL, MapWindowPoints, MonitorFromPoint};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, IServiceProvider};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::System::Variant::{VARIANT, VT_I4};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow,
    SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::Shell::{
    CSIDL_DESKTOP, FOLDERVIEWMODE, FWF_NOICONS, IFolderView2, IShellBrowser, IShellItem,
    IShellWindows, SID_STopLevelBrowser, SIGDN_DESKTOPABSOLUTEPARSING, SVGIO_ALLVIEW, SWC_DESKTOP,
    SWFO_NEEDDISPATCH, ShellWindows,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GA_ROOT, GW_HWNDNEXT, GWL_EXSTYLE, GetAncestor, GetTopWindow, GetWindow,
    GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    WS_EX_LAYERED, WS_EX_TRANSPARENT,
};
use windows::core::{Interface, PCWSTR, w};

use super::util::{ComScope, Pidl, ResultExt, paths_equal_ci, take_co_string};
use crate::model::{DesktopSpot, Rect};
use crate::{Error, Result};

/// Gap between the top of an item's cell and its icon, in logical px
/// (comctl32 draws icon-view icons just below the cell's top edge).
const ICON_TOP_MARGIN: f64 = 2.0;

/// Makes the calling thread per-monitor DPI aware for its lifetime so all
/// coordinates are physical pixels whatever the process's awareness.
struct DpiScope(DPI_AWARENESS_CONTEXT);

impl DpiScope {
    fn per_monitor() -> Self {
        // SAFETY: plain thread-state switch, undone in Drop.
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}

impl Drop for DpiScope {
    fn drop(&mut self) {
        if !self.0.0.is_null() {
            // SAFETY: restores the context returned by the first call.
            unsafe { SetThreadDpiAwarenessContext(self.0) };
        }
    }
}

fn variant_i4(value: i32) -> VARIANT {
    let mut v = VARIANT::default();
    // SAFETY: writing the active members of a zeroed VARIANT; VT_I4 owns
    // no resources.
    unsafe {
        let inner = &mut v.Anonymous.Anonymous;
        inner.vt = VT_I4;
        inner.Anonymous.lVal = value;
    }
    v
}

/// The desktop's folder view and its windows.
struct DesktopView {
    view: IFolderView2,
    listview: HWND,
    /// Top-level window hosting the icons (Progman or a WorkerW).
    root: HWND,
}

impl DesktopView {
    fn open() -> Result<DesktopView> {
        // SAFETY (whole block): COM and window calls with valid arguments.
        unsafe {
            let windows: IShellWindows =
                CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ctx("create ShellWindows")?;
            let location = variant_i4(CSIDL_DESKTOP as i32);
            let root = VARIANT::default();
            let mut hwnd = 0i32;
            let dispatch = windows
                .FindWindowSW(&location, &root, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)
                .ctx("find the desktop window")?;
            let provider: IServiceProvider = dispatch.cast().ctx("desktop → IServiceProvider")?;
            let browser: IShellBrowser = provider
                .QueryService(&SID_STopLevelBrowser)
                .ctx("get the desktop browser")?;
            let shell_view = browser.QueryActiveShellView().ctx("get the desktop view")?;
            let view: IFolderView2 = shell_view.cast().ctx("desktop view → IFolderView2")?;
            let defview = shell_view.GetWindow().ctx("get the desktop view window")?;
            let listview = FindWindowExW(Some(defview), None, w!("SysListView32"), PCWSTR::null())
                .ctx("find the desktop list view")?;
            let root = GetAncestor(listview, GA_ROOT);
            Ok(DesktopView {
                view,
                listview,
                root,
            })
        }
    }

    /// Nominal icon size of the view (16/32/48/96/256…, unscaled).
    fn icon_size(&self) -> Result<u32> {
        let mut mode = FOLDERVIEWMODE::default();
        let mut size = 0i32;
        // SAFETY: valid out pointers.
        unsafe { self.view.GetViewModeAndIconSize(&mut mode, &mut size) }
            .ctx("read the desktop icon size")?;
        u32::try_from(size)
            .ok()
            .filter(|&s| s > 0)
            .ok_or_else(|| Error::Other(format!("unexpected desktop icon size {size}")))
    }

    /// "Show desktop icons" is off.
    fn icons_hidden(&self) -> bool {
        // SAFETY: plain getters.
        unsafe {
            !IsWindowVisible(self.listview).as_bool()
                || self
                    .view
                    .GetCurrentFolderFlags()
                    .is_ok_and(|f| f & FWF_NOICONS.0 as u32 != 0)
        }
    }

    /// View index of the item whose parsing name is `target`.
    fn find(&self, target: &OsStr) -> Result<Option<i32>> {
        // SAFETY: COM getters; returned strings are freed by take_co_string.
        unsafe {
            let count = self
                .view
                .ItemCount(SVGIO_ALLVIEW)
                .ctx("count desktop items")?;
            for i in 0..count {
                let Ok(item) = self.view.GetItem::<IShellItem>(i) else {
                    continue;
                };
                let Ok(name) = item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) else {
                    continue;
                };
                if paths_equal_ci(&take_co_string(name), target) {
                    return Ok(Some(i));
                }
            }
        }
        Ok(None)
    }

    /// Screen rect (physical px) of the icon image of item `index`: the
    /// icon (nominal size × monitor DPI scale) centred horizontally in the
    /// item's cell (the view's spacing), just below the cell's top.
    fn icon_rect(&self, index: i32) -> Result<Rect> {
        // SAFETY: COM and window calls with valid arguments; the child
        // PIDL is freed by Pidl.
        unsafe {
            let pidl = Pidl(self.view.Item(index).ctx("get the desktop item")?);
            let position = self
                .view
                .GetItemPosition(pidl.0)
                .ctx("get the desktop item position")?;
            let mut spacing = POINT::default();
            let _ = self.view.GetSpacing(&mut spacing);
            let dpi = GetDpiForWindow(self.listview);
            let scale = if dpi > 0 { f64::from(dpi) / 96.0 } else { 1.0 };
            let icon = (f64::from(self.icon_size().unwrap_or(48)) * scale).round();
            let mut points = [position];
            MapWindowPoints(Some(self.listview), None, &mut points);
            let cell = if spacing.x > 0 {
                f64::from(spacing.x)
            } else {
                icon
            };
            let x = f64::from(points[0].x) + ((cell - icon) / 2.0).max(0.0).round();
            let y = f64::from(points[0].y) + (ICON_TOP_MARGIN * scale).round();
            Ok(Rect::new(x, y, icon, icon))
        }
    }
}

/// Where the desktop icon for `path` is on screen, or `None` when the
/// desktop does not show it (or there is no desktop, e.g. on a headless
/// session). `visible` is false when desktop icons are hidden, the icon is
/// off every monitor, or another top-level window covers its centre.
///
/// `path` is matched against each item's desktop-absolute parsing name, so
/// system icons can be found with `::{CLSID}` (e.g. `::{20D04FE0-…}`).
pub fn find_desktop_icon(path: &Path) -> Result<Option<DesktopSpot>> {
    let _com = ComScope::enter()?;
    let _dpi = DpiScope::per_monitor();
    let Ok(desk) = DesktopView::open() else {
        return Ok(None);
    };
    let Some(index) = desk.find(path.as_os_str())? else {
        return Ok(None);
    };
    let rect = desk.icon_rect(index)?;
    let (cx, cy) = rect.center();
    let centre = POINT {
        x: cx.round() as i32,
        y: cy.round() as i32,
    };
    // SAFETY: plain query.
    let on_screen = !unsafe { MonitorFromPoint(centre, MONITOR_DEFAULTTONULL) }.is_invalid();
    let visible = on_screen && !desk.icons_hidden() && !occluded(centre, desk.root);
    Ok(Some(DesktopSpot { rect, visible }))
}

/// Nominal desktop icon size in px (e.g. 48 for "Medium icons").
pub fn desktop_icon_size() -> Result<u32> {
    let _com = ComScope::enter()?;
    DesktopView::open()?.icon_size()
}

/// Some top-level window above `desktop_root` in z-order covers `pt`.
fn occluded(pt: POINT, desktop_root: HWND) -> bool {
    // SAFETY: plain window enumeration.
    let own_pid = unsafe { GetCurrentProcessId() };
    let mut next = unsafe { GetTopWindow(None) }.ok();
    // Bounded in case the z-order changes under us.
    for _ in 0..20_000 {
        let Some(hwnd) = next else { break };
        if hwnd == desktop_root {
            return false;
        }
        if covers(hwnd, pt, own_pid) {
            return true;
        }
        next = unsafe { GetWindow(hwnd, GW_HWNDNEXT) }.ok();
    }
    false
}

/// `hwnd` is a visible, non-minimised, uncloaked, non-click-through window
/// of another process whose frame contains `pt`.
fn covers(hwnd: HWND, pt: POINT, own_pid: u32) -> bool {
    // SAFETY (whole block): window queries with valid out pointers.
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == own_pid {
            return false;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return false;
        }
        // Click-through overlays (layered + transparent) don't hide anything.
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_LAYERED.0 != 0 && ex & WS_EX_TRANSPARENT.0 != 0 {
            return false;
        }
        let mut r = RECT::default();
        let framed = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        );
        if framed.is_err() && GetWindowRect(hwnd, &mut r).is_err() {
            return false;
        }
        r.right > r.left
            && r.bottom > r.top
            && (r.left..r.right).contains(&pt.x)
            && (r.top..r.bottom).contains(&pt.y)
    }
}

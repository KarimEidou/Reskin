//! Wallpaper, theme and system-appearance queries for the previews.

use std::ffi::c_void;
use std::path::PathBuf;

use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Dwm::DwmGetColorizationColor;
use windows::Win32::Graphics::Gdi::{
    COLOR_DESKTOP, GetMonitorInfoW, GetSysColor, MONITOR_DEFAULTTOPRIMARY, MONITORINFO,
    MonitorFromPoint,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper};
use windows::Win32::UI::WindowsAndMessaging::{
    SPI_GETCLIENTAREAANIMATION, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    SystemParametersInfoW,
};
use windows::core::{BOOL, PCWSTR};

use super::desktop::desktop_icon_size;
use super::known;
use super::util::{ComScope, RegKey, os_from_wide, pcwstr, take_co_string, wide};
use crate::model::{WallpaperFit, WallpaperInfo};

const DESKTOP_KEY: &str = r"Control Panel\Desktop";
const DEFAULT_ICON_SIZE: u32 = 48;

fn existing_file(p: PathBuf) -> Option<PathBuf> {
    p.is_file().then_some(p)
}

/// The image currently used as wallpaper, if any: `SPI_GETDESKWALLPAPER`,
/// else `IDesktopWallpaper` for the primary monitor, else Explorer's
/// transcoded copy (`%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper`).
/// Only existing files are returned. Uses COM: call it on the STA.
pub fn wallpaper_path() -> Option<PathBuf> {
    let mut buf = vec![0u16; 1024];
    // SAFETY: `buf` holds the advertised number of characters.
    let spi = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            Some(buf.as_mut_ptr() as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    if spi.is_ok()
        && let Some(p) = existing_file(PathBuf::from(os_from_wide(&buf)))
    {
        return Some(p);
    }
    primary_monitor_wallpaper().or_else(|| {
        let transcoded = known::roaming_app_data()
            .ok()?
            .join(r"Microsoft\Windows\Themes\TranscodedWallpaper");
        existing_file(transcoded)
    })
}

/// `IDesktopWallpaper`: the shared wallpaper, else the primary monitor's
/// (the one containing the origin), else the first monitor that has one.
fn primary_monitor_wallpaper() -> Option<PathBuf> {
    let _com = ComScope::enter().ok()?;
    // SAFETY (whole block): COM calls; returned strings are freed by
    // take_co_string.
    unsafe {
        let dw: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL).ok()?;
        let wallpaper_of = |id: PCWSTR| {
            dw.GetWallpaper(id)
                .ok()
                .map(|p| PathBuf::from(take_co_string(p)))
                .and_then(existing_file)
        };
        if let Some(p) = wallpaper_of(PCWSTR::null()) {
            return Some(p);
        }
        let count = dw.GetMonitorDevicePathCount().ok()?;
        let ids: Vec<Vec<u16>> = (0..count)
            .filter_map(|i| dw.GetMonitorDevicePathAt(i).ok())
            .map(|p| wide(take_co_string(p)))
            .collect();
        let is_primary = |id: &Vec<u16>| {
            dw.GetMonitorRECT(pcwstr(id))
                .is_ok_and(|r| r.left <= 0 && 0 < r.right && r.top <= 0 && 0 < r.bottom)
        };
        ids.iter()
            .filter(|id| is_primary(id))
            .chain(ids.iter())
            .find_map(|id| wallpaper_of(pcwstr(id)))
    }
}

fn desktop_setting(name: &str) -> Option<u32> {
    let key = RegKey::open(HKEY_CURRENT_USER, DESKTOP_KEY, KEY_READ).ok()??;
    key.dword(name).ok().flatten()
}

/// `WallpaperStyle` / `TileWallpaper` → fit (10 Fill, 6 Fit, 2 Stretch,
/// 0 + tile Tile, 0 Center, 22 Span; Fill when unset).
fn wallpaper_fit() -> WallpaperFit {
    let tile = desktop_setting("TileWallpaper") == Some(1);
    match desktop_setting("WallpaperStyle") {
        Some(6) => WallpaperFit::Fit,
        Some(2) => WallpaperFit::Stretch,
        Some(0) if tile => WallpaperFit::Tile,
        Some(0) => WallpaperFit::Center,
        Some(22) => WallpaperFit::Span,
        _ => WallpaperFit::Fill,
    }
}

fn hex(r: u32, g: u32, b: u32) -> String {
    format!("#{:02x}{:02x}{:02x}", r & 0xFF, g & 0xFF, b & 0xFF)
}

/// Desktop background colour (`COLOR_DESKTOP`, a COLORREF `0x00BBGGRR`).
fn background_color() -> String {
    // SAFETY: plain query.
    let c = unsafe { GetSysColor(COLOR_DESKTOP) };
    hex(c, c >> 8, c >> 16)
}

fn primary_monitor_size() -> (u32, u32) {
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: valid monitor handle (DEFAULTTOPRIMARY) and out struct.
    let ok = unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        GetMonitorInfoW(monitor, &mut info).as_bool()
    };
    let r = info.rcMonitor;
    if ok && r.right > r.left && r.bottom > r.top {
        ((r.right - r.left) as u32, (r.bottom - r.top) as u32)
    } else {
        (1920, 1080)
    }
}

fn registry_icon_size() -> Option<u32> {
    RegKey::open(
        HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\Shell\Bags\1\Desktop",
        KEY_READ,
    )
    .ok()??
    .dword("IconSize")
    .ok()
    .flatten()
}

/// The taskbar uses the dark theme (`SystemUsesLightTheme == 0`; dark when
/// unset, as on a default Windows 11 install).
fn dark_taskbar() -> bool {
    RegKey::open(
        HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        KEY_READ,
    )
    .ok()
    .flatten()
    .and_then(|k| k.dword("SystemUsesLightTheme").ok().flatten())
    .is_none_or(|v| v == 0)
}

/// Everything the wallpaper preview needs. `monitor_size` is the physical
/// size of the monitor the box is on (the primary monitor when `None`).
/// Uses COM (desktop icon size, wallpaper): call it on the STA.
pub fn wallpaper_info(monitor_size: Option<(u32, u32)>) -> WallpaperInfo {
    let (monitor_width, monitor_height) = monitor_size.unwrap_or_else(primary_monitor_size);
    let icon_size = desktop_icon_size()
        .ok()
        .or_else(registry_icon_size)
        .filter(|s| (16..=256).contains(s))
        .unwrap_or(DEFAULT_ICON_SIZE);
    WallpaperInfo {
        has_image: wallpaper_path().is_some(),
        fit: wallpaper_fit(),
        background: background_color(),
        monitor_width,
        monitor_height,
        icon_size,
        dark_taskbar: dark_taskbar(),
        accent: accent_color(),
    }
}

/// The Windows accent colour as `#rrggbb`: `HKCU\…\DWM\AccentColor`
/// (ABGR), else the DWM colorization colour (ARGB).
pub fn accent_color() -> Option<String> {
    let from_registry = RegKey::open(
        HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\DWM",
        KEY_READ,
    )
    .ok()
    .flatten()
    .and_then(|k| k.dword("AccentColor").ok().flatten());
    if let Some(abgr) = from_registry {
        return Some(hex(abgr, abgr >> 8, abgr >> 16));
    }
    let (mut argb, mut opaque) = (0u32, BOOL(0));
    // SAFETY: valid out pointers.
    unsafe { DwmGetColorizationColor(&mut argb, &mut opaque) }.ok()?;
    Some(hex(argb >> 16, argb >> 8, argb))
}

/// Windows' "Animation effects" setting (`SPI_GETCLIENTAREAANIMATION`);
/// true when it cannot be read.
pub fn client_area_animation() -> bool {
    let mut enabled = BOOL(1);
    // SAFETY: `enabled` is a BOOL-sized out buffer.
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut enabled as *mut BOOL as *mut c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    read.is_err() || enabled.as_bool()
}

/// Windows 11 or later (`CurrentBuildNumber` ≥ 22000).
pub fn is_windows11() -> bool {
    let Ok(Some(key)) = RegKey::open(
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        KEY_READ,
    ) else {
        return false;
    };
    ["CurrentBuildNumber", "CurrentBuild"]
        .iter()
        .find_map(|name| key.string(name).ok().flatten())
        .and_then(|b| b.trim().parse::<u32>().ok())
        .is_some_and(|build| build >= 22000)
}

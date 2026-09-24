//! The floating box window: transparent, frameless, topmost, no taskbar
//! button. Created visible (events to hidden-created windows can be lost)
//! at its saved position.

use reskin_core::model::{BoxMetrics, Rect, Settings};
use tauri::{AppHandle, Runtime, WebviewWindow, WebviewWindowBuilder};

use super::{monitors, raw, webview2, window_config};

pub const LABEL: &str = "box";

/// Default distance from the work-area corner (logical px).
const CORNER_GAP: f64 = 28.0;

pub fn create<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
) -> tauri::Result<WebviewWindow<R>> {
    let cfg = window_config(app, LABEL)?;
    let metrics = BoxMetrics::for_size(settings.box_size);
    let (x, y) = initial_position(app, settings, metrics.window);
    let compat = settings.compatibility_mode;
    let window = WebviewWindowBuilder::from_config(app, &cfg)?
        .inner_size(metrics.window, metrics.window)
        .position(x, y)
        .focused(false)
        .transparent(!compat)
        .build()?;
    webview2::tune(&window);
    if compat {
        apply_compat_shape(&window, &metrics);
    }
    Ok(window)
}

/// Compatibility mode: the window is opaque, so clip it to the visual box.
pub fn apply_compat_shape<R: Runtime>(window: &WebviewWindow<R>, m: &BoxMetrics) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let visual = Rect::new(
        m.margin * scale,
        m.margin * scale,
        m.visual * scale,
        m.visual * scale,
    );
    let h = raw::hwnd_of(window);
    raw::set_round_region(h, visual, m.radius * scale);
    raw::round_corners(h);
}

/// Rebuilds the box window (after the transparency setting changed). The
/// new window starts hidden; the caller shows it.
pub fn recreate<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
) -> tauri::Result<WebviewWindow<R>> {
    use tauri::Manager;
    if let Some(old) = app.get_webview_window(LABEL) {
        let _ = old.destroy();
        for _ in 0..40 {
            if app.get_webview_window(LABEL).is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    let window = create(app, settings)?;
    raw::hide(raw::hwnd_of(&window));
    Ok(window)
}

/// Logical position for the window builder: the saved position when it is
/// still fully on a work area, else the bottom-right corner of the primary
/// work area.
fn initial_position<R: Runtime>(app: &AppHandle<R>, settings: &Settings, size: f64) -> (f64, f64) {
    if let Some(saved) = &settings.box_position {
        let (sx, sy) = (saved.x as f64, saved.y as f64);
        if let Some(m) = monitors::all(app).into_iter().find(|m| {
            let phys = size * m.scale;
            m.work.contains_rect(&Rect::new(sx, sy, phys, phys))
        }) {
            return (sx / m.scale, sy / m.scale);
        }
    }
    match monitors::primary(app) {
        Some(m) => {
            let phys = size * m.scale;
            let gap = CORNER_GAP * m.scale;
            (
                (m.work.right() - phys - gap) / m.scale,
                (m.work.bottom() - phys - gap) / m.scale,
            )
        }
        None => (100.0, 100.0),
    }
}

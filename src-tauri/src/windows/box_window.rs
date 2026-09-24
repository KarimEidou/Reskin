//! The floating box window: transparent, frameless, topmost, no taskbar
//! button. Created visible (events to hidden-created windows can be lost)
//! at its saved position.

use reskin_core::model::{BoxMetrics, Rect, Settings};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use super::{monitors, raw, webview2, window_config};
use crate::state::AppState;

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
    // On a monitor with another DPI the window keeps its logical size, but
    // its clip region (physical px) must be rebuilt for the new scale.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
            let settings = handle.state::<AppState>().settings();
            if settings.compatibility_mode
                && let Some(w) = handle.get_webview_window(LABEL)
            {
                let metrics = BoxMetrics::for_size(settings.box_size);
                clip_to_visual(&w, &metrics, *scale_factor);
            }
        }
    });
    Ok(window)
}

/// Compatibility mode: the window is opaque, so clip it to the visual box.
pub fn apply_compat_shape<R: Runtime>(window: &WebviewWindow<R>, m: &BoxMetrics) {
    clip_to_visual(window, m, window.scale_factor().unwrap_or(1.0));
    raw::round_corners(raw::hwnd_of(window));
}

/// Clips the window to the visual box at `scale` (physical px per CSS px).
fn clip_to_visual<R: Runtime>(window: &WebviewWindow<R>, m: &BoxMetrics, scale: f64) {
    let (visual, radius) = visual_region(m, scale);
    raw::set_round_region(raw::hwnd_of(window), visual, radius);
}

/// The visual box inside the window, and its corner radius, in physical px.
fn visual_region(m: &BoxMetrics, scale: f64) -> (Rect, f64) {
    let visual = Rect::new(
        m.margin * scale,
        m.margin * scale,
        m.visual * scale,
        m.visual * scale,
    );
    (visual, m.radius * scale)
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

#[cfg(test)]
mod tests {
    use super::*;
    use reskin_core::model::SizeClass;

    #[test]
    fn the_clip_region_follows_the_scale() {
        let m = BoxMetrics::for_size(SizeClass::Medium);
        let (at_1, r_1) = visual_region(&m, 1.0);
        assert_eq!((at_1, r_1), (Rect::new(14.0, 14.0, 120.0, 120.0), 30.0));
        // Dragged onto a 150 % monitor: the same box, 1.5 times the pixels.
        let (at_15, r_15) = visual_region(&m, 1.5);
        assert_eq!((at_15, r_15), (Rect::new(21.0, 21.0, 180.0, 180.0), 45.0));
    }
}

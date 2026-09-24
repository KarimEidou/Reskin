//! Monitor helpers in physical pixels.

use reskin_core::model::Rect;
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone)]
pub struct MonitorInfo {
    pub name: Option<String>,
    /// Full monitor rect (physical px).
    pub rect: Rect,
    /// Work area (physical px), excluding the taskbar.
    pub work: Rect,
    pub scale: f64,
}

pub fn all<R: Runtime>(app: &AppHandle<R>) -> Vec<MonitorInfo> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let wa = m.work_area();
            MonitorInfo {
                name: m.name().cloned(),
                rect: Rect::new(
                    m.position().x as f64,
                    m.position().y as f64,
                    m.size().width as f64,
                    m.size().height as f64,
                ),
                work: Rect::new(
                    wa.position.x as f64,
                    wa.position.y as f64,
                    wa.size.width as f64,
                    wa.size.height as f64,
                ),
                scale: m.scale_factor(),
            }
        })
        .collect()
}

pub fn primary<R: Runtime>(app: &AppHandle<R>) -> Option<MonitorInfo> {
    let p = app.primary_monitor().ok().flatten()?;
    let pos = *p.position();
    all(app)
        .into_iter()
        .find(|m| m.rect.x == pos.x as f64 && m.rect.y == pos.y as f64)
}

/// The monitor containing the point, else the nearest one, else primary.
pub fn at_point<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) -> Option<MonitorInfo> {
    let list = all(app);
    if let Some(m) = list.iter().find(|m| m.rect.contains_point(x, y)) {
        return Some(m.clone());
    }
    list.into_iter()
        .min_by(|a, b| dist2(&a.rect, x, y).total_cmp(&dist2(&b.rect, x, y)))
        .or_else(|| primary(app))
}

fn dist2(r: &Rect, x: f64, y: f64) -> f64 {
    let (nx, ny) = reskin_core::geom::nearest_point_in(*r, x, y);
    (nx - x).powi(2) + (ny - y).powi(2)
}

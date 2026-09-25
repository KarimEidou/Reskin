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

/// Where the box (`current`, physical px) rests, given the work areas of
/// the monitors connected now: its saved home (`saved`, the top-left
/// corner) while that is fully on one of them, else where it is — pulled
/// into the nearest work area when it is off all of them. A saved home
/// off every monitor (its monitor was disconnected) is not dropped: it
/// counts again once that monitor is back. Without any monitor known
/// nothing can be checked, and the saved home stands.
pub fn resting_home(saved: Option<(f64, f64)>, current: Rect, works: &[Rect]) -> Rect {
    let home = saved.map(|(x, y)| Rect::new(x, y, current.w, current.h));
    let on_screen = |r: &Rect| works.iter().any(|w| w.contains_rect(r));
    if let Some(home) = home.filter(|h| works.is_empty() || on_screen(h)) {
        return home;
    }
    if works.is_empty() || on_screen(&current) {
        return current;
    }
    let (cx, cy) = current.center();
    works
        .iter()
        .min_by(|a, b| dist2(a, cx, cy).total_cmp(&dist2(b, cx, cy)))
        .map_or(current, |w| reskin_core::geom::clamp_into(current, *w))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1920 × 1080 monitor at `x` with a 48 px taskbar.
    fn work(x: f64) -> Rect {
        Rect::new(x, 0.0, 1920.0, 1032.0)
    }

    #[test]
    fn the_saved_home_counts_while_it_is_on_a_monitor() {
        let current = Rect::new(100.0, 100.0, 148.0, 148.0);
        let both = [work(0.0), work(1920.0)];
        // Saved on the second monitor, the box elsewhere for a moment (the
        // editor collapsed onto it where it opened).
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, &both),
            Rect::new(3000.0, 700.0, 148.0, 148.0)
        );
        // Never saved: where it is.
        assert_eq!(resting_home(None, current, &both), current);
    }

    #[test]
    fn a_home_on_a_disconnected_monitor_is_not_where_the_box_goes() {
        let current = Rect::new(1700.0, 800.0, 148.0, 148.0);
        // The second monitor is gone: the box stays where it is, on screen.
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, &[work(0.0)]),
            current
        );
        // Half off the remaining work area (under the taskbar) counts as off.
        assert_eq!(
            resting_home(Some((1700.0, 950.0)), current, &[work(0.0)]),
            current
        );
    }

    #[test]
    fn a_box_off_every_monitor_is_pulled_onto_the_nearest() {
        // Left where the disconnected monitor was.
        let current = Rect::new(3000.0, 700.0, 148.0, 148.0);
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, &[work(0.0)]),
            Rect::new(1772.0, 700.0, 148.0, 148.0)
        );
        assert_eq!(
            resting_home(None, current, &[work(-1920.0), work(0.0)]),
            Rect::new(1772.0, 700.0, 148.0, 148.0)
        );
    }

    #[test]
    fn without_any_monitor_known_the_saved_home_stands() {
        let current = Rect::new(100.0, 100.0, 148.0, 148.0);
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, &[]),
            Rect::new(3000.0, 700.0, 148.0, 148.0)
        );
        assert_eq!(resting_home(None, current, &[]), current);
    }
}

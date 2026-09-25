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

/// Where the box (`current`, physical px; its window `side` logical px
/// wide) rests, given the monitors connected now: its saved home (`saved`,
/// the top-left corner) while the box, as large as it is on that monitor,
/// fits there fully on one of their work areas (the test the box's
/// start-up position makes too), else where it is — pulled into the
/// nearest work area when it is off all of them. A saved home off every
/// monitor (its monitor was disconnected) is not dropped: it counts again
/// once that monitor is back. Without any monitor known nothing can be
/// checked, and the saved home stands.
pub fn resting_home(
    saved: Option<(f64, f64)>,
    current: Rect,
    side: f64,
    monitors: &[MonitorInfo],
) -> Rect {
    let fits_at = |(x, y): (f64, f64)| {
        monitors.iter().any(|m| {
            let phys = side * m.scale;
            m.work.contains_rect(&Rect::new(x, y, phys, phys))
        })
    };
    if let Some((x, y)) = saved.filter(|&home| monitors.is_empty() || fits_at(home)) {
        return Rect::new(x, y, current.w, current.h);
    }
    if monitors.is_empty() || monitors.iter().any(|m| m.work.contains_rect(&current)) {
        return current;
    }
    let (cx, cy) = current.center();
    monitors
        .iter()
        .min_by(|a, b| dist2(&a.work, cx, cy).total_cmp(&dist2(&b.work, cx, cy)))
        .map_or(current, |m| reskin_core::geom::clamp_into(current, m.work))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The medium box's window (logical px).
    const SIDE: f64 = 148.0;

    /// A `w` × `h` px monitor at `x` at `scale`, with a 48 logical px taskbar.
    fn monitor(x: f64, w: f64, h: f64, scale: f64) -> MonitorInfo {
        MonitorInfo {
            name: None,
            rect: Rect::new(x, 0.0, w, h),
            work: Rect::new(x, 0.0, w, h - 48.0 * scale),
            scale,
        }
    }

    /// A 1920 × 1080 monitor at 100 % at `x`.
    fn fhd(x: f64) -> MonitorInfo {
        monitor(x, 1920.0, 1080.0, 1.0)
    }

    #[test]
    fn the_saved_home_counts_while_it_is_on_a_monitor() {
        let current = Rect::new(100.0, 100.0, 148.0, 148.0);
        let both = [fhd(0.0), fhd(1920.0)];
        // Saved on the second monitor, the box elsewhere for a moment (the
        // editor collapsed onto it where it opened).
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, SIDE, &both),
            Rect::new(3000.0, 700.0, 148.0, 148.0)
        );
        // Never saved: where it is.
        assert_eq!(resting_home(None, current, SIDE, &both), current);
    }

    #[test]
    fn the_saved_home_is_checked_at_the_size_the_box_has_on_its_monitor() {
        // Home snapped into the bottom-right corner of a 100 % monitor; for
        // now the box is on a 150 % screen (the editor collapsed onto it
        // there), 222 px wide: 148 px wide at home, it fits there.
        let monitors = [fhd(0.0), monitor(1920.0, 2880.0, 1800.0, 1.5)];
        let current = Rect::new(2400.0, 600.0, 222.0, 222.0);
        let home = (1920.0 - 148.0 - 8.0, 1032.0 - 148.0 - 8.0);
        assert_eq!(
            resting_home(Some(home), current, SIDE, &monitors),
            Rect::new(home.0, home.1, 222.0, 222.0)
        );
        // At 150 % there, it would not.
        let scaled = [monitor(0.0, 1920.0, 1080.0, 1.5), fhd(1920.0)];
        let current = Rect::new(2400.0, 600.0, 148.0, 148.0);
        assert_eq!(resting_home(Some(home), current, SIDE, &scaled), current);
    }

    #[test]
    fn a_home_on_a_disconnected_monitor_is_not_where_the_box_goes() {
        let current = Rect::new(1700.0, 800.0, 148.0, 148.0);
        // The second monitor is gone: the box stays where it is, on screen.
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, SIDE, &[fhd(0.0)]),
            current
        );
        // Half off the remaining work area (under the taskbar) counts as off.
        assert_eq!(
            resting_home(Some((1700.0, 950.0)), current, SIDE, &[fhd(0.0)]),
            current
        );
    }

    #[test]
    fn a_box_off_every_monitor_is_pulled_onto_the_nearest() {
        // Left where the disconnected monitor was.
        let current = Rect::new(3000.0, 700.0, 148.0, 148.0);
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, SIDE, &[fhd(0.0)]),
            Rect::new(1772.0, 700.0, 148.0, 148.0)
        );
        assert_eq!(
            resting_home(None, current, SIDE, &[fhd(-1920.0), fhd(0.0)]),
            Rect::new(1772.0, 700.0, 148.0, 148.0)
        );
    }

    #[test]
    fn without_any_monitor_known_the_saved_home_stands() {
        let current = Rect::new(100.0, 100.0, 148.0, 148.0);
        assert_eq!(
            resting_home(Some((3000.0, 700.0)), current, SIDE, &[]),
            Rect::new(3000.0, 700.0, 148.0, 148.0)
        );
        assert_eq!(resting_home(None, current, SIDE, &[]), current);
    }
}

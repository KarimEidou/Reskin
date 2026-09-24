//! Window geometry: where the editor opens relative to the box, and where
//! the box snaps after a fling.
//!
//! All rects here are in the same unit (physical px in practice); callers
//! convert.

use crate::model::Rect;

/// Places the editor so that it
/// 1. always *contains* the box rect (the proxy morphs out of the box's
///    exact on-screen spot),
/// 2. grows from the box toward the centre of the work area, and
/// 3. stays inside the work area.
///
/// `size` is the desired editor size; it is shrunk to fit the work area
/// and grown to at least the box size.
pub fn place_editor(box_rect: Rect, work_area: Rect, size: (f64, f64)) -> Rect {
    let w = size.0.min(work_area.w).max(box_rect.w).round();
    let h = size.1.min(work_area.h).max(box_rect.h).round();
    let (bx, by) = box_rect.center();
    let (cx, cy) = work_area.center();

    // Grow toward the centre: a box left of centre keeps its left edge and
    // the editor extends right, and vice versa.
    let x = if bx <= cx {
        box_rect.x
    } else {
        box_rect.right() - w
    };
    let y = if by <= cy {
        box_rect.y
    } else {
        box_rect.bottom() - h
    };

    // Clamp to the work area. When the box itself sits inside the work
    // area this cannot break containment: the clamp only moves the editor
    // toward the centre, and the box edge that anchored it is within bounds.
    let x = clamp(x, work_area.x, work_area.right() - w);
    let y = clamp(y, work_area.y, work_area.bottom() - h);
    Rect::new(x.round(), y.round(), w, h)
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if hi < lo { lo } else { v.clamp(lo, hi) }
}

/// Clamps a window rect so it is fully inside `area` (keeping its size).
pub fn clamp_into(r: Rect, area: Rect) -> Rect {
    Rect::new(
        clamp(r.x, area.x, area.right() - r.w),
        clamp(r.y, area.y, area.bottom() - r.h),
        r.w,
        r.h,
    )
}

/// Where a released box should come to rest.
///
/// The box keeps `margin` px from the work-area edges. If it ends within
/// `snap` px of an edge it snaps flush to that edge (and to a corner when
/// near two edges).
pub fn snap_target(r: Rect, area: Rect, margin: f64, snap: f64) -> Rect {
    let inner = Rect::new(
        area.x + margin,
        area.y + margin,
        (area.w - 2.0 * margin).max(r.w),
        (area.h - 2.0 * margin).max(r.h),
    );
    let mut t = clamp_into(r, inner);
    if (t.x - inner.x).abs() <= snap {
        t.x = inner.x;
    } else if (inner.right() - t.right()).abs() <= snap {
        t.x = inner.right() - t.w;
    }
    if (t.y - inner.y).abs() <= snap {
        t.y = inner.y;
    } else if (inner.bottom() - t.bottom()).abs() <= snap {
        t.y = inner.bottom() - t.h;
    }
    t
}

/// Projects where a fling would carry the box, given the release velocity
/// (px/s) and an exponential friction time constant `tau` (s).
pub fn fling_projection(r: Rect, vx: f64, vy: f64, tau: f64) -> Rect {
    // Cap absurd velocities from jittery input.
    let cap = 6000.0;
    let vx = vx.clamp(-cap, cap);
    let vy = vy.clamp(-cap, cap);
    r.translate(vx * tau, vy * tau)
}

/// Critically-damped spring step toward `target` (per axis). Returns the new
/// (position, velocity). `omega` is the natural frequency (rad/s).
pub fn spring_step(pos: f64, vel: f64, target: f64, omega: f64, dt: f64) -> (f64, f64) {
    // Exact solution of x'' = -2ωx' - ω²(x - target) over dt.
    let x0 = pos - target;
    let e = (-omega * dt).exp();
    let c = vel + omega * x0;
    let x = (x0 + c * dt) * e;
    let v = (c - omega * (x0 + c * dt)) * e;
    (target + x, v)
}

/// The point of `r` closest to `(x, y)`.
pub fn nearest_point_in(r: Rect, x: f64, y: f64) -> (f64, f64) {
    (x.clamp(r.x, r.right()), y.clamp(r.y, r.bottom()))
}

/// Point on a quadratic Bézier arc from `a` to `b` that bulges upward by
/// `lift` px at the middle, at parameter `t` in 0..=1.
pub fn arc_point(a: (f64, f64), b: (f64, f64), lift: f64, t: f64) -> (f64, f64) {
    let mid = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0 - lift);
    let u = 1.0 - t;
    (
        u * u * a.0 + 2.0 * u * t * mid.0 + t * t * b.0,
        u * u * a.1 + 2.0 * u * t * mid.1 + t * t * b.1,
    )
}

/// Ease-in-out cubic.
pub fn ease_in_out(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny deterministic PRNG so the property tests need no dependency.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
        }
        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.next()
        }
    }

    #[test]
    fn editor_contains_box_and_stays_in_work_area() {
        let mut rng = Lcg(42);
        for _ in 0..20_000 {
            let wa = Rect::new(
                rng.range(-3000.0, 3000.0).round(),
                rng.range(-2000.0, 2000.0).round(),
                rng.range(640.0, 3840.0).round(),
                rng.range(480.0, 2160.0).round(),
            );
            let bs = rng.range(96.0, 250.0).round();
            let bx = rng.range(wa.x, wa.right() - bs).round();
            let by = rng.range(wa.y, wa.bottom() - bs).round();
            let b = Rect::new(bx, by, bs, bs);
            let size = (rng.range(200.0, 4000.0), rng.range(200.0, 3000.0));
            let e = place_editor(b, wa, size);
            assert!(
                e.contains_rect(&b),
                "editor {e:?} must contain box {b:?} (wa {wa:?})"
            );
            assert!(
                wa.contains_rect(&e),
                "editor {e:?} must be inside work area {wa:?}"
            );
            assert!(e.w <= size.0.max(b.w).round() + 0.5);
        }
    }

    #[test]
    fn editor_grows_toward_center() {
        let wa = Rect::new(0.0, 0.0, 1920.0, 1040.0);
        // Box near the top-right corner: editor extends left and down.
        let b = Rect::new(1700.0, 40.0, 148.0, 148.0);
        let e = place_editor(b, wa, (1000.0, 700.0));
        assert_eq!(e.right(), b.right());
        assert_eq!(e.y, b.y);
        // Box near the bottom-left: editor extends right and up.
        let b = Rect::new(20.0, 860.0, 148.0, 148.0);
        let e = place_editor(b, wa, (1000.0, 700.0));
        assert_eq!(e.x, b.x);
        assert_eq!(e.bottom(), b.bottom());
    }

    #[test]
    fn editor_shrinks_to_small_work_area() {
        let wa = Rect::new(0.0, 0.0, 800.0, 600.0);
        let b = Rect::new(300.0, 200.0, 148.0, 148.0);
        let e = place_editor(b, wa, (1280.0, 820.0));
        assert_eq!((e.w, e.h), (800.0, 600.0));
        assert_eq!((e.x, e.y), (0.0, 0.0));
    }

    #[test]
    fn snapping() {
        let area = Rect::new(0.0, 0.0, 1000.0, 800.0);
        let r = Rect::new(20.0, 300.0, 100.0, 100.0);
        let t = snap_target(r, area, 8.0, 40.0);
        assert_eq!(t.x, 8.0);
        assert_eq!(t.y, 300.0);
        let corner = snap_target(Rect::new(970.0, 790.0, 100.0, 100.0), area, 8.0, 40.0);
        assert_eq!((corner.right(), corner.bottom()), (992.0, 792.0));
        let off = snap_target(Rect::new(-500.0, -500.0, 100.0, 100.0), area, 8.0, 40.0);
        assert_eq!((off.x, off.y), (8.0, 8.0));
    }

    #[test]
    fn spring_converges() {
        let (mut x, mut v) = (0.0, 0.0);
        for _ in 0..120 {
            (x, v) = spring_step(x, v, 100.0, 18.0, 1.0 / 60.0);
        }
        assert!((x - 100.0).abs() < 0.05, "x = {x}");
        assert!(v.abs() < 1.0);
    }

    #[test]
    fn arc_endpoints() {
        let a = (0.0, 100.0);
        let b = (200.0, 100.0);
        assert_eq!(arc_point(a, b, 50.0, 0.0), a);
        assert_eq!(arc_point(a, b, 50.0, 1.0), b);
        assert!(arc_point(a, b, 50.0, 0.5).1 < 100.0);
        assert_eq!(ease_in_out(0.0), 0.0);
        assert_eq!(ease_in_out(1.0), 1.0);
    }
}

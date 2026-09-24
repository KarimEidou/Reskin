//! The box animator: one thread owns every movement of the box window.
//!
//! Motion is time-based (`Instant` deltas), paced by `DwmFlush()` so each
//! step lands on a composition frame, and applied with
//! `SetWindowPos(NOSIZE | NOZORDER | NOACTIVATE | ASYNCWINDOWPOS)` so the
//! UI thread is never blocked. HWNDs cross threads as `isize`.
//!
//! `drag` replaces `data-tauri-drag-region` (which swallows mouseup and
//! maximizes on double-click): JS invokes `box_drag` on pointerdown and the
//! loop follows `GetCursorPos` until the button is released, then flings,
//! snaps to edges/corners and reports `click` or `moved`.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reskin_core::geom;
use reskin_core::model::{DragResult, Rect};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, GetWindowRect, SM_SWAPBUTTON, SWP_ASYNCWINDOWPOS,
    SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
};

/// Movement (logical px) that turns a press into a drag.
const DRAG_THRESHOLD: f64 = 4.0;
/// Distance (logical px) kept from work-area edges after a fling.
const EDGE_MARGIN: f64 = 8.0;
/// Within this distance (logical px) of an edge the box snaps flush to it.
const SNAP_DISTANCE: f64 = 56.0;
/// Fling projection time constant (s): how far a release velocity carries.
const FLING_TAU: f64 = 0.11;
/// Spring natural frequency (rad/s) for settle / glide motions.
const SPRING_OMEGA: f64 = 15.0;
/// Safety cap for a single drag.
const MAX_DRAG: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DragOutcome {
    pub result: DragResult,
    /// Final window top-left (physical px).
    pub pos: (i32, i32),
}

enum Job {
    Drag(Sender<DragOutcome>),
    /// Spring to a point (physical top-left).
    Glide((i32, i32), Sender<()>),
    /// Arc flight to a point over `duration` with `lift` px of bulge.
    Arc {
        to: (i32, i32),
        lift: f64,
        duration: Duration,
        done: Sender<()>,
    },
    /// Move instantly.
    Jump((i32, i32), Sender<()>),
}

/// Handle to the animator thread. Cheap to clone.
#[derive(Clone)]
pub struct Animator {
    tx: Sender<Job>,
    hwnd: Arc<AtomicIsize>,
    /// Serialises callers so one motion finishes (or is preempted) before
    /// the next caller's result is awaited.
    gate: Arc<Mutex<()>>,
}

impl Animator {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel();
        let hwnd = Arc::new(AtomicIsize::new(0));
        let h = hwnd.clone();
        std::thread::Builder::new()
            .name("reskin-animator".into())
            .spawn(move || run(rx, h))
            .expect("spawn animator thread");
        Self {
            tx,
            hwnd,
            gate: Arc::new(Mutex::new(())),
        }
    }

    /// Sets the box window handle (after it is created / recreated).
    pub fn set_hwnd(&self, hwnd: isize) {
        self.hwnd.store(hwnd, Ordering::SeqCst);
    }

    pub fn hwnd(&self) -> isize {
        self.hwnd.load(Ordering::SeqCst)
    }

    /// Current window rect in physical px.
    pub fn rect(&self) -> Option<Rect> {
        window_rect(self.hwnd())
    }

    /// Runs the drag loop. Blocks until the button is released and the box
    /// has settled. A drag preempts any glide in progress.
    pub fn drag(&self) -> Option<DragOutcome> {
        let (tx, rx) = mpsc::channel();
        self.tx.send(Job::Drag(tx)).ok()?;
        rx.recv().ok()
    }

    /// Springs the box to `to` (physical top-left); blocks until settled or
    /// preempted.
    pub fn glide_to(&self, to: (i32, i32)) {
        let _g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Job::Glide(to, tx)).is_ok() {
            let _ = rx.recv();
        }
    }

    /// Flies an arc to `to`; blocks until arrival or preemption.
    pub fn arc_to(&self, to: (i32, i32), lift: f64, duration: Duration) {
        let _g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        let (tx, rx) = mpsc::channel();
        if self
            .tx
            .send(Job::Arc {
                to,
                lift,
                duration,
                done: tx,
            })
            .is_ok()
        {
            let _ = rx.recv();
        }
    }

    /// Moves instantly (e.g. to park the hidden box before it is shown).
    pub fn jump_to(&self, to: (i32, i32)) {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(Job::Jump(to, tx)).is_ok() {
            let _ = rx.recv();
        }
    }
}

fn run(rx: Receiver<Job>, hwnd: Arc<AtomicIsize>) {
    let mut next: Option<Job> = None;
    loop {
        let job = match next.take() {
            Some(j) => j,
            None => match rx.recv() {
                Ok(j) => j,
                Err(_) => return,
            },
        };
        let h = hwnd.load(Ordering::SeqCst);
        match job {
            Job::Drag(reply) => {
                let out = drag(h, &rx, &mut next);
                let _ = reply.send(out);
            }
            Job::Glide(to, done) => {
                if let Some(r) = window_rect(h) {
                    next = spring_to(h, (r.x, r.y), (0.0, 0.0), to, &rx);
                }
                let _ = done.send(());
            }
            Job::Arc {
                to,
                lift,
                duration,
                done,
            } => {
                if let Some(r) = window_rect(h) {
                    next = arc(h, (r.x, r.y), to, lift, duration, &rx);
                }
                let _ = done.send(());
            }
            Job::Jump(to, done) => {
                set_pos(h, to.0, to.1);
                let _ = done.send(());
            }
        }
    }
}

/// The drag loop. Any job arriving meanwhile is deferred (stored in
/// `next`), except that a drag always completes first.
fn drag(h: isize, rx: &Receiver<Job>, next: &mut Option<Job>) -> DragOutcome {
    let Some(start_rect) = window_rect(h) else {
        return DragOutcome {
            result: DragResult::Click,
            pos: (0, 0),
        };
    };
    let start_cursor = cursor();
    let scale = window_scale(h);
    let threshold = DRAG_THRESHOLD * scale;
    let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
        VK_RBUTTON
    } else {
        VK_LBUTTON
    };
    let t0 = Instant::now();
    let mut moved = false;
    let mut samples: Vec<(Instant, f64, f64)> = Vec::with_capacity(64);
    let mut pos = (start_rect.x, start_rect.y);
    let mut cancelled = false;
    loop {
        let down = key_down(button.0 as i32);
        let c = cursor();
        let (dx, dy) = (c.0 - start_cursor.0, c.1 - start_cursor.1);
        if !moved && dx * dx + dy * dy > threshold * threshold {
            moved = true;
        }
        if moved {
            pos = (start_rect.x + dx, start_rect.y + dy);
            set_pos(h, pos.0.round() as i32, pos.1.round() as i32);
            let now = Instant::now();
            samples.push((now, pos.0, pos.1));
            samples.retain(|s| now.duration_since(s.0) <= Duration::from_millis(90));
        }
        if !down || t0.elapsed() > MAX_DRAG {
            break;
        }
        if moved && key_down(VK_ESCAPE.0 as i32) {
            // Esc cancels the drag: spring back to where it started.
            cancelled = true;
            break;
        }
        // Defer (don't drop) motion requests that arrive mid-drag.
        if let Ok(j) = rx.try_recv() {
            match j {
                Job::Drag(reply) => {
                    // A second drag request while dragging: answer it as a
                    // click so the caller doesn't hang.
                    let _ = reply.send(DragOutcome {
                        result: DragResult::Click,
                        pos: (pos.0 as i32, pos.1 as i32),
                    });
                }
                other => *next = Some(other),
            }
        }
        frame_wait();
    }
    if !moved {
        return DragOutcome {
            result: DragResult::Click,
            pos: (start_rect.x as i32, start_rect.y as i32),
        };
    }
    let (vx, vy) = if cancelled {
        (0.0, 0.0)
    } else {
        velocity(&samples)
    };
    let cur = Rect::new(pos.0, pos.1, start_rect.w, start_rect.h);
    let target = if cancelled {
        start_rect
    } else {
        let proj = geom::fling_projection(cur, vx, vy, FLING_TAU);
        let (cx, cy) = proj.center();
        let work = work_area_at(cx, cy).unwrap_or(cur);
        geom::snap_target(proj, work, EDGE_MARGIN * scale, SNAP_DISTANCE * scale)
    };
    let to = (target.x.round() as i32, target.y.round() as i32);
    if let Some(j) = spring_to(h, pos, (vx, vy), to, rx) {
        *next = Some(j);
    }
    DragOutcome {
        result: DragResult::Moved,
        pos: to,
    }
}

fn velocity(samples: &[(Instant, f64, f64)]) -> (f64, f64) {
    let (Some(first), Some(last)) = (samples.first(), samples.last()) else {
        return (0.0, 0.0);
    };
    let dt = last.0.duration_since(first.0).as_secs_f64();
    if dt < 0.012 {
        return (0.0, 0.0);
    }
    ((last.1 - first.1) / dt, (last.2 - first.2) / dt)
}

/// Critically damped spring from `from` with initial velocity to `to`.
/// Returns a job that preempted the motion, if any.
fn spring_to(
    h: isize,
    from: (f64, f64),
    vel: (f64, f64),
    to: (i32, i32),
    rx: &Receiver<Job>,
) -> Option<Job> {
    let (tx, ty) = (to.0 as f64, to.1 as f64);
    let (mut x, mut y) = from;
    let (mut vx, mut vy) = vel;
    let mut last = Instant::now();
    let start = last;
    loop {
        if let Ok(j) = rx.try_recv() {
            return Some(j);
        }
        frame_wait();
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f64().min(0.05);
        last = now;
        (x, vx) = geom::spring_step(x, vx, tx, SPRING_OMEGA, dt);
        (y, vy) = geom::spring_step(y, vy, ty, SPRING_OMEGA, dt);
        let settled =
            (x - tx).abs() < 0.5 && (y - ty).abs() < 0.5 && vx.abs() < 15.0 && vy.abs() < 15.0;
        if settled || now.duration_since(start) > Duration::from_secs(3) {
            set_pos(h, to.0, to.1);
            return None;
        }
        set_pos(h, x.round() as i32, y.round() as i32);
    }
}

fn arc(
    h: isize,
    from: (f64, f64),
    to: (i32, i32),
    lift: f64,
    duration: Duration,
    rx: &Receiver<Job>,
) -> Option<Job> {
    let b = (to.0 as f64, to.1 as f64);
    let total = duration.as_secs_f64().max(0.001);
    let start = Instant::now();
    loop {
        if let Ok(j) = rx.try_recv() {
            return Some(j);
        }
        frame_wait();
        let t = (start.elapsed().as_secs_f64() / total).min(1.0);
        let (x, y) = geom::arc_point(from, b, lift, geom::ease_in_out(t));
        set_pos(h, x.round() as i32, y.round() as i32);
        if t >= 1.0 {
            return None;
        }
    }
}

// ---------------------------------------------------------------------------
// Win32 helpers
// ---------------------------------------------------------------------------

fn hwnd_of(h: isize) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

fn set_pos(h: isize, x: i32, y: i32) {
    if h == 0 {
        return;
    }
    unsafe {
        let _ = SetWindowPos(
            hwnd_of(h),
            None,
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
    }
}

pub fn window_rect(h: isize) -> Option<Rect> {
    if h == 0 {
        return None;
    }
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd_of(h), &mut r) }.ok()?;
    Some(Rect::new(
        r.left as f64,
        r.top as f64,
        (r.right - r.left) as f64,
        (r.bottom - r.top) as f64,
    ))
}

fn window_scale(h: isize) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd_of(h)) };
    if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 }
}

fn cursor() -> (f64, f64) {
    let mut p = POINT::default();
    let _ = unsafe { GetCursorPos(&mut p) };
    (p.x as f64, p.y as f64)
}

fn key_down(vk: i32) -> bool {
    (unsafe { GetAsyncKeyState(vk) } as u16) & 0x8000 != 0
}

/// Work area (physical px) of the monitor nearest to a point.
pub fn work_area_at(x: f64, y: f64) -> Option<Rect> {
    unsafe {
        let mon = MonitorFromPoint(
            POINT {
                x: x.round() as i32,
                y: y.round() as i32,
            },
            MONITOR_DEFAULTTONEAREST,
        );
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(mon, &mut info).as_bool() {
            return None;
        }
        let r = info.rcWork;
        Some(Rect::new(
            r.left as f64,
            r.top as f64,
            (r.right - r.left) as f64,
            (r.bottom - r.top) as f64,
        ))
    }
}

/// Waits for the next DWM composition frame (falls back to ~120 Hz sleeps
/// when composition is unavailable).
fn frame_wait() {
    if unsafe { DwmFlush() }.is_err() {
        std::thread::sleep(Duration::from_millis(8));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn velocity_from_samples() {
        let t = Instant::now();
        let s = vec![(t, 0.0, 0.0), (t + Duration::from_millis(50), 50.0, -25.0)];
        let (vx, vy) = velocity(&s);
        assert!((vx - 1000.0).abs() < 1.0);
        assert!((vy + 500.0).abs() < 1.0);
        assert_eq!(velocity(&s[..1]), (0.0, 0.0));
    }
}

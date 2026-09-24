//! The box ⇄ editor handoff state machine.
//!
//! Invariant: a window hides only when its content is transparent, and a
//! window shows only on top of an identical picture. Neither window resizes
//! while visible. The editor draws a proxy of the box (same `BoxVisual`
//! component) exactly where the real box is, so swapping windows is
//! invisible; the proxy then morphs into the panel. See
//! docs/ARCHITECTURE.md for the message sequence.

use std::collections::HashSet;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use reskin_core::geom;
use reskin_core::model::{
    AckStage, BoxCollapse, CollapseThen, EditorCmd, EditorView, ItemInfo, MotionPref, OpenStyle,
    Rect, Settings, editor_size,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use super::{box_window, editor_window, monitors, raw, webview2};
use crate::log;
use crate::state::AppState;

/// How long the editor may take to draw the proxy before we crossfade.
pub const PREPARE_TIMEOUT: Duration = Duration::from_millis(400);
const REVEAL_TIMEOUT: Duration = Duration::from_millis(1500);
const EXPAND_TIMEOUT: Duration = Duration::from_millis(2500);
const COLLAPSE_TIMEOUT: Duration = Duration::from_millis(1800);
const CLEAR_TIMEOUT: Duration = Duration::from_millis(1000);
/// How long the box may take to show the picture it took over from the
/// editor's proxy (two frames once it is visible, plus the IPC round trip).
const BOX_PAINT_TIMEOUT: Duration = Duration::from_millis(300);
/// The editor page must be polling the mailbox within this long.
const ALIVE_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Closed,
    Opening,
    Open,
    Closing,
}

#[derive(Default)]
struct Inner {
    session: u32,
    phase: Phase,
    acks: HashSet<(u32, AckStage)>,
    /// Latest session whose collapse picture the box confirmed on screen.
    box_painted: u32,
    /// The box was visible when this session opened (so it morphs back).
    box_was_visible: bool,
}

#[derive(Default)]
pub struct Morph {
    inner: Mutex<Inner>,
    cv: Condvar,
    /// Held for the whole duration of an open or close handoff.
    busy: Mutex<()>,
}

impl Morph {
    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    pub fn session(&self) -> u32 {
        self.lock().session
    }

    /// Records an ack from the editor page.
    pub fn ack(&self, session: u32, stage: AckStage) {
        let mut g = self.lock();
        g.acks.insert((session, stage));
        drop(g);
        self.cv.notify_all();
    }

    /// Records that the box shows the collapse picture of `session`.
    pub fn box_painted(&self, session: u32) {
        let mut g = self.lock();
        g.box_painted = g.box_painted.max(session);
        drop(g);
        self.cv.notify_all();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Waits until `done` holds or `timeout` elapses; false on timeout.
    fn wait_until(&self, timeout: Duration, done: impl Fn(&Inner) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut g = self.lock();
        loop {
            if done(&g) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            g = self
                .cv
                .wait_timeout(g, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    fn wait(&self, session: u32, stage: AckStage, timeout: Duration) -> bool {
        let acked = self.wait_until(timeout, |g| g.acks.contains(&(session, stage)));
        if !acked {
            log::line(&format!(
                "morph: session {session} timed out waiting for {stage:?}"
            ));
        }
        acked
    }

    /// Waits for the box to confirm the collapse picture of `session`.
    fn wait_box_painted(&self, session: u32, timeout: Duration) -> bool {
        let painted = self.wait_until(timeout, |g| g.box_painted >= session);
        if !painted {
            log::line(&format!(
                "morph: session {session}: the box did not confirm its picture in time; clearing anyway"
            ));
        }
        painted
    }

    fn set_phase(&self, p: Phase) {
        self.lock().phase = p;
    }
}

/// Should the handoff morph (vs. crossfade)?
fn wants_morph(settings: &Settings, system_reduced: bool) -> bool {
    let reduced = match settings.motion {
        MotionPref::Reduced => true,
        MotionPref::Full => false,
        MotionPref::System => system_reduced,
    };
    // An opaque (compatibility-mode) editor can't show the box proxy over
    // the desktop, so it always crossfades.
    settings.open_style == OpenStyle::Morph && !reduced && !settings.compatibility_mode
}

/// Returns the editor window, creating (or recreating) it when it is
/// missing or its page stopped polling the mailbox.
pub fn ensure_editor<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
) -> Result<WebviewWindow<R>, String> {
    let state = app.state::<AppState>();
    for attempt in 0..2 {
        let window = match app.get_webview_window(editor_window::LABEL) {
            Some(w) => w,
            None => {
                state.mailbox.reset();
                editor_window::create(app, settings).map_err(|e| format!("create editor: {e}"))?
            }
        };
        // A freshly created page needs a moment to boot and start polling.
        let deadline = Instant::now() + Duration::from_secs(if attempt == 0 { 6 } else { 10 });
        while Instant::now() < deadline {
            if state.mailbox.is_alive(ALIVE_GRACE) {
                return Ok(window);
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        log::line("morph: editor mailbox silent; recreating the editor window");
        let _ = window.destroy();
        // Give tauri a moment to drop the label before re-creating it.
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("the editor did not start".into())
}

fn box_hwnd<R: Runtime>(app: &AppHandle<R>) -> isize {
    app.get_webview_window(box_window::LABEL)
        .map(|w| raw::hwnd_of(&w))
        .unwrap_or(0)
}

/// The box's resting rect (physical px): its saved home, else where it is.
pub fn box_home<R: Runtime>(app: &AppHandle<R>) -> Option<Rect> {
    let state = app.state::<AppState>();
    let current = raw::rect(box_hwnd(app))?;
    let settings = state.settings();
    Some(match settings.box_position {
        Some(p) => Rect::new(p.x as f64, p.y as f64, current.w, current.h),
        None => current,
    })
}

/// Opens the editor out of the box. Blocks for the whole handoff (call it
/// from a blocking-capable thread). If the editor is already open the items
/// are added / the view switched instead.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    items: Vec<ItemInfo>,
    view: EditorView,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let morph = &state.morph;
    // Only one handoff at a time. Whoever loses the race (or arrives while
    // the editor is already open) hands its items to the editor instead.
    let busy = morph.busy.try_lock();
    if busy.is_err() || morph.phase() != Phase::Closed {
        if !items.is_empty() {
            state.mailbox.push(EditorCmd::AddItems { items });
        } else if morph.phase() == Phase::Open {
            state.mailbox.push(EditorCmd::Navigate { view });
        }
        if morph.phase() == Phase::Open
            && let Some(w) = app.get_webview_window(editor_window::LABEL)
        {
            let _ = w.set_focus();
        }
        return Ok(());
    }
    let _busy = busy;
    morph.set_phase(Phase::Opening);
    let result = open_inner(app, items, view);
    morph.set_phase(if result.is_ok() {
        Phase::Open
    } else {
        Phase::Closed
    });
    if result.is_err() {
        // Never leave the user without the box.
        let bh = box_hwnd(app);
        if !state.box_hidden_by_user() {
            raw::show_no_activate(bh);
        }
    }
    result
}

fn open_inner<R: Runtime>(
    app: &AppHandle<R>,
    items: Vec<ItemInfo>,
    view: EditorView,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let editor = ensure_editor(app, &settings)?;
    let bh = box_hwnd(app);
    let box_visible = raw::is_visible(bh);
    let box_rect = if box_visible {
        raw::rect(bh)
    } else {
        box_home(app)
    }
    .ok_or("box window missing")?;

    // Place the (hidden) editor so it contains the box and grows toward
    // the centre of the box's monitor.
    let (cx, cy) = box_rect.center();
    let mon = monitors::at_point(app, cx, cy).ok_or("no monitor")?;
    let (lw, lh) = editor_size(settings.editor_size);
    let er = geom::place_editor(box_rect, mon.work, (lw * mon.scale, lh * mon.scale));
    let _ = editor.set_position(PhysicalPosition::new(er.x as i32, er.y as i32));
    let _ = editor.set_size(PhysicalSize::new(er.w as u32, er.h as u32));
    // The move may have changed the window's DPI; re-assert the size.
    let _ = editor.set_size(PhysicalSize::new(er.w as u32, er.h as u32));
    let scale = editor.scale_factor().unwrap_or(mon.scale);
    let css = Rect::new(
        (box_rect.x - er.x) / scale,
        (box_rect.y - er.y) / scale,
        box_rect.w / scale,
        box_rect.h / scale,
    );

    let morph = &state.morph;
    let session = {
        let mut g = morph.lock();
        g.session += 1;
        g.box_was_visible = box_visible;
        let current = g.session;
        g.acks.retain(|(s, _)| *s + 4 > current);
        current
    };
    let do_morph = box_visible && wants_morph(&settings, state.system_reduced_motion());
    webview2::set_memory_low(&editor, false);
    state.mailbox.push(EditorCmd::Prepare {
        session,
        box_rect: css,
        items,
        view,
        settings: settings.clone(),
        morph: do_morph,
    });
    let prepared = morph.wait(session, AckStage::Prepared, PREPARE_TIMEOUT);

    let _ = editor.set_always_on_top(true);
    let _ = editor.set_skip_taskbar(false);
    let _ = editor.show();
    state.mailbox.push(EditorCmd::Reveal { session });
    let morphing = if prepared {
        // The proxy is on screen over the real box; swap them.
        morph.wait(session, AckStage::Revealed, REVEAL_TIMEOUT);
        do_morph
    } else {
        log::line("morph: Prepared late, falling back to crossfade");
        false
    };
    raw::hide(bh);
    crate::smoke::probe(app, "2-revealed");
    state.mailbox.push(EditorCmd::Expand {
        session,
        morph: morphing,
    });
    morph.wait(session, AckStage::Expanded, EXPAND_TIMEOUT);
    crate::smoke::probe(app, "3-expanded");
    let _ = editor.set_focus();
    let _ = editor.set_always_on_top(false);
    log::line(&format!("morph: session {session} open (morph={morphing})"));
    Ok(())
}

/// Closes the editor back into the box. `then` decides what the box does
/// afterwards; `Fly`/`Celebrate` are driven by the caller (apply flow).
pub fn close<R: Runtime>(
    app: &AppHandle<R>,
    then: CollapseThen,
    icon: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let morph = &state.morph;
    if morph.phase() != Phase::Open {
        return Ok(());
    }
    let Ok(_busy) = morph.busy.try_lock() else {
        return Ok(());
    };
    morph.set_phase(Phase::Closing);
    let result = close_inner(app, then, icon);
    morph.set_phase(Phase::Closed);
    result
}

fn close_inner<R: Runtime>(
    app: &AppHandle<R>,
    then: CollapseThen,
    icon: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let morph = &state.morph;
    let (session, box_was_visible) = {
        let g = morph.lock();
        (g.session, g.box_was_visible)
    };
    let editor = app
        .get_webview_window(editor_window::LABEL)
        .ok_or("editor window missing")?;
    let bh = box_hwnd(app);
    let eh = raw::hwnd_of(&editor);
    let er = raw::rect(eh).ok_or("editor rect")?;
    let home = box_home(app).ok_or("box window missing")?;
    let show_box = !state.box_hidden_by_user();
    // Collapse onto the box's home, or the nearest in-window spot when the
    // user moved the editor away from it.
    let at = if er.contains_rect(&home) {
        home
    } else {
        geom::clamp_into(home, er)
    };
    state.animator.jump_to((at.x as i32, at.y as i32));
    let scale = editor.scale_factor().unwrap_or(1.0);
    let css = Rect::new(
        (at.x - er.x) / scale,
        (at.y - er.y) / scale,
        at.w / scale,
        at.h / scale,
    );
    let do_morph =
        show_box && box_was_visible && wants_morph(&settings, state.system_reduced_motion());

    let _ = editor.set_always_on_top(true);
    state.mailbox.push(EditorCmd::Collapse {
        session,
        box_rect: css,
        then,
        icon: icon.clone(),
        morph: do_morph,
    });
    morph.wait(session, AckStage::Collapsed, COLLAPSE_TIMEOUT);
    if show_box {
        // The hidden box takes on the picture the editor's proxy ends on,
        // is shown under the (still topmost) editor and confirms once that
        // picture is on screen — a hidden window paints nothing, so it can
        // only confirm after being shown. Only then may the proxy go.
        let _ = app.emit_to(
            box_window::LABEL,
            "box:collapse",
            BoxCollapse {
                session,
                then,
                icon,
            },
        );
        raw::show_no_activate(bh);
        raw::set_topmost(bh, true);
        let _ = app.emit_to(box_window::LABEL, "box:shown", ());
        morph.wait_box_painted(session, BOX_PAINT_TIMEOUT);
    }
    crate::smoke::probe(app, "5-collapsed");
    state.mailbox.push(EditorCmd::Clear { session });
    morph.wait(session, AckStage::Cleared, CLEAR_TIMEOUT);
    let _ = editor.hide();
    let _ = editor.set_always_on_top(false);
    let _ = editor.set_skip_taskbar(true);
    webview2::set_memory_low(&editor, true);
    log::line(&format!("morph: session {session} closed"));

    if state.take_window_rebuild() {
        // Compatibility mode changed while the editor was open.
        crate::commands::settings::rebuild_windows(app, &settings);
    } else if settings.low_memory {
        // Free the editor's memory entirely; it is recreated on next open.
        let _ = editor.destroy();
        state.mailbox.reset();
    }
    if show_box && then == CollapseThen::Hide && (at.x != home.x || at.y != home.y) {
        state.animator.glide_to((home.x as i32, home.y as i32));
    }
    Ok(())
}

/// Hides the editor immediately without a handoff (quit / hotkey while a
/// modal is up). Used as a last resort.
pub fn force_hide<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if let Some(w) = app.get_webview_window(editor_window::LABEL) {
        let _ = w.hide();
    }
    state.morph.set_phase(Phase::Closed);
    if !state.box_hidden_by_user() {
        raw::show_no_activate(box_hwnd(app));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_wait() {
        let m = Morph::default();
        m.ack(1, AckStage::Prepared);
        assert!(m.wait(1, AckStage::Prepared, Duration::from_millis(1)));
        assert!(!m.wait(1, AckStage::Revealed, Duration::from_millis(5)));
        assert!(!m.wait(2, AckStage::Prepared, Duration::from_millis(5)));
    }

    #[test]
    fn box_painted_wait() {
        let m = std::sync::Arc::new(Morph::default());
        assert!(!m.wait_box_painted(1, Duration::from_millis(5)));
        // A confirmation from another thread wakes the waiting close.
        let other = m.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            other.box_painted(2);
        });
        assert!(m.wait_box_painted(2, Duration::from_secs(5)));
        t.join().unwrap();
        // A late confirmation for an older session changes nothing.
        m.box_painted(1);
        assert!(m.wait_box_painted(2, Duration::from_millis(1)));
        assert!(!m.wait_box_painted(3, Duration::from_millis(5)));
    }

    #[test]
    fn morph_preference() {
        let mut s = Settings::default();
        assert!(wants_morph(&s, false));
        assert!(!wants_morph(&s, true));
        s.motion = MotionPref::Full;
        assert!(wants_morph(&s, true));
        s.open_style = OpenStyle::Crossfade;
        assert!(!wants_morph(&s, false));
    }
}

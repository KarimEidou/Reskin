//! The box ⇄ editor handoff state machine.
//!
//! Invariant: a window hides only when its content is transparent, and a
//! window shows only over an identical picture. Neither window resizes
//! while visible. The editor draws a proxy of the box (same `BoxVisual`
//! component) exactly where the real box is; the proxy then morphs into
//! the panel. Both windows are translucent, so the box's picture must be
//! painted by exactly one of them at every moment: the window that shows
//! over the other paints nothing at first (the editor holds its proxy, the
//! box its picture), and the two swap in one frame — Rust sends both halves
//! at once (`Reveal` + `box:conceal` on open, `Clear` + `box:reveal` on
//! close) and each page makes its change on its next frame. See
//! docs/ARCHITECTURE.md for the message sequence.
//!
//! Every picture the box takes on for a handoff, and each half of a swap,
//! comes the same way: `box:handoff` (open), `box:conceal`, `box:collapse`
//! (close) or `box:reveal` with a box session number, confirmed with
//! `box_painted` once it is on screen.
//!
//! Outside a handoff the box follows `box_allowed`: shown unless the user
//! hid it or a fullscreen app runs (`settle_box`).

use std::collections::HashSet;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use reskin_core::geom;
use reskin_core::model::{
    AckStage, BoxCollapse, BoxHandoff, BoxSwap, CollapseThen, EditorCmd, EditorView, ItemInfo,
    MotionPref, OpenStyle, Rect, Settings, editor_size,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

pub use super::rules::Phase;
use super::rules::{AfterClose, BoxReturn};
use super::{box_window, editor_window, monitors, raw, rules, webview2};
use crate::state::AppState;
use crate::{log, tray};

/// How long the editor may take to draw the proxy before we crossfade.
pub const PREPARE_TIMEOUT: Duration = Duration::from_millis(400);
const REVEAL_TIMEOUT: Duration = Duration::from_millis(1500);
const EXPAND_TIMEOUT: Duration = Duration::from_millis(2500);
const COLLAPSE_TIMEOUT: Duration = Duration::from_millis(1800);
const CLEAR_TIMEOUT: Duration = Duration::from_millis(1000);
/// How long the box may take to show a picture it takes on, or its half of
/// a swap (up to three frames once it is visible, plus the IPC round trip).
const BOX_PAINT_TIMEOUT: Duration = Duration::from_millis(300);
/// The editor page must be polling the mailbox within this long.
const ALIVE_GRACE: Duration = Duration::from_secs(2);
/// How long a destroyed window may keep its label.
const DESTROY_WAIT: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Inner {
    session: u32,
    phase: Phase,
    acks: HashSet<(u32, AckStage)>,
    /// Latest box session: numbers every picture handed to the box
    /// (`box:handoff`, `box:collapse`), apart from the editor's `session`.
    box_session: u32,
    /// Latest box session whose picture the box confirmed on screen.
    box_painted: u32,
    /// The box was visible when this session opened (so it morphs back).
    box_was_visible: bool,
    /// Low-memory mode destroys the closed editor once its page settled the
    /// apply that closed it (`AfterClose::DestroyWhenSettled`).
    destroy_when_settled: bool,
}

#[derive(Default)]
pub struct Morph {
    inner: Mutex<Inner>,
    cv: Condvar,
    /// Held for the whole duration of an open or close handoff (and for a
    /// moment by `settle_box`): outside it the phase is `Open` or `Closed`.
    busy: Mutex<()>,
}

impl Morph {
    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    /// Records an ack from the editor page.
    pub fn ack(&self, session: u32, stage: AckStage) {
        let mut g = self.lock();
        g.acks.insert((session, stage));
        drop(g);
        self.cv.notify_all();
    }

    /// Records that the box shows the picture of box session `session`.
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

    /// Numbers a new picture for the box.
    fn next_box_session(&self) -> u32 {
        let mut g = self.lock();
        g.box_session += 1;
        g.box_session
    }

    /// Waits for the box to confirm the picture of box session `session`.
    fn wait_box_painted(&self, session: u32, timeout: Duration) -> bool {
        let painted = self.wait_until(timeout, |g| g.box_painted >= session);
        if !painted {
            log::line(&format!(
                "morph: the box did not confirm its picture {session} in time; going on"
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
        destroy_editor(app, &window);
    }
    Err("the editor did not start".into())
}

/// Destroys the editor window and forgets its page (the next open builds a
/// new one). Waits until tauri has released the label, so that the next
/// open does not find the dying window.
pub(crate) fn destroy_editor<R: Runtime>(app: &AppHandle<R>, editor: &WebviewWindow<R>) {
    let _ = editor.destroy();
    let deadline = Instant::now() + DESTROY_WAIT;
    while app.get_webview_window(editor_window::LABEL).is_some() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    app.state::<AppState>().mailbox.reset();
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

/// The box may be on screen outside a handoff (see `rules::box_allowed`).
pub fn box_allowed(state: &AppState) -> bool {
    rules::box_allowed(state.box_hidden_by_user(), state.hidden_for_fullscreen())
}

/// Shows the box (on top of the topmost band, with `box:shown`) when it is
/// allowed, else hides it. The caller makes sure no handoff runs. True when
/// its visibility changed.
fn rest_box<R: Runtime>(app: &AppHandle<R>) -> bool {
    let h = box_hwnd(app);
    if h == 0 {
        return false;
    }
    match rules::rest_change(box_allowed(&app.state::<AppState>()), raw::is_visible(h)) {
        Some(true) => {
            raw::show_no_activate(h);
            raw::set_topmost(h, true);
            let _ = app.emit_to(box_window::LABEL, "box:shown", ());
            true
        }
        Some(false) => {
            raw::hide(h);
            true
        }
        None => false,
    }
}

/// Brings the box at rest in line with `box_allowed` (after the user showed
/// or hid it, or a fullscreen app came or went). While a handoff runs or the
/// editor is open this does nothing: the box belongs to the handoff, and the
/// close asks `box_allowed` itself.
pub fn settle_box<R: Runtime>(app: &AppHandle<R>) {
    let morph = &app.state::<AppState>().morph;
    // Never waits for a handoff (the main thread calls this too).
    if morph.phase() != Phase::Closed {
        return;
    }
    let Ok(_busy) = morph.busy.try_lock() else {
        return;
    };
    if morph.phase() == Phase::Closed && rest_box(app) {
        tray::refresh(app);
    }
}

/// Shows the editor window on top of the topmost band, with a taskbar
/// button.
fn show_editor<R: Runtime>(editor: &WebviewWindow<R>) {
    let _ = editor.set_always_on_top(true);
    let _ = editor.set_skip_taskbar(false);
    let _ = editor.show();
}

/// Puts the editor window at rest: hidden, not topmost, without a taskbar
/// button, its WebView2 memory target low.
fn rest_editor<R: Runtime>(editor: &WebviewWindow<R>) {
    let _ = editor.hide();
    let _ = editor.set_always_on_top(false);
    let _ = editor.set_skip_taskbar(true);
    webview2::set_memory_low(editor, true);
}

/// Opens the editor out of the box. Blocks for the whole handoff (call it
/// from a blocking-capable thread). A handoff in progress is waited for
/// first; if the editor is open then, the items are added / the view
/// switched instead.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    items: Vec<ItemInfo>,
    view: EditorView,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let morph = &state.morph;
    // Only one handoff at a time; with `busy` held the editor is either
    // open or closed.
    let _busy = morph.busy.lock().unwrap_or_else(|e| e.into_inner());
    if rules::hands_over(morph.phase()) {
        hand_over(app, items, view);
        return Ok(());
    }
    morph.set_phase(Phase::Opening);
    // The editor is needed again: a destroy still waiting for it is off.
    morph.lock().destroy_when_settled = false;
    let result = open_inner(app, items, view);
    if result.is_ok() {
        morph.set_phase(Phase::Open);
    } else {
        // Never leave the user without the box: back to the closed state
        // (every failure comes before the editor shows).
        if let Some(editor) = app.get_webview_window(editor_window::LABEL) {
            rest_editor(&editor);
        }
        morph.set_phase(Phase::Closed);
        rest_box(app);
    }
    tray::refresh(app);
    result
}

/// An open for the open editor (the caller holds `busy`, so no close can
/// start meanwhile): its items join the queue, or it switches to `view`.
fn hand_over<R: Runtime>(app: &AppHandle<R>, items: Vec<ItemInfo>, view: EditorView) {
    let state = app.state::<AppState>();
    if items.is_empty() {
        state.mailbox.push(EditorCmd::Navigate { view });
    } else {
        state.mailbox.push(EditorCmd::AddItems { items });
    }
    if let Some(w) = app.get_webview_window(editor_window::LABEL) {
        let _ = w.set_focus();
    }
}

/// Hands the (visible) box the picture the editor's proxy draws over it:
/// the first item's icon and the item count (`handoffProps` in the editor).
/// An open the box asked for finds it on that picture already; any other
/// (tray, menu, Explorer, first run) changes it here, before the editor
/// shows, so the swap stays invisible. Returns the box session.
fn hand_picture<R: Runtime>(app: &AppHandle<R>, items: &[ItemInfo]) -> u32 {
    let session = app.state::<AppState>().morph.next_box_session();
    let _ = app.emit_to(
        box_window::LABEL,
        "box:handoff",
        BoxHandoff {
            session,
            icon: items.first().and_then(|i| i.icon.clone()),
            count: items.len() as u32,
        },
    );
    session
}

/// Sends the box its half of a swap with the editor's proxy (`box:conceal`
/// or `box:reveal`, see `BoxSwap`), right after the editor's half. Returns
/// the box session its confirmation carries.
fn swap_box<R: Runtime>(app: &AppHandle<R>, event: &str) -> u32 {
    let session = app.state::<AppState>().morph.next_box_session();
    let _ = app.emit_to(box_window::LABEL, event, BoxSwap { session });
    session
}

fn open_inner<R: Runtime>(
    app: &AppHandle<R>,
    items: Vec<ItemInfo>,
    view: EditorView,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = crate::smoke::handoff_settings(&state.smoke, state.settings());
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
    // The box takes on the proxy's picture while the editor draws it.
    let picture = box_visible.then(|| {
        (
            hand_picture(app, &items),
            Instant::now() + BOX_PAINT_TIMEOUT,
        )
    });
    webview2::set_memory_low(&editor, false);
    // Over the box, the editor paints nothing until the swap (its proxy
    // is held); see `rules::shows_while_preparing`.
    let show_early = rules::shows_while_preparing(settings.compatibility_mode);
    if show_early {
        show_editor(&editor);
    }
    state.mailbox.push(EditorCmd::Prepare {
        session,
        // A hidden box leaves nothing to morph from: the panel fades in.
        box_rect: box_visible.then_some(css),
        items,
        view,
        settings: settings.clone(),
        morph: do_morph,
    });
    let prepared = morph.wait(session, AckStage::Prepared, PREPARE_TIMEOUT);
    if let Some((box_session, by)) = picture {
        morph.wait_box_painted(box_session, by.saturating_duration_since(Instant::now()));
    }
    if !show_early {
        show_editor(&editor);
    }

    // The swap: the editor paints its proxy over the box and the box stops
    // painting, each on its next frame — exactly one of them paints the
    // picture at every moment.
    state.mailbox.push(EditorCmd::Reveal { session });
    let concealed = box_visible.then(|| {
        (
            swap_box(app, "box:conceal"),
            Instant::now() + BOX_PAINT_TIMEOUT,
        )
    });
    let morphing = if prepared {
        morph.wait(session, AckStage::Revealed, REVEAL_TIMEOUT);
        do_morph
    } else {
        log::line("morph: Prepared late, falling back to crossfade");
        false
    };
    // The box hides only once it paints nothing — also when the editor was
    // late: shown again for a close, it may show its last frame until it
    // paints anew.
    if let Some((box_session, by)) = concealed {
        morph.wait_box_painted(box_session, by.saturating_duration_since(Instant::now()));
    }
    crate::smoke::probe(app, "1-swapped");
    raw::hide(bh);
    crate::smoke::probe(app, "2-revealed");
    crate::smoke::handoff_taken(app, crate::smoke::Handoff::Open, morphing);
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
/// afterwards; `Fly`/`Celebrate` are driven by the caller (apply flow). A
/// handoff that fails still ends in the closed state (`rest_closed`).
pub fn close<R: Runtime>(
    app: &AppHandle<R>,
    then: CollapseThen,
    icon: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let morph = &state.morph;
    // A handoff in progress is waited for (an open finishing, or another
    // close); with `busy` held the editor is either open or closed.
    let _busy = morph.busy.lock().unwrap_or_else(|e| e.into_inner());
    if morph.phase() != Phase::Open {
        return Ok(());
    }
    morph.set_phase(Phase::Closing);
    let result = close_inner(app, then, icon);
    if result.is_err() {
        rest_closed(app, then);
    }
    morph.set_phase(Phase::Closed);
    result
}

fn close_inner<R: Runtime>(
    app: &AppHandle<R>,
    then: CollapseThen,
    icon: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = crate::smoke::handoff_settings(&state.smoke, state.settings());
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
    let show_box = box_allowed(&state);
    // Collapse onto the box's home, or the nearest in-window spot when the
    // user moved the editor away from it. A box that stays hidden is not
    // moved (without a saved home, where it is is its home).
    let at = if er.contains_rect(&home) {
        home
    } else {
        geom::clamp_into(home, er)
    };
    if show_box {
        state.animator.jump_to((at.x as i32, at.y as i32));
    }
    let scale = editor.scale_factor().unwrap_or(1.0);
    let css = Rect::new(
        (at.x - er.x) / scale,
        (at.y - er.y) / scale,
        at.w / scale,
        at.h / scale,
    );
    let do_morph =
        show_box && box_was_visible && wants_morph(&settings, state.system_reduced_motion());
    crate::smoke::handoff_taken(app, crate::smoke::Handoff::Close, do_morph);

    let _ = editor.set_always_on_top(true);
    state.mailbox.push(EditorCmd::Collapse {
        session,
        box_rect: css,
        then,
        icon: icon.clone(),
        morph: do_morph,
    });
    morph.wait(session, AckStage::Collapsed, COLLAPSE_TIMEOUT);
    let back = rules::box_return(show_box, do_morph);
    if back != BoxReturn::Hidden {
        // The hidden box takes on the picture the editor ends on — under
        // the proxy held, painting nothing until the swap — is shown right
        // under the (still topmost) editor, and confirms once its frame is
        // on screen: a hidden window paints nothing, so it can only confirm
        // after being shown. Until then it shows its last frame, which is
        // empty under the proxy: the open's swap left it painting nothing.
        let box_session = morph.next_box_session();
        let _ = app.emit_to(
            box_window::LABEL,
            "box:collapse",
            BoxCollapse {
                session: box_session,
                then,
                icon,
                held: back == BoxReturn::Held,
            },
        );
        raw::show_below(bh, eh);
        let _ = app.emit_to(box_window::LABEL, "box:shown", ());
        morph.wait_box_painted(box_session, BOX_PAINT_TIMEOUT);
    }
    crate::smoke::probe(app, "5-collapsed");
    // The swap: the editor stops painting its proxy and the box paints the
    // picture it holds, each on its next frame. (After a fade out the
    // editor paints nothing any more, and the box paints already.)
    state.mailbox.push(EditorCmd::Clear { session });
    let revealed = (back == BoxReturn::Held).then(|| {
        (
            swap_box(app, "box:reveal"),
            Instant::now() + BOX_PAINT_TIMEOUT,
        )
    });
    morph.wait(session, AckStage::Cleared, CLEAR_TIMEOUT);
    if let Some((box_session, by)) = revealed {
        morph.wait_box_painted(box_session, by.saturating_duration_since(Instant::now()));
    }
    crate::smoke::probe(app, "6-cleared");
    let _ = editor.hide();
    if show_box {
        // Back on top of the topmost band, where it lives.
        raw::set_topmost(bh, true);
    }
    finish_close(app, &editor, &settings, then);
    tray::refresh(app);
    log::line(&format!(
        "morph: session {session} closed (morph={do_morph})"
    ));
    if show_box && then == CollapseThen::Hide && (at.x != home.x || at.y != home.y) {
        state.animator.glide_to((home.x as i32, home.y as i32));
    }
    Ok(())
}

/// The editor is closed (`then`): at rest (see `rest_editor`), then rebuilt
/// with the box when compatibility mode changed meanwhile, or destroyed in
/// low-memory mode — after an apply's close only once its page settled the
/// apply (`rules::after_close`, `apply_settled`).
fn finish_close<R: Runtime>(
    app: &AppHandle<R>,
    editor: &WebviewWindow<R>,
    settings: &Settings,
    then: CollapseThen,
) {
    rest_editor(editor);
    let state = app.state::<AppState>();
    match rules::after_close(then, settings.low_memory, state.take_window_rebuild()) {
        AfterClose::Keep => {}
        AfterClose::Rebuild => crate::commands::settings::rebuild_windows(app, settings),
        // Free the editor's memory entirely; it is recreated on next open.
        AfterClose::Destroy => destroy_editor(app, editor),
        AfterClose::DestroyWhenSettled => state.morph.lock().destroy_when_settled = true,
    }
}

/// The editor page settled the apply that closed it (`editor_close
/// ('applied')`): its outcome is handled and the design's autosave settled.
/// A low-memory destroy that waited for it (`AfterClose::DestroyWhenSettled`)
/// happens now — unless the editor opened again meanwhile.
pub fn apply_settled<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let morph = &state.morph;
    let _busy = morph.busy.lock().unwrap_or_else(|e| e.into_inner());
    let due = std::mem::take(&mut morph.lock().destroy_when_settled);
    if due
        && morph.phase() == Phase::Closed
        && state.settings().low_memory
        && let Some(editor) = app.get_webview_window(editor_window::LABEL)
    {
        destroy_editor(app, &editor);
    }
}

/// A close handoff failed (a window went missing): puts both windows in the
/// closed state without it — the editor as after any close
/// (`finish_close`), the box resting on the empty picture, shown when it is
/// allowed. The caller holds `busy`.
fn rest_closed<R: Runtime>(app: &AppHandle<R>, then: CollapseThen) {
    let state = app.state::<AppState>();
    let morph = &state.morph;
    if let Some(editor) = app.get_webview_window(editor_window::LABEL) {
        finish_close(app, &editor, &state.settings(), then);
    }
    let bh = box_hwnd(app);
    if box_allowed(&state) {
        let _ = app.emit_to(
            box_window::LABEL,
            "box:collapse",
            BoxCollapse {
                session: morph.next_box_session(),
                then: CollapseThen::Hide,
                icon: None,
                held: false,
            },
        );
        raw::show_no_activate(bh);
        raw::set_topmost(bh, true);
        let _ = app.emit_to(box_window::LABEL, "box:shown", ());
    } else {
        raw::hide(bh);
    }
    tray::refresh(app);
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
    fn every_box_picture_gets_its_own_session() {
        let m = Morph::default();
        // The open's picture and the close's picture of one editor session
        // are numbered apart, so the open's confirmation (even a late one)
        // never stands for the close's.
        let open = m.next_box_session();
        m.box_painted(open);
        let close = m.next_box_session();
        assert!(close > open);
        assert!(!m.wait_box_painted(close, Duration::from_millis(5)));
        m.box_painted(close);
        assert!(m.wait_box_painted(close, Duration::from_millis(1)));
        // Nor does the held picture's confirmation stand for the swap that
        // reveals it: the box confirms its half of the swap on its own.
        let reveal = m.next_box_session();
        assert!(!m.wait_box_painted(reveal, Duration::from_millis(5)));
        m.box_painted(reveal);
        assert!(m.wait_box_painted(reveal, Duration::from_millis(1)));
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

    #[test]
    fn the_smoke_test_forces_either_path() {
        use crate::smoke::HandoffPath;
        // The CI runner: Windows reports reduced motion.
        let user = Settings::default();
        assert!(!wants_morph(&user, true));
        assert!(wants_morph(&HandoffPath::Morph.apply(user.clone()), true));
        assert!(!wants_morph(&HandoffPath::Crossfade.apply(user), false));
    }
}

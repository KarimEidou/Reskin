//! `--smoke-test`: proves the packaged app works on a real Windows machine.
//!
//! 1. Both pages boot and call `smoke_ready` (else exit 2 after 30 s).
//! 2. The memory of the whole process tree is logged, idle (`memory.rs`):
//!    private bytes over `PRIVATE_HARD_CEILING` fail the run, over
//!    `PRIVATE_SOFT_BUDGET` they are a warning.
//! 3. With `--capture-handoff`: open the editor out of the box and close it
//!    again while sampling the screen under the box — twice, forcing each
//!    handoff path in turn (`HandoffPath`): the morph first (Windows on the
//!    CI runner reports reduced motion, which alone only ever runs the
//!    crossfade), then the crossfade. Each round trip must take the path
//!    it forced, and the box region must never look like the bare desktop
//!    during it (a window hid before an identical picture covered it), and
//!    look like the box wherever the box's picture shows — painted once:
//!    the box and the editor's proxy both painted, one over the other,
//!    look darker (`HANDOFF_FRAMES`). All-black captures are inconclusive:
//!    only the paths are checked then.
//! 4. A real open → export → apply → restore cycle on a temp `.lnk`
//!    fixture, driven through the editor page (`EditorCmd::SmokeCycle`),
//!    verified independently here.
//! 5. The memory again, with the editor hidden (its WebView2 memory target
//!    low) after those round trips; same budgets.
//!
//! Exit codes: 0 pass, 2 timeout, 3 handoff/cycle/memory failure.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reskin_core::model::{
    CollapseThen, EditorCmd, EditorView, EntryState, MotionPref, OpenStyle, Rect, Settings,
    SmokeReport, WindowKind,
};
use reskin_core::pixels::Rgba;
use tauri::{AppHandle, Manager, Runtime};

use crate::memory::{self, Verdict};
use crate::state::AppState;
use crate::windows::{box_window, morph, raw};
use crate::{capture, items, log};

pub const TIMEOUT: Duration = Duration::from_secs(90);
pub const EXIT_TIMEOUT: i32 = 2;
pub const EXIT_FAILED: i32 = 3;
/// Pages must report within this long.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Both pages booted, the editor hidden with a low memory target: WebView2
/// settles this long before the idle memory is taken.
const IDLE_SETTLE: Duration = Duration::from_millis(2500);
/// The editor was just hidden again: time for WebView2 to act on the low
/// memory target before the memory is taken again.
const HIDDEN_SETTLE: Duration = Duration::from_millis(2000);
/// Max mean colour difference for "the same picture".
const SAME: f64 = 14.0;
/// Min mean colour difference between the box and the bare desktop.
const DISTINCT: f64 = 4.0;
/// Every probe of one open → close round trip, in order (`probe` calls in
/// windows/morph.rs, then after the close), and whether it must show the
/// box's picture — the box or the editor's identical proxy, painted once:
/// both painted over each other (doubled translucency) differ from it —
/// rather than the panel. A missing probe fails the run rather than
/// passing on fewer frames.
///
/// * `1-swapped`: the open's swap confirmed by both pages (the proxy
///   painted, the box painting nothing), the box not hidden yet.
/// * `2-revealed`: the box hidden.
/// * `3-expanded`: the panel.
/// * `5-collapsed`: the box shown under the proxy it holds the picture of
///   (after a fade out: the box alone), before the swap.
/// * `6-cleared`: the close's swap confirmed by both pages (the box
///   painted, the editor painting nothing), the editor not hidden yet.
/// * `9-after-close`: the editor hidden.
const HANDOFF_FRAMES: [(&str, bool); 6] = [
    ("1-swapped", true),
    ("2-revealed", true),
    ("3-expanded", false),
    ("5-collapsed", true),
    ("6-cleared", true),
    ("9-after-close", true),
];

/// A handoff path the smoke test forces for one captured round trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffPath {
    Morph,
    Crossfade,
}

impl HandoffPath {
    /// The settings a handoff on this path runs with. Rust decides on the
    /// morph from the open style and motion (`wants_morph`), the editor from
    /// the motion of the settings `Prepare` carries: a forced morph asks for
    /// full motion, whatever Windows or the user prefer.
    pub fn apply(self, mut settings: Settings) -> Settings {
        match self {
            Self::Morph => {
                settings.open_style = OpenStyle::Morph;
                settings.motion = MotionPref::Full;
            }
            Self::Crossfade => settings.open_style = OpenStyle::Crossfade,
        }
        settings
    }

    fn is_morph(self) -> bool {
        self == Self::Morph
    }
}

impl std::fmt::Display for HandoffPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.is_morph() {
            "morph"
        } else {
            "crossfade"
        })
    }
}

/// The two halves of a round trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handoff {
    Open,
    Close,
}

pub struct Smoke {
    pub enabled: bool,
    pub capture_handoff: bool,
    ready: Mutex<HashSet<WindowKind>>,
    cycle: Mutex<Option<String>>,
    frames: Mutex<Vec<(String, Rgba)>>,
    region: Mutex<Option<Rect>>,
    /// The path the running capture forces (`handoff_settings`).
    forced: Mutex<Option<HandoffPath>>,
    /// Whether each handoff of the running capture morphed (`handoff_taken`).
    taken: Mutex<Vec<(Handoff, bool)>>,
}

impl Smoke {
    pub fn new(enabled: bool, capture_handoff: bool) -> Self {
        Self {
            enabled,
            capture_handoff,
            ready: Mutex::new(HashSet::new()),
            cycle: Mutex::new(None),
            frames: Mutex::new(Vec::new()),
            region: Mutex::new(None),
            forced: Mutex::new(None),
            taken: Mutex::new(Vec::new()),
        }
    }

    /// Records a ready page; true when this call made both pages ready.
    fn mark(&self, kind: WindowKind) -> bool {
        let mut r = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let before = r.len();
        r.insert(kind);
        r.len() == 2 && before == 1
    }

    fn force(&self, path: Option<HandoffPath>) {
        *self.forced.lock().unwrap_or_else(|e| e.into_inner()) = path;
    }
}

/// The settings a handoff runs with (windows/morph.rs): the user's, or the
/// path a capture forces (`HandoffPath::apply`). Only a smoke test forces
/// one; everywhere else these are the user's settings.
pub fn handoff_settings(smoke: &Smoke, settings: Settings) -> Settings {
    match *smoke.forced.lock().unwrap_or_else(|e| e.into_inner()) {
        Some(path) => path.apply(settings),
        None => settings,
    }
}

/// Records whether a handoff morphed (windows/morph.rs; no-op unless smoke
/// testing).
pub fn handoff_taken<R: Runtime>(app: &AppHandle<R>, handoff: Handoff, morph: bool) {
    let state = app.state::<AppState>();
    if state.smoke.enabled {
        state
            .smoke
            .taken
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((handoff, morph));
    }
}

/// Fails the run if nothing finishes in time.
pub fn start_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(TIMEOUT);
        log::line("smoke: TIMEOUT");
        std::process::exit(EXIT_TIMEOUT);
    });
    std::thread::spawn(|| {
        std::thread::sleep(READY_TIMEOUT);
        // Both pages must have booted by now (the scenarios have their own
        // deadlines under the overall TIMEOUT).
        if !READY.load(std::sync::atomic::Ordering::SeqCst) {
            log::line("smoke: TIMEOUT waiting for both pages");
            std::process::exit(EXIT_TIMEOUT);
        }
    });
}

static READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn on_ready<R: Runtime>(app: &AppHandle<R>, smoke: &Smoke, report: SmokeReport) {
    log::line(&format!(
        "smoke: {:?} reported: {}",
        report.window, report.detail
    ));
    if report.window == WindowKind::Editor && report.detail.starts_with("cycle:") {
        *smoke.cycle.lock().unwrap_or_else(|e| e.into_inner()) = Some(report.detail);
        return;
    }
    if smoke.mark(report.window) {
        READY.store(true, std::sync::atomic::Ordering::SeqCst);
        log::line("smoke: both pages ready");
        let app = app.clone();
        std::thread::spawn(move || {
            let t = Instant::now();
            let code = run_scenarios(&app);
            log::line(&format!(
                "smoke: finished with exit code {code} after {:.1} s",
                t.elapsed().as_secs_f64()
            ));
            crate::exit_with(&app, code);
        });
    }
}

/// Called by the morph FSM at interesting moments (no-op unless capturing).
pub fn probe<R: Runtime>(app: &AppHandle<R>, name: &str) {
    let state = app.state::<AppState>();
    if !(state.smoke.enabled && state.smoke.capture_handoff) {
        return;
    }
    let Some(region) = *state.smoke.region.lock().unwrap_or_else(|e| e.into_inner()) else {
        return;
    };
    settle();
    if let Some(img) = capture::screen(region) {
        state
            .smoke
            .frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((name.to_string(), img));
    }
}

/// Lets two or three composition frames pass so the screen reflects the
/// latest window state.
fn settle() {
    for _ in 0..3 {
        if unsafe { windows::Win32::Graphics::Dwm::DwmFlush() }.is_err() {
            std::thread::sleep(Duration::from_millis(16));
        }
    }
}

fn run_scenarios<R: Runtime>(app: &AppHandle<R>) -> i32 {
    let state = app.state::<AppState>();
    std::thread::sleep(IDLE_SETTLE);
    let mut ok = memory_within_ceiling("idle");
    if state.smoke.capture_handoff {
        for path in [HandoffPath::Morph, HandoffPath::Crossfade] {
            match handoff(app, path) {
                Ok(msg) => log::line(&format!("smoke: handoff ({path}) {msg}")),
                Err(e) => {
                    log::line(&format!("smoke: handoff ({path}) FAILED: {e}"));
                    return EXIT_FAILED;
                }
            }
        }
    }
    match cycle(app) {
        Ok(()) => log::line("smoke: apply/restore cycle PASS"),
        Err(e) => {
            log::line(&format!("smoke: apply/restore cycle FAILED: {e}"));
            ok = false;
        }
    }
    // A cycle that failed half-way may have left the editor open.
    let _ = morph::close(app, CollapseThen::Hide, None);
    std::thread::sleep(HIDDEN_SETTLE);
    ok &= memory_within_ceiling("after the handoffs, editor hidden");
    if ok { 0 } else { EXIT_FAILED }
}

/// Logs the memory of the process tree; false when its private bytes are
/// over the hard ceiling (over the soft budget is only a warning).
fn memory_within_ceiling(moment: &str) -> bool {
    let report = memory::measure();
    log::line(&format!("smoke: memory {moment}: {report}"));
    let mb = |bytes: u64| bytes / (1024 * 1024);
    match report.verdict() {
        Verdict::Ok => true,
        Verdict::OverBudget => {
            log::line(&format!(
                "smoke: WARNING: private bytes {moment} over the {} MB budget",
                mb(memory::PRIVATE_SOFT_BUDGET)
            ));
            true
        }
        Verdict::OverCeiling => {
            log::line(&format!(
                "smoke: memory {moment} FAILED: private bytes over the {} MB ceiling",
                mb(memory::PRIVATE_HARD_CEILING)
            ));
            false
        }
    }
}

fn save(path: HandoffPath, name: &str, img: &Rgba) {
    let file = std::env::temp_dir().join(format!("reskin-handoff-{path}-{name}.png"));
    let _ = std::fs::write(file, img.encode_png());
}

/// One captured round trip on the forced `path` (the user's settings stay
/// as they are).
fn handoff<R: Runtime>(app: &AppHandle<R>, path: HandoffPath) -> Result<String, String> {
    let smoke = &app.state::<AppState>().smoke;
    smoke.force(Some(path));
    let result = capture_round_trip(app, path);
    smoke.force(None);
    result
}

fn capture_round_trip<R: Runtime>(app: &AppHandle<R>, path: HandoffPath) -> Result<String, String> {
    let smoke = &app.state::<AppState>().smoke;
    let bh = app
        .get_webview_window(box_window::LABEL)
        .map(|w| raw::hwnd_of(&w))
        .ok_or("no box window")?;
    let region = raw::rect(bh).ok_or("no box rect")?;
    // Reference frames: the idle box, and the bare desktop under it.
    settle();
    let with_box = capture::screen(region).ok_or("capture failed")?;
    raw::hide(bh);
    settle();
    let bare = capture::screen(region).ok_or("capture failed")?;
    raw::show_no_activate(bh);
    settle();
    save(path, "0-box", &with_box);
    save(path, "0-bare", &bare);
    // Frames say something only when the box stands out from the desktop.
    let inconclusive = if capture::is_black(&with_box) {
        Some("black capture".to_string())
    } else {
        let distinct = capture::diff(&with_box, &bare);
        (distinct < DISTINCT).then(|| format!("box indistinguishable from desktop: {distinct:.1}"))
    };
    *smoke.region.lock().unwrap_or_else(|e| e.into_inner()) =
        inconclusive.is_none().then_some(region);
    smoke
        .frames
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    smoke
        .taken
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();

    let t = Instant::now();
    let round_trip = morph::open(app, vec![], EditorView::Start).and_then(|()| {
        std::thread::sleep(Duration::from_millis(300));
        morph::close(app, CollapseThen::Hide, None)
    });
    probe(app, "9-after-close");
    *smoke.region.lock().unwrap_or_else(|e| e.into_inner()) = None;
    round_trip?;
    log::line(&format!(
        "smoke: handoff ({path}) round trip took {:?}",
        t.elapsed()
    ));

    let taken = std::mem::take(&mut *smoke.taken.lock().unwrap_or_else(|e| e.into_inner()));
    let paths = check_paths(path, &taken)?;
    if let Some(why) = inconclusive {
        return Ok(format!("{paths}; frames inconclusive ({why})"));
    }
    let frames = std::mem::take(&mut *smoke.frames.lock().unwrap_or_else(|e| e.into_inner()));
    for (name, img) in &frames {
        save(path, name, img);
    }
    Ok(format!(
        "{paths}; {}",
        judge_frames(&frames, &with_box, &bare)?
    ))
}

/// Both handoffs of a round trip took the forced path.
fn check_paths(path: HandoffPath, taken: &[(Handoff, bool)]) -> Result<String, String> {
    let morphed = |h: Handoff| taken.iter().find(|(t, _)| *t == h).map(|(_, m)| *m);
    for handoff in [Handoff::Open, Handoff::Close] {
        match morphed(handoff) {
            None => return Err(format!("no {handoff:?} handoff was recorded")),
            Some(m) if m != path.is_morph() => {
                return Err(format!(
                    "the {handoff:?} handoff {} although the {path} was forced",
                    if m { "morphed" } else { "crossfaded" }
                ));
            }
            Some(_) => {}
        }
    }
    Ok(format!("open and close took the {path}"))
}

/// The handoff invariant on the captured frames: never the bare desktop,
/// and the box's picture, painted once, wherever it should show.
fn judge_frames(frames: &[(String, Rgba)], with_box: &Rgba, bare: &Rgba) -> Result<String, String> {
    let captured: Vec<&str> = frames.iter().map(|(name, _)| name.as_str()).collect();
    let expected: Vec<&str> = HANDOFF_FRAMES.iter().map(|(name, _)| *name).collect();
    if captured != expected {
        return Err(format!(
            "captured frames {captured:?}, expected {expected:?}"
        ));
    }
    let distinct = capture::diff(with_box, bare);
    let mut report = Vec::new();
    for ((name, img), (_, box_picture)) in frames.iter().zip(HANDOFF_FRAMES) {
        let to_bare = capture::diff(img, bare);
        let to_box = capture::diff(img, with_box);
        report.push(format!("{name}: Δbare={to_bare:.1} Δbox={to_box:.1}"));
        if to_bare < DISTINCT.min(distinct / 2.0) {
            return Err(format!("empty frame at {name} ({})", report.join("; ")));
        }
        if box_picture && to_box > SAME {
            return Err(format!(
                "frame {name} differs from the box ({})",
                report.join("; ")
            ));
        }
    }
    Ok(format!(
        "frames ok ({} frames: {})",
        frames.len(),
        report.join("; ")
    ))
}

/// Temp fixture shortcut for the apply/restore cycle.
fn fixture() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("reskin-smoke");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lnk = dir.join("Reskin Smoke Fixture.lnk");
    let windir = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let target = PathBuf::from(windir).join("System32").join("notepad.exe");
    let state_lnk = lnk.clone();
    reskin_core::win::shortcut::create_link(&state_lnk, &target, "", None, "Reskin smoke test")
        .map_err(|e| e.to_string())?;
    Ok(lnk)
}

fn cycle<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let lnk = {
        let sta = &state.sta;
        sta.run(fixture).map_err(|e| e.to_string())??
    };
    let infos = items::inspect_blocking(app, std::slice::from_ref(&lnk));
    let item = infos
        .first()
        .ok_or("fixture could not be inspected")?
        .clone();
    if item.icon.is_none() {
        return Err("fixture has no icon preview".into());
    }
    let target = lnk.display().to_string();
    // The journal outlives runs (the fixture path is the same every time):
    // only the entries this cycle adds count.
    let earlier: HashSet<String> = state
        .journal()
        .entries_for(&target)
        .iter()
        .map(|e| e.id.clone())
        .collect();
    morph::open(app, vec![item.clone()], EditorView::Edit)?;
    *state.smoke.cycle.lock().unwrap_or_else(|e| e.into_inner()) = None;
    state.mailbox.push(EditorCmd::SmokeCycle {
        item: item.id.clone(),
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let outcome = loop {
        if let Some(o) = state
            .smoke
            .cycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            break o;
        }
        if Instant::now() > deadline {
            return Err("editor never reported the cycle".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = morph::close(app, CollapseThen::Hide, None);
    if outcome != "cycle:ok" {
        return Err(outcome);
    }
    // Independent verification: the fixture's icon is back to the original
    // (no custom icon) and the journal recorded apply + restore.
    let path = lnk.clone();
    let link = state
        .sta
        .run(move || reskin_core::win::shortcut::read_link(&path))
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if link.icon_location.as_deref().is_some_and(|l| !l.is_empty()) {
        return Err(format!(
            "fixture icon was not restored: {:?}",
            link.icon_location
        ));
    }
    let journal = state.journal();
    let added: Vec<_> = journal
        .entries_for(&target)
        .into_iter()
        .filter(|e| !earlier.contains(&e.id))
        .collect();
    if added.is_empty() || added.iter().any(|e| e.state != EntryState::Restored) {
        return Err(format!(
            "the cycle's journal entries for the fixture are not all restored: {:?}",
            added.iter().map(|e| e.state).collect::<Vec<_>>()
        ));
    }
    if journal.active_for(&target).is_some() {
        return Err("journal still has an active entry for the fixture".into());
    }
    let _ = std::fs::remove_dir_all(lnk.parent().unwrap_or(&lnk));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(rgb: [u8; 3]) -> Rgba {
        let data = std::iter::repeat_n([rgb[0], rgb[1], rgb[2], 255], 16)
            .flatten()
            .collect();
        Rgba::from_raw(4, 4, data).unwrap()
    }

    #[test]
    fn a_forced_path_changes_only_how_the_handoff_runs() {
        let user = Settings {
            motion: MotionPref::Reduced,
            open_style: OpenStyle::Crossfade,
            ..Settings::default()
        };
        let morph = HandoffPath::Morph.apply(user.clone());
        assert_eq!(morph.open_style, OpenStyle::Morph);
        assert_eq!(morph.motion, MotionPref::Full);
        assert_eq!(
            Settings {
                open_style: user.open_style,
                motion: user.motion,
                ..morph
            },
            user
        );
        let fade = HandoffPath::Crossfade.apply(Settings::default());
        assert_eq!(fade.open_style, OpenStyle::Crossfade);
        assert_eq!(fade.motion, MotionPref::System);
    }

    #[test]
    fn only_a_running_capture_forces_a_path() {
        let smoke = Smoke::new(true, true);
        let user = Settings {
            motion: MotionPref::Reduced,
            ..Settings::default()
        };
        assert_eq!(handoff_settings(&smoke, user.clone()), user);
        smoke.force(Some(HandoffPath::Morph));
        assert_eq!(
            handoff_settings(&smoke, user.clone()).motion,
            MotionPref::Full
        );
        smoke.force(None);
        assert_eq!(handoff_settings(&smoke, user.clone()), user);
    }

    #[test]
    fn a_round_trip_must_take_the_forced_path() {
        let both = |m| [(Handoff::Open, m), (Handoff::Close, m)];
        assert!(check_paths(HandoffPath::Morph, &both(true)).is_ok());
        assert!(check_paths(HandoffPath::Crossfade, &both(false)).is_ok());
        let err = check_paths(
            HandoffPath::Morph,
            &[(Handoff::Open, false), (Handoff::Close, true)],
        )
        .unwrap_err();
        assert!(err.contains("the Open handoff crossfaded"), "{err}");
        let err = check_paths(HandoffPath::Crossfade, &both(true)).unwrap_err();
        assert!(err.contains("the Open handoff morphed"), "{err}");
        let err = check_paths(HandoffPath::Morph, &[(Handoff::Open, true)]).unwrap_err();
        assert!(err.contains("no Close handoff"), "{err}");
    }

    #[test]
    fn frames_keep_the_handoff_invariant() {
        let boxed = solid([90, 70, 200]);
        let bare = solid([20, 40, 60]);
        let panel = solid([200, 200, 210]);
        // The box's translucent picture painted twice, one over the other:
        // darker than the box, still far from the desktop.
        let doubled = solid([70, 60, 160]);
        let frames = |pictures: [&Rgba; 6]| -> Vec<(String, Rgba)> {
            HANDOFF_FRAMES
                .iter()
                .zip(pictures)
                .map(|((name, _), img)| (name.to_string(), img.clone()))
                .collect()
        };
        let fine = [&boxed, &boxed, &panel, &boxed, &boxed, &boxed];
        assert!(judge_frames(&frames(fine), &boxed, &bare).is_ok());
        // The desktop showed through: a window hid too early.
        let mut empty = fine;
        empty[2] = &bare;
        let err = judge_frames(&frames(empty), &boxed, &bare).unwrap_err();
        assert!(err.starts_with("empty frame at 3-expanded"), "{err}");
        // Another picture where the box should be.
        let mut other = fine;
        other[1] = &panel;
        let err = judge_frames(&frames(other), &boxed, &bare).unwrap_err();
        assert!(
            err.starts_with("frame 2-revealed differs from the box"),
            "{err}"
        );
        // Both windows painted the box's picture: on open once the proxy is
        // on screen over the box, on close once the box is under the proxy.
        for (at, name) in [(0, "1-swapped"), (3, "5-collapsed"), (4, "6-cleared")] {
            let mut twice = fine;
            twice[at] = &doubled;
            let err = judge_frames(&frames(twice), &boxed, &bare).unwrap_err();
            assert!(
                err.starts_with(&format!("frame {name} differs from the box")),
                "{err}"
            );
        }
        // A missing probe fails rather than passing on fewer frames.
        let mut fewer = frames(fine);
        fewer.remove(1);
        let err = judge_frames(&fewer, &boxed, &bare).unwrap_err();
        assert!(err.starts_with("captured frames"), "{err}");
    }
}

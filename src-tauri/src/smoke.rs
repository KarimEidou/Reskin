//! `--smoke-test`: proves the packaged app works on a real Windows machine.
//!
//! 1. Both pages boot and call `smoke_ready` (else exit 2 after 30 s).
//! 2. With `--capture-handoff`: open the editor out of the box and close it
//!    again while sampling the screen under the box. The box region must
//!    never look like the bare desktop during the handoff (a window hid
//!    before an identical picture covered it). All-black captures are
//!    inconclusive and don't fail the run.
//! 3. A real open → export → apply → restore cycle on a temp `.lnk`
//!    fixture, driven through the editor page (`EditorCmd::SmokeCycle`),
//!    verified independently here.
//!
//! Exit codes: 0 pass, 2 timeout, 3 handoff/cycle failure.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reskin_core::model::{CollapseThen, EditorCmd, EditorView, Rect, SmokeReport, WindowKind};
use reskin_core::pixels::Rgba;
use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;
use crate::windows::{box_window, morph, raw};
use crate::{capture, items, log};

pub const TIMEOUT: Duration = Duration::from_secs(90);
pub const EXIT_TIMEOUT: i32 = 2;
pub const EXIT_FAILED: i32 = 3;
/// Pages must report within this long.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Max mean colour difference for "the same picture".
const SAME: f64 = 14.0;
/// Min mean colour difference between the box and the bare desktop.
const DISTINCT: f64 = 4.0;

pub struct Smoke {
    pub enabled: bool,
    pub capture_handoff: bool,
    ready: Mutex<HashSet<WindowKind>>,
    cycle: Mutex<Option<String>>,
    frames: Mutex<Vec<(String, Rgba)>>,
    region: Mutex<Option<Rect>>,
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
        }
    }

    /// Records a ready page; true when this call made both pages ready.
    fn mark(&self, kind: WindowKind) -> bool {
        let mut r = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        let before = r.len();
        r.insert(kind);
        r.len() == 2 && before == 1
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
            let code = run_scenarios(&app);
            log::line(&format!("smoke: finished with exit code {code}"));
            app.exit(code);
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
    // Idle footprint: both pages booted, editor hidden with a low memory
    // target. Give WebView2 a moment to settle first.
    std::thread::sleep(Duration::from_millis(2500));
    log::line(&format!(
        "smoke: idle working set {}",
        crate::memory::measure()
    ));
    if state.smoke.capture_handoff {
        match handoff(app) {
            Ok(msg) => log::line(&format!("smoke: handoff {msg}")),
            Err(e) => {
                log::line(&format!("smoke: handoff FAILED: {e}"));
                return EXIT_FAILED;
            }
        }
    }
    match cycle(app) {
        Ok(()) => {
            log::line("smoke: apply/restore cycle PASS");
            0
        }
        Err(e) => {
            log::line(&format!("smoke: apply/restore cycle FAILED: {e}"));
            EXIT_FAILED
        }
    }
}

fn save(name: &str, img: &Rgba) {
    let path = std::env::temp_dir().join(format!("reskin-handoff-{name}.png"));
    let _ = std::fs::write(path, img.encode_png());
}

fn handoff<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let state = app.state::<AppState>();
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
    save("0-box", &with_box);
    save("0-bare", &bare);
    if capture::is_black(&with_box) {
        return Ok("inconclusive (black capture)".into());
    }
    let distinct = capture::diff(&with_box, &bare);
    if distinct < DISTINCT {
        return Ok(format!(
            "inconclusive (box indistinguishable from desktop: {distinct:.1})"
        ));
    }
    *state.smoke.region.lock().unwrap_or_else(|e| e.into_inner()) = Some(region);
    state
        .smoke
        .frames
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();

    let t = Instant::now();
    morph::open(app, vec![], EditorView::Start)?;
    std::thread::sleep(Duration::from_millis(300));
    morph::close(app, CollapseThen::Hide, None)?;
    probe(app, "9-after-close");
    log::line(&format!("smoke: handoff round trip took {:?}", t.elapsed()));
    *state.smoke.region.lock().unwrap_or_else(|e| e.into_inner()) = None;

    let frames = std::mem::take(&mut *state.smoke.frames.lock().unwrap_or_else(|e| e.into_inner()));
    let mut report = Vec::new();
    for (name, img) in &frames {
        save(name, img);
        let to_bare = capture::diff(img, &bare);
        let to_box = capture::diff(img, &with_box);
        report.push(format!("{name}: Δbare={to_bare:.1} Δbox={to_box:.1}"));
        if to_bare < DISTINCT.min(distinct / 2.0) {
            return Err(format!("empty frame at {name} ({})", report.join("; ")));
        }
        // Frames where the box (or its identical proxy) should be showing.
        if (name.contains("revealed") || name.contains("collapsed") || name.contains("after-close"))
            && to_box > SAME
        {
            return Err(format!(
                "frame {name} differs from the box ({})",
                report.join("; ")
            ));
        }
    }
    Ok(format!(
        "ok ({} frames: {})",
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
    let target = lnk.display().to_string();
    let journal = state.journal();
    let entries: Vec<_> = journal
        .entries()
        .iter()
        .filter(|e| e.target.eq_ignore_ascii_case(&target))
        .collect();
    if entries.is_empty() {
        return Err("journal has no entry for the fixture".into());
    }
    if journal.active_for(&target).is_some() {
        return Err("journal still has an active entry for the fixture".into());
    }
    let _ = std::fs::remove_dir_all(lnk.parent().unwrap_or(&lnk));
    Ok(())
}

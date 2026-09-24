//! `--smoke-test`: proves the packaged app works on a real Windows machine.
//! Both pages must boot and call `smoke_ready`; the process then exits 0.
//! If that doesn't happen within 30 s it exits 2.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use reskin_core::model::{SmokeReport, WindowKind};
use tauri::{AppHandle, Runtime};

pub const TIMEOUT: Duration = Duration::from_secs(30);
pub const EXIT_TIMEOUT: i32 = 2;

pub struct Smoke {
    pub enabled: bool,
    #[expect(dead_code, reason = "handoff capture lands with the morph FSM (M2)")]
    pub capture_handoff: bool,
    ready: Mutex<HashSet<WindowKind>>,
}

impl Smoke {
    pub fn new(enabled: bool, capture_handoff: bool) -> Self {
        Self {
            enabled,
            capture_handoff,
            ready: Mutex::new(HashSet::new()),
        }
    }

    /// Records a ready page; true once both pages are ready.
    fn mark(&self, kind: WindowKind) -> bool {
        let mut r = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        r.insert(kind);
        r.contains(&WindowKind::Box) && r.contains(&WindowKind::Editor)
    }
}

/// Starts the watchdog that fails the run if the pages never report.
pub fn start_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(TIMEOUT);
        crate::log::line("smoke: TIMEOUT waiting for both pages");
        std::process::exit(EXIT_TIMEOUT);
    });
}

pub fn on_ready<R: Runtime>(app: &AppHandle<R>, smoke: &Smoke, report: SmokeReport) {
    crate::log::line(&format!(
        "smoke: {:?} ready ({})",
        report.window, report.detail
    ));
    if smoke.mark(report.window) {
        crate::log::line("smoke: PASS (both pages ready)");
        app.exit(0);
    }
}

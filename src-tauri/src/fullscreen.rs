//! Hides the box while a fullscreen app, game or presentation runs in
//! front (`SHQueryUserNotificationState`) — unless the user showed it over
//! that app ("Show box", see `state::FullscreenHide`) — and brings it back
//! afterwards. Each tick also puts a box at rest back in line with the
//! user's wish (`morph::settle_box`), should anything have left it
//! otherwise.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use crate::state::AppState;
use crate::windows::morph;

const POLL: Duration = Duration::from_millis(1500);

pub fn start_watcher<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("reskin-fullscreen".into())
        .spawn(move || {
            let mut last = Instant::now();
            loop {
                std::thread::sleep(POLL);
                let now = Instant::now();
                tick(&app, now - last);
                last = now;
            }
        });
}

/// One reading, `elapsed` after the previous one (measured: a busy PC can
/// wake the watcher late).
fn tick<R: Runtime>(app: &AppHandle<R>, elapsed: Duration) {
    let state = app.state::<AppState>();
    let busy =
        state.settings().auto_hide_fullscreen && reskin_core::win::fullscreen::is_fullscreen_busy();
    state.set_fullscreen_busy(busy, elapsed);
    // A box at rest follows at once; while the editor is open (or a
    // handoff runs) the close asks the same flag.
    morph::settle_box(app);
}

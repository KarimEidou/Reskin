//! Hides the box while a fullscreen app, game or presentation runs
//! (`SHQueryUserNotificationState`), and brings it back afterwards.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::state::AppState;
use crate::windows::{box_window, morph, raw};

const POLL: Duration = Duration::from_millis(1500);

pub fn start_watcher<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("reskin-fullscreen".into())
        .spawn(move || {
            loop {
                std::thread::sleep(POLL);
                tick(&app);
            }
        });
}

fn tick<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let enabled = state.settings().auto_hide_fullscreen;
    let busy = enabled && reskin_core::win::fullscreen::is_fullscreen_busy();
    let was = state.hidden_for_fullscreen();
    if busy == was || state.morph.phase() != morph::Phase::Closed {
        return;
    }
    state.set_hidden_for_fullscreen(busy);
    let Some(w) = app.get_webview_window(box_window::LABEL) else {
        return;
    };
    let h = raw::hwnd_of(&w);
    if busy {
        raw::hide(h);
    } else if !state.box_hidden_by_user() {
        raw::show_no_activate(h);
        raw::set_topmost(h, true);
        let _ = app.emit_to(box_window::LABEL, "box:shown", ());
    }
}

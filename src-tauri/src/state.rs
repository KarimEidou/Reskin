//! Process-wide application state (managed by Tauri).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock};

use reskin_core::history::Journal;
use reskin_core::model::{EditorCmd, Settings};
use reskin_core::paths::AppDirs;
use reskin_core::win::sta::Sta;
use tauri::{AppHandle, Emitter, Runtime};

use crate::apply::Elevations;
use crate::cli::AppArgs;
use crate::items::Items;
use crate::smoke::Smoke;
use crate::windows::animator::Animator;
use crate::windows::mailbox::Mailbox;
use crate::windows::morph::Morph;

pub struct AppState {
    pub dirs: AppDirs,
    pub settings: RwLock<Settings>,
    pub mailbox: Mailbox,
    pub morph: Morph,
    pub animator: Animator,
    pub items: Items,
    pub sta: Sta,
    pub smoke: Smoke,
    /// Applies waiting for the user to approve elevation.
    pub elevations: Elevations,
    journal: Mutex<Journal>,
    /// Held while a settings change is applied to the OS and saved.
    settings_changes: Mutex<()>,
    /// The first-run welcome hasn't been finished (`Settings::onboarded`).
    first_run: AtomicBool,
    box_hidden_by_user: AtomicBool,
    hidden_for_fullscreen: AtomicBool,
    /// Compatibility mode changed: rebuild both windows at the next close.
    rebuild_windows: AtomicBool,
}

impl AppState {
    pub fn new(
        args: &AppArgs,
        dirs: AppDirs,
        settings: Settings,
        journal: Journal,
        sta: Sta,
    ) -> Self {
        let smoke = Smoke::new(args.smoke, args.capture_handoff);
        Self {
            dirs,
            first_run: AtomicBool::new(!settings.onboarded),
            settings: RwLock::new(settings),
            mailbox: Mailbox::default(),
            morph: Morph::default(),
            animator: Animator::spawn(),
            items: Items::default(),
            sta,
            smoke,
            elevations: Elevations::default(),
            journal: Mutex::new(journal),
            settings_changes: Mutex::new(()),
            box_hidden_by_user: AtomicBool::new(false),
            hidden_for_fullscreen: AtomicBool::new(false),
            rebuild_windows: AtomicBool::new(false),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Serialises settings changes that touch OS state: each one is applied
    /// against the OS as the previous one left it. Never taken on the main
    /// thread (a change waits for the main thread to register the hotkey).
    pub fn lock_settings_changes(&self) -> MutexGuard<'_, ()> {
        self.settings_changes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Mutates, normalises and persists the settings, then tells both
    /// windows. Returns the new settings.
    pub fn update_settings<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        f: impl FnOnce(&mut Settings),
    ) -> Settings {
        let new = {
            let mut g = self.settings.write().unwrap_or_else(|e| e.into_inner());
            let mut s = g.clone();
            f(&mut s);
            *g = reskin_core::settings::normalize(s);
            g.clone()
        };
        if let Err(e) = reskin_core::settings::save(&self.dirs.settings_file(), &new) {
            crate::log::line(&format!("saving settings failed: {e}"));
        }
        let _ = app.emit_to(
            crate::windows::box_window::LABEL,
            "settings:changed",
            new.clone(),
        );
        self.mailbox.push(EditorCmd::Settings {
            settings: new.clone(),
        });
        new
    }

    pub fn journal(&self) -> MutexGuard<'_, Journal> {
        self.journal.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The first-run welcome is due (and the box's hint after it).
    pub fn first_run(&self) -> bool {
        self.first_run.load(Ordering::SeqCst)
    }

    /// The welcome was finished: a box built later (after a compatibility-
    /// mode toggle) boots without the first-run hint.
    pub fn finish_first_run(&self) {
        self.first_run.store(false, Ordering::SeqCst);
    }

    pub fn box_hidden_by_user(&self) -> bool {
        self.box_hidden_by_user.load(Ordering::SeqCst)
    }

    pub fn set_box_hidden_by_user(&self, v: bool) {
        self.box_hidden_by_user.store(v, Ordering::SeqCst);
    }

    pub fn hidden_for_fullscreen(&self) -> bool {
        self.hidden_for_fullscreen.load(Ordering::SeqCst)
    }

    pub fn set_hidden_for_fullscreen(&self, v: bool) {
        self.hidden_for_fullscreen.store(v, Ordering::SeqCst);
    }

    pub fn request_window_rebuild(&self) {
        self.rebuild_windows.store(true, Ordering::SeqCst);
    }

    pub fn take_window_rebuild(&self) -> bool {
        self.rebuild_windows.swap(false, Ordering::SeqCst)
    }

    /// Windows' "Animation effects" are off. Read live (one cheap
    /// `SystemParametersInfo` call) so the handoff and the flourish follow
    /// a change right away, as the pages' reduced-motion media query does.
    pub fn system_reduced_motion(&self) -> bool {
        !reskin_core::win::wallpaper::client_area_animation()
    }
}

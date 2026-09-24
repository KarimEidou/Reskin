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
    /// No settings.json existed at startup.
    pub first_run: bool,
    pub mailbox: Mailbox,
    pub morph: Morph,
    pub animator: Animator,
    pub items: Items,
    pub sta: Sta,
    pub smoke: Smoke,
    /// Applies waiting for the user to approve elevation.
    pub elevations: Elevations,
    journal: Mutex<Journal>,
    box_hidden_by_user: AtomicBool,
    hidden_for_fullscreen: AtomicBool,
    system_reduced_motion: AtomicBool,
}

impl AppState {
    pub fn new(
        args: &AppArgs,
        dirs: AppDirs,
        settings: Settings,
        first_run: bool,
        journal: Journal,
        sta: Sta,
    ) -> Self {
        let smoke = Smoke::new(args.smoke, args.capture_handoff);
        Self {
            dirs,
            settings: RwLock::new(settings),
            first_run,
            mailbox: Mailbox::default(),
            morph: Morph::default(),
            animator: Animator::spawn(),
            items: Items::default(),
            sta,
            smoke,
            elevations: Elevations::default(),
            journal: Mutex::new(journal),
            box_hidden_by_user: AtomicBool::new(false),
            hidden_for_fullscreen: AtomicBool::new(false),
            system_reduced_motion: AtomicBool::new(false),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
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

    pub fn system_reduced_motion(&self) -> bool {
        self.system_reduced_motion.load(Ordering::SeqCst)
    }

    pub fn set_system_reduced_motion(&self, v: bool) {
        self.system_reduced_motion.store(v, Ordering::SeqCst);
    }
}

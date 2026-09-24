//! Process-wide application state (managed by Tauri).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock};
use std::time::Duration;

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

/// How long "Show box" outlasts the fullscreen app it was chosen over. A
/// fullscreen app only counts while it is in front, and reaching the tray
/// to choose "Show box" takes the user away from it: the choice has to
/// hold until they are back.
pub const SHOWN_ANYWAY_GRACE: Duration = Duration::from_secs(30);

/// Whether a fullscreen app keeps the box hidden. The watcher reports
/// whether one runs in front (with auto-hide on); "Show box" shows the box
/// over it anyway — also when chosen just after the user left it for the
/// tray — until the user hides the box again or no fullscreen app has been
/// seen for [`SHOWN_ANYWAY_GRACE`] (the app went away).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FullscreenHide {
    /// How long ago the watcher last saw a fullscreen app: zero while it
    /// sees one, `None` when it saw none within [`SHOWN_ANYWAY_GRACE`].
    last_seen: Option<Duration>,
    shown_anyway: bool,
}

impl FullscreenHide {
    /// The watcher's reading, `elapsed` after its previous one: a
    /// fullscreen app runs in front (and auto-hide is on).
    pub fn set_busy(&mut self, busy: bool, elapsed: Duration) {
        self.last_seen = if busy {
            Some(Duration::ZERO)
        } else {
            self.last_seen
                .map(|ago| ago.saturating_add(elapsed))
                .filter(|ago| *ago < SHOWN_ANYWAY_GRACE)
        };
        self.shown_anyway &= self.last_seen.is_some();
    }

    /// The user asked to see the box: over the fullscreen app running now
    /// or just left (none, nothing changes).
    pub fn show_anyway(&mut self) {
        self.shown_anyway = self.last_seen.is_some();
    }

    /// The user hid the box: a fullscreen app hides it again.
    pub fn user_hid_box(&mut self) {
        self.shown_anyway = false;
    }

    /// The box stays hidden for a fullscreen app.
    pub fn hides(&self) -> bool {
        self.last_seen == Some(Duration::ZERO) && !self.shown_anyway
    }
}

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
    fullscreen: Mutex<FullscreenHide>,
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
            fullscreen: Mutex::default(),
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

    /// Records the user's wish (tray, menu, hotkey, Settings). Hiding the
    /// box also ends showing it over a fullscreen app.
    pub fn set_box_hidden_by_user(&self, v: bool) {
        self.box_hidden_by_user.store(v, Ordering::SeqCst);
        if v {
            self.fullscreen().user_hid_box();
        }
    }

    /// "Show box": the user wants the box on screen, over the fullscreen
    /// app running now (or just left for the tray) too.
    pub fn show_box_anyway(&self) {
        self.set_box_hidden_by_user(false);
        self.fullscreen().show_anyway();
    }

    /// A fullscreen app keeps the box hidden (see [`FullscreenHide`]).
    pub fn hidden_for_fullscreen(&self) -> bool {
        self.fullscreen().hides()
    }

    /// The fullscreen watcher's reading, `elapsed` after its previous one.
    pub fn set_fullscreen_busy(&self, busy: bool, elapsed: Duration) {
        self.fullscreen().set_busy(busy, elapsed);
    }

    fn fullscreen(&self) -> MutexGuard<'_, FullscreenHide> {
        self.fullscreen.lock().unwrap_or_else(|e| e.into_inner())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_box_keeps_the_box_over_a_fullscreen_app_until_it_goes_or_the_user_hides_it() {
        const TICK: Duration = Duration::from_millis(1500);
        let mut f = FullscreenHide::default();
        assert!(!f.hides());
        f.set_busy(true, TICK);
        assert!(f.hides());
        // "Show box" while the fullscreen app runs: the box shows, also at
        // the watcher's next readings.
        f.show_anyway();
        assert!(!f.hides());
        f.set_busy(true, TICK);
        assert!(!f.hides());
        // The user hides the box again: the fullscreen app keeps it hidden.
        f.user_hid_box();
        assert!(f.hides());

        // The user left the fullscreen app for the tray (it no longer
        // counts) and chose "Show box" there: back in the app, the box
        // stays.
        f.set_busy(false, TICK);
        assert!(!f.hides());
        f.show_anyway();
        f.set_busy(false, TICK);
        f.set_busy(true, TICK);
        assert!(!f.hides());

        // Shown anyway, then the fullscreen app goes: once none has been
        // seen for the grace period, the next one hides the box again.
        let mut ago = Duration::ZERO;
        while ago + TICK < SHOWN_ANYWAY_GRACE {
            f.set_busy(false, TICK);
            ago += TICK;
        }
        f.set_busy(true, TICK);
        assert!(!f.hides(), "a fullscreen app back within the grace");
        f.set_busy(false, SHOWN_ANYWAY_GRACE);
        f.set_busy(true, TICK);
        assert!(f.hides());

        // "Show box" with no fullscreen app seen lately changes nothing
        // later.
        let mut f = FullscreenHide::default();
        f.show_anyway();
        f.set_busy(true, TICK);
        assert!(f.hides());
        f.set_busy(false, SHOWN_ANYWAY_GRACE);
        f.show_anyway();
        f.set_busy(true, TICK);
        assert!(f.hides());
    }
}

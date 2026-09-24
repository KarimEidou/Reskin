//! Process-wide application state (managed by Tauri).

use std::sync::RwLock;

use reskin_core::model::Settings;

use crate::cli::AppArgs;
use crate::smoke::Smoke;
use crate::windows::mailbox::Mailbox;

pub struct AppState {
    #[expect(
        dead_code,
        reason = "--edit forwarding lands with the item commands (M2)"
    )]
    pub args: AppArgs,
    pub settings: RwLock<Settings>,
    /// No settings.json existed at startup.
    pub first_run: bool,
    pub mailbox: Mailbox,
    pub smoke: Smoke,
}

impl AppState {
    pub fn new(args: AppArgs, settings: Settings, first_run: bool) -> Self {
        let smoke = Smoke::new(args.smoke, args.capture_handoff);
        Self {
            args,
            settings: RwLock::new(settings),
            first_run,
            mailbox: Mailbox::default(),
            smoke,
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

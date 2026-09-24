//! Reskin — a floating box that turns any desktop icon into an editable
//! canvas. This crate is the Tauri app: windows, the box animator, the
//! editor mailbox, IPC commands, tray, hotkey and the CLI helper modes.
//! Platform logic lives in `reskin-core`.

#[cfg(not(windows))]
compile_error!("Reskin is a Windows application; build it for a Windows target.");

pub mod cli;
mod commands;
mod console;
mod helper;
mod log;
mod selftest;
mod smoke;
mod state;
pub mod windows;

use std::time::Duration;

use reskin_core::model::Settings;
use tauri::Manager;

use crate::cli::AppArgs;
use crate::state::AppState;

/// Bundle identifier; also the app-data folder name.
pub const APP_ID: &str = "com.karimeidou.reskin";

/// "release 1a2b3c4" / "debug".
pub fn build_label() -> String {
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    match option_env!("RESKIN_COMMIT") {
        Some(c) => format!("{profile} {c}"),
        None => profile.to_string(),
    }
}

fn load_settings() -> (Settings, bool) {
    let Some(base) = std::env::var_os("APPDATA") else {
        return (Settings::default(), true);
    };
    let path = std::path::Path::new(&base)
        .join(APP_ID)
        .join("settings.json");
    match std::fs::read(&path) {
        Ok(bytes) => (serde_json::from_slice(&bytes).unwrap_or_default(), false),
        Err(_) => (Settings::default(), true),
    }
}

pub fn run(args: AppArgs) {
    let (settings, first_run) = load_settings();
    log::line(&format!(
        "Reskin {} starting ({}) args={args:?}",
        env!("CARGO_PKG_VERSION"),
        build_label()
    ));
    let smoke = args.smoke;
    let prewarm = if smoke {
        Duration::ZERO
    } else if args.autostart {
        Duration::from_secs(10)
    } else {
        Duration::from_millis(1500)
    };
    let state = AppState::new(args, settings, first_run);

    tauri::Builder::default()
        // Must be registered first so a second launch exits before doing work.
        .plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
            let forwarded = AppArgs::parse(&argv);
            log::line(&format!("second instance: {forwarded:?}"));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings = app.state::<AppState>().settings();
            windows::box_window::create(&handle, &settings)?;
            if smoke {
                smoke::start_watchdog();
            }
            // Pre-warm the editor off the main thread: building a webview
            // from the event-loop thread outside `setup` can deadlock on
            // Windows, and the build call dispatches to the loop anyway.
            std::thread::spawn(move || {
                std::thread::sleep(prewarm);
                let settings = handle.state::<AppState>().settings();
                if let Err(e) = windows::editor_window::create(&handle, &settings) {
                    log::line(&format!("editor pre-warm failed: {e}"));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::boot::app_boot,
            commands::editor_cmds::editor_next,
            commands::editor_cmds::editor_ack,
            commands::system::smoke_ready,
            commands::system::settings_get,
            commands::system::settings_set,
            commands::system::set_box_visible,
            commands::system::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Reskin")
        .run(|_app, event| {
            // Windows are only ever hidden, never closed; keep running
            // unless an explicit exit code was requested.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                && code.is_none()
            {
                api.prevent_exit();
            }
        });
}

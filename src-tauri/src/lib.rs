//! Reskin — a floating box that turns any desktop icon into an editable
//! canvas. This crate is the Tauri app: windows, the box animator, the
//! editor mailbox, IPC commands, tray, hotkey and the CLI helper modes.
//! Platform logic lives in `reskin-core`.

#[cfg(not(windows))]
compile_error!("Reskin is a Windows application; build it for a Windows target.");

mod actions;
mod apply;
mod capture;
pub mod cli;
mod commands;
mod console;
mod fullscreen;
mod helper;
mod hotkey;
mod items;
mod log;
mod memory;
mod menu;
mod restore;
mod selftest;
mod smoke;
mod state;
mod tray;
pub mod windows;

use std::time::Duration;

use reskin_core::history::Journal;
use reskin_core::model::EditorView;
use reskin_core::paths::AppDirs;
use tauri::Manager;

use crate::cli::AppArgs;
use crate::state::AppState;

/// Bundle identifier; also the app-data folder name.
pub const APP_ID: &str = reskin_core::paths::APP_ID;

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

/// A native error box for failures before any window exists.
fn fatal_dialog(msg: &str) {
    use ::windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    use ::windows::core::HSTRING;
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(msg),
            &HSTRING::from("Reskin"),
            MB_OK | MB_ICONERROR,
        );
    }
}

pub fn run(args: AppArgs) {
    log::rotate();
    log::line(&format!(
        "Reskin {} starting ({}) args={args:?}",
        env!("CARGO_PKG_VERSION"),
        build_label()
    ));
    let dirs = AppDirs::from_env();
    if let Err(e) = dirs.ensure() {
        log::line(&format!("creating app data folders failed: {e}"));
    }
    let (settings, first_run) = reskin_core::settings::load(&dirs.settings_file());
    let journal = match Journal::load(dirs.journal_file()) {
        Ok(j) => j,
        Err(e) => {
            // Only a journal written by a newer Reskin fails to load (a
            // damaged one is backed up and replaced). Don't risk losing
            // its history: refuse to start.
            log::line(&format!("fatal: journal unreadable: {e}"));
            fatal_dialog(&format!(
                "Reskin could not read its history file:\n{e}\n\nIt may have been written by a newer version of Reskin."
            ));
            return;
        }
    };
    let sta = match reskin_core::win::sta::Sta::spawn() {
        Ok(s) => s,
        Err(e) => {
            log::line(&format!("fatal: COM worker failed to start: {e}"));
            fatal_dialog(&format!(
                "Reskin could not start its Windows shell worker:\n{e}"
            ));
            return;
        }
    };
    let smoke = args.smoke;
    let prewarm = if smoke {
        Duration::ZERO
    } else if args.autostart {
        Duration::from_secs(10)
    } else {
        Duration::from_millis(1500)
    };
    let edit_paths = args.edit.clone();
    let state = AppState::new(&args, dirs, settings, first_run, journal, sta);

    let app = tauri::Builder::default()
        // Must be registered first so a second launch exits before doing work.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let forwarded = AppArgs::parse(&argv);
            log::line(&format!("second instance: {forwarded:?}"));
            if forwarded.edit.is_empty() {
                actions::set_box_hidden(app, false);
            } else {
                actions::open_paths(app, forwarded.edit);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state)
        .on_menu_event(|app, event| menu::dispatch(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            let settings = state.settings();
            state.set_system_reduced_motion(!reskin_core::win::wallpaper::client_area_animation());

            let box_win = windows::box_window::create(&handle, &settings)?;
            state.animator.set_hwnd(windows::raw::hwnd_of(&box_win));
            if let Err(e) = tray::create(&handle) {
                log::line(&format!("tray: {e}"));
            }
            if !smoke {
                commands::settings::apply_at_startup(&handle, &settings);
                fullscreen::start_watcher(&handle);
            } else {
                smoke::start_watchdog();
            }
            restore::reconcile_at_startup(&handle);

            let first_run = state.first_run && !smoke;
            // Pre-warm the editor off the main thread: building a webview
            // from the event-loop thread outside `setup` can deadlock on
            // Windows, and the build call dispatches to the loop anyway.
            std::thread::spawn(move || {
                std::thread::sleep(if first_run || !edit_paths.is_empty() {
                    Duration::from_millis(300)
                } else {
                    prewarm
                });
                let settings = handle.state::<AppState>().settings();
                if let Err(e) = windows::editor_window::create(&handle, &settings) {
                    log::line(&format!("editor pre-warm failed: {e}"));
                    return;
                }
                if first_run {
                    actions::open_editor(&handle, vec![], EditorView::Welcome);
                } else if !edit_paths.is_empty() {
                    actions::open_paths(&handle, edit_paths);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::boot::app_boot,
            commands::box_cmds::box_drag,
            commands::box_cmds::box_menu,
            commands::box_cmds::open_editor,
            commands::box_cmds::box_painted,
            commands::editor_cmds::editor_next,
            commands::editor_cmds::editor_ack,
            commands::editor_cmds::editor_close,
            items::inspect_paths,
            items::inspect_system_icon,
            items::item_frames,
            items::pick_files,
            items::read_project,
            apply::apply_icon,
            apply::apply_icon_elevated,
            apply::export_file,
            restore::restore,
            restore::history_list,
            restore::refresh_icons,
            commands::library::library_list,
            commands::library::library_save,
            commands::library::library_load,
            commands::library::library_delete,
            commands::library::autosave,
            commands::library::autosave_load,
            commands::system::wallpaper,
            commands::system::wallpaper_info,
            commands::system::system_fonts,
            commands::system::accent_color,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::system::open_external,
            commands::system::set_box_visible,
            commands::system::quit_app,
            commands::system::smoke_ready,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Reskin");
    // `run` would end the process with code 0 whatever `app.exit(code)`
    // asked for (tao exits on its own); `run_return` hands the code back so
    // the smoke test and helper modes report failures.
    let code = app.run_return(|_app, event| {
        // Windows are only ever hidden, never closed; keep running
        // unless an explicit exit code was requested.
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event
            && code.is_none()
        {
            api.prevent_exit();
        }
    });
    std::process::exit(code);
}

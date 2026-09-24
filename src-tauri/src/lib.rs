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

use ::windows::Win32::UI::WindowsAndMessaging::{
    IDYES, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_YESNO, MESSAGEBOX_RESULT, MESSAGEBOX_STYLE,
    MessageBoxW,
};
use ::windows::core::HSTRING;
use reskin_core::history::Journal;
use reskin_core::model::EditorView;
use reskin_core::paths::AppDirs;
use reskin_core::win::elevate;
use tauri::Manager;

use crate::cli::AppArgs;
use crate::state::AppState;

/// Bundle identifier; also the app-data folder name.
pub const APP_ID: &str = reskin_core::paths::APP_ID;

/// Microsoft's Evergreen WebView2 Runtime bootstrapper.
const WEBVIEW2_DOWNLOAD: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// Added to the arguments of an instance started again, unelevated, by one
/// that was run as administrator (so it never tries a second time).
const RELAUNCHED: &str = "--relaunched";

/// Exit code when Reskin cannot start (no WebView2, unreadable history, …).
const EXIT_CANNOT_START: i32 = 1;

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

fn message_box(text: &str, style: MESSAGEBOX_STYLE) -> MESSAGEBOX_RESULT {
    // SAFETY: plain modal message box without an owner window.
    unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("Reskin"), style) }
}

/// A failure that stops Reskin: logged, and shown in a native error box
/// (not under `--smoke-test`, where nobody could close it).
fn fatal(smoke: bool, log_msg: &str, user_msg: &str) {
    log::line(&format!("fatal: {log_msg}"));
    if !smoke {
        message_box(user_msg, MB_OK | MB_ICONERROR);
    }
}

/// Every panic goes to reskin.log. Release builds abort on panic, so the
/// user also learns why Reskin vanished (unless `dialog` is off).
fn install_panic_hook(dialog: bool) {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::line(&format!("panic: {info}"));
        if dialog && cfg!(panic = "abort") {
            message_box(
                &format!(
                    "Reskin ran into an unexpected problem and has to close.\n\n{}\n\nDetails are in {}.",
                    info.payload_as_str().unwrap_or("An internal error."),
                    log::path().display()
                ),
                MB_OK | MB_ICONERROR,
            );
        }
        default(info);
    }));
}

/// Without the WebView2 Runtime no window can open: says so and offers
/// Microsoft's download.
fn webview2_missing(smoke: bool, why: &str) {
    log::line(&format!("fatal: {why}"));
    if smoke {
        return;
    }
    let answer = message_box(
        "Reskin needs the Microsoft Edge WebView2 Runtime, which isn't installed on this PC.\n\n\
         Windows 11 comes with it, and the Reskin installer adds it by itself; the portable \
         Reskin needs it installed once.\n\nDownload it from Microsoft now?",
        MB_YESNO | MB_ICONERROR,
    );
    if answer == IDYES {
        use ::windows::Win32::UI::Shell::ShellExecuteW;
        use ::windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        // SAFETY: plain shell call with valid strings.
        unsafe {
            ShellExecuteW(
                None,
                &HSTRING::from("open"),
                &HSTRING::from(WEBVIEW2_DOWNLOAD),
                None,
                None,
                SW_SHOWNORMAL,
            );
        }
    }
}

/// Run as administrator: starts Reskin again, unelevated, through Explorer
/// and returns true (this instance then quits). Elevated, Windows would
/// drop every drag from Explorer onto the box (UIPI), and shell writes
/// would bypass the elevated helper's checks. When that fails Reskin warns
/// and carries on.
fn restarted_unelevated(argv: &[String]) -> bool {
    if !elevate::is_uac_elevated() {
        return false;
    }
    let restarted = if argv.iter().any(|a| a == RELAUNCHED) {
        Err("it still runs as administrator after restarting through Explorer".to_string())
    } else {
        std::env::current_exe()
            .map_err(|e| e.to_string())
            .and_then(|exe| {
                let mut args: Vec<String> = argv.iter().skip(1).cloned().collect();
                args.push(RELAUNCHED.to_owned());
                elevate::run_unelevated(&exe, &args).map_err(|e| e.to_string())
            })
    };
    match restarted {
        Ok(()) => {
            log::line("started as administrator: restarted unelevated through Explorer");
            true
        }
        Err(e) => {
            log::line(&format!("running as administrator: {e}"));
            message_box(
                &format!(
                    "Reskin is running as administrator, so Windows won't let you drag icons \
                     from the desktop onto the box.\n\nClose Reskin and start it normally (not \
                     with “Run as administrator”).\n\nReskin could not restart itself without \
                     administrator rights: {e}"
                ),
                MB_OK | MB_ICONWARNING,
            );
            false
        }
    }
}

/// The app (every mode but the early helper modes, see `cli::run_early`).
/// Returns the process exit code.
pub fn run(argv: &[String]) -> i32 {
    let args = AppArgs::parse(argv);
    let smoke = args.smoke;
    log::rotate();
    log::line(&format!(
        "Reskin {} starting ({}) args={args:?}",
        env!("CARGO_PKG_VERSION"),
        build_label()
    ));
    install_panic_hook(!smoke);
    // The smoke test's exit code is its result: it never hands over.
    if !smoke && restarted_unelevated(argv) {
        return 0;
    }
    if let Err(e) = selftest::webview2_version() {
        webview2_missing(smoke, &e);
        return EXIT_CANNOT_START;
    }
    let dirs = AppDirs::from_env();
    if let Err(e) = dirs.ensure() {
        log::line(&format!("creating app data folders failed: {e}"));
    }
    let settings = reskin_core::settings::load(&dirs.settings_file());
    let journal = match Journal::load(dirs.journal_file()) {
        Ok(j) => j,
        Err(e) => {
            // Only a journal written by a newer Reskin fails to load (a
            // damaged one is backed up and replaced). Don't risk losing
            // its history: refuse to start.
            fatal(
                smoke,
                &format!("journal unreadable: {e}"),
                &format!(
                    "Reskin could not read its history file:\n{e}\n\nIt may have been written by a newer version of Reskin."
                ),
            );
            return EXIT_CANNOT_START;
        }
    };
    let sta = match reskin_core::win::sta::Sta::spawn() {
        Ok(s) => s,
        Err(e) => {
            fatal(
                smoke,
                &format!("COM worker failed to start: {e}"),
                &format!("Reskin could not start its Windows shell worker:\n{e}"),
            );
            return EXIT_CANNOT_START;
        }
    };
    let prewarm = if smoke {
        Duration::ZERO
    } else if args.autostart {
        Duration::from_secs(10)
    } else {
        Duration::from_millis(1500)
    };
    let edit_paths = args.edit.clone();
    let state = AppState::new(&args, dirs, settings, journal, sta);

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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state)
        .on_menu_event(|app, event| menu::dispatch(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            let settings = state.settings();

            let box_win = match windows::box_window::create(&handle, &settings) {
                Ok(w) => w,
                Err(e) => {
                    // Returned, the error would make Tauri panic without a
                    // word to the user.
                    fatal(
                        smoke,
                        &format!("creating the box window failed: {e}"),
                        &format!("Reskin could not open its window:\n{e}"),
                    );
                    handle.exit(EXIT_CANNOT_START);
                    return Ok(());
                }
            };
            state.animator.set_hwnd(windows::raw::hwnd_of(&box_win));
            if let Err(e) = tray::create(&handle) {
                log::line(&format!("tray: {e}"));
            }
            if !smoke {
                // Registering the hotkey waits for the event loop, which
                // runs once `setup` returns.
                let app = handle.clone();
                std::thread::spawn(move || commands::settings::reconcile_at_startup(&app));
                fullscreen::start_watcher(&handle);
            } else {
                smoke::start_watchdog();
            }
            restore::reconcile_at_startup(&handle);

            let first_run = state.first_run() && !smoke;
            // Low-memory mode builds the editor only when it opens, unless
            // it is about to open anyway.
            if settings.low_memory && !smoke && !first_run && edit_paths.is_empty() {
                return Ok(());
            }
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
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            fatal(
                smoke,
                &format!("building the app failed: {e}"),
                &format!("Reskin could not start:\n{e}"),
            );
            return EXIT_CANNOT_START;
        }
    };
    // `run` would end the process with code 0 whatever `app.exit(code)`
    // asked for (tao exits on its own); `run_return` hands the code back so
    // the smoke test and helper modes report failures.
    app.run_return(|_app, event| {
        // Windows are only ever hidden, never closed; keep running
        // unless an explicit exit code was requested.
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event
            && code.is_none()
        {
            api.prevent_exit();
        }
    })
}

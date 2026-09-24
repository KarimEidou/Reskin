// Generates the ACL permissions (`allow-<command>`) for every app command.
// Keep this list in sync with `src/lib/ipc/commands.ts` (COMMAND_NAMES) and
// the `generate_handler!` list in src/lib.rs.
const COMMANDS: &[&str] = &[
    "app_boot",
    "box_drag",
    "box_menu",
    "open_editor",
    "editor_next",
    "editor_ack",
    "editor_close",
    "inspect_paths",
    "inspect_system_icon",
    "item_frames",
    "pick_files",
    "read_project",
    "apply_icon",
    "apply_icon_elevated",
    "restore",
    "history_list",
    "refresh_icons",
    "export_file",
    "library_list",
    "library_save",
    "library_load",
    "library_delete",
    "autosave",
    "autosave_load",
    "wallpaper",
    "wallpaper_info",
    "system_fonts",
    "accent_color",
    "settings_get",
    "settings_set",
    "open_external",
    "set_box_visible",
    "quit_app",
    "smoke_ready",
];

fn main() {
    // Record the commit for About / --self-test.
    if let Ok(sha) = std::env::var("GITHUB_SHA") {
        println!("cargo:rustc-env=RESKIN_COMMIT={}", &sha[..sha.len().min(7)]);
    }
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

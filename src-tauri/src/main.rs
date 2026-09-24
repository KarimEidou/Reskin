// Release builds are GUI-subsystem executables (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Helper modes (--elevated-apply, --restore-all, --self-test) run before
    // Tauri is built and exit without creating any window.
    if let Some(code) = reskin_lib::cli::run_early(&args) {
        std::process::exit(code);
    }
    std::process::exit(reskin_lib::run(&args));
}

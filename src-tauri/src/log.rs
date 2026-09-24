//! Minimal diagnostics log: `%TEMP%\reskin.log` (plus stderr in debug
//! builds). Reskin has no telemetry; this file only exists locally.

use std::io::Write;

pub fn path() -> std::path::PathBuf {
    std::env::temp_dir().join("reskin.log")
}

pub fn line(msg: &str) {
    let stamp = reskin_core::now_ms() as u64;
    let text = format!("[{stamp}] {msg}\n");
    if cfg!(debug_assertions) {
        eprint!("{text}");
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path())
    {
        let _ = f.write_all(text.as_bytes());
    }
}

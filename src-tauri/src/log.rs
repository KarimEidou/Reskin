//! Minimal diagnostics log: `%TEMP%\reskin.log` (plus stderr in debug
//! builds). Reskin has no telemetry; this file only exists locally.

use std::io::Write;

const MAX_BYTES: u64 = 512 * 1024;

pub fn path() -> std::path::PathBuf {
    std::env::temp_dir().join("reskin.log")
}

/// Starts a fresh log when the old one grew too large.
pub fn rotate() {
    let p = path();
    if std::fs::metadata(&p).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&p, p.with_extension("old.log"));
    }
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

//! Helper modes that run without any window: the elevated icon writer and
//! "restore all" (used by the uninstaller).

/// Exit codes shared with the parent process / installer.
pub const EXIT_OK: i32 = 0;
pub const EXIT_INVALID: i32 = 2;
pub const EXIT_FAILED: i32 = 3;

/// `reskin.exe --elevated-apply <job.json>`
pub fn elevated_apply(job_path: &str) -> i32 {
    crate::log::line(&format!(
        "elevated-apply {job_path}: not available in this build"
    ));
    EXIT_INVALID
}

/// `reskin.exe --restore-all [--quiet]`
pub fn restore_all(_quiet: bool) -> i32 {
    crate::log::line("restore-all: nothing to restore");
    let _ = (EXIT_OK, EXIT_FAILED);
    EXIT_OK
}

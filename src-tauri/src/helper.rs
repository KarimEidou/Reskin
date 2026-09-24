//! Helper modes that run without any window: the elevated icon writer and
//! "restore all" (used by the uninstaller), plus launching the elevated
//! helper from the app.

use std::path::Path;
use std::time::Duration;

use reskin_core::job::{self, JobExec, JobOp, JobResult};
use reskin_core::paths::AppDirs;
use reskin_core::win::{elevate, known, notify, shortcut, urlfile};
use reskin_core::{Error, Result};
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx,
};

use crate::{log, restore};

pub use job::{EXIT_FAILED, EXIT_INVALID, EXIT_OK};

/// COM-backed side effects of an elevated job.
struct WinJobExec;

impl JobExec for WinJobExec {
    fn write_icon(&mut self, dest: &str, bytes: &[u8]) -> Result<()> {
        let dest = Path::new(dest);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
            // %ProgramData% lets any user create folders, so `Reskin\icons`
            // (or `Reskin`) could be a junction planted to redirect this
            // elevated write. Refuse to write through reparse points.
            for d in dir.ancestors().take(2) {
                if is_reparse_point(d) {
                    return Err(Error::AccessDenied(format!(
                        "{} is a link; refusing to write through it",
                        d.display()
                    )));
                }
            }
        }
        if is_reparse_point(dest) {
            return Err(Error::AccessDenied(format!("{} is a link", dest.display())));
        }
        if std::fs::read(dest).is_ok_and(|existing| existing == bytes) {
            return Ok(());
        }
        reskin_core::store::write_atomic(dest, bytes)
    }

    fn set_shortcut_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()> {
        shortcut::set_link_icon(Path::new(target), icon)
    }

    fn set_url_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()> {
        urlfile::set_url_icon(Path::new(target), icon)
    }

    fn notify(&mut self, target: &str) {
        notify::item_updated(Path::new(target));
    }
}

fn is_reparse_point(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(p)
        .is_ok_and(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

fn com_init() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    }
}

/// `reskin.exe --elevated-apply <job.json>` (runs elevated).
pub fn elevated_apply(job_path: &str) -> i32 {
    com_init();
    let dirs = AppDirs::from_env();
    let public_desktop = match known::public_desktop() {
        Ok(p) => p.display().to_string(),
        Err(e) => {
            log::line(&format!("elevated-apply: no public desktop: {e}"));
            return EXIT_INVALID;
        }
    };
    let icons = dirs.public_icons_dir().display().to_string();
    let code = job::run_job_file(
        Path::new(job_path),
        &public_desktop,
        &icons,
        &mut WinJobExec,
    );
    log::line(&format!("elevated-apply {job_path}: exit {code}"));
    code
}

/// Writes a job, runs `reskin.exe --elevated-apply` through UAC and reads
/// the result. `Error::Cancelled` when the user declines the prompt.
pub fn run_elevated_job(dirs: &AppDirs, ops: Vec<JobOp>) -> Result<JobResult> {
    let job = job::new_job(ops);
    let path = job::write_job(&dirs.jobs_dir(), &job)?;
    let exe = std::env::current_exe()?;
    let result = (|| {
        let code = elevate::run_elevated(
            &exe,
            &["--elevated-apply".to_string(), path.display().to_string()],
        )?;
        // The helper writes its result before exiting; allow a moment for
        // the file system to settle on slow disks.
        for _ in 0..20 {
            if let Some(r) = job::read_result(&path)? {
                return Ok(r);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(Error::Other(format!(
            "the elevated helper exited with code {code} without a result"
        )))
    })();
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(job::result_path(&path));
    result
}

/// `reskin.exe --restore-all [--quiet]` — restores every change. In quiet
/// mode (uninstaller) Public-Desktop items that need elevation are skipped.
pub fn restore_all(quiet: bool) -> i32 {
    com_init();
    if !quiet {
        crate::console::attach_parent();
    }
    let dirs = AppDirs::from_env();
    let mut journal = match reskin_core::history::Journal::load(dirs.journal_file()) {
        Ok(j) => j,
        Err(e) => {
            log::line(&format!("restore-all: journal unreadable: {e}"));
            if !quiet {
                println!("Reskin: could not read the journal: {e}");
            }
            return EXIT_FAILED;
        }
    };
    // Settle changes interrupted by a crash first, or restore-all would
    // skip them.
    if !journal.pending().is_empty() {
        let report = journal.reconcile(restore::probe);
        log::line(&format!("restore-all: reconcile {report:?}"));
    }
    let plans = journal.plan_restore_all();
    if plans.is_empty() {
        if !quiet {
            println!("Reskin: nothing to restore.");
        }
        return EXIT_OK;
    }
    let run = |p: reskin_core::history::RestorePlan| restore::execute(&p);
    let mut finish = |p: &reskin_core::history::RestorePlan, ok: bool| {
        let _ = journal.finish_plan(p, ok);
    };
    let report = restore::execute_plans(&dirs, plans, !quiet, &run, &mut finish);
    let _ = journal.gc_icons(&dirs.icons_dir());
    log::line(&format!("restore-all: {report:?}"));
    if !quiet {
        println!(
            "Reskin: restored {} icon(s); {} failed; {} need administrator approval.",
            report.restored,
            report.failed.len(),
            report.needs_elevation
        );
        for f in &report.failed {
            println!("  {f}");
        }
    }
    if report.failed.is_empty() {
        EXIT_OK
    } else {
        EXIT_FAILED
    }
}

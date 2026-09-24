//! Helper modes that run without any window: the elevated icon writer and
//! "restore all" (used by the uninstaller), plus launching the elevated
//! helper from the app.
//!
//! The elevated helper creates and writes files only in the admin-owned
//! `%ProgramData%\Reskin` tree and edits only shortcuts that are plain files
//! directly on the Public Desktop, never following a link on the way
//! (`reskin_core::win::access`). It writes no log either: `%TEMP%` belongs
//! to the user. Its result file and exit code are its only report.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use reskin_core::history::{IN_FLIGHT_GRACE, Journal};
use reskin_core::job::{self, JobExec, JobOp, JobResult, LinkKind};
use reskin_core::paths::{self, AppDirs};
use reskin_core::win::access::{self, AdminDir, TrustedDir};
use reskin_core::win::{elevate, known, notify, shortcut, urlfile};
use reskin_core::{Error, Result};
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx,
};

use crate::{log, restore};

pub use job::{EXIT_FAILED, EXIT_INVALID, EXIT_OK};

/// `%ProgramData%\Reskin`, located through the known-folder API (never the
/// `ProgramData` environment variable, which the user controls).
fn public_root() -> Result<PathBuf> {
    Ok(known::program_data()?.join(paths::PUBLIC_DIR_NAME))
}

/// Where elevated applies keep their icons: `%ProgramData%\Reskin\icons`.
pub fn public_icons_dir() -> Result<PathBuf> {
    Ok(public_root()?.join(job::ICONS_DIR))
}

/// The side effects of an elevated job: icons in the admin-owned
/// `%ProgramData%\Reskin\icons`, shortcut edits on the Public Desktop after
/// checking the file is a plain one directly in it.
struct WinJobExec {
    program_data: PathBuf,
    desktop: TrustedDir,
    /// Opened (created, or checked and locked down) by the first op that
    /// needs it.
    icons: Option<Result<AdminDir>>,
}

impl WinJobExec {
    fn icons(&mut self) -> Result<&AdminDir> {
        let program_data = &self.program_data;
        self.icons
            .get_or_insert_with(|| {
                AdminDir::open(program_data, &[paths::PUBLIC_DIR_NAME, job::ICONS_DIR])
            })
            .as_ref()
            .map_err(Clone::clone)
    }
}

/// The file name of `dest`, which must lie directly in `icons`.
fn icon_name<'a>(icons: &AdminDir, dest: &'a str) -> Result<&'a str> {
    if paths::is_directly_under(dest, &icons.path().to_string_lossy()) {
        Ok(paths::file_name_of(dest))
    } else {
        Err(Error::AccessDenied(format!(
            "{dest} is not in {}",
            icons.path().display()
        )))
    }
}

/// Whether a shortcut on the Public Desktop shows the icon `icon`. A
/// shortcut that cannot be read cannot show it either.
fn used_on_public_desktop(desktop: &Path, icon: &str) -> Result<bool> {
    let icon = paths::normalize_for_compare(icon);
    for entry in std::fs::read_dir(desktop)? {
        let path = entry?.path();
        let location = match LinkKind::of(&path.to_string_lossy()) {
            Some(LinkKind::Shortcut) => shortcut::read_link(&path)
                .ok()
                .and_then(|link| link.icon_path(&path))
                .map(|(p, _)| p.display().to_string()),
            Some(LinkKind::Url) => urlfile::read_url_icon(&path).ok().and_then(|(l, _)| l),
            None => None,
        };
        if location.is_some_and(|l| paths::normalize_for_compare(&l) == icon) {
            return Ok(true);
        }
    }
    Ok(false)
}

impl JobExec for WinJobExec {
    fn write_icon(&mut self, dest: &str, bytes: &[u8]) -> Result<()> {
        let icons = self.icons()?;
        icons.put(icon_name(icons, dest)?, bytes)
    }

    fn set_shortcut_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()> {
        self.desktop.check_file(Path::new(target))?;
        shortcut::set_link_icon(Path::new(target), icon)
    }

    fn set_url_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()> {
        self.desktop.check_file(Path::new(target))?;
        urlfile::set_url_icon(Path::new(target), icon)
    }

    fn delete_icon(&mut self, dest: &str) -> Result<bool> {
        if used_on_public_desktop(self.desktop.path(), dest)? {
            return Ok(false);
        }
        let icons = self.icons()?;
        icons.remove(icon_name(icons, dest)?)?;
        Ok(true)
    }

    fn notify(&mut self, target: &str) {
        notify::item_updated(Path::new(target));
    }
}

fn com_init() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
    }
}

/// `reskin.exe --elevated-apply <job.json>` (runs elevated): reads the job
/// once, validates it, runs it and leaves the result in
/// `%ProgramData%\Reskin\results` (removing results older than
/// [`job::RESULT_TTL`] that nobody read). Returns the exit code.
pub fn elevated_apply(job_path: &str) -> i32 {
    com_init();
    let Ok(id) = job::job_id_of(job_path) else {
        return EXIT_INVALID;
    };
    let Ok(program_data) = known::program_data() else {
        return EXIT_INVALID;
    };
    let bytes = access::read_plain_file(Path::new(job_path), job::MAX_JOB_FILE_BYTES);
    let icons_dir = program_data
        .join(paths::PUBLIC_DIR_NAME)
        .join(job::ICONS_DIR);
    let result = match known::public_desktop().and_then(|d| TrustedDir::open(&d)) {
        Ok(desktop) => {
            let desktop_dir = desktop.path().display().to_string();
            let mut exec = WinJobExec {
                program_data: program_data.clone(),
                desktop,
                icons: None,
            };
            job::run_job(
                &id,
                bytes,
                &desktop_dir,
                &icons_dir.display().to_string(),
                &mut exec,
            )
        }
        Err(e) => JobResult::rejected(&id, &e),
    };
    // Without a result file the app goes by the exit code alone.
    let _ = write_result(&program_data, &result);
    result.exit_code()
}

fn write_result(program_data: &Path, result: &JobResult) -> Result<()> {
    let results = AdminDir::open(program_data, &[paths::PUBLIC_DIR_NAME, job::RESULTS_DIR])?;
    for (name, age) in results.files()? {
        if job::is_stale_result(&name, age) {
            // One that cannot go now goes with a later run.
            let _ = results.remove(&name);
        }
    }
    results.put(
        &job::result_file_name(&result.id),
        &job::encode_result(result)?,
    )
}

/// Writes a job, runs `reskin.exe --elevated-apply` through UAC and takes
/// its result from `%ProgramData%\Reskin\results` — only from a file an
/// administrator wrote that agrees with the exit code
/// ([`job::result_for`]). `Error::Cancelled` when the user declines the
/// prompt.
pub fn run_elevated_job(dirs: &AppDirs, ops: Vec<JobOp>) -> Result<JobResult> {
    let count = ops.len();
    let job = job::new_job(ops);
    let path = job::write_job(&dirs.jobs_dir(), &job)?;
    let code = std::env::current_exe()
        .map_err(Error::from)
        .and_then(|exe| {
            elevate::run_elevated(
                &exe,
                &["--elevated-apply".to_string(), path.display().to_string()],
            )
        });
    let _ = std::fs::remove_file(&path);
    let code = code?;
    let file = public_root().and_then(|root| {
        let file = job::result_file(&root.join(job::RESULTS_DIR), &job.id);
        access::read_admin_file(&file, job::MAX_RESULT_FILE_BYTES)
    });
    let file = file.unwrap_or_else(|e| {
        log::line(&format!(
            "elevated job {}: no usable result file: {e}",
            job.id
        ));
        None
    });
    Ok(job::result_for(&job.id, code, count, file.as_deref()))
}

/// `reskin.exe --restore-all [--quiet]` — restores every change, asking
/// once for administrator approval when Public-Desktop items need it (also
/// under `--quiet`, the uninstaller's run). Safe while the app runs: each
/// step is planned and recorded under the journal lock. Exit code
/// [`EXIT_OK`] when everything Reskin changed is back, [`EXIT_FAILED`]
/// otherwise — the uninstaller then keeps Reskin's data (and the icons that
/// are still in use).
pub fn restore_all(quiet: bool) -> i32 {
    com_init();
    if !quiet {
        crate::console::attach_parent();
    }
    let say = |text: &str| {
        if !quiet {
            println!("{text}");
        }
    };
    let dirs = AppDirs::from_env();
    let loaded = Journal::load(dirs.journal_file()).and_then(|mut journal| {
        // Settle changes interrupted by a crash first, or they would stay;
        // a change the running app is still making is left to it.
        let report = journal.reconcile_settled(restore::probe, IN_FLIGHT_GRACE)?;
        log::line(&format!("restore-all: reconcile {report:?}"));
        let steps = journal.restore_all_steps();
        Ok((journal, steps))
    });
    let (journal, steps) = match loaded {
        Ok(loaded) => loaded,
        Err(e) => {
            log::line(&format!("restore-all: journal unusable: {e}"));
            say(&format!("Reskin: could not read the journal: {e}"));
            return EXIT_FAILED;
        }
    };
    if steps.is_empty() {
        say("Reskin: nothing to restore.");
        return EXIT_OK;
    }
    let journal = Mutex::new(journal);
    let lock = || journal.lock().unwrap_or_else(|e| e.into_inner());
    let report = restore::execute_steps(
        &dirs,
        &lock,
        &restore::execute,
        &restore::is_gone,
        &mut |_, _| {},
        steps,
    );
    let icons = dirs.icons_dir();
    if let Err(e) = lock().locked(|j| j.gc_icons(&icons)) {
        log::line(&format!("restore-all: gc: {e}"));
    }
    log::line(&format!("restore-all: {report:?}"));
    say(&format!(
        "Reskin: restored {} icon(s); {} failed; {} need administrator approval.",
        report.restored,
        report.failed.len(),
        report.needs_elevation
    ));
    for f in &report.failed {
        say(&format!("  {f}"));
    }
    if report.failed.is_empty() && report.needs_elevation == 0 {
        EXIT_OK
    } else {
        EXIT_FAILED
    }
}

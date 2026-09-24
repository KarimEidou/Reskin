//! Helper modes that run without any window: the elevated icon writer and
//! "restore all" (used by the uninstaller), plus launching the elevated
//! helper from the app.
//!
//! "Restore all" never works with an administrator's rights: started with
//! them, it starts itself again as the desktop user and passes that run's
//! verdict on (see [`restore_all`]).
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
        urlfile::set_url_icon_in(&self.desktop, Path::new(target), icon)
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

/// Where `reskin.exe --restore-all` does its work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestoreAs {
    /// In this process, which acts with the user's own rights.
    Here,
    /// In Reskin started again as the desktop user: this process holds an
    /// administrator's full token (started from an elevated terminal or
    /// uninstaller) and must not use it on the user's files.
    DesktopUser,
    /// Nowhere: started again as the desktop user, it still holds an
    /// administrator's full token (the desktop shell runs elevated).
    Refused,
}

fn restore_as(uac_elevated: bool, relaunched: bool) -> RestoreAs {
    match (uac_elevated, relaunched) {
        (false, _) => RestoreAs::Here,
        (true, false) => RestoreAs::DesktopUser,
        (true, true) => RestoreAs::Refused,
    }
}

/// Why `--restore-all` does not run with administrator rights.
const NOT_AS_ADMIN: &str = "Reskin puts icons back with your own rights, not an administrator's: \
     with them it would write where anything you run can redirect it.";

/// What `--restore-all` run as administrator reports and returns once its
/// run as the desktop user ended with `code`.
fn desktop_user_verdict(code: i32) -> (i32, &'static str) {
    if code == EXIT_OK {
        (
            EXIT_OK,
            "Reskin: every icon it changed is back (restored with your own rights).",
        )
    } else {
        (
            EXIT_FAILED,
            "Reskin: not every icon could be put back. To see which, run \
             `reskin.exe --restore-all` again from a terminal that isn't run as administrator.",
        )
    }
}

/// `reskin.exe --restore-all [--quiet]` — restores every change, asking
/// once for administrator approval when Public-Desktop items need it (also
/// under `--quiet`, the uninstaller's run). Safe while the app runs: each
/// step is planned and recorded under the journal lock. Exit code
/// [`EXIT_OK`] when everything Reskin changed is back, [`EXIT_FAILED`]
/// otherwise — the uninstaller then keeps Reskin's data (and the icons that
/// are still in use).
///
/// Started with an administrator's full token (an elevated terminal or
/// uninstaller), it restores nothing itself — it would write the journal,
/// the icons folder and the user's shortcuts with administrator rights,
/// where the user can plant links, and read the history of whoever
/// approved the prompt — but starts itself again as the desktop user
/// (`relaunched`), waits and passes that run's exit code on. Public-Desktop
/// items still go through the elevated helper's checked jobs. When that
/// fails, it refuses with [`EXIT_FAILED`], so the uninstaller keeps the
/// data.
pub fn restore_all(quiet: bool, relaunched: bool) -> i32 {
    if !quiet {
        crate::console::attach_parent();
    }
    let say = |text: &str| {
        if !quiet {
            println!("{text}");
        }
    };
    match restore_as(elevate::is_uac_elevated(), relaunched) {
        RestoreAs::Here => restore_all_here(&say),
        // Nothing here writes, not even the log (`%TEMP%` is the user's).
        RestoreAs::DesktopUser => {
            let args = [
                "--restore-all".to_owned(),
                "--quiet".to_owned(),
                crate::cli::RELAUNCHED.to_owned(),
            ];
            let run = std::env::current_exe()
                .map_err(Error::from)
                .and_then(|exe| elevate::run_as_desktop_user(&exe, &args));
            match run {
                Ok(code) => {
                    let (code, verdict) = desktop_user_verdict(code);
                    say(verdict);
                    code
                }
                Err(e) => {
                    say(&format!(
                        "Reskin: {NOT_AS_ADMIN} It could not start itself without them ({e}); \
                         run it again from a terminal that isn't run as administrator."
                    ));
                    EXIT_FAILED
                }
            }
        }
        RestoreAs::Refused => {
            say(&format!(
                "Reskin: {NOT_AS_ADMIN} Run it again from a terminal that isn't run as \
                 administrator."
            ));
            EXIT_FAILED
        }
    }
}

/// `--restore-all` in this process (see [`restore_all`]).
fn restore_all_here(say: &dyn Fn(&str)) -> i32 {
    com_init();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_all_never_works_with_an_administrators_rights() {
        assert_eq!(restore_as(false, false), RestoreAs::Here);
        // Started again by an elevated run: it has the user's rights now.
        assert_eq!(restore_as(false, true), RestoreAs::Here);
        // From an elevated terminal or uninstaller: the desktop user's run
        // restores.
        assert_eq!(restore_as(true, false), RestoreAs::DesktopUser);
        // Still elevated after that (the desktop shell runs elevated): no
        // second start, and no restore as administrator either.
        assert_eq!(restore_as(true, true), RestoreAs::Refused);
    }

    #[test]
    fn the_desktop_users_run_decides_the_exit_code() {
        let (code, text) = desktop_user_verdict(EXIT_OK);
        assert_eq!(code, EXIT_OK);
        assert!(text.contains("every icon"), "{text}");
        // Anything else keeps the uninstaller from deleting Reskin's data.
        for failed in [EXIT_FAILED, EXIT_INVALID, 1, -1] {
            let (code, text) = desktop_user_verdict(failed);
            assert_eq!(code, EXIT_FAILED, "{failed}");
            assert!(text.contains("isn't run as administrator"), "{text}");
        }
    }
}

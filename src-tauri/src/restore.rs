//! Restore (undo one change, restore an item, restore everything), the
//! history list, icon refresh, and the startup journal reconcile.
//!
//! A restore may meet another Reskin process — `--restore-all` from a
//! terminal or the uninstaller while the app runs — so it works in
//! [`RestoreStep`]s: each is planned, carried out and recorded while
//! holding the journal lock ([`execute_steps`]). Public-Desktop steps are
//! planned under the lock, carried out by the elevated helper without it
//! (a UAC prompt may take minutes), and recorded under it again only if
//! they still plan the same.

use std::path::Path;
use std::sync::MutexGuard;

use reskin_core::history::{Journal, Probe, RestorePlan, RestoreStep, RestoreTo};
use reskin_core::model::{
    BoxProgress, HistoryEntry, RefreshLevel, RestoreReport, RestoreTarget, TargetKind,
};
use reskin_core::paths::AppDirs;
use reskin_core::win::{folder, notify, shortcut, sysicons, urlfile};
use reskin_core::{Error, job};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::CmdResult;
use crate::state::AppState;
use crate::windows::box_window;
use crate::{helper, log};

/// Writes one plan's target back (must run on an STA / COM thread).
pub fn execute(plan: &RestorePlan) -> reskin_core::Result<()> {
    let path = Path::new(&plan.target);
    match (&plan.to, plan.kind) {
        (RestoreTo::Delete, _) => {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
            notify::item_updated(path);
        }
        (RestoreTo::Original(o), TargetKind::Shortcut) => {
            shortcut::set_link_icon(path, o.location.as_deref().map(|l| (l, o.index)))?;
            notify::item_updated(path);
        }
        (RestoreTo::Original(o), TargetKind::InternetShortcut) => {
            urlfile::set_url_icon(path, o.location.as_deref().map(|l| (l, o.index)))?;
            notify::item_updated(path);
        }
        (RestoreTo::Original(o), TargetKind::Folder) => {
            let loc = o.location.as_deref().map(Path::new);
            folder::set_folder_icon(path, loc.map(|l| (l, o.index)))?;
            notify::item_updated(path);
        }
        (RestoreTo::Original(o), TargetKind::SystemIcon) => {
            let id = plan
                .system_icon
                .ok_or_else(|| Error::Other("system icon entry without an id".into()))?;
            sysicons::restore_system_icon(id, o)?;
            notify::assoc_changed();
        }
        (RestoreTo::Icon(icon), TargetKind::Shortcut) => {
            shortcut::set_link_icon(path, Some((icon, 0)))?;
            notify::item_updated(path);
        }
        (RestoreTo::Icon(icon), TargetKind::InternetShortcut) => {
            urlfile::set_url_icon(path, Some((icon, 0)))?;
            notify::item_updated(path);
        }
        (RestoreTo::Icon(icon), TargetKind::Folder) => {
            folder::set_folder_icon(path, Some((Path::new(icon), 0)))?;
            notify::item_updated(path);
        }
        (RestoreTo::Icon(icon), TargetKind::SystemIcon) => {
            let id = plan
                .system_icon
                .ok_or_else(|| Error::Other("system icon entry without an id".into()))?;
            sysicons::set_system_icon(id, Path::new(icon))?;
            notify::assoc_changed();
        }
        (RestoreTo::Original(_) | RestoreTo::Icon(_), TargetKind::CreatedShortcut) => {
            // Created shortcuts are only ever deleted.
            std::fs::remove_file(path)?;
            notify::item_updated(path);
        }
    }
    Ok(())
}

/// Whether the item `plan` restores is gone — deleted, or moved away —
/// while the drive or share it was on is there: its custom icon went with
/// it, so nothing is left to put back. An item on a drive (or share) that
/// is not reachable right now is not gone.
pub fn is_gone(plan: &RestorePlan) -> bool {
    if plan.kind == TargetKind::SystemIcon {
        return false;
    }
    let path = Path::new(&plan.target);
    let missing = matches!(
        std::fs::symlink_metadata(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound
    );
    missing && path.ancestors().last().is_some_and(Path::is_dir)
}

/// The helper op that restores an elevated (Public Desktop) plan.
fn elevated_op(plan: &RestorePlan) -> reskin_core::Result<job::JobOp> {
    let original = match &plan.to {
        RestoreTo::Original(o) => o.clone(),
        RestoreTo::Icon(icon) => reskin_core::model::OriginalIcon {
            location: Some(icon.clone()),
            index: 0,
            existed: true,
        },
        RestoreTo::Delete => {
            return Err(Error::Unsupported("cannot delete elevated targets".into()));
        }
    };
    job::JobOp::restore_icon(&plan.target, &original)
}

/// What became of one step run under the journal lock.
enum Ran {
    Restored,
    /// Nothing (left) to do: another process got there first, or the item
    /// is gone ([`is_gone`]).
    Nothing,
    /// A Public-Desktop step, left for the elevated helper.
    Elevated,
    Failed(String),
}

/// Carries out `steps` and reports how it went, calling `progress(done,
/// total)` after each; the last call has `done == total`.
///
/// `journal` hands out the journal (the app's behind its mutex, or
/// `--restore-all`'s own); `run` writes a plan's target back on a COM
/// thread; `gone` tells an item that no longer exists ([`is_gone`]): its
/// whole chain is recorded as restored without touching anything (there
/// is nothing to go back to), where it would otherwise fail on every
/// restore and make the uninstaller keep Reskin's data for good. Every
/// step is planned, run and recorded in one hold of the journal lock, so
/// it restores what the journal on disk says at that moment.
/// Public-Desktop steps then go to the elevated helper together
/// ([`execute_elevated`]).
pub fn execute_steps<'a>(
    dirs: &AppDirs,
    journal: &dyn Fn() -> MutexGuard<'a, Journal>,
    run: &dyn Fn(&RestorePlan) -> reskin_core::Result<()>,
    gone: &dyn Fn(&RestorePlan) -> bool,
    progress: &mut dyn FnMut(u32, u32),
    steps: Vec<RestoreStep>,
) -> RestoreReport {
    let total = steps.len() as u32;
    let mut report = RestoreReport::default();
    let mut elevated = Vec::new();
    let mut done = 0;
    for step in steps {
        let ran = journal().locked(|j| {
            let Some(plan) = j.plan_step(&step)? else {
                return Ok(Ran::Nothing);
            };
            if gone(&plan) {
                log::line(&format!("restore {}: the item is gone", plan.target));
                let chain = j.plan_restore_target(&plan.target).unwrap_or(plan);
                return j.finish_plan(&chain, true).map(|()| Ran::Nothing);
            }
            if plan.elevated {
                return Ok(Ran::Elevated);
            }
            match run(&plan) {
                Ok(()) => j.finish_plan(&plan, true).map(|()| Ran::Restored),
                Err(e) => {
                    log::line(&format!("restore {}: {e}", plan.target));
                    Ok(Ran::Failed(format!("{} — {e}", plan.name)))
                }
            }
        });
        match ran {
            Ok(Ran::Restored) => report.restored += 1,
            Ok(Ran::Nothing) => {}
            Ok(Ran::Elevated) => {
                elevated.push(step);
                continue;
            }
            Ok(Ran::Failed(why)) => report.failed.push(why),
            Err(e) => {
                log::line(&format!("restore {step:?}: {e}"));
                report.failed.push(e.to_string());
            }
        }
        done += 1;
        progress(done, total);
    }
    if !elevated.is_empty() {
        execute_elevated(dirs, journal, elevated, &mut report);
        progress(total, total);
    }
    report
}

/// Carries out Public-Desktop steps through the elevated helper, in jobs of
/// at most [`job::MAX_JOB_OPS`] ops (one UAC prompt each; a declined prompt
/// ends the batch). The last job also deletes the Public-Desktop icons that
/// no entry needs once the steps are done ([`Journal::icons_released_by`]);
/// the helper keeps any a Public Desktop shortcut still shows.
fn execute_elevated<'a>(
    dirs: &AppDirs,
    journal: &dyn Fn() -> MutexGuard<'a, Journal>,
    steps: Vec<RestoreStep>,
    report: &mut RestoreReport,
) {
    let icons_dir = helper::public_icons_dir();
    let planned = journal().locked(|j| {
        let mut plans = Vec::new();
        let mut failed = Vec::new();
        for step in steps {
            match j.plan_step(&step) {
                Ok(Some(plan)) => plans.push((step, plan)),
                Ok(None) => {}
                Err(e) => failed.push(e.to_string()),
            }
        }
        let just_plans: Vec<RestorePlan> = plans.iter().map(|(_, p)| p.clone()).collect();
        let released = match &icons_dir {
            Ok(dir) => j.icons_released_by(&just_plans, &dir.display().to_string()),
            Err(_) => Vec::new(),
        };
        Ok((plans, failed, released))
    });
    let (plans, failed, released) = match planned {
        Ok(planned) => planned,
        Err(e) => {
            report.failed.push(e.to_string());
            return;
        }
    };
    report.failed.extend(failed);
    let mut runs: Vec<(job::JobOp, RestoreStep, RestorePlan)> = Vec::new();
    for (step, plan) in plans {
        match elevated_op(&plan) {
            Ok(op) => runs.push((op, step, plan)),
            Err(e) => report.failed.push(format!("{} — {e}", plan.name)),
        }
    }
    let chunks: Vec<_> = runs.chunks(job::MAX_JOB_OPS).collect();
    for (n, chunk) in chunks.iter().enumerate() {
        let mut ops: Vec<job::JobOp> = chunk.iter().map(|(op, _, _)| op.clone()).collect();
        if n + 1 == chunks.len()
            && let Ok(dir) = &icons_dir
        {
            ops.extend(unused_public_icons(
                dir,
                &released,
                job::MAX_JOB_OPS - ops.len(),
            ));
        }
        match helper::run_elevated_job(dirs, ops) {
            Ok(result) => record_elevated(journal, chunk, &result, report),
            Err(Error::Cancelled) => {
                let left: usize = chunks[n..].iter().map(|c| c.len()).sum();
                report.needs_elevation += left as u32;
                return;
            }
            Err(e) => {
                for (_, _, plan) in chunk.iter() {
                    report.failed.push(format!("{} — {e}", plan.name));
                }
            }
        }
    }
}

/// Delete ops for the `released` icons that still exist in `dir` (the app
/// can see them, not delete them), at most `room`.
fn unused_public_icons(dir: &Path, released: &[String], room: usize) -> Vec<job::JobOp> {
    released
        .iter()
        .filter(|name| dir.join(name).is_file())
        .take(room)
        .map(|name| job::JobOp::delete_icon(name))
        .collect()
}

/// Records the helper's results for `chunk` (its first ops, in order):
/// a step it restored is finished if it still plans the same — else the
/// journal changed during the prompt and the step is reported instead.
fn record_elevated<'a>(
    journal: &dyn Fn() -> MutexGuard<'a, Journal>,
    chunk: &[(job::JobOp, RestoreStep, RestorePlan)],
    result: &job::JobResult,
    report: &mut RestoreReport,
) {
    let recorded = journal().locked(|j| {
        let mut restored = 0;
        let mut failed = Vec::new();
        for (i, (_, step, plan)) in chunk.iter().enumerate() {
            let outcome = result.results.get(i);
            if !outcome.is_some_and(|o| o.ok) {
                let why = outcome
                    .map(|o| o.message.clone())
                    .or_else(|| result.error.clone())
                    .unwrap_or_default();
                failed.push(format!("{} — {why}", plan.name));
                continue;
            }
            let still = j.plan_step(step).ok().flatten();
            if still.as_ref() == Some(plan) && j.finish_plan(plan, true).is_ok() {
                restored += 1;
            } else {
                failed.push(format!(
                    "{} — its history changed while Windows asked for approval; restore it again",
                    plan.name
                ));
            }
        }
        Ok((restored, failed))
    });
    match recorded {
        Ok((restored, failed)) => {
            report.restored += restored;
            report.failed.extend(failed);
        }
        Err(e) => {
            for (_, _, plan) in chunk {
                report.failed.push(format!(
                    "{} — restored, but the history could not record it: {e}",
                    plan.name
                ));
            }
        }
    }
}

/// The steps `target` stands for, planned from the journal on disk.
fn steps_for<R: Runtime>(
    app: &AppHandle<R>,
    target: &RestoreTarget,
) -> Result<Vec<RestoreStep>, String> {
    let state = app.state::<AppState>();
    if let RestoreTarget::Item { item } = target {
        let rec = state.items.get(item).ok_or("unknown item")?;
        let key = match (rec.system_icon, &rec.path) {
            (Some(id), _) => id.slug().to_string(),
            (None, Some(p)) => p.display().to_string(),
            (None, None) => return Err("item has no target".into()),
        };
        return Ok(vec![RestoreStep::Target(key)]);
    }
    state
        .journal()
        .locked(|j| match target {
            RestoreTarget::Entry { id } => j.undo_steps(id),
            _ => Ok(j.restore_all_steps()),
        })
        .map_err(|e| e.to_string())
}

pub fn restore_blocking<R: Runtime>(
    app: &AppHandle<R>,
    target: &RestoreTarget,
) -> Result<RestoreReport, String> {
    let steps = steps_for(app, target)?;
    let state = app.state::<AppState>();
    let sta = state.sta.clone();
    let run = move |p: &RestorePlan| -> reskin_core::Result<()> {
        let p = p.clone();
        sta.run(move || execute(&p))?
    };
    let journal = || state.journal();
    // Restore all shows its progress on the box (the batch ring).
    let all = matches!(target, RestoreTarget::All);
    let mut progress = |done: u32, total: u32| {
        if all {
            let _ = app.emit_to(
                box_window::LABEL,
                "box:progress",
                BoxProgress { done, total },
            );
        }
    };
    let report = execute_steps(&state.dirs, &journal, &run, &is_gone, &mut progress, steps);
    // Items whose chain is gone are no longer "reskinned".
    if let RestoreTarget::Item { item } = target {
        state.items.update(item, |i| i.reskinned = false);
    }
    gc(&state);
    Ok(report)
}

pub fn restore_all_blocking<R: Runtime>(app: &AppHandle<R>) -> RestoreReport {
    restore_blocking(app, &RestoreTarget::All).unwrap_or_else(|e| RestoreReport {
        failed: vec![e],
        ..Default::default()
    })
}

/// Deletes unused icons of the user's own icons folder.
fn gc(state: &AppState) {
    let dir = state.dirs.icons_dir();
    match state.journal().locked(|j| j.gc_icons(&dir)) {
        Ok(n) if n > 0 => log::line(&format!("gc: removed {n} unused icon(s)")),
        Ok(_) => {}
        Err(e) => log::line(&format!("gc: {e}")),
    }
}

#[tauri::command]
pub async fn restore(app: AppHandle, target: RestoreTarget) -> CmdResult<RestoreReport> {
    tauri::async_runtime::spawn_blocking(move || restore_blocking(&app, &target))
        .await
        .map_err(|e| e.to_string())?
}

/// Every journal entry, newest first — as on disk, so changes another
/// Reskin process made (`--restore-all`) show up.
#[tauri::command]
pub async fn history_list(app: AppHandle) -> CmdResult<Vec<HistoryEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut journal = state.journal();
        if let Err(e) = journal.refresh() {
            log::line(&format!("history: {e}"));
        }
        let mut v: Vec<HistoryEntry> = journal.entries().to_vec();
        v.reverse();
        v
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_icons(app: AppHandle, level: RefreshLevel) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state
            .sta
            .run(move || match level {
                RefreshLevel::Notify => {
                    notify::assoc_changed();
                    Ok(())
                }
                RefreshLevel::Rebuild => notify::rebuild_icon_cache(),
            })
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Current icon location of a journal target (for reconcile).
fn current_location(e: &HistoryEntry) -> reskin_core::Result<Option<String>> {
    let path = Path::new(&e.target);
    Ok(match e.kind {
        TargetKind::Shortcut | TargetKind::CreatedShortcut => {
            if !path.exists() {
                return Err(Error::NotFound(e.target.clone()));
            }
            if path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("url"))
            {
                urlfile::read_url_icon(path)?.0
            } else {
                shortcut::read_link(path)?.icon_location
            }
        }
        TargetKind::InternetShortcut => urlfile::read_url_icon(path)?.0,
        TargetKind::Folder => folder::read_folder_icon(path)?.map(|(l, _)| l),
        TargetKind::SystemIcon => {
            let id = e
                .system_icon
                .ok_or_else(|| Error::Other("system icon entry without an id".into()))?;
            sysicons::read_system_icon(id)?.location
        }
    })
}

/// What a pending entry's target points at now (for `reconcile`).
pub fn probe(e: &HistoryEntry) -> Probe {
    match current_location(e) {
        Ok(Some(loc))
            if Path::new(&loc) == Path::new(&e.icon_path)
                || loc.eq_ignore_ascii_case(&e.icon_path) =>
        {
            Probe::PointsToIcon
        }
        Ok(_) => Probe::PointsElsewhere,
        Err(_) => Probe::Missing,
    }
}

/// After a crash between journaling and committing, settle pending
/// entries by looking at what the targets actually point at.
pub fn reconcile_at_startup<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    let pending: Vec<HistoryEntry> = state.journal().pending().into_iter().cloned().collect();
    if pending.is_empty() {
        gc(&state);
        return;
    }
    let probes: Vec<(String, Probe)> = state
        .sta
        .run(move || pending.iter().map(|e| (e.id.clone(), probe(e))).collect())
        .unwrap_or_default();
    let report = state.journal().reconcile(|e| {
        probes
            .iter()
            .find(|(id, _)| *id == e.id)
            .map(|(_, p)| *p)
            .unwrap_or(Probe::Missing)
    });
    log::line(&format!("journal reconcile: {report:?}"));
    gc(&state);
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use reskin_core::history::NewEntry;
    use reskin_core::model::{EntryState, OriginalIcon};

    use super::*;

    fn apply(journal: &mut Journal, target: &str) -> String {
        let id = journal
            .begin(NewEntry {
                kind: TargetKind::Shortcut,
                target: target.into(),
                name: reskin_core::paths::file_name_of(target).into(),
                system_icon: None,
                icon_path: format!("{target}.ico"),
                original: OriginalIcon::default(),
                elevated: false,
                thumb: None,
                design_name: None,
                group: None,
            })
            .unwrap();
        journal.commit(&id).unwrap();
        id
    }

    #[test]
    fn each_step_restores_what_the_journal_on_disk_says_and_reports_progress() {
        let root = std::env::temp_dir().join(format!(
            "reskin-restore-steps-{}-{}",
            std::process::id(),
            reskin_core::now_ms() as u64
        ));
        let dirs = AppDirs::at(&root);
        let [a, b, c] = [
            r"C:\Users\Kim\Desktop\A.lnk",
            r"C:\Users\Kim\Desktop\B.lnk",
            r"C:\Users\Kim\Desktop\C.lnk",
        ];
        let mut app = Journal::load(dirs.journal_file()).unwrap();
        let ids = [a, b, c].map(|t| apply(&mut app, t));
        let steps = app.restore_all_steps();
        // Another Reskin process restores B before the steps run.
        let mut other = Journal::load(dirs.journal_file()).unwrap();
        let plan = other.plan_restore_target(b).unwrap();
        other.finish_plan(&plan, true).unwrap();

        let journal = Mutex::new(app);
        let lock = || journal.lock().unwrap();
        let ran = RefCell::new(Vec::new());
        let run = |plan: &RestorePlan| {
            ran.borrow_mut().push(plan.target.clone());
            if plan.target == c {
                Err(Error::AccessDenied("read-only".into()))
            } else {
                Ok(())
            }
        };
        let mut progress = Vec::new();
        let report = execute_steps(
            &dirs,
            &lock,
            &run,
            &|_| false,
            &mut |d, t| progress.push((d, t)),
            steps,
        );

        assert_eq!(*ran.borrow(), [a, c]);
        assert_eq!(report.restored, 1);
        assert_eq!(report.failed.len(), 1);
        assert!(
            report.failed[0].starts_with("C.lnk — "),
            "{:?}",
            report.failed
        );
        assert_eq!(report.needs_elevation, 0);
        assert_eq!(progress, [(1, 3), (2, 3), (3, 3)]);
        let on_disk = Journal::load(dirs.journal_file()).unwrap();
        let states = ids.map(|id| on_disk.get(&id).unwrap().state);
        assert_eq!(
            states,
            [
                EntryState::Restored,
                EntryState::Restored,
                EntryState::Applied
            ]
        );
        drop(journal);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_item_that_is_gone_is_recorded_as_restored_without_touching_it() {
        let root = std::env::temp_dir().join(format!(
            "reskin-restore-gone-{}-{}",
            std::process::id(),
            reskin_core::now_ms() as u64
        ));
        let dirs = AppDirs::at(&root);
        let [kept, deleted] = [
            r"C:\Users\Kim\Desktop\Kept.lnk",
            r"C:\Users\Kim\Desktop\Deleted.lnk",
        ];
        let mut app = Journal::load(dirs.journal_file()).unwrap();
        let kept_id = apply(&mut app, kept);
        // Reskinned twice, then deleted by the user.
        let chain = [apply(&mut app, deleted), apply(&mut app, deleted)];
        // Undo the newer change (as the History does), then restore the rest.
        let mut steps = app.undo_steps(&chain[1]).unwrap();
        steps.push(RestoreStep::Target(kept.into()));

        let journal = Mutex::new(app);
        let lock = || journal.lock().unwrap();
        let ran = RefCell::new(Vec::new());
        let run = |plan: &RestorePlan| {
            ran.borrow_mut().push(plan.target.clone());
            Ok(())
        };
        let gone = |plan: &RestorePlan| plan.target == deleted;
        let mut progress = Vec::new();
        let report = execute_steps(
            &dirs,
            &lock,
            &run,
            &gone,
            &mut |d, t| progress.push((d, t)),
            steps,
        );

        // Nothing is written for the deleted item and nothing fails, so a
        // restore — the uninstaller's too — finds everything back; with
        // nothing to go back to, its whole chain is done.
        assert_eq!(*ran.borrow(), [kept]);
        assert_eq!(report.restored, 1);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(report.needs_elevation, 0);
        assert_eq!(progress, [(1, 2), (2, 2)]);
        let on_disk = Journal::load(dirs.journal_file()).unwrap();
        for id in chain.iter().chain([&kept_id]) {
            assert_eq!(on_disk.get(id).unwrap().state, EntryState::Restored);
        }
        assert!(on_disk.restore_all_steps().is_empty());
        drop(journal);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_missing_item_on_a_drive_that_is_there_is_gone() {
        let root = std::env::temp_dir().join(format!(
            "reskin-is-gone-{}-{}",
            std::process::id(),
            reskin_core::now_ms() as u64
        ));
        std::fs::create_dir_all(&root).unwrap();
        let plan = |kind: TargetKind, target: &Path| RestorePlan {
            entry_id: "e".into(),
            kind,
            target: target.display().to_string(),
            name: "Item".into(),
            system_icon: None,
            elevated: false,
            to: RestoreTo::Original(OriginalIcon::default()),
            scope: reskin_core::history::PlanScope::Full {
                chain: vec!["e".into()],
            },
        };
        let there = root.join("There.lnk");
        std::fs::write(&there, b"x").unwrap();
        assert!(!is_gone(&plan(TargetKind::Shortcut, &there)));
        assert!(!is_gone(&plan(TargetKind::Folder, &root)));
        assert!(is_gone(&plan(
            TargetKind::Shortcut,
            &root.join("Deleted.lnk")
        )));
        // Its folder went too.
        assert!(is_gone(&plan(TargetKind::Folder, &root.join(r"Games\Old"))));
        // A drive that isn't connected: the item may come back with it.
        let unplugged = ('D'..='Z')
            .map(|d| PathBuf::from(format!(r"{d}:\")))
            .find(|drive| !drive.exists())
            .expect("a free drive letter");
        assert!(!is_gone(&plan(
            TargetKind::Shortcut,
            &unplugged.join(r"Desktop\App.lnk")
        )));
        // System icons are always there.
        assert!(!is_gone(&plan(
            TargetKind::SystemIcon,
            Path::new("this-pc")
        )));
        let _ = std::fs::remove_dir_all(&root);
    }
}

//! Restore (undo one change, restore an item, restore everything), the
//! history list, icon refresh, and the startup journal reconcile.

use std::path::Path;

use reskin_core::history::{Probe, RestorePlan, RestoreTo};
use reskin_core::model::{HistoryEntry, RefreshLevel, RestoreReport, RestoreTarget, TargetKind};
use reskin_core::paths::AppDirs;
use reskin_core::win::{folder, notify, shortcut, sysicons, urlfile};
use reskin_core::{Error, job};
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::CmdResult;
use crate::state::AppState;
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

/// Executes plans: normal ones on the STA, elevated ones through one
/// helper run (one UAC prompt) when `allow_elevation`.
pub fn execute_plans(
    dirs: &AppDirs,
    plans: Vec<RestorePlan>,
    allow_elevation: bool,
    run_sta: &dyn Fn(RestorePlan) -> reskin_core::Result<()>,
    finish: &mut dyn FnMut(&RestorePlan, bool),
) -> RestoreReport {
    let mut report = RestoreReport::default();
    let (elevated, normal): (Vec<_>, Vec<_>) = plans.into_iter().partition(|p| p.elevated);
    for plan in normal {
        match run_sta(plan.clone()) {
            Ok(()) => {
                report.restored += 1;
                finish(&plan, true);
            }
            Err(e) => {
                log::line(&format!("restore {}: {e}", plan.target));
                report.failed.push(format!("{} — {e}", plan.name));
                finish(&plan, false);
            }
        }
    }
    if elevated.is_empty() {
        return report;
    }
    if !allow_elevation {
        report.needs_elevation += elevated.len() as u32;
        return report;
    }
    let mut ops = Vec::new();
    let mut with_ops = Vec::new();
    for plan in elevated {
        match elevated_op(&plan) {
            Ok(op) => {
                ops.push(op);
                with_ops.push(plan);
            }
            Err(e) => report.failed.push(format!("{} — {e}", plan.name)),
        }
    }
    match helper::run_elevated_job(dirs, ops) {
        Ok(result) => {
            for (i, plan) in with_ops.iter().enumerate() {
                let ok = result.results.get(i).is_some_and(|r| r.ok);
                if ok {
                    report.restored += 1;
                } else {
                    let why = result
                        .results
                        .get(i)
                        .map(|r| r.message.clone())
                        .or_else(|| result.error.clone())
                        .unwrap_or_default();
                    report.failed.push(format!("{} — {why}", plan.name));
                }
                finish(plan, ok);
            }
        }
        Err(Error::Cancelled) => report.needs_elevation += with_ops.len() as u32,
        Err(e) => {
            for plan in &with_ops {
                report.failed.push(format!("{} — {e}", plan.name));
            }
        }
    }
    report
}

fn plans_for<R: Runtime>(
    app: &AppHandle<R>,
    target: &RestoreTarget,
) -> Result<Vec<RestorePlan>, String> {
    let state = app.state::<AppState>();
    let journal = state.journal();
    Ok(match target {
        RestoreTarget::Entry { id } => vec![journal.plan_undo(id).map_err(|e| e.to_string())?],
        RestoreTarget::Item { item } => {
            let rec = state.items.get(item).ok_or("unknown item")?;
            let key = match (rec.system_icon, &rec.path) {
                (Some(id), _) => id.slug().to_string(),
                (None, Some(p)) => p.display().to_string(),
                (None, None) => return Err("item has no target".into()),
            };
            journal.plan_restore_target(&key).into_iter().collect()
        }
        RestoreTarget::All => journal.plan_restore_all(),
    })
}

pub fn restore_blocking<R: Runtime>(
    app: &AppHandle<R>,
    target: &RestoreTarget,
) -> Result<RestoreReport, String> {
    let plans = plans_for(app, target)?;
    let state = app.state::<AppState>();
    let sta = state.sta.clone();
    let run = move |p: RestorePlan| -> reskin_core::Result<()> { sta.run(move || execute(&p))? };
    let mut finish = |p: &RestorePlan, ok: bool| {
        if let Err(e) = state.journal().finish_plan(p, ok) {
            log::line(&format!("journal finish_plan: {e}"));
        }
    };
    let report = execute_plans(&state.dirs, plans, true, &run, &mut finish);
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

fn gc(state: &AppState) {
    let journal = state.journal();
    match journal.gc_icons_older_than(&state.dirs.icons_dir(), reskin_core::history::GC_GRACE) {
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

/// Every journal entry, newest first.
#[tauri::command]
pub fn history_list(app: AppHandle) -> Vec<HistoryEntry> {
    let state = app.state::<AppState>();
    let mut v: Vec<HistoryEntry> = state.journal().entries().to_vec();
    v.reverse();
    v
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

fn probe(e: &HistoryEntry) -> Probe {
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
    if state.journal().pending().is_empty() {
        gc(&state);
        return;
    }
    let pending: Vec<HistoryEntry> = state.journal().pending().into_iter().cloned().collect();
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

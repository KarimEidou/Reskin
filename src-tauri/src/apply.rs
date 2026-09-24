//! Save & Apply: build the `.ico`, journal the change, check access, then
//! commit — at the moment the box "drops" the icon on the desktop when the
//! flourish plays, immediately otherwise.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reskin_core::history::NewEntry;
use reskin_core::model::{
    Access, ApplyMode, ApplyOutcome, ApplyRequest, BoxFlight, CollapseThen, DesktopSpot, ExportKind,
    ExportRequest, FlightPhase, HistoryEntry, ItemKind, MotionPref, OriginalIcon, SizedPng, SystemIconId,
    TargetKind,
};
use reskin_core::pixels::b64_decode;
use reskin_core::win::{desktop, folder, known, notify, shortcut, sysicons, urlfile};
use reskin_core::{Error, ico, job, store};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::commands::CmdResult;
use crate::items::ItemRecord;
use crate::state::AppState;
use crate::windows::{box_window, morph, raw};
use crate::{helper, log};

/// How long an elevation ticket stays valid.
const TICKET_TTL: Duration = Duration::from_secs(10 * 60);

/// An apply waiting for the user to approve elevation.
pub struct PendingElevation {
    rec: ItemRecord,
    ico: Vec<u8>,
    thumb: Option<String>,
    design_name: Option<String>,
    preview: Option<String>,
    flourish: bool,
    created: Instant,
}

#[derive(Default)]
pub struct Elevations(Mutex<HashMap<String, PendingElevation>>);

impl Elevations {
    fn put(&self, p: PendingElevation) -> String {
        let ticket = store::new_id();
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|_, v| v.created.elapsed() < TICKET_TTL);
        g.insert(ticket.clone(), p);
        ticket
    }

    fn take(&self, ticket: &str) -> Option<PendingElevation> {
        let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.remove(ticket).filter(|p| p.created.elapsed() < TICKET_TTL)
    }
}

/// What an apply changes.
#[derive(Debug, Clone)]
enum Target {
    /// `.lnk` (url=false) or `.url` (url=true) in place.
    Link { path: PathBuf, url: bool },
    Folder { path: PathBuf },
    System { id: SystemIconId },
    /// A new desktop shortcut with the icon.
    NewShortcut {
        dest: PathBuf,
        target: PathBuf,
        args: String,
        description: String,
    },
    /// Copy of a (Public Desktop) link on the user's desktop.
    PersonalCopy { src: PathBuf, dest: PathBuf, url: bool },
}

impl Target {
    fn journal_target(&self) -> String {
        match self {
            Target::Link { path, .. } | Target::Folder { path } => path.display().to_string(),
            Target::System { id } => id.slug().to_string(),
            Target::NewShortcut { dest, .. } | Target::PersonalCopy { dest, .. } => dest.display().to_string(),
        }
    }

    fn kind(&self) -> TargetKind {
        match self {
            Target::Link { url: false, .. } => TargetKind::Shortcut,
            Target::Link { url: true, .. } => TargetKind::InternetShortcut,
            Target::Folder { .. } => TargetKind::Folder,
            Target::System { .. } => TargetKind::SystemIcon,
            Target::NewShortcut { .. } | Target::PersonalCopy { .. } => TargetKind::CreatedShortcut,
        }
    }

    /// The file whose desktop icon shows the change (for the flight).
    fn desktop_path(&self) -> Option<&Path> {
        match self {
            Target::Link { path, .. } | Target::Folder { path } => Some(path),
            Target::NewShortcut { dest, .. } | Target::PersonalCopy { dest, .. } => Some(dest),
            Target::System { .. } => None,
        }
    }
}

/// `<desktop>\<stem><ext>`, or `<stem> (2)<ext>` … when taken.
fn unique_on_desktop(stem: &str, ext: &str) -> Result<PathBuf, String> {
    let desktop = known::desktop().map_err(|e| e.to_string())?;
    let clean: String = stem
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_end_matches('.');
    let clean = if clean.is_empty() { "Reskin" } else { clean };
    for n in 1..1000 {
        let name = if n == 1 {
            format!("{clean}{ext}")
        } else {
            format!("{clean} ({n}){ext}")
        };
        let p = desktop.join(name);
        if !p.exists() {
            return Ok(p);
        }
    }
    Err("could not find a free file name on the desktop".into())
}

fn resolve_target<R: Runtime>(app: &AppHandle<R>, rec: &ItemRecord, mode: ApplyMode) -> Result<Target, ApplyOutcome> {
    let unsupported = |why: &str| ApplyOutcome::Unsupported { reason: why.into() };
    if !rec.info.modes.contains(&mode) {
        return Err(unsupported("That kind of change isn't possible for this item."));
    }
    let path = rec.path.clone();
    match (rec.info.kind, mode) {
        (ItemKind::Shortcut, ApplyMode::InPlace) => Ok(Target::Link {
            path: path.ok_or_else(|| unsupported("missing path"))?,
            url: false,
        }),
        (ItemKind::InternetShortcut, ApplyMode::InPlace) => Ok(Target::Link {
            path: path.ok_or_else(|| unsupported("missing path"))?,
            url: true,
        }),
        (ItemKind::Folder, ApplyMode::InPlace) => Ok(Target::Folder {
            path: path.ok_or_else(|| unsupported("missing path"))?,
        }),
        (ItemKind::SystemIcon, ApplyMode::InPlace) => Ok(Target::System {
            id: rec.system_icon.ok_or_else(|| unsupported("missing system icon"))?,
        }),
        (ItemKind::Executable | ItemKind::File, ApplyMode::NewShortcut) => {
            let target = path.ok_or_else(|| unsupported("missing path"))?;
            let dest = unique_on_desktop(&rec.info.name, ".lnk").map_err(|e| unsupported(&e))?;
            Ok(Target::NewShortcut {
                dest,
                description: format!("{} (Reskin)", rec.info.name),
                target,
                args: String::new(),
            })
        }
        (ItemKind::Shortcut, ApplyMode::NewShortcut) => {
            // A classic shortcut for a Store app: explorer.exe shell:AppsFolder\<AUMID>.
            let src = path.ok_or_else(|| unsupported("missing path"))?;
            let state = app.state::<AppState>();
            let link = state
                .sta
                .run(move || shortcut::read_link(&src))
                .map_err(|e| unsupported(&e.to_string()))?
                .map_err(|e| unsupported(&e.to_string()))?;
            let aumid = link
                .app_user_model_id
                .ok_or_else(|| unsupported("This shortcut has no app id to link to."))?;
            let windir = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            let dest = unique_on_desktop(&rec.info.name, ".lnk").map_err(|e| unsupported(&e))?;
            Ok(Target::NewShortcut {
                dest,
                target: PathBuf::from(windir).join("explorer.exe"),
                args: format!("shell:AppsFolder\\{aumid}"),
                description: format!("{} (Reskin)", rec.info.name),
            })
        }
        (ItemKind::Shortcut | ItemKind::InternetShortcut, ApplyMode::PersonalCopy) => {
            let src = path.ok_or_else(|| unsupported("missing path"))?;
            let url = rec.info.kind == ItemKind::InternetShortcut;
            let dest = unique_on_desktop(&rec.info.name, if url { ".url" } else { ".lnk" }).map_err(|e| unsupported(&e))?;
            Ok(Target::PersonalCopy { src, dest, url })
        }
        _ => Err(unsupported("That kind of change isn't possible for this item.")),
    }
}

/// The icon a target has right now (captured before changing it).
fn read_original(target: &Target) -> reskin_core::Result<OriginalIcon> {
    match target {
        Target::Link { path, url: false } => {
            let l = shortcut::read_link(path)?;
            let location = l.icon_location.filter(|s| !s.is_empty());
            Ok(OriginalIcon {
                existed: location.is_some(),
                location,
                index: l.icon_index,
            })
        }
        Target::Link { path, url: true } => {
            let (location, index) = urlfile::read_url_icon(path)?;
            let location = location.filter(|s| !s.is_empty());
            Ok(OriginalIcon {
                existed: location.is_some(),
                location,
                index,
            })
        }
        Target::Folder { path } => Ok(match folder::read_folder_icon(path)? {
            Some((location, index)) => OriginalIcon {
                location: Some(location),
                index,
                existed: true,
            },
            None => OriginalIcon::default(),
        }),
        Target::System { id } => sysicons::read_system_icon(*id),
        Target::NewShortcut { .. } | Target::PersonalCopy { .. } => Ok(OriginalIcon::default()),
    }
}

/// Performs the change (on the STA thread) and notifies the shell.
fn commit(target: &Target, icon: &Path) -> reskin_core::Result<()> {
    let icon_str = icon.display().to_string();
    match target {
        Target::Link { path, url: false } => {
            shortcut::set_link_icon(path, Some((&icon_str, 0)))?;
            notify::item_updated(path);
        }
        Target::Link { path, url: true } => {
            urlfile::set_url_icon(path, Some((&icon_str, 0)))?;
            notify::item_updated(path);
        }
        Target::Folder { path } => {
            folder::set_folder_icon(path, Some((icon, 0)))?;
            notify::item_updated(path);
        }
        Target::System { id } => {
            sysicons::set_system_icon(*id, icon)?;
            notify::assoc_changed();
        }
        Target::NewShortcut {
            dest,
            target,
            args,
            description,
        } => {
            shortcut::create_link(dest, target, args, Some((icon, 0)), description)?;
            notify::item_updated(dest);
        }
        Target::PersonalCopy { src, dest, url } => {
            std::fs::copy(src, dest)?;
            let r = if *url {
                urlfile::set_url_icon(dest, Some((&icon_str, 0)))
            } else {
                shortcut::set_link_icon(dest, Some((&icon_str, 0)))
            };
            if let Err(e) = r {
                let _ = std::fs::remove_file(dest);
                return Err(e);
            }
            notify::item_updated(dest);
        }
    }
    Ok(())
}

fn largest(images: &[SizedPng]) -> Option<&SizedPng> {
    images.iter().max_by_key(|i| i.size)
}

fn thumb(images: &[SizedPng]) -> Option<String> {
    images
        .iter()
        .filter(|i| i.size >= 48)
        .min_by_key(|i| i.size)
        .or_else(|| largest(images))
        .map(|i| i.png.clone())
}

fn failed(e: &Error) -> ApplyOutcome {
    let hint = match e {
        Error::AccessDenied(_) => Some(
            "Windows blocked the change. Try again with administrator approval, or make a personal copy.".into(),
        ),
        Error::NotFound(_) => Some("The item was moved or deleted. Drop it on the box again.".into()),
        _ => None,
    };
    ApplyOutcome::Failed {
        message: e.to_string(),
        hint,
    }
}

fn flourish_enabled(state: &AppState, requested: bool) -> bool {
    let s = state.settings();
    let reduced = match s.motion {
        MotionPref::Reduced => true,
        MotionPref::Full => false,
        MotionPref::System => state.system_reduced_motion(),
    };
    requested && s.flourish && !reduced && !state.box_hidden_by_user()
}

fn emit_flight<R: Runtime>(app: &AppHandle<R>, phase: FlightPhase, icon: Option<String>, ms: u32, message: Option<String>) {
    let _ = app.emit_to(
        box_window::LABEL,
        "box:flight",
        BoxFlight {
            phase,
            icon,
            duration_ms: ms,
            message,
        },
    );
}

#[tauri::command]
pub async fn apply_icon(app: AppHandle, req: ApplyRequest) -> CmdResult<ApplyOutcome> {
    tauri::async_runtime::spawn_blocking(move || apply_blocking(&app, req))
        .await
        .map_err(|e| e.to_string())
}

fn apply_blocking<R: Runtime>(app: &AppHandle<R>, req: ApplyRequest) -> ApplyOutcome {
    let state = app.state::<AppState>();
    let Some(rec) = state.items.get(&req.item) else {
        return ApplyOutcome::Failed {
            message: "Unknown item — drop it on the box again.".into(),
            hint: None,
        };
    };
    let ico = match ico::build_ico_from_pngs(&req.images) {
        Ok(b) => b,
        Err(e) => {
            return ApplyOutcome::Failed {
                message: format!("Could not build the icon: {e}"),
                hint: None,
            };
        }
    };
    let preview = largest(&req.images).map(|i| format!("data:image/png;base64,{}", i.png));
    let target = match resolve_target(app, &rec, req.mode) {
        Ok(t) => t,
        Err(outcome) => return outcome,
    };
    if matches!(target, Target::Link { .. }) && rec.info.access == Access::NeedsElevation {
        let ticket = state.elevations.put(PendingElevation {
            rec: rec.clone(),
            ico,
            thumb: thumb(&req.images),
            design_name: req.design_name.clone(),
            preview,
            flourish: req.flourish,
            created: Instant::now(),
        });
        return ApplyOutcome::NeedsElevation {
            ticket,
            reason: format!(
                "\"{}\" is on the Public Desktop, shared by all users. Changing it needs administrator approval.",
                rec.info.name
            ),
        };
    }

    let icon_path = match store::store_icon(&state.dirs.icons_dir(), &rec.info.name, &ico) {
        Ok(p) => p,
        Err(e) => return failed(&e),
    };
    let t2 = target.clone();
    let original = match state.sta.run(move || read_original(&t2)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return failed(&e),
        Err(e) => return failed(&e),
    };
    let entry_id = {
        let mut j = state.journal();
        match j.begin(NewEntry {
            kind: target.kind(),
            target: target.journal_target(),
            name: rec.info.name.clone(),
            system_icon: rec.system_icon,
            icon_path: icon_path.display().to_string(),
            original,
            elevated: false,
            thumb: thumb(&req.images),
            design_name: req.design_name.clone(),
        }) {
            Ok(id) => id,
            Err(e) => return failed(&e),
        }
    };

    let do_commit = {
        let target = target.clone();
        let icon_path = icon_path.clone();
        let state_sta = state.sta.clone();
        move || -> reskin_core::Result<()> {
            let t = target.clone();
            let p = icon_path.clone();
            state_sta.run(move || commit(&t, &p))?
        }
    };
    let flourish = flourish_enabled(&state, req.flourish) && state.morph.phase() == morph::Phase::Open;
    let (result, landed) = if flourish {
        run_flourish(app, &target, preview.clone(), do_commit)
    } else {
        (do_commit(), false)
    };
    let outcome = finish(app, &rec, &entry_id, result, landed);
    if let ApplyOutcome::Applied { .. } = &outcome
        && req.update_pins
        && let Target::Link { path, url: false } = &target
    {
        let extra = apply_to_pins(app, path, &icon_path, &rec, &req);
        if let ApplyOutcome::Applied { entries, landed } = outcome {
            let mut all = entries;
            all.extend(extra);
            return ApplyOutcome::Applied { entries: all, landed };
        }
    }
    outcome
}

/// Journals the result and builds the outcome.
fn finish<R: Runtime>(
    app: &AppHandle<R>,
    rec: &ItemRecord,
    entry_id: &str,
    result: reskin_core::Result<()>,
    landed: bool,
) -> ApplyOutcome {
    let state = app.state::<AppState>();
    match result {
        Ok(()) => {
            let entry = {
                let mut j = state.journal();
                if let Err(e) = j.commit(entry_id) {
                    log::line(&format!("journal commit failed: {e}"));
                }
                j.get(entry_id).cloned()
            };
            state.items.update(&rec.info.id, |i| {
                i.reskinned = true;
                i.custom_icon = true;
            });
            if let Some(e) = &entry {
                let _ = app.emit_to(box_window::LABEL, "box:undo", e.id.clone());
            }
            ApplyOutcome::Applied {
                entries: entry.into_iter().collect(),
                landed,
            }
        }
        Err(e) => {
            log::line(&format!("apply failed: {e}"));
            let _ = state.journal().fail(entry_id, &e.to_string());
            emit_flight(app, FlightPhase::Error, None, 480, Some(e.to_string()));
            failed(&e)
        }
    }
}

/// Collapses the editor into the box, flies to the icon on the desktop
/// and commits the change at landing (or celebrates in place when the
/// icon isn't visible). Returns the commit result and whether it landed.
fn run_flourish<R: Runtime>(
    app: &AppHandle<R>,
    target: &Target,
    icon: Option<String>,
    commit: impl FnOnce() -> reskin_core::Result<()>,
) -> (reskin_core::Result<()>, bool) {
    let state = app.state::<AppState>();
    let speed = state.settings().animation_speed.clamp(0.5, 2.0);
    let ms = |base: f64| (base / speed) as u32;
    // Created shortcuts don't exist on the desktop until committed.
    let creates = matches!(target, Target::NewShortcut { .. } | Target::PersonalCopy { .. });
    let find = |path: &Path| -> Option<DesktopSpot> {
        let p = path.to_path_buf();
        state
            .sta
            .run(move || desktop::find_desktop_icon(&p))
            .ok()
            .and_then(|r| r.ok())
            .flatten()
            .filter(|s| s.visible)
    };
    let mut result = None;
    if creates {
        result = Some(commit());
        // Give Explorer a moment to add the new icon to the desktop view.
        std::thread::sleep(Duration::from_millis(250));
    }
    let spot = match (&result, target.desktop_path()) {
        (Some(Err(_)), _) | (_, None) => None,
        (_, Some(p)) => find(p),
    };
    let then = if spot.is_some() {
        CollapseThen::Fly
    } else {
        CollapseThen::Celebrate
    };
    if let Err(e) = morph::close(app, then, icon.clone()) {
        log::line(&format!("collapse before flight failed: {e}"));
    }
    let Some(spot) = spot else {
        let r = result.unwrap_or_else(commit);
        if r.is_ok() {
            emit_flight(app, FlightPhase::Celebrate, icon, ms(900.0), None);
        }
        return (r, false);
    };
    let Some(home) = morph::box_home(app) else {
        return (result.unwrap_or_else(commit), false);
    };
    let bh = app
        .get_webview_window(box_window::LABEL)
        .map(|w| raw::hwnd_of(&w))
        .unwrap_or(0);
    let size = raw::rect(bh).map(|r| (r.w, r.h)).unwrap_or((home.w, home.h));
    let (cx, cy) = spot.rect.center();
    let dest = ((cx - size.0 / 2.0).round() as i32, (cy - size.1 / 2.0).round() as i32);
    let lift = (home.y - spot.rect.y).abs().max(80.0).min(260.0);
    emit_flight(app, FlightPhase::Depart, icon.clone(), ms(650.0), None);
    state.animator.arc_to(dest, lift, Duration::from_millis(ms(650.0) as u64));
    let r = result.unwrap_or_else(commit);
    emit_flight(
        app,
        if r.is_ok() { FlightPhase::Land } else { FlightPhase::Error },
        icon,
        ms(520.0),
        r.as_ref().err().map(|e| e.to_string()),
    );
    std::thread::sleep(Duration::from_millis(ms(560.0) as u64));
    emit_flight(app, FlightPhase::Return, None, ms(600.0), None);
    state
        .animator
        .arc_to((home.x as i32, home.y as i32), lift * 0.6, Duration::from_millis(ms(600.0) as u64));
    emit_flight(app, FlightPhase::Home, None, 0, None);
    (r, true)
}

/// Start-menu / taskbar-pin shortcuts that launch the same program get the
/// same icon (each journaled on its own).
fn apply_to_pins<R: Runtime>(
    app: &AppHandle<R>,
    link: &Path,
    icon: &Path,
    rec: &ItemRecord,
    req: &ApplyRequest,
) -> Vec<HistoryEntry> {
    let state = app.state::<AppState>();
    let link = link.to_path_buf();
    let matches = state
        .sta
        .run(move || matching_pins(&link))
        .unwrap_or_default();
    let mut out = Vec::new();
    for pin in matches {
        let target = Target::Link { path: pin, url: false };
        let t2 = target.clone();
        let Ok(Ok(original)) = state.sta.run(move || read_original(&t2)) else {
            continue;
        };
        let id = match state.journal().begin(NewEntry {
            kind: TargetKind::Shortcut,
            target: target.journal_target(),
            name: rec.info.name.clone(),
            system_icon: None,
            icon_path: icon.display().to_string(),
            original,
            elevated: false,
            thumb: thumb(&req.images),
            design_name: req.design_name.clone(),
        }) {
            Ok(id) => id,
            Err(_) => continue,
        };
        let t3 = target.clone();
        let p = icon.to_path_buf();
        let r = state.sta.run(move || commit(&t3, &p)).unwrap_or_else(Err);
        let mut j = state.journal();
        match r {
            Ok(()) => {
                let _ = j.commit(&id);
                if let Some(e) = j.get(&id) {
                    out.push(e.clone());
                }
            }
            Err(e) => {
                let _ = j.fail(&id, &e.to_string());
            }
        }
    }
    out
}

/// `.lnk` files in the Start menu and taskbar pins with the same target.
fn matching_pins(link: &Path) -> Vec<PathBuf> {
    let Ok(info) = shortcut::read_link(link) else {
        return Vec::new();
    };
    let Some(target) = info.target else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for r in [known::start_menu(), known::common_start_menu(), known::taskbar_pins()] {
        if let Ok(p) = r {
            roots.push(p);
        }
    }
    let mut out = Vec::new();
    for root in roots {
        walk_lnks(&root, 4, &mut |p| {
            if p != link
                && let Ok(l) = shortcut::read_link(p)
                && l.target.as_deref().is_some_and(|t| same_path(t, &target))
                && reskin_core::win::access::probe_writable(p) == Access::Writable
            {
                out.push(p.to_path_buf());
            }
        });
    }
    out
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

fn walk_lnks(dir: &Path, depth: u32, f: &mut dyn FnMut(&Path)) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                walk_lnks(&p, depth - 1, f);
            }
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")) {
            f(&p);
        }
    }
}

/// The user approved elevation: run the helper (UAC prompt), then play the
/// flourish without the commit-at-landing (the change is already made).
#[tauri::command]
pub async fn apply_icon_elevated(app: AppHandle, ticket: String) -> CmdResult<ApplyOutcome> {
    tauri::async_runtime::spawn_blocking(move || elevated_blocking(&app, &ticket))
        .await
        .map_err(|e| e.to_string())
}

fn elevated_blocking<R: Runtime>(app: &AppHandle<R>, ticket: &str) -> ApplyOutcome {
    let state = app.state::<AppState>();
    let Some(p) = state.elevations.take(ticket) else {
        return ApplyOutcome::Failed {
            message: "That request expired — press Apply again.".into(),
            hint: None,
        };
    };
    let Some(path) = p.rec.path.clone() else {
        return ApplyOutcome::Unsupported {
            reason: "missing path".into(),
        };
    };
    let url = p.rec.info.kind == ItemKind::InternetShortcut;
    let target = Target::Link {
        path: path.clone(),
        url,
    };
    let t2 = target.clone();
    let original = match state.sta.run(move || read_original(&t2)) {
        Ok(Ok(o)) => o,
        Ok(Err(e)) | Err(e) => return failed(&e),
    };
    let name = reskin_core::paths::icon_file_name(&p.rec.info.name, &p.ico);
    let icon_path = state.dirs.public_icons_dir().join(&name);
    let op = match job::JobOp::set_icon(&path.display().to_string(), &name, &p.ico) {
        Ok(op) => op,
        Err(e) => return failed(&e),
    };
    let entry_id = match state.journal().begin(NewEntry {
        kind: target.kind(),
        target: target.journal_target(),
        name: p.rec.info.name.clone(),
        system_icon: None,
        icon_path: icon_path.display().to_string(),
        original,
        elevated: true,
        thumb: p.thumb.clone(),
        design_name: p.design_name.clone(),
    }) {
        Ok(id) => id,
        Err(e) => return failed(&e),
    };
    let result = helper::run_elevated_job(&state.dirs, vec![op]).and_then(|r| {
        if r.ok {
            Ok(())
        } else {
            Err(Error::Other(
                r.error
                    .or_else(|| r.results.iter().find(|o| !o.ok).map(|o| o.message.clone()))
                    .unwrap_or_else(|| "the elevated helper failed".into()),
            ))
        }
    });
    if let Err(Error::Cancelled) = &result {
        let _ = state.journal().fail(&entry_id, "cancelled");
        return ApplyOutcome::Cancelled;
    }
    if result.is_ok() && flourish_enabled(&state, p.flourish) && state.morph.phase() == morph::Phase::Open {
        let (r, landed) = run_flourish(app, &target, p.preview.clone(), || Ok(()));
        let _ = r;
        return finish(app, &p.rec, &entry_id, result, landed);
    }
    finish(app, &p.rec, &entry_id, result, false)
}

/// Native save dialog + write of an export.
#[tauri::command]
pub async fn export_file(app: AppHandle, req: ExportRequest) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let (ext, label) = match req.kind {
            ExportKind::Ico => ("ico", "Windows icon"),
            ExportKind::Png => ("png", "PNG image"),
            ExportKind::Project => ("reskin", "Reskin project"),
        };
        let bytes = match req.kind {
            ExportKind::Ico => ico::build_ico_from_pngs(&req.images).map_err(|e| e.to_string())?,
            ExportKind::Png => {
                let img = req.images.first().ok_or("nothing to export")?;
                b64_decode(&img.png)?
            }
            ExportKind::Project => req.data.clone().ok_or("nothing to export")?.into_bytes(),
        };
        let name = reskin_core::paths::slugify(&req.suggested_name);
        let Some(file) = app
            .dialog()
            .file()
            .set_title("Export")
            .set_file_name(format!("{name}.{ext}"))
            .add_filter(label, &[ext])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        store::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

//! Save & Apply: build the `.ico`, journal the change, check access, then
//! commit — at the moment the box "drops" the icon on the desktop when the
//! flourish plays, immediately otherwise.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reskin_core::history::NewEntry;
use reskin_core::model::{
    Access, ApplyMode, ApplyOutcome, ApplyRequest, BoxFlight, CollapseThen, ExportKind,
    ExportRequest, FlightPhase, HistoryEntry, ItemKind, MotionPref, OriginalIcon, Rect, SizedPng,
    SystemIconId, TargetKind,
};
use reskin_core::pixels::b64_decode;
use reskin_core::win::{access, desktop, folder, known, notify, shortcut, sysicons, urlfile};
use reskin_core::{Error, ico, job, store};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use windows::Win32::UI::Shell::{SHQUERYRBINFO, SHQueryRecycleBinW};
use windows::core::PCWSTR;

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
    update_pins: bool,
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
        g.remove(ticket)
            .filter(|p| p.created.elapsed() < TICKET_TTL)
    }
}

/// What an apply changes.
#[derive(Debug, Clone)]
enum Target {
    /// `.lnk` (url=false) or `.url` (url=true) in place.
    Link {
        path: PathBuf,
        url: bool,
    },
    Folder {
        path: PathBuf,
    },
    System {
        id: SystemIconId,
    },
    /// A new desktop shortcut with the icon.
    NewShortcut {
        dest: PathBuf,
        target: PathBuf,
        args: String,
        description: String,
    },
    /// Copy of a (Public Desktop) link on the user's desktop.
    PersonalCopy {
        src: PathBuf,
        dest: PathBuf,
        url: bool,
    },
}

impl Target {
    fn journal_target(&self) -> String {
        match self {
            Target::Link { path, .. } | Target::Folder { path } => path.display().to_string(),
            Target::System { id } => id.slug().to_string(),
            Target::NewShortcut { dest, .. } | Target::PersonalCopy { dest, .. } => {
                dest.display().to_string()
            }
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

    /// What the desktop shows the change on, for the flight: the file, or
    /// a system icon's `::{CLSID}` parsing name — the Recycle Bin's only
    /// while the bin is in the state (empty / full) whose icon changed.
    fn desktop_item(&self) -> Option<PathBuf> {
        match self {
            Target::Link { path, .. } | Target::Folder { path } => Some(path.clone()),
            Target::NewShortcut { dest, .. } | Target::PersonalCopy { dest, .. } => {
                Some(dest.clone())
            }
            Target::System { id } => system_desktop_item(*id, recycle_bin_is_full),
        }
    }

    /// Whether Windows lets Reskin make the change now. Probed at apply
    /// time, before anything is journaled or collapsed: the item may have
    /// changed since it was inspected.
    fn probe(&self) -> Access {
        match self {
            Target::Link { path, .. } | Target::Folder { path } => access::probe_writable(path),
            Target::NewShortcut { dest, .. } | Target::PersonalCopy { dest, .. } => dest
                .parent()
                .map_or(Access::ReadOnly, access::probe_creatable),
            Target::System { .. } => Access::Writable,
        }
    }
}

/// The desktop item that shows system icon `id`: `::{CLSID}`, except for a
/// Recycle Bin variant while the bin is in the other state (or Windows
/// can't tell which), whose icon the desktop does not show.
fn system_desktop_item(
    id: SystemIconId,
    bin_is_full: impl Fn() -> Option<bool>,
) -> Option<PathBuf> {
    let shown = match id {
        SystemIconId::RecycleBinEmpty => bin_is_full() == Some(false),
        SystemIconId::RecycleBinFull => bin_is_full() == Some(true),
        _ => true,
    };
    shown.then(|| PathBuf::from(format!("::{}", id.clsid())))
}

/// Whether the Recycle Bin (all drives) holds items; `None` when Windows
/// can't tell.
fn recycle_bin_is_full() -> Option<bool> {
    let mut info = SHQUERYRBINFO {
        cbSize: size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: NULL root = every drive; `info` is a valid out struct.
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.ok()?;
    Some(info.i64NumItems > 0)
}

/// `<desktop>\<stem><ext>`, or `<stem> (2)<ext>` … when taken.
fn unique_on_desktop(stem: &str, ext: &str) -> Result<PathBuf, String> {
    let desktop = known::desktop().map_err(|e| e.to_string())?;
    let clean: String = stem
        .chars()
        .map(|c| {
            if r#"<>:"/\|?*"#.contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
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

fn resolve_target<R: Runtime>(
    app: &AppHandle<R>,
    rec: &ItemRecord,
    mode: ApplyMode,
) -> Result<Target, ApplyOutcome> {
    let unsupported = |why: &str| ApplyOutcome::Unsupported { reason: why.into() };
    if !rec.info.modes.contains(&mode) {
        return Err(unsupported(
            "That kind of change isn't possible for this item.",
        ));
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
            id: rec
                .system_icon
                .ok_or_else(|| unsupported("missing system icon"))?,
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
            let dest = unique_on_desktop(&rec.info.name, if url { ".url" } else { ".lnk" })
                .map_err(|e| unsupported(&e))?;
            Ok(Target::PersonalCopy { src, dest, url })
        }
        _ => Err(unsupported(
            "That kind of change isn't possible for this item.",
        )),
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

/// What an apply does given the access probed at apply time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    Go,
    /// Ask for administrator approval (a Public-Desktop link).
    Elevate,
    /// Windows won't allow it; say so before anything happens.
    Refuse,
}

fn gate(access: Access, target: &Target) -> Gate {
    match access {
        Access::Writable => Gate::Go,
        // Only `.lnk` / `.url` files on the Public Desktop are probed so.
        Access::NeedsElevation if matches!(target, Target::Link { .. }) => Gate::Elevate,
        Access::NeedsElevation | Access::ReadOnly => Gate::Refuse,
    }
}

/// The outcome when Windows won't let Reskin make the change and no
/// administrator approval would help. Nothing was journaled or collapsed.
fn refused(rec: &ItemRecord, target: &Target) -> ApplyOutcome {
    let name = &rec.info.name;
    let (message, hint) = match target {
        Target::Link { .. } => (
            format!("Windows won't let Reskin change \"{name}\"."),
            Some(
                "Make a personal copy on your desktop instead: drop the shortcut on the box again and apply it as a personal copy.",
            ),
        ),
        Target::Folder { .. } => (
            format!("Windows won't let Reskin change the folder \"{name}\"."),
            Some("Only an account that may change the folder can give it an icon."),
        ),
        Target::NewShortcut { .. } | Target::PersonalCopy { .. } => (
            "Windows won't let Reskin create a shortcut on your desktop.".to_string(),
            Some("Check that your desktop folder isn't read-only."),
        ),
        Target::System { .. } => (format!("Windows won't let Reskin change \"{name}\"."), None),
    };
    ApplyOutcome::Failed {
        message,
        hint: hint.map(str::to_owned),
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

fn emit_flight<R: Runtime>(
    app: &AppHandle<R>,
    phase: FlightPhase,
    icon: Option<String>,
    ms: u32,
    message: Option<String>,
) {
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
    match gate(target.probe(), &target) {
        Gate::Go => {}
        Gate::Elevate => {
            let ticket = state.elevations.put(PendingElevation {
                rec: rec.clone(),
                ico,
                thumb: thumb(&req.images),
                design_name: req.design_name.clone(),
                preview,
                flourish: req.flourish,
                update_pins: req.update_pins,
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
        Gate::Refuse => return refused(&rec, &target),
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
            group: None,
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
    let flourish =
        flourish_enabled(&state, req.flourish) && state.morph.phase() == morph::Phase::Open;
    let (result, shown) = if flourish {
        run_flourish(app, &target, preview, do_commit)
    } else {
        (do_commit(), Shown::default())
    };
    let outcome = finish(app, &rec, &entry_id, result, shown);
    let outcome = match &target {
        Target::Link { path, url: false } if req.update_pins => with_pins(
            app,
            outcome,
            path,
            &icon_path,
            &rec,
            thumb(&req.images),
            req.design_name.clone(),
        ),
        _ => outcome,
    };
    announce_undo(app, &outcome);
    outcome
}

/// What the box showed of an apply.
#[derive(Debug, Clone, Copy, Default)]
struct Shown {
    /// It flew to the icon on the desktop.
    landed: bool,
    /// The editor collapsed into it: from then on the box is where the
    /// user looks for what happens.
    collapsed: bool,
    /// An `error` flight already told it what went wrong.
    error: bool,
}

impl Shown {
    /// A failure is the box's to tell — with one `error` flight — once the
    /// editor collapsed into it, unless a flight already told it.
    fn owes_error_flight(self) -> bool {
        self.collapsed && !self.error
    }
}

/// Journals the result and builds the outcome. A failure after the editor
/// collapsed reaches the box as exactly one `error` flight carrying the
/// message; before that the editor, still open, shows it.
fn finish<R: Runtime>(
    app: &AppHandle<R>,
    rec: &ItemRecord,
    entry_id: &str,
    result: reskin_core::Result<()>,
    shown: Shown,
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
            ApplyOutcome::Applied {
                entries: entry.into_iter().collect(),
                landed: shown.landed,
                skipped_pins: None,
            }
        }
        Err(e) => {
            log::line(&format!("apply failed: {e}"));
            if let Err(je) = state.journal().fail(entry_id, &e.to_string()) {
                log::line(&format!("journal fail failed: {je}"));
            }
            if shown.owes_error_flight() {
                emit_flight(app, FlightPhase::Error, None, 480, Some(e.to_string()));
            }
            failed(&e)
        }
    }
}

/// After a successful apply the box offers **Undo** for its main entry,
/// which undoes the matching pins with it.
fn announce_undo<R: Runtime>(app: &AppHandle<R>, outcome: &ApplyOutcome) {
    if let ApplyOutcome::Applied { entries, .. } = outcome
        && let Some(main) = entries.first()
    {
        let _ = app.emit_to(box_window::LABEL, "box:undo", main.id.clone());
    }
}

/// Collapses the editor into the box, flies to the icon on the desktop and
/// commits the change at landing, or — when the icon isn't visible —
/// commits, celebrates in place and glides home. A new shortcut has to
/// exist before it can be found on the desktop, so it is created first,
/// and a failure there returns before anything collapses. Returns the
/// commit result and what the box showed.
fn run_flourish<R: Runtime>(
    app: &AppHandle<R>,
    target: &Target,
    icon: Option<String>,
    commit: impl FnOnce() -> reskin_core::Result<()>,
) -> (reskin_core::Result<()>, Shown) {
    let mut commit = Some(commit);
    let mut run_commit = move || match commit.take() {
        Some(f) => f(),
        None => Ok(()),
    };
    let state = app.state::<AppState>();
    let speed = state.settings().animation_speed.clamp(0.5, 2.0);
    let ms = |base: f64| (base / speed) as u32;
    // Created shortcuts don't exist on the desktop until committed.
    if matches!(
        target,
        Target::NewShortcut { .. } | Target::PersonalCopy { .. }
    ) {
        if let Err(e) = run_commit() {
            return (Err(e), Shown::default());
        }
        // Give Explorer a moment to add the new icon to the desktop view.
        std::thread::sleep(Duration::from_millis(250));
    }
    // Both the Recycle Bin query and the icon lookup are shell calls: they
    // belong on the COM thread.
    let shown_by = target.clone();
    let spot = state
        .sta
        .run(move || match shown_by.desktop_item() {
            Some(item) => desktop::find_desktop_icon(&item),
            None => Ok(None),
        })
        .ok()
        .and_then(|r| r.ok())
        .flatten()
        .filter(|s| s.visible);
    let then = if spot.is_some() {
        CollapseThen::Fly
    } else {
        CollapseThen::Celebrate
    };
    if let Err(e) = morph::close(app, then, icon.clone()) {
        log::line(&format!("collapse before flight failed: {e}"));
    }
    let collapsed = Shown {
        collapsed: true,
        ..Shown::default()
    };
    let Some(spot) = spot else {
        let r = run_commit();
        let pause = match &r {
            Ok(()) => {
                emit_flight(app, FlightPhase::Celebrate, icon, ms(900.0), None);
                ms(900.0)
            }
            Err(e) => {
                emit_flight(
                    app,
                    FlightPhase::Error,
                    None,
                    ms(480.0),
                    Some(e.to_string()),
                );
                ms(480.0)
            }
        };
        // The editor collapsed onto the box wherever it was; once the box
        // has had its moment there, it goes home.
        std::thread::sleep(Duration::from_millis(u64::from(pause)));
        glide_home(app);
        let error = r.is_err();
        return (r, Shown { error, ..collapsed });
    };
    let Some(home) = morph::box_home(app) else {
        return (run_commit(), collapsed);
    };
    let bh = app
        .get_webview_window(box_window::LABEL)
        .map(|w| raw::hwnd_of(&w))
        .unwrap_or(0);
    let size = raw::rect(bh)
        .map(|r| (r.w, r.h))
        .unwrap_or((home.w, home.h));
    let (cx, cy) = spot.rect.center();
    let dest = (
        (cx - size.0 / 2.0).round() as i32,
        (cy - size.1 / 2.0).round() as i32,
    );
    let lift = (home.y - spot.rect.y).abs().clamp(80.0, 260.0);
    emit_flight(app, FlightPhase::Depart, icon.clone(), ms(650.0), None);
    state
        .animator
        .arc_to(dest, lift, Duration::from_millis(ms(650.0) as u64));
    let r = run_commit();
    emit_flight(
        app,
        if r.is_ok() {
            FlightPhase::Land
        } else {
            FlightPhase::Error
        },
        icon,
        ms(520.0),
        r.as_ref().err().map(|e| e.to_string()),
    );
    std::thread::sleep(Duration::from_millis(ms(560.0) as u64));
    emit_flight(app, FlightPhase::Return, None, ms(600.0), None);
    state.animator.arc_to(
        (home.x as i32, home.y as i32),
        lift * 0.6,
        Duration::from_millis(ms(600.0) as u64),
    );
    emit_flight(app, FlightPhase::Home, None, 0, None);
    let error = r.is_err();
    (
        r,
        Shown {
            landed: true,
            error,
            ..collapsed
        },
    )
}

/// Glides the box back home when it isn't there, unless the user hid it.
fn glide_home<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if state.box_hidden_by_user() {
        return;
    }
    if let (Some(home), Some(now)) = (morph::box_home(app), state.animator.rect())
        && let Some(to) = way_home(home, now)
    {
        state.animator.glide_to(to);
    }
}

/// Where the box at `now` must glide to reach `home` (physical px), if
/// anywhere.
fn way_home(home: Rect, now: Rect) -> Option<(i32, i32)> {
    let home_at = (home.x.round() as i32, home.y.round() as i32);
    (home_at != (now.x.round() as i32, now.y.round() as i32)).then_some(home_at)
}

/// Adds the matching Start-menu and taskbar-pin shortcuts to a successful
/// apply ([`apply_to_pins`]), reporting those Reskin had to leave alone.
fn with_pins<R: Runtime>(
    app: &AppHandle<R>,
    outcome: ApplyOutcome,
    link: &Path,
    icon: &Path,
    rec: &ItemRecord,
    thumb: Option<String>,
    design_name: Option<String>,
) -> ApplyOutcome {
    match outcome {
        ApplyOutcome::Applied {
            mut entries,
            landed,
            skipped_pins,
        } => {
            let Some(main) = entries.first().map(|e| e.id.clone()) else {
                return ApplyOutcome::Applied {
                    entries,
                    landed,
                    skipped_pins,
                };
            };
            let (pins, skipped) = apply_to_pins(app, link, icon, rec, thumb, design_name, &main);
            entries.extend(pins);
            ApplyOutcome::Applied {
                entries,
                landed,
                skipped_pins: (skipped > 0).then_some(skipped),
            }
        }
        other => other,
    }
}

/// Gives the Start-menu and taskbar-pin shortcuts that launch the same
/// program the same icon. Each is journaled with the apply's main entry
/// (`main`) as its group, so undoing the apply undoes them too. Returns
/// their entries and how many matching pins Reskin can't change (e.g. in
/// the all-users Start menu).
fn apply_to_pins<R: Runtime>(
    app: &AppHandle<R>,
    link: &Path,
    icon: &Path,
    rec: &ItemRecord,
    thumb: Option<String>,
    design_name: Option<String>,
    main: &str,
) -> (Vec<HistoryEntry>, u32) {
    let state = app.state::<AppState>();
    let link = link.to_path_buf();
    let (matches, skipped) = state
        .sta
        .run(move || matching_pins(&link))
        .unwrap_or_default();
    let mut out = Vec::new();
    for pin in matches {
        let target = Target::Link {
            path: pin,
            url: false,
        };
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
            thumb: thumb.clone(),
            design_name: design_name.clone(),
            group: Some(main.to_owned()),
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
    (out, skipped)
}

/// `.lnk` files in the Start menu and taskbar pins with the same target:
/// those Reskin can change, and how many others there are.
fn matching_pins(link: &Path) -> (Vec<PathBuf>, u32) {
    let Ok(info) = shortcut::read_link(link) else {
        return (Vec::new(), 0);
    };
    let Some(target) = info.target else {
        return (Vec::new(), 0);
    };
    let roots: Vec<PathBuf> = [
        known::start_menu(),
        known::common_start_menu(),
        known::taskbar_pins(),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut out = Vec::new();
    let mut skipped = 0;
    for root in roots {
        walk_lnks(&root, 4, &mut |p| {
            if p != link
                && let Ok(l) = shortcut::read_link(p)
                && l.target.as_deref().is_some_and(|t| same_path(t, &target))
            {
                if access::probe_writable(p) == Access::Writable {
                    out.push(p.to_path_buf());
                } else {
                    skipped += 1;
                }
            }
        });
    }
    (out, skipped)
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .eq_ignore_ascii_case(&b.to_string_lossy())
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
    let icons_dir = match helper::public_icons_dir() {
        Ok(dir) => dir,
        Err(e) => return failed(&e),
    };
    let name = reskin_core::paths::icon_file_name(&p.rec.info.name, &p.ico);
    let icon_path = icons_dir.join(&name);
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
        group: None,
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
    // The change is made (or failed) before anything collapses: the
    // flourish only shows it.
    let shown = if result.is_ok()
        && flourish_enabled(&state, p.flourish)
        && state.morph.phase() == morph::Phase::Open
    {
        run_flourish(app, &target, p.preview.clone(), || Ok(())).1
    } else {
        Shown::default()
    };
    let outcome = finish(app, &p.rec, &entry_id, result, shown);
    let outcome = if p.update_pins && !url {
        with_pins(
            app,
            outcome,
            &path,
            &icon_path,
            &p.rec,
            p.thumb.clone(),
            p.design_name.clone(),
        )
    } else {
        outcome
    };
    announce_undo(app, &outcome);
    outcome
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

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> Target {
        Target::Link {
            path: PathBuf::from(r"C:\Users\Public\Desktop\App.lnk"),
            url: false,
        }
    }

    fn folder() -> Target {
        Target::Folder {
            path: PathBuf::from(r"C:\Users\Public\Desktop\Games"),
        }
    }

    #[test]
    fn only_a_public_desktop_link_asks_for_elevation_and_refusals_come_first() {
        assert_eq!(gate(Access::Writable, &link()), Gate::Go);
        assert_eq!(gate(Access::Writable, &folder()), Gate::Go);
        assert_eq!(gate(Access::NeedsElevation, &link()), Gate::Elevate);
        // Nothing but a link can go through the elevated helper.
        assert_eq!(gate(Access::NeedsElevation, &folder()), Gate::Refuse);
        assert_eq!(gate(Access::ReadOnly, &link()), Gate::Refuse);
        assert_eq!(gate(Access::ReadOnly, &folder()), Gate::Refuse);
        let new = Target::NewShortcut {
            dest: PathBuf::from(r"C:\Users\Kim\Desktop\App.lnk"),
            target: PathBuf::from(r"C:\Apps\app.exe"),
            args: String::new(),
            description: String::new(),
        };
        assert_eq!(gate(Access::ReadOnly, &new), Gate::Refuse);
        let rec = ItemRecord {
            info: crate::items::tests::info("App"),
            path: None,
            system_icon: None,
        };
        for target in [link(), folder(), new] {
            match refused(&rec, &target) {
                ApplyOutcome::Failed { message, hint } => {
                    assert!(message.starts_with("Windows won't let Reskin"), "{message}");
                    assert!(hint.is_some());
                }
                other => panic!("{other:?}"),
            }
        }
        match refused(&rec, &link()) {
            ApplyOutcome::Failed { hint, .. } => {
                assert!(hint.unwrap().contains("personal copy"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_failure_reaches_the_box_once_and_only_after_the_collapse() {
        // Still open, the editor shows it.
        assert!(!Shown::default().owes_error_flight());
        // Collapsed without a word yet: one `error` flight.
        let collapsed = Shown {
            collapsed: true,
            ..Shown::default()
        };
        assert!(collapsed.owes_error_flight());
        // The landing (or the celebration) already sent it.
        for landed in [false, true] {
            let told = Shown {
                landed,
                collapsed: true,
                error: true,
            };
            assert!(!told.owes_error_flight());
        }
    }

    #[test]
    fn system_icons_fly_to_their_desktop_item_while_it_shows_the_change() {
        let bin = "::{645FF040-5081-101B-9F08-00AA002F954E}";
        assert_eq!(
            system_desktop_item(SystemIconId::ThisPc, || None),
            Some(PathBuf::from("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"))
        );
        assert_eq!(
            system_desktop_item(SystemIconId::RecycleBinEmpty, || Some(false)),
            Some(PathBuf::from(bin))
        );
        assert_eq!(
            system_desktop_item(SystemIconId::RecycleBinFull, || Some(true)),
            Some(PathBuf::from(bin))
        );
        // The other state's icon is not on the desktop now.
        assert_eq!(
            system_desktop_item(SystemIconId::RecycleBinEmpty, || Some(true)),
            None
        );
        assert_eq!(
            system_desktop_item(SystemIconId::RecycleBinFull, || Some(false)),
            None
        );
        assert_eq!(
            system_desktop_item(SystemIconId::RecycleBinFull, || None),
            None
        );
        assert_eq!(
            Target::System {
                id: SystemIconId::Network
            }
            .desktop_item(),
            Some(PathBuf::from("::{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}"))
        );
    }

    #[test]
    fn the_box_glides_home_only_when_it_is_elsewhere() {
        let home = Rect::new(1700.0, 40.0, 148.0, 148.0);
        assert_eq!(way_home(home, home), None);
        assert_eq!(way_home(home, Rect::new(1700.4, 39.6, 148.0, 148.0)), None);
        assert_eq!(
            way_home(home, Rect::new(900.0, 500.0, 148.0, 148.0)),
            Some((1700, 40))
        );
    }
}

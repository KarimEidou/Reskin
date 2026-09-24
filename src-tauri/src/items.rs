//! The `ItemId → target` registry and the item commands.
//!
//! JS only ever sees opaque ids; mutating commands resolve ids here, so a
//! compromised page cannot point Reskin at arbitrary paths.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use reskin_core::model::{
    Access, ApplyMode, IconFrame, ItemId, ItemInfo, ItemKind, ItemLocation, PickPurpose, SystemIconId,
};
use reskin_core::pixels::Rgba;
use reskin_core::win::extract::{self, Inspected};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::CmdResult;
use crate::state::AppState;

const MAX_ITEMS: usize = 4096;
/// Largest project file Reskin will read.
const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ItemRecord {
    pub info: ItemInfo,
    pub path: Option<PathBuf>,
    pub system_icon: Option<SystemIconId>,
}

#[derive(Default)]
pub struct Items {
    map: Mutex<(HashMap<ItemId, ItemRecord>, VecDeque<ItemId>)>,
    counter: AtomicU64,
}

impl Items {
    fn register(&self, mut info: ItemInfo, path: Option<PathBuf>, system_icon: Option<SystemIconId>) -> ItemInfo {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let salt = reskin_core::paths::sha256_hex(format!("{n}:{}:{}", info.path, reskin_core::now_ms()).as_bytes());
        let id = ItemId(format!("it{n:x}{}", &salt[..10]));
        info.id = id.clone();
        let mut g = self.map.lock().unwrap_or_else(|e| e.into_inner());
        g.0.insert(
            id.clone(),
            ItemRecord {
                info: info.clone(),
                path,
                system_icon,
            },
        );
        g.1.push_back(id);
        while g.1.len() > MAX_ITEMS {
            if let Some(old) = g.1.pop_front() {
                g.0.remove(&old);
            }
        }
        info
    }

    pub fn get(&self, id: &ItemId) -> Option<ItemRecord> {
        let g = self.map.lock().unwrap_or_else(|e| e.into_inner());
        g.0.get(id).cloned()
    }

    /// Replaces the stored info (e.g. after an apply changed `reskinned`).
    pub fn update(&self, id: &ItemId, f: impl FnOnce(&mut ItemInfo)) {
        let mut g = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = g.0.get_mut(id) {
            f(&mut r.info);
        }
    }
}

/// Apply modes that make sense for an inspected item, preferred first.
pub fn modes_for(kind: ItemKind, access: Access, store_app: bool) -> Vec<ApplyMode> {
    use ApplyMode::*;
    match kind {
        ItemKind::Shortcut | ItemKind::InternetShortcut => {
            let mut m = match access {
                Access::Writable => vec![InPlace],
                Access::NeedsElevation => vec![InPlace, PersonalCopy],
                Access::ReadOnly => vec![PersonalCopy],
            };
            if store_app {
                m.push(NewShortcut);
            }
            m
        }
        ItemKind::Folder => match access {
            Access::ReadOnly => vec![],
            _ => vec![InPlace],
        },
        ItemKind::SystemIcon => vec![InPlace],
        ItemKind::Executable | ItemKind::File => vec![NewShortcut],
        ItemKind::Image | ItemKind::Project => vec![],
    }
}

fn notes_for(ins: &Inspected) -> Vec<String> {
    let mut notes = Vec::new();
    match ins.location {
        ItemLocation::PublicDesktop => notes.push(
            "On the Public Desktop (all users) — changing it needs administrator approval, or Reskin can make a personal copy."
                .into(),
        ),
        ItemLocation::TaskbarPin => notes.push("A taskbar pin — Explorer may cache its icon until you sign out.".into()),
        _ => {}
    }
    if ins.store_app {
        notes.push("A Store app shortcut — Windows may ignore a custom icon; Reskin can create a classic shortcut instead.".into());
    }
    match ins.kind {
        ItemKind::Executable | ItemKind::File => {
            notes.push("Reskin never modifies programs; it will create a new desktop shortcut with your icon.".into())
        }
        ItemKind::Image => notes.push("An image — it becomes the starting point of your design.".into()),
        _ => {}
    }
    if ins.access == Access::ReadOnly && !matches!(ins.kind, ItemKind::Image | ItemKind::Project) {
        notes.push("This item is read-only.".into());
    }
    notes
}

/// A ≤256 px data-URL preview.
pub fn preview(img: &Rgba) -> String {
    let max = img.w.max(img.h);
    if max > 256 {
        let k = 256.0 / max as f64;
        let w = ((img.w as f64 * k).round() as u32).max(1);
        let h = ((img.h as f64 * k).round() as u32).max(1);
        img.resize(w, h).to_data_url()
    } else {
        img.to_data_url()
    }
}

fn to_info(state: &AppState, ins: &Inspected) -> ItemInfo {
    let path_str = ins.path.display().to_string();
    let reskinned = state.journal().active_for(&path_str).is_some();
    ItemInfo {
        id: ItemId(String::new()),
        kind: ins.kind,
        name: ins.name.clone(),
        path: path_str,
        target: ins.target.clone(),
        location: ins.location,
        access: ins.access,
        modes: modes_for(ins.kind, ins.access, ins.store_app),
        icon: ins.icon.as_ref().map(preview),
        icon_source: ins.icon_source,
        custom_icon: ins.custom_icon,
        reskinned,
        store_app: ins.store_app,
        system_icon: None,
        notes: notes_for(ins),
    }
}

/// Inspects paths on the STA worker; unreadable paths are skipped.
pub fn inspect_blocking<R: Runtime>(app: &AppHandle<R>, paths: &[PathBuf]) -> Vec<ItemInfo> {
    let state = app.state::<AppState>();
    let mut out = Vec::new();
    for p in paths {
        let path = p.clone();
        match state.sta.run(move || extract::inspect_path(&path)) {
            Ok(Ok(ins)) => {
                let info = to_info(&state, &ins);
                out.push(state.items.register(info, Some(ins.path.clone()), None));
            }
            Ok(Err(e)) => crate::log::line(&format!("inspect {}: {e}", p.display())),
            Err(e) => crate::log::line(&format!("inspect {}: STA: {e}", p.display())),
        }
    }
    out
}

pub fn system_icon_blocking<R: Runtime>(app: &AppHandle<R>, id: SystemIconId) -> Result<ItemInfo, String> {
    let state = app.state::<AppState>();
    let ins = state
        .sta
        .run(move || extract::inspect_system_icon(id))
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut info = to_info(&state, &ins);
    info.kind = ItemKind::SystemIcon;
    info.system_icon = Some(id);
    info.name = id.label().to_string();
    info.path = format!("::{}", id.clsid());
    info.location = ItemLocation::System;
    info.modes = modes_for(ItemKind::SystemIcon, Access::Writable, false);
    info.reskinned = state.journal().active_for(id.slug()).is_some();
    info.notes = vec!["A system icon — Reskin changes it for your account only.".into()];
    Ok(state.items.register(info, None, Some(id)))
}

/// Resolves ids to infos (errors on unknown ids).
pub fn infos(state: &AppState, ids: &[ItemId]) -> Result<Vec<ItemInfo>, String> {
    ids.iter()
        .map(|id| {
            state
                .items
                .get(id)
                .map(|r| r.info)
                .ok_or_else(|| format!("unknown item {}", id.0))
        })
        .collect()
}

fn frames_to_ipc(frames: Vec<Rgba>) -> Vec<IconFrame> {
    frames
        .into_iter()
        .map(|f| IconFrame {
            width: f.w,
            height: f.h,
            png: f.to_png_base64(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn inspect_paths(app: AppHandle, paths: Vec<String>) -> CmdResult<Vec<ItemInfo>> {
    let paths: Vec<PathBuf> = paths.into_iter().take(64).map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || inspect_blocking(&app, &paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn inspect_system_icon(app: AppHandle, id: SystemIconId) -> CmdResult<ItemInfo> {
    tauri::async_runtime::spawn_blocking(move || system_icon_blocking(&app, id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn item_frames(app: AppHandle, item: ItemId) -> CmdResult<Vec<IconFrame>> {
    let rec = app
        .state::<AppState>()
        .items
        .get(&item)
        .ok_or("unknown item")?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let frames = match (rec.system_icon, rec.path) {
            (Some(id), _) => state.sta.run(move || extract::system_icon_frames(id)),
            (None, Some(path)) => state.sta.run(move || extract::icon_frames(&path)),
            (None, None) => return Err("item has no icon source".to_string()),
        }
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        Ok(frames_to_ipc(frames))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pick_files(app: AppHandle, purpose: PickPurpose) -> CmdResult<Vec<ItemInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let picked = match purpose {
            PickPurpose::Import => dialog
                .set_title("Import an image or icon")
                .add_filter(
                    "Images, icons and shortcuts",
                    &[
                        "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff", "lnk", "url", "exe", "dll",
                    ],
                )
                .add_filter("All files", &["*"])
                .blocking_pick_files(),
            PickPurpose::Project => dialog
                .set_title("Open a Reskin project")
                .add_filter("Reskin project", &["reskin"])
                .blocking_pick_file()
                .map(|f| vec![f]),
        };
        let paths: Vec<PathBuf> = picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .collect();
        Ok(inspect_blocking(&app, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn read_project(state: State<'_, AppState>, item: ItemId) -> CmdResult<String> {
    let rec = state.items.get(&item).ok_or("unknown item")?;
    if rec.info.kind != ItemKind::Project {
        return Err("not a Reskin project".into());
    }
    let path = rec.path.ok_or("project has no path")?;
    read_limited(&path)
}

fn read_limited(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_PROJECT_BYTES {
        return Err("project file is too large".into());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes() {
        assert_eq!(
            modes_for(ItemKind::Shortcut, Access::Writable, false),
            vec![ApplyMode::InPlace]
        );
        assert_eq!(
            modes_for(ItemKind::Shortcut, Access::NeedsElevation, true),
            vec![ApplyMode::InPlace, ApplyMode::PersonalCopy, ApplyMode::NewShortcut]
        );
        assert_eq!(
            modes_for(ItemKind::Executable, Access::ReadOnly, false),
            vec![ApplyMode::NewShortcut]
        );
        assert!(modes_for(ItemKind::Image, Access::Writable, false).is_empty());
    }
}

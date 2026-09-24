//! Library of saved designs and the crash-recovery autosave.

use std::sync::Mutex;

use reskin_core::model::{LibraryEntry, LibrarySave};
use reskin_core::store::{AutosaveSlots, Library};
use tauri::State;

use super::CmdResult;
use crate::log;
use crate::state::AppState;

fn library(state: &AppState) -> Library {
    Library::new(state.dirs.library_dir())
}

#[tauri::command]
pub fn library_list(state: State<'_, AppState>) -> CmdResult<Vec<LibraryEntry>> {
    library(&state).list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_save(state: State<'_, AppState>, entry: LibrarySave) -> CmdResult<LibraryEntry> {
    library(&state).save(entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_load(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    library(&state).load(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    library(&state).delete(&id).map_err(|e| e.to_string())
}

/// The autosave slots. Their first use in this process (= this launch)
/// rotates them: what the previous launch left in the live slot becomes
/// the recovery offer before this launch writes its own. Until that
/// succeeds (it is tried again on every use) the slots are left alone.
fn autosave_slots(state: &AppState) -> CmdResult<AutosaveSlots> {
    static ROTATED: Mutex<bool> = Mutex::new(false);
    let slots = AutosaveSlots::new(state.dirs.autosave_file());
    slots.rotate_once(&ROTATED).map_err(|e| {
        let message = format!("could not keep the last autosave for recovery: {e}");
        log::line(&message);
        message
    })?;
    Ok(slots)
}

/// `data`: the open design's unsaved changes for the live slot (an empty
/// string empties it: nothing is unsaved any more). `None` discards every
/// unsaved design, the recovery offer included.
#[tauri::command]
pub fn autosave(state: State<'_, AppState>, data: Option<String>) -> CmdResult<()> {
    let slots = autosave_slots(&state)?;
    match data {
        Some(data) => slots.write(&data),
        None => slots.discard(),
    }
    .map_err(|e| e.to_string())
}

/// The design offered for recovery: what an earlier launch left unsaved.
#[tauri::command]
pub fn autosave_load(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    autosave_slots(&state)?
        .read_recovery()
        .map_err(|e| e.to_string())
}

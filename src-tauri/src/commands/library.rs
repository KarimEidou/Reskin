//! Library of saved designs and the crash-recovery autosave.

use reskin_core::model::{LibraryEntry, LibrarySave};
use reskin_core::store::{self, Library};
use tauri::State;

use super::CmdResult;
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

#[tauri::command]
pub fn autosave(state: State<'_, AppState>, data: Option<String>) -> CmdResult<()> {
    store::autosave_write(&state.dirs.autosave_file(), data.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn autosave_load(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    store::autosave_read(&state.dirs.autosave_file()).map_err(|e| e.to_string())
}

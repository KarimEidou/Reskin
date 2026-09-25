//! Library of saved designs and the crash-recovery autosave.
//!
//! Every command here reads or writes whole files, so each is `async` and
//! does its work on the blocking pool ([`off_main`]): Tauri runs a
//! synchronous command on the main thread, where both windows and the
//! open/close handoff run.

use std::path::PathBuf;
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

/// Runs `work` on the blocking pool, off the main thread, and answers with
/// its result.
async fn off_main<T: Send + 'static>(
    work: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn library_list(state: State<'_, AppState>) -> CmdResult<Vec<LibraryEntry>> {
    let library = library(&state);
    off_main(move || library.list().map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn library_save(
    state: State<'_, AppState>,
    entry: LibrarySave,
) -> CmdResult<LibraryEntry> {
    let library = library(&state);
    off_main(move || library.save(entry).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn library_load(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let library = library(&state);
    off_main(move || library.load(&id).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn library_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let library = library(&state);
    off_main(move || library.delete(&id).map_err(|e| e.to_string())).await
}

/// The autosave slots of the live autosave file `live`. Their first use in
/// this process (= this launch) rotates them: what the previous launch left
/// in the live slot becomes the recovery offer before this launch writes
/// its own. Until that succeeds (it is tried again on every use) the slots
/// are left alone.
fn autosave_slots(live: PathBuf) -> CmdResult<AutosaveSlots> {
    static ROTATED: Mutex<bool> = Mutex::new(false);
    let slots = AutosaveSlots::new(live);
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
///
/// Two calls could run side by side here: the page keeps them in order by
/// making every call through `Autosave.enqueue`
/// (`src/engine/io/autosave.ts`), which waits for the one before to finish.
#[tauri::command]
pub async fn autosave(state: State<'_, AppState>, data: Option<String>) -> CmdResult<()> {
    let live = state.dirs.autosave_file();
    off_main(move || {
        let slots = autosave_slots(live)?;
        match data {
            Some(data) => slots.write(&data),
            None => slots.discard(),
        }
        .map_err(|e| e.to_string())
    })
    .await
}

/// The design offered for recovery: what an earlier launch left unsaved.
#[tauri::command]
pub async fn autosave_load(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let live = state.dirs.autosave_file();
    off_main(move || {
        autosave_slots(live)?
            .read_recovery()
            .map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::thread;

    use super::*;

    #[test]
    fn the_work_runs_off_the_calling_thread_and_its_answer_comes_back() {
        let caller = thread::current().id();
        let ran_on = tauri::async_runtime::block_on(off_main(|| Ok(thread::current().id())));
        assert_ne!(ran_on, Ok(caller));
        let failed: CmdResult<()> =
            tauri::async_runtime::block_on(off_main(|| Err("the disk is full".to_string())));
        assert_eq!(failed, Err("the disk is full".to_string()));
    }

    /// Tauri runs a synchronous command on the main thread, so each of these
    /// must be a future (which Tauri runs on its async runtime).
    #[test]
    fn every_command_is_a_future() {
        fn one<'a, F: Future>(_: impl Fn(State<'a, AppState>) -> F) {}
        fn two<'a, A, F: Future>(_: impl Fn(State<'a, AppState>, A) -> F) {}
        one(library_list);
        two(library_save);
        two(library_load);
        two(library_delete);
        two(autosave);
        one(autosave_load);
    }
}

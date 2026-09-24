use reskin_core::model::{AckStage, CloseReason, CollapseThen, Envelope};
use tauri::{AppHandle, State};

use super::CmdResult;
use crate::actions;
use crate::state::AppState;
use crate::windows::mailbox::HEARTBEAT;

/// Long-poll for editor commands with `seq > after`.
#[tauri::command]
pub async fn editor_next(after: u32, state: State<'_, AppState>) -> CmdResult<Vec<Envelope>> {
    let mailbox = state.mailbox.clone();
    tauri::async_runtime::spawn_blocking(move || mailbox.next(after, HEARTBEAT))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn editor_ack(session: u32, stage: AckStage, state: State<'_, AppState>) {
    state.morph.ack(session, stage);
}

/// The editor asks to close (close button, Esc). The collapse handoff runs
/// on its own thread; this returns immediately so the page can keep
/// polling the mailbox.
#[tauri::command]
pub fn editor_close(app: AppHandle, reason: CloseReason) {
    match reason {
        // The apply flow drives its own collapse + flight.
        CloseReason::Applied => {}
        CloseReason::User | CloseReason::Hide => actions::close_editor(&app, CollapseThen::Hide),
    }
}

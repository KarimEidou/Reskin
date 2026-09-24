use reskin_core::model::{AckStage, Envelope};
use tauri::State;

use super::CmdResult;
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
pub fn editor_ack(session: u32, stage: AckStage) {
    crate::log::line(&format!("editor ack {session} {stage:?}"));
}

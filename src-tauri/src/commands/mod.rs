//! Tauri command handlers. Names and argument shapes match
//! `src/lib/ipc/commands.ts`.

pub mod boot;
pub mod editor_cmds;
pub mod system;

/// Command result type: errors reach JS as the rejection message.
pub type CmdResult<T> = Result<T, String>;

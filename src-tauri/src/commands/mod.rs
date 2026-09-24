//! Tauri command handlers. Names and argument shapes match
//! `src/lib/ipc/commands.ts`. (Item, apply and restore commands live in
//! `crate::items`, `crate::apply` and `crate::restore`.)

pub mod boot;
pub mod box_cmds;
pub mod editor_cmds;
pub mod library;
pub mod settings;
pub mod system;

/// Command result type: errors reach JS as the rejection message.
pub type CmdResult<T> = Result<T, String>;

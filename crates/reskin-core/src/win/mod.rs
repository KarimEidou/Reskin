//! Windows shell integration. Everything that touches COM runs on the
//! single STA worker thread in [`sta`].

pub mod access;
pub mod contextmenu;
pub mod desktop;
pub mod elevate;
pub mod extract;
pub mod folder;
pub mod fonts;
pub mod fullscreen;
pub mod known;
pub mod notify;
pub mod shortcut;
pub mod sta;
pub mod sysicons;
pub mod urlfile;
pub mod wallpaper;

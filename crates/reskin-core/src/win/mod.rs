//! Windows shell integration. Everything that touches COM runs on the
//! single STA worker thread in [`sta`]; the COM-using functions also
//! initialise COM for their own duration when called from another thread,
//! but the app always goes through [`sta::Sta::run`].

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
mod util;
pub mod wallpaper;

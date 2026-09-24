//! IPC types shared by the Rust backend and the web front end.
//!
//! Everything here crosses the Tauri IPC boundary as JSON. With the `ts`
//! feature the types are exported to `src/lib/ipc/bindings/*.ts` by ts-rs
//! (`pnpm bindings`); CI fails if the checked-in bindings drift.
//!
//! Conventions:
//! - struct fields are `camelCase` on the wire;
//! - enums with data are internally tagged with `type`;
//! - timestamps are unix milliseconds carried as `f64` so TS sees `number`;
//! - images are PNG, base64 encoded (no `data:` prefix) unless a field says
//!   it is a data URL.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// An axis-aligned rectangle. The unit (CSS px or physical px) depends on
/// where it is used and is always stated on the field that carries it.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
    /// True when `other` lies entirely inside `self` (edges may touch).
    pub fn contains_rect(&self, other: &Rect) -> bool {
        const EPS: f64 = 1e-6;
        other.x >= self.x - EPS
            && other.y >= self.y - EPS
            && other.right() <= self.right() + EPS
            && other.bottom() <= self.bottom() + EPS
    }
    pub fn contains_point(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.right() && y < self.bottom()
    }
    pub fn scale(&self, k: f64) -> Rect {
        Rect::new(self.x * k, self.y * k, self.w * k, self.h * k)
    }
    pub fn translate(&self, dx: f64, dy: f64) -> Rect {
        Rect::new(self.x + dx, self.y + dy, self.w, self.h)
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum BoxSkin {
    #[default]
    Glass,
    Neon,
    Minimal,
    Aurora,
}

/// Small / medium / large, used for both the box and the editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum SizeClass {
    Small,
    #[default]
    Medium,
    Large,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum MotionPref {
    /// Follow Windows (SPI_GETCLIENTAREAANIMATION) and `prefers-reduced-motion`.
    #[default]
    System,
    Reduced,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum OpenStyle {
    /// The box FLIP-morphs into the editor panel.
    #[default]
    Morph,
    /// Simple crossfade (also the automatic fallback).
    Crossfade,
}

/// Saved box position: top-left of the box *window* in physical pixels plus
/// the monitor it was on, so it can be re-validated when displays change.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SavedPos {
    pub x: i32,
    pub y: i32,
    pub monitor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Schema version of settings.json.
    pub schema: u32,
    pub theme: ThemeMode,
    /// Tint the UI with the Windows accent colour.
    pub use_accent: bool,
    pub box_skin: BoxSkin,
    pub box_size: SizeClass,
    /// Opacity of the idle box, 0.25..=1.
    pub idle_opacity: f64,
    pub box_position: Option<SavedPos>,
    pub editor_size: SizeClass,
    /// Animation speed multiplier, 0.5..=2 (2 = twice as fast).
    pub animation_speed: f64,
    pub motion: MotionPref,
    pub open_style: OpenStyle,
    pub sounds: bool,
    pub autostart: bool,
    /// Explorer context-menu verb "Reskin this icon" (HKCU).
    pub context_menu: bool,
    /// Global hotkey that toggles the box, e.g. "Ctrl+Alt+Shift+R". Empty = off.
    pub hotkey: String,
    /// Opaque windows with DWM rounded corners instead of transparency.
    pub compatibility_mode: bool,
    /// Destroy the editor when it closes instead of keeping it warm.
    pub low_memory: bool,
    /// Hide the box while a fullscreen app / presentation is running.
    pub auto_hide_fullscreen: bool,
    /// Also update matching Start-menu and taskbar-pin shortcuts.
    pub update_pins: bool,
    /// Play the celebratory fly-to-icon animation after applying.
    pub flourish: bool,
    /// First-run welcome has been shown.
    pub onboarded: bool,
    /// Most recent colours, newest first, `#rrggbbaa`.
    pub recent_colors: Vec<String>,
    /// Icon sizes written into .ico files.
    pub ico_sizes: Vec<u32>,
    /// Pixel-art grid used when pixel-art mode starts (16/24/32/48/64).
    pub pixel_grid: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema: Settings::SCHEMA,
            theme: ThemeMode::System,
            use_accent: true,
            box_skin: BoxSkin::Glass,
            box_size: SizeClass::Medium,
            idle_opacity: 0.92,
            box_position: None,
            editor_size: SizeClass::Medium,
            animation_speed: 1.0,
            motion: MotionPref::System,
            open_style: OpenStyle::Morph,
            sounds: false,
            autostart: false,
            context_menu: false,
            hotkey: "Ctrl+Alt+Shift+R".into(),
            compatibility_mode: false,
            low_memory: false,
            auto_hide_fullscreen: true,
            update_pins: false,
            flourish: true,
            onboarded: false,
            recent_colors: Vec::new(),
            ico_sizes: ICO_SIZES.to_vec(),
            pixel_grid: 32,
        }
    }
}

impl Settings {
    pub const SCHEMA: u32 = 1;
}

/// Every size Reskin writes into an .ico, smallest first.
pub const ICO_SIZES: [u32; 12] = [16, 20, 24, 32, 40, 48, 60, 64, 72, 96, 128, 256];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum WindowKind {
    Box,
    Editor,
}

/// Box geometry in CSS px. The window is `window` square; the visual box is
/// `visual` square, centred, leaving `margin` on every side for glow/scale.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BoxMetrics {
    pub window: f64,
    pub visual: f64,
    pub margin: f64,
    pub radius: f64,
}

impl BoxMetrics {
    pub fn for_size(size: SizeClass) -> Self {
        let (visual, radius) = match size {
            SizeClass::Small => (96.0, 24.0),
            SizeClass::Medium => (120.0, 30.0),
            SizeClass::Large => (148.0, 36.0),
        };
        let margin = 14.0;
        Self {
            window: visual + 2.0 * margin,
            visual,
            margin,
            radius,
        }
    }
}

/// Editor window size in CSS px for a size class (before clamping to the
/// work area).
pub fn editor_size(size: SizeClass) -> (f64, f64) {
    match size {
        SizeClass::Small => (900.0, 620.0),
        SizeClass::Medium => (1080.0, 720.0),
        SizeClass::Large => (1280.0, 820.0),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub window: WindowKind,
    pub version: String,
    pub settings: Settings,
    /// Windows has client-area animations turned off.
    pub system_reduced_motion: bool,
    /// Windows accent colour as `#rrggbb`.
    pub accent: Option<String>,
    /// e.g. "release 1a2b3c4".
    pub build: String,
    /// Running under `--smoke-test`.
    pub smoke: bool,
    /// The first-run welcome hasn't been finished (`Settings::onboarded`).
    pub first_run: bool,
    pub box_metrics: BoxMetrics,
    /// Windows 11 or later (rounded corners, Mica-era visuals).
    pub windows11: bool,
    /// Why the saved global hotkey doesn't work right now (another app
    /// held it when Reskin tried to register it); absent when it works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub hotkey_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Items (things dropped on the box)
// ---------------------------------------------------------------------------

/// Opaque handle for an inspected item. Rust keeps the `ItemId -> path`
/// map; mutating commands only ever accept ids, never raw paths.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(transparent)]
pub struct ItemId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    /// `.lnk`
    Shortcut,
    /// `.url` (web links, Steam / Epic game shortcuts)
    InternetShortcut,
    Folder,
    /// This PC, Recycle Bin, …
    SystemIcon,
    /// `.exe` — never modified; Reskin offers a new shortcut instead.
    Executable,
    /// png/jpg/svg/ico/… — becomes the design source.
    Image,
    /// Any other file — offered a new shortcut.
    File,
    /// Reskin project file.
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum Access {
    /// The current user can write the target.
    Writable,
    /// Needs the elevated helper (e.g. Public Desktop).
    NeedsElevation,
    /// Cannot be changed in place (read-only media, protected location).
    ReadOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum ItemLocation {
    UserDesktop,
    PublicDesktop,
    StartMenu,
    TaskbarPin,
    System,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum SystemIconId {
    ThisPc,
    RecycleBinEmpty,
    RecycleBinFull,
    UserFiles,
    Network,
    ControlPanel,
}

impl SystemIconId {
    pub const ALL: [SystemIconId; 6] = [
        SystemIconId::ThisPc,
        SystemIconId::RecycleBinEmpty,
        SystemIconId::RecycleBinFull,
        SystemIconId::UserFiles,
        SystemIconId::Network,
        SystemIconId::ControlPanel,
    ];

    pub fn label(self) -> &'static str {
        match self {
            SystemIconId::ThisPc => "This PC",
            SystemIconId::RecycleBinEmpty => "Recycle Bin (empty)",
            SystemIconId::RecycleBinFull => "Recycle Bin (full)",
            SystemIconId::UserFiles => "User files",
            SystemIconId::Network => "Network",
            SystemIconId::ControlPanel => "Control Panel",
        }
    }

    /// Shell CLSID of the namespace object.
    pub fn clsid(self) -> &'static str {
        match self {
            SystemIconId::ThisPc => "{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
            SystemIconId::RecycleBinEmpty | SystemIconId::RecycleBinFull => {
                "{645FF040-5081-101B-9F08-00AA002F954E}"
            }
            SystemIconId::UserFiles => "{59031a47-3f72-44a7-89c5-5595fe6b30ee}",
            SystemIconId::Network => "{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}",
            SystemIconId::ControlPanel => "{5399E694-6CE5-4D6C-8FCE-1D8870FDCBA0}",
        }
    }

    /// Value name under `…\CLSID\{GUID}\DefaultIcon` ("" = `(Default)`).
    pub fn value_name(self) -> &'static str {
        match self {
            SystemIconId::RecycleBinEmpty => "empty",
            SystemIconId::RecycleBinFull => "full",
            _ => "",
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            SystemIconId::ThisPc => "this-pc",
            SystemIconId::RecycleBinEmpty => "recycle-bin-empty",
            SystemIconId::RecycleBinFull => "recycle-bin-full",
            SystemIconId::UserFiles => "user-files",
            SystemIconId::Network => "network",
            SystemIconId::ControlPanel => "control-panel",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum IconSource {
    /// Frames read from an .ico file.
    IcoFile,
    /// Exact RT_GROUP_ICON rebuild from a PE resource.
    Resource,
    /// IShellItemImageFactory rendering.
    Shell,
    /// The item itself is an image.
    Image,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum ApplyMode {
    /// Change the item's own icon.
    InPlace,
    /// Create a new desktop shortcut with the icon (exe / other files,
    /// Store apps whose IconLocation is ignored).
    NewShortcut,
    /// Copy a Public-Desktop shortcut to the user's desktop and change that.
    PersonalCopy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub id: ItemId,
    pub kind: ItemKind,
    /// Display name (file stem / system icon label).
    pub name: String,
    /// Full path, for display only.
    pub path: String,
    /// Shortcut / URL target, for display only.
    pub target: Option<String>,
    pub location: ItemLocation,
    pub access: Access,
    /// Apply modes that make sense for this item, preferred first. Empty
    /// for items that can only be a design source (images, projects).
    pub modes: Vec<ApplyMode>,
    /// Best preview of the current icon as a `data:image/png;base64,` URL
    /// (≤256 px, straight alpha), or the image itself for image files.
    pub icon: Option<String>,
    pub icon_source: IconSource,
    /// The item already has a custom icon (set by Reskin or anyone else).
    pub custom_icon: bool,
    /// Reskin's journal has an applied change for this target.
    pub reskinned: bool,
    /// Shortcut to a Store (AppsFolder) app; IconLocation may be ignored.
    pub store_app: bool,
    pub system_icon: Option<SystemIconId>,
    /// Human-readable notes for the UI (e.g. "Public desktop — needs admin").
    pub notes: Vec<String>,
    /// Set on the first item `inspect_paths` returns when it was given more
    /// paths than it inspects in one call: how many it left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub skipped: Option<u32>,
}

/// One frame of an icon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct IconFrame {
    pub width: u32,
    pub height: u32,
    /// base64 PNG, straight alpha.
    pub png: String,
}

// ---------------------------------------------------------------------------
// Apply / restore / history
// ---------------------------------------------------------------------------

/// A rendered square icon image at one size.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SizedPng {
    pub size: u32,
    /// base64 PNG (RGBA, straight alpha), `size`×`size`.
    pub png: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ApplyRequest {
    pub item: ItemId,
    /// One image per size in `Settings::ico_sizes`.
    pub images: Vec<SizedPng>,
    /// Optional design name, stored in history.
    pub design_name: Option<String>,
    pub mode: ApplyMode,
    /// Play the collapse → fly → drop animation and commit at landing.
    pub flourish: bool,
    /// Also update matching Start-menu / taskbar-pin shortcuts.
    pub update_pins: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Shortcut,
    InternetShortcut,
    Folder,
    SystemIcon,
    /// A shortcut Reskin created (restore deletes it).
    CreatedShortcut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum EntryState {
    /// Written before touching the target; reconciled on startup.
    Pending,
    Applied,
    /// A later entry for the same target replaced this one.
    Superseded,
    Restored,
    Failed,
}

/// The icon a target had before Reskin touched it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct OriginalIcon {
    /// Raw icon location (unexpanded), `None` = no custom icon / value absent.
    pub location: Option<String>,
    pub index: i32,
    /// For registry-backed system icons: the value existed at all.
    pub existed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub kind: TargetKind,
    /// Absolute path of the target, or the system icon slug.
    pub target: String,
    pub name: String,
    pub system_icon: Option<SystemIconId>,
    /// The .ico Reskin wrote and pointed the target at.
    pub icon_path: String,
    pub original: OriginalIcon,
    pub state: EntryState,
    pub elevated: bool,
    /// 48 px PNG thumbnail of the applied icon (base64).
    pub thumb: Option<String>,
    pub design_name: Option<String>,
    /// Unix ms.
    pub applied_at: f64,
    /// Unix ms, set when restored.
    pub restored_at: Option<f64>,
    /// Entry that this one was applied on top of (same target), if any.
    pub supersedes: Option<String>,
    /// Set on the extra entries of one apply (matching Start-menu and
    /// taskbar-pin shortcuts): the id of the apply's main entry. Undoing
    /// the main entry undoes them too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub group: Option<String>,
}

/// Where the applied icon sits on screen, for the fly-to-icon flourish.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct DesktopSpot {
    /// Screen rect of the icon image in physical px.
    pub rect: Rect,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApplyOutcome {
    Applied {
        /// The main entry first, then one per matching pin that was updated.
        entries: Vec<HistoryEntry>,
        /// The box flew to the icon on the desktop (false = celebrated in place).
        landed: bool,
        /// How many matching Start-menu / taskbar-pin shortcuts were left
        /// unchanged because Windows won't let Reskin change them (e.g. in
        /// the all-users Start menu); absent when there were none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        skipped_pins: Option<u32>,
    },
    /// The target needs admin rights. Call `apply_icon_elevated(ticket)`
    /// after the user agrees, or retry with `PersonalCopy`.
    NeedsElevation {
        ticket: String,
        reason: String,
    },
    Unsupported {
        reason: String,
    },
    Cancelled,
    Failed {
        message: String,
        hint: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestoreTarget {
    Item { item: ItemId },
    Entry { id: String },
    All,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: u32,
    pub failed: Vec<String>,
    pub needs_elevation: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum RefreshLevel {
    /// SHChangeNotify(ASSOCCHANGED) + per-item updates.
    Notify,
    /// `ie4uinit -show` (rebuilds the icon cache view).
    Rebuild,
}

// ---------------------------------------------------------------------------
// Files: export, import, library
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum ExportKind {
    Ico,
    Png,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub kind: ExportKind,
    /// File name without extension.
    pub suggested_name: String,
    /// Ico: every size. Png: exactly one image.
    pub images: Vec<SizedPng>,
    /// Project: the .reskin JSON.
    pub data: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum PickPurpose {
    /// Images, icons, shortcuts, executables — anything with an icon.
    Import,
    /// A .reskin project.
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub name: String,
    /// base64 PNG thumbnail (≤128 px).
    pub thumb: String,
    pub updated_at: f64,
    pub bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct LibrarySave {
    /// Overwrite this entry; `None` creates a new one.
    pub id: Option<String>,
    pub name: String,
    pub thumb: String,
    /// The .reskin JSON.
    pub data: String,
}

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum WallpaperFit {
    Fill,
    Fit,
    Stretch,
    Tile,
    Center,
    Span,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct WallpaperInfo {
    /// A wallpaper image is available via `wallpaper()`.
    pub has_image: bool,
    pub fit: WallpaperFit,
    /// Desktop background colour `#rrggbb`.
    pub background: String,
    /// Monitor size in physical px (the one the box is on).
    pub monitor_width: u32,
    pub monitor_height: u32,
    /// Desktop icon size in px (32/48/96…).
    pub icon_size: u32,
    /// Windows uses a dark taskbar ("system" theme).
    pub dark_taskbar: bool,
    pub accent: Option<String>,
}

// ---------------------------------------------------------------------------
// Box window
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "lowercase")]
pub enum DragResult {
    /// Released within the 4 px click threshold.
    Click,
    Moved,
}

/// Which view the editor should show when it opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum EditorView {
    /// Start page: recent designs, drop hint, system icons.
    #[default]
    Start,
    /// Straight into editing the given items.
    Edit,
    Library,
    History,
    Settings,
    SystemIcons,
    Welcome,
    About,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum FlightPhase {
    /// Leaving home toward the desktop icon (payload: icon preview).
    Depart,
    /// Arrived over the icon; the change was committed.
    Land,
    /// Gliding back home.
    Return,
    /// Back home, idle.
    Home,
    /// Could not find the icon on screen: celebrate in place.
    Celebrate,
    /// Something failed: shake.
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BoxFlight {
    pub phase: FlightPhase,
    /// Data URL of the icon being carried.
    pub icon: Option<String>,
    /// How long this leg lasts (ms), so the box can time its squash.
    pub duration_ms: u32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BoxProgress {
    pub done: u32,
    pub total: u32,
}

/// `box:handoff`: sent to the visible box as the editor starts to open over
/// it. The box takes on the picture the editor's proxy draws — the first
/// item's icon with a badge for more than one item, or the empty box — and
/// confirms with `box_painted(session)` once it shows it (an open the box
/// asked for finds it on that picture already).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BoxHandoff {
    /// Box session: numbers every picture handed to the box (`box:handoff`,
    /// `box:collapse`), apart from the editor's handoff sessions.
    pub session: u32,
    /// Data URL of the first item's icon.
    pub icon: Option<String>,
    /// Number of items opening.
    pub count: u32,
}

/// `box:collapse`: sent to the still hidden box once the editor has
/// collapsed onto its proxy. The box takes on the proxy's final picture
/// (the empty box after `Hide`, `icon` after `Fly` / `Celebrate`) so that it
/// is shown under an identical picture, then confirms with `box_painted`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct BoxCollapse {
    /// Box session (see `BoxHandoff::session`).
    pub session: u32,
    pub then: CollapseThen,
    /// Data URL of the icon the box carries (as in `EditorCmd::Collapse`).
    pub icon: Option<String>,
}

// ---------------------------------------------------------------------------
// Editor mailbox (Rust -> editor), acks (editor -> Rust)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum CollapseThen {
    /// Plain close.
    Hide,
    /// Hand the icon to the box, which flies to the desktop icon.
    Fly,
    /// Celebrate in place (icon not visible on the desktop).
    Celebrate,
}

/// Commands delivered to the editor through `editor_next`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditorCmd {
    /// Draw the box proxy at `box_rect` (editor CSS px), load items, then
    /// ack `Prepared`. The window is still hidden.
    Prepare {
        session: u32,
        /// Where the box is; `None` while it is hidden: no proxy, the panel
        /// fades in (`morph` is false then).
        box_rect: Option<Rect>,
        items: Vec<ItemInfo>,
        view: EditorView,
        /// Settings snapshot (the editor may have been warm for a while).
        settings: Settings,
        /// false = crossfade (reduced motion, user setting or fallback).
        morph: bool,
    },
    /// The window is now visible on top of the box: ack `Revealed` after a
    /// double rAF so Rust can hide the real box.
    Reveal {
        session: u32,
    },
    /// The real box is hidden: morph the proxy into the panel (or, when
    /// `morph` is false because `Prepared` came too late, crossfade the
    /// panel in), then ack `Expanded`.
    Expand {
        session: u32,
        morph: bool,
    },
    /// Collapse into a proxy at `box_rect`, ack `Collapsed`.
    Collapse {
        session: u32,
        box_rect: Rect,
        then: CollapseThen,
        /// Icon the box should carry (for `Fly`).
        icon: Option<String>,
        /// false = fade out instead of collapsing into the proxy (the box is
        /// hidden, or reduced motion).
        morph: bool,
    },
    /// The box is visible again: clear to transparent, ack `Cleared`.
    Clear {
        session: u32,
    },
    /// More items were dropped while the editor was open.
    AddItems {
        items: Vec<ItemInfo>,
    },
    /// Switch view without a morph (editor already open).
    Navigate {
        view: EditorView,
    },
    Settings {
        settings: Settings,
    },
    /// `--smoke-test` only: render the current design through the export
    /// pipeline, `apply_icon` it to `item` (a temp fixture), `restore` it,
    /// then report the outcome with `smoke_ready`.
    SmokeCycle {
        item: ItemId,
    },
    /// Nothing happened for a while; poll again.
    Heartbeat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub seq: u32,
    pub cmd: EditorCmd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum AckStage {
    Prepared,
    Revealed,
    Expanded,
    Collapsed,
    Cleared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    /// Close button / Esc.
    User,
    /// Not a request: the page settled an apply that closed the editor
    /// (Rust drove that collapse and flight itself). Low-memory mode
    /// destroys the editor only then.
    Applied,
    /// Hotkey / tray "hide".
    Hide,
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SmokeReport {
    pub window: WindowKind,
    /// Free-form diagnostics from the page (renderer, timings).
    pub detail: String,
}

/// Output of `reskin.exe --self-test`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SelfTest {
    pub version: String,
    pub ok: bool,
    pub checks: Vec<SelfTestCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SelfTestCheck {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_roundtrip_and_partial_json() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
        // Missing fields fall back to defaults.
        let partial: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(partial.theme, ThemeMode::Dark);
        assert_eq!(partial.hotkey, "Ctrl+Alt+Shift+R");
        assert_eq!(partial.ico_sizes, ICO_SIZES.to_vec());
    }

    #[test]
    fn tagged_enums_use_type_field() {
        let cmd = EditorCmd::Reveal { session: 3 };
        assert_eq!(
            serde_json::to_string(&cmd).unwrap(),
            r#"{"type":"reveal","session":3}"#
        );
        let c: EditorCmd = serde_json::from_str(
            r#"{"type":"collapse","session":1,"boxRect":{"x":0,"y":0,"w":10,"h":10},"then":"fly","icon":null,"morph":true}"#,
        )
        .unwrap();
        assert!(matches!(
            c,
            EditorCmd::Collapse {
                then: CollapseThen::Fly,
                ..
            }
        ));
        let b = BoxCollapse {
            session: 2,
            then: CollapseThen::Celebrate,
            icon: None,
        };
        assert_eq!(
            serde_json::to_string(&b).unwrap(),
            r#"{"session":2,"then":"celebrate","icon":null}"#
        );
        let h = BoxHandoff {
            session: 3,
            icon: None,
            count: 2,
        };
        assert_eq!(
            serde_json::to_string(&h).unwrap(),
            r#"{"session":3,"icon":null,"count":2}"#
        );
        // A hidden box: no rect to draw the proxy at.
        let p: EditorCmd = serde_json::from_value(serde_json::json!({
            "type": "prepare",
            "session": 4,
            "boxRect": null,
            "items": [],
            "view": "start",
            "settings": Settings::default(),
            "morph": false
        }))
        .unwrap();
        assert!(matches!(p, EditorCmd::Prepare { box_rect: None, .. }));
        let o = ApplyOutcome::NeedsElevation {
            ticket: "t".into(),
            reason: "r".into(),
        };
        assert_eq!(
            serde_json::to_string(&o).unwrap(),
            r#"{"type":"needsElevation","ticket":"t","reason":"r"}"#
        );
    }

    #[test]
    fn box_metrics_have_margin() {
        for s in [SizeClass::Small, SizeClass::Medium, SizeClass::Large] {
            let m = BoxMetrics::for_size(s);
            assert_eq!(m.window, m.visual + 2.0 * m.margin);
        }
        assert_eq!(BoxMetrics::for_size(SizeClass::Medium).window, 148.0);
    }

    #[test]
    fn rect_helpers() {
        let a = Rect::new(0.0, 0.0, 100.0, 100.0);
        assert!(a.contains_rect(&Rect::new(10.0, 10.0, 90.0, 90.0)));
        assert!(!a.contains_rect(&Rect::new(10.0, 10.0, 91.0, 90.0)));
        assert!(a.contains_point(0.0, 99.9));
        assert!(!a.contains_point(100.0, 50.0));
    }
}

//! `settings.json`: loading (with recovery from damaged files), saving,
//! sanitising, the global-hotkey parser, and how the settings that mirror
//! OS state (hotkey, "Start with Windows", Explorer verb) stay true to it.

pub mod autostart;

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use self::autostart::StartupEntry;
use crate::model::{ICO_SIZES, Settings};
use crate::{Error, Result, now_ms, store};

/// Pixel-art grids the editor offers.
pub const PIXEL_GRIDS: [u32; 5] = [16, 24, 32, 48, 64];

/// Sizes every `.ico` must contain whatever the user picks: the shell
/// falls back to scaling these when a size is missing.
pub const REQUIRED_ICO_SIZES: [u32; 4] = [16, 32, 48, 256];

/// How many recent colours are remembered.
pub const MAX_RECENT_COLORS: usize = 16;

const DEFAULT_PIXEL_GRID: u32 = 32;

/// Loads settings. The first-run welcome is due while `onboarded` is false
/// (the welcome sets it when the user finishes it), so a settings file
/// written before that — the box dragged, a setting changed — doesn't skip
/// it.
///
/// * missing file → defaults (not onboarded: first run);
/// * a file that is not a JSON object → it is moved aside to
///   `settings.json.bak-<unix ms>` and defaults are used;
/// * a JSON object with some unusable fields (wrong types) → those fields
///   fall back to their defaults, the rest are kept;
/// * a file that cannot be read at all → defaults, left untouched.
///
/// Recovered defaults count as onboarded: a settings file existed, so
/// Reskin has run here before. The result is always [`normalize`]d.
pub fn load(path: &Path) -> Settings {
    let been_here = Settings {
        onboarded: true,
        ..Settings::default()
    };
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Settings::default(),
        Err(_) => return been_here,
    };
    match parse_lenient(&bytes) {
        Some(settings) => normalize(settings),
        None => {
            // Best effort: if the rename fails the next save overwrites it.
            let _ = std::fs::rename(path, backup_path(path));
            been_here
        }
    }
}

/// `settings.json` → `settings.json.bak-<unix ms>`.
fn backup_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_owned());
    path.with_file_name(format!("{name}.bak-{}", now_ms() as u64))
}

/// Parses settings, salvaging every individually valid field when the
/// object as a whole does not deserialise. `None` when the bytes are not a
/// JSON object at all.
fn parse_lenient(bytes: &[u8]) -> Option<Settings> {
    let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(store::strip_bom(bytes)) else {
        return None;
    };
    // `Settings` is `#[serde(default)]`, so a single field deserialises on
    // its own and fields are independent of each other.
    let valid: Map<String, Value> = map
        .into_iter()
        .filter(|(key, value)| {
            let mut single = Map::new();
            single.insert(key.clone(), value.clone());
            serde_json::from_value::<Settings>(Value::Object(single)).is_ok()
        })
        .collect();
    serde_json::from_value(Value::Object(valid)).ok()
}

/// Normalises and atomically writes settings; returns what was written.
pub fn save(path: &Path, settings: &Settings) -> Result<Settings> {
    let normalized = normalize(settings.clone());
    store::write_json(path, &normalized)?;
    Ok(normalized)
}

/// Brings every field into its valid range:
///
/// * `schema` = [`Settings::SCHEMA`];
/// * `idle_opacity` ∈ 0.25..=1, `animation_speed` ∈ 0.5..=2 (NaN → default);
/// * `ico_sizes` ⊆ [`ICO_SIZES`], ascending, unique, always including
///   [`REQUIRED_ICO_SIZES`];
/// * `pixel_grid` ∈ [`PIXEL_GRIDS`] (else 32);
/// * `recent_colors`: valid `#rrggbb` / `#rrggbbaa`, lowercase, unique,
///   at most [`MAX_RECENT_COLORS`] (newest first is preserved);
/// * `hotkey`: canonical form ("Ctrl+Alt+Shift+R"), "" when disabled, the
///   default when it does not parse.
pub fn normalize(mut s: Settings) -> Settings {
    let defaults = Settings::default();
    s.schema = Settings::SCHEMA;
    s.idle_opacity = clamp_or(s.idle_opacity, 0.25, 1.0, defaults.idle_opacity);
    s.animation_speed = clamp_or(s.animation_speed, 0.5, 2.0, 1.0);

    let mut sizes: Vec<u32> = s
        .ico_sizes
        .iter()
        .copied()
        .filter(|size| ICO_SIZES.contains(size))
        .chain(REQUIRED_ICO_SIZES)
        .collect();
    sizes.sort_unstable();
    sizes.dedup();
    s.ico_sizes = sizes;

    if !PIXEL_GRIDS.contains(&s.pixel_grid) {
        s.pixel_grid = DEFAULT_PIXEL_GRID;
    }

    let mut colors: Vec<String> = Vec::with_capacity(MAX_RECENT_COLORS);
    for color in &s.recent_colors {
        let color = color.trim().to_ascii_lowercase();
        if is_hex_color(&color) && !colors.contains(&color) {
            colors.push(color);
            if colors.len() == MAX_RECENT_COLORS {
                break;
            }
        }
    }
    s.recent_colors = colors;

    s.hotkey = match parse_hotkey(&s.hotkey) {
        Ok(Some(hotkey)) => hotkey.to_string(),
        Ok(None) => String::new(),
        Err(_) => defaults.hotkey,
    };
    s
}

fn clamp_or(v: f64, lo: f64, hi: f64, nan: f64) -> f64 {
    if v.is_nan() { nan } else { v.clamp(lo, hi) }
}

/// `#rrggbb` or `#rrggbbaa` (any case).
pub fn is_hex_color(s: &str) -> bool {
    s.strip_prefix('#').is_some_and(|hex| {
        (hex.len() == 6 || hex.len() == 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

// ---------------------------------------------------------------------------
// Settings that mirror OS state
// ---------------------------------------------------------------------------

/// The OS state behind the settings that mirror it: the global hotkey's
/// registration, the "Start with Windows" entry and the Explorer verb.
/// The app implements it on Windows; tests fake it.
pub trait SystemSettings {
    /// The hotkey registered right now (canonical form, `""` = none).
    fn hotkey(&self) -> String;
    /// Registers `hotkey` (canonical, `""` = none) in place of the current
    /// one. On failure the current one must stay registered.
    fn set_hotkey(&mut self, hotkey: &str) -> Result<()>;
    /// The "Start with Windows" entry as Windows has it.
    fn autostart(&self) -> Result<StartupEntry>;
    /// Creates (for this executable, enabled) or removes the entry.
    fn set_autostart(&mut self, on: bool) -> Result<()>;
    /// The Explorer verb is registered.
    fn context_menu(&self) -> bool;
    /// The Explorer verb is registered and launches an executable that
    /// still exists (possibly another copy of Reskin, which keeps it).
    fn context_menu_usable(&self) -> bool;
    /// Registers (for this executable) or removes the Explorer verb.
    fn set_context_menu(&mut self, on: bool) -> Result<()>;
}

/// Applies the OS side of a settings change from `old` to `new` and
/// returns the settings to save, with a user-facing message for every
/// change that failed. A failed change is taken back so the saved settings
/// match the OS: the hotkey keeps its old value (still registered), "Start
/// with Windows" and the Explorer verb take the state Windows reports (the
/// old value when it can't be read either).
///
/// A saved hotkey that isn't registered (it was taken when Reskin started)
/// is tried again with every change; that attempt failing is no error of
/// the change, since the hotkey wasn't part of it.
pub fn apply_system_change(
    sys: &mut impl SystemSettings,
    old: &Settings,
    mut new: Settings,
) -> (Settings, Vec<String>) {
    let mut errors = Vec::new();
    if new.hotkey != sys.hotkey()
        && let Err(e) = sys.set_hotkey(&new.hotkey)
        && new.hotkey != old.hotkey
    {
        errors.push(format!("Global shortcut: {e}"));
        new.hotkey = old.hotkey.clone();
    }
    if new.autostart != old.autostart
        && let Err(e) = sys.set_autostart(new.autostart)
    {
        errors.push(format!("Start with Windows: {e}"));
        new.autostart = sys
            .autostart()
            .map_or(old.autostart, |entry| entry == StartupEntry::Enabled);
    }
    if new.context_menu != old.context_menu
        && let Err(e) = sys.set_context_menu(new.context_menu)
    {
        errors.push(format!("Explorer menu: {e}"));
        new.context_menu = sys.context_menu();
    }
    (new, errors)
}

/// Startup: brings the OS state and the saved settings back in line and
/// returns the settings to use, with a message for everything that failed.
///
/// * the hotkey is registered; when that fails the setting is kept (the
///   other app may be gone next time) and the error reported;
/// * "Start with Windows" follows Windows: an entry turned off (or back on)
///   in Task Manager updates the setting instead of being overridden; a
///   missing entry is created again when the setting is on; an entry that
///   can't be read is left alone, and so is the setting;
/// * the Explorer verb is registered again when on (pointing it at this
///   executable, which may have moved).
pub fn reconcile_system_settings(
    sys: &mut impl SystemSettings,
    mut saved: Settings,
) -> (Settings, Vec<String>) {
    let mut errors = Vec::new();
    if !saved.hotkey.is_empty()
        && let Err(e) = sys.set_hotkey(&saved.hotkey)
    {
        errors.push(format!("Global shortcut: {e}"));
    }
    match sys.autostart() {
        Ok(StartupEntry::Enabled) => saved.autostart = true,
        Ok(StartupEntry::Disabled) => saved.autostart = false,
        Ok(StartupEntry::Missing) => {
            if saved.autostart
                && let Err(e) = sys.set_autostart(true)
            {
                errors.push(format!("Start with Windows: {e}"));
                saved.autostart = false;
            }
        }
        // Writing now could undo what the user chose in Task Manager.
        Err(e) => errors.push(format!("Start with Windows: {e}")),
    }
    // Only a missing or broken verb is (re)registered: another copy of
    // Reskin that owns it (the installed one, when a portable or dev copy
    // starts) keeps it.
    if saved.context_menu
        && !sys.context_menu_usable()
        && let Err(e) = sys.set_context_menu(true)
    {
        errors.push(format!("Explorer menu: {e}"));
        saved.context_menu = sys.context_menu();
    }
    (saved, errors)
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

/// The non-modifier key of a [`Hotkey`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    /// `A`–`Z` (always uppercase).
    Letter(char),
    /// `0`–`9`.
    Digit(u8),
    /// `F1`–`F24`.
    F(u8),
    Space,
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Insert,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    /// The `=`/`+` key.
    Plus,
    Minus,
    Comma,
    Period,
    Slash,
    Backquote,
    BracketLeft,
    BracketRight,
    Backslash,
    Semicolon,
    Quote,
}

/// Named keys: `(key, user-facing name, W3C `KeyboardEvent.code`)`. The
/// code is what the global-shortcut plugin parses.
const NAMED_KEYS: [(Key, &str, &str); 26] = [
    (Key::Space, "Space", "Space"),
    (Key::Enter, "Enter", "Enter"),
    (Key::Tab, "Tab", "Tab"),
    (Key::Escape, "Escape", "Escape"),
    (Key::Backspace, "Backspace", "Backspace"),
    (Key::Delete, "Delete", "Delete"),
    (Key::Insert, "Insert", "Insert"),
    (Key::Home, "Home", "Home"),
    (Key::End, "End", "End"),
    (Key::PageUp, "PageUp", "PageUp"),
    (Key::PageDown, "PageDown", "PageDown"),
    (Key::Up, "Up", "ArrowUp"),
    (Key::Down, "Down", "ArrowDown"),
    (Key::Left, "Left", "ArrowLeft"),
    (Key::Right, "Right", "ArrowRight"),
    (Key::Plus, "Plus", "Equal"),
    (Key::Minus, "Minus", "Minus"),
    (Key::Comma, "Comma", "Comma"),
    (Key::Period, "Period", "Period"),
    (Key::Slash, "Slash", "Slash"),
    (Key::Backquote, "Backquote", "Backquote"),
    (Key::BracketLeft, "BracketLeft", "BracketLeft"),
    (Key::BracketRight, "BracketRight", "BracketRight"),
    (Key::Backslash, "Backslash", "Backslash"),
    (Key::Semicolon, "Semicolon", "Semicolon"),
    (Key::Quote, "Quote", "Quote"),
];

impl Key {
    /// Parses one key token (case-insensitive): `A`–`Z`, `0`–`9`,
    /// `F1`–`F24`, the named keys (`Space`, `Enter`, `Tab`, `Escape`/`Esc`,
    /// `Backspace`, `Delete`, `Insert`, `Home`, `End`, `PageUp`,
    /// `PageDown`, `Up`, `Down`, `Left`, `Right`, `Plus`, `Minus`, `Comma`,
    /// `Period`, `Slash`, `Backquote`, `BracketLeft`, `BracketRight`,
    /// `Backslash`, `Semicolon`, `Quote`), and the W3C code spellings
    /// (`KeyR`, `Digit5`, `ArrowUp`, `Equal`) so that
    /// [`Hotkey::to_accelerator`] output parses back.
    pub fn parse(token: &str) -> Option<Key> {
        let upper = token.to_ascii_uppercase();
        let single = |s: &str| {
            let mut chars = s.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Some(c),
                _ => None,
            }
        };
        let letter = single(&upper).or_else(|| upper.strip_prefix("KEY").and_then(single));
        if let Some(c) = letter.filter(char::is_ascii_uppercase) {
            return Some(Key::Letter(c));
        }
        let digit = single(&upper).or_else(|| upper.strip_prefix("DIGIT").and_then(single));
        if let Some(d) = digit.and_then(|c| c.to_digit(10)) {
            return Some(Key::Digit(d as u8));
        }
        // No sign or leading zero: "F05" is not a key name.
        if let Some(n) = upper.strip_prefix('F')
            && !n.starts_with(['0', '+', '-'])
            && let Ok(n) = n.parse::<u8>()
        {
            return (1..=24).contains(&n).then_some(Key::F(n));
        }
        if upper == "ESC" {
            return Some(Key::Escape);
        }
        NAMED_KEYS
            .iter()
            .find(|(_, name, code)| {
                upper.eq_ignore_ascii_case(name) || upper.eq_ignore_ascii_case(code)
            })
            .map(|(key, _, _)| *key)
    }

    fn named(self) -> Option<(&'static str, &'static str)> {
        NAMED_KEYS
            .iter()
            .find(|(key, _, _)| *key == self)
            .map(|(_, name, code)| (*name, *code))
    }

    /// The W3C `KeyboardEvent.code` name (`KeyR`, `Digit5`, `F5`,
    /// `ArrowUp`, `Equal`, …) understood by the global-shortcut plugin.
    pub fn code(self) -> String {
        match self {
            Key::Letter(c) => format!("Key{c}"),
            Key::Digit(d) => format!("Digit{d}"),
            Key::F(n) => format!("F{n}"),
            other => other.named().map(|(_, code)| code).unwrap_or("").to_owned(),
        }
    }
}

impl fmt::Display for Key {
    /// The user-facing name (`R`, `5`, `F5`, `Up`, `Plus`, …).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Key::Letter(c) => write!(f, "{c}"),
            Key::Digit(d) => write!(f, "{d}"),
            Key::F(n) => write!(f, "F{n}"),
            other => f.write_str(other.named().map(|(name, _)| name).unwrap_or("")),
        }
    }
}

/// A global hotkey: at least one modifier plus exactly one key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Hotkey {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
    pub key: Key,
}

impl Hotkey {
    /// The accelerator string for `tauri-plugin-global-shortcut` (parsed
    /// by `global_hotkey::hotkey::HotKey::from_str`), e.g.
    /// `"Control+Alt+Shift+KeyR"`.
    pub fn to_accelerator(&self) -> String {
        let mut out = String::new();
        for (on, name) in [
            (self.ctrl, "Control"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
            (self.win, "Super"),
        ] {
            if on {
                out.push_str(name);
                out.push('+');
            }
        }
        out.push_str(&self.key.code());
        out
    }
}

impl fmt::Display for Hotkey {
    /// Canonical user-facing form, modifiers in a fixed order:
    /// `Ctrl+Alt+Shift+Win+R`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (on, name) in [
            (self.ctrl, "Ctrl"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
            (self.win, "Win"),
        ] {
            if on {
                write!(f, "{name}+")?;
            }
        }
        write!(f, "{}", self.key)
    }
}

/// Parses a hotkey such as `"Ctrl+Alt+Shift+R"`.
///
/// Tokens are separated by `+` (surrounding spaces are ignored) and may
/// come in any order. Modifiers are case-insensitive: `Ctrl`/`Control`,
/// `Alt`, `Shift`, `Win`/`Super`/`Meta`/`Cmd`/`Command`, and
/// `CommandOrControl` (plus its `CmdOrCtrl`-style spellings) meaning Ctrl.
/// Exactly one key token is required (see [`Key::parse`]) and at least one
/// modifier. An empty string means "no hotkey" and yields `Ok(None)`.
pub fn parse_hotkey(s: &str) -> Result<Option<Hotkey>> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let invalid = |why: &str| Error::Other(format!("invalid hotkey {s:?}: {why}"));
    let (mut ctrl, mut alt, mut shift, mut win) = (false, false, false, false);
    let mut key = None;
    for raw in s.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err(invalid("empty key name (use \"Plus\" for the + key)"));
        }
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "commandorctrl" | "cmdorctrl"
            | "cmdorcontrol" => ctrl = true,
            "alt" => alt = true,
            "shift" => shift = true,
            "win" | "super" | "meta" | "cmd" | "command" => win = true,
            _ => {
                let parsed =
                    Key::parse(token).ok_or_else(|| invalid(&format!("unknown key {token:?}")))?;
                if key.replace(parsed).is_some() {
                    return Err(invalid("only one non-modifier key is allowed"));
                }
            }
        }
    }
    let Some(key) = key else {
        return Err(invalid("a key is missing"));
    };
    // Shift alone would swallow that character system-wide (Shift+A types
    // "A"), so a global hotkey needs Ctrl, Alt or Win — except for the
    // function keys, which type nothing.
    if !(ctrl || alt || shift || win) {
        return Err(invalid("add at least one of Ctrl, Alt, Shift or Win"));
    }
    if !(ctrl || alt || win || matches!(key, Key::F(_))) {
        return Err(invalid("add Ctrl, Alt or Win (Shift alone isn't enough)"));
    }
    Ok(Some(Hotkey {
        ctrl,
        alt,
        shift,
        win,
        key,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_hotkey_is_canonical() {
        let d = Settings::default();
        let hk = parse_hotkey(&d.hotkey).unwrap().unwrap();
        assert_eq!(hk.to_string(), d.hotkey);
        assert_eq!(hk.to_accelerator(), "Control+Alt+Shift+KeyR");
    }

    #[test]
    fn every_named_key_round_trips() {
        for (key, name, code) in NAMED_KEYS {
            assert_eq!(Key::parse(name), Some(key), "{name}");
            assert_eq!(Key::parse(code), Some(key), "{code}");
            assert_eq!(key.to_string(), name);
            assert_eq!(key.code(), code);
        }
        for n in 1..=24u8 {
            let key = Key::F(n);
            assert_eq!(Key::parse(&key.to_string()), Some(key));
        }
    }

    #[test]
    fn hex_colors() {
        assert!(is_hex_color("#a0B1c2"));
        assert!(is_hex_color("#a0b1c2ff"));
        for bad in ["a0b1c2", "#a0b1c", "#a0b1c2f", "#ggg000", "", "#"] {
            assert!(!is_hex_color(bad), "{bad}");
        }
    }

    /// Windows, faked: hotkeys another app holds, and failing writes.
    #[derive(Default)]
    struct FakeSystem {
        registered: String,
        taken: Vec<&'static str>,
        entry: Option<StartupEntry>,
        verb: bool,
        /// The registered verb names an executable that no longer exists.
        verb_broken: bool,
        registry_locked: bool,
        /// Reading the "Start with Windows" entry fails.
        registry_unreadable: bool,
        calls: Vec<String>,
    }

    impl SystemSettings for FakeSystem {
        fn hotkey(&self) -> String {
            self.registered.clone()
        }
        fn set_hotkey(&mut self, hotkey: &str) -> Result<()> {
            self.calls.push(format!("hotkey {hotkey}"));
            if self.taken.contains(&hotkey) {
                return Err(Error::Other(format!("{hotkey} is in use by another app")));
            }
            self.registered = hotkey.to_owned();
            Ok(())
        }
        fn autostart(&self) -> Result<StartupEntry> {
            if self.registry_unreadable {
                return Err(Error::AccessDenied("StartupApproved key".into()));
            }
            Ok(self.entry.unwrap_or(StartupEntry::Missing))
        }
        fn set_autostart(&mut self, on: bool) -> Result<()> {
            self.calls.push(format!("autostart {on}"));
            if self.registry_locked {
                return Err(Error::AccessDenied("Run key".into()));
            }
            self.entry = Some(if on {
                StartupEntry::Enabled
            } else {
                StartupEntry::Missing
            });
            Ok(())
        }
        fn context_menu(&self) -> bool {
            self.verb
        }
        fn context_menu_usable(&self) -> bool {
            self.verb && !self.verb_broken
        }
        fn set_context_menu(&mut self, on: bool) -> Result<()> {
            self.calls.push(format!("verb {on}"));
            if self.registry_locked {
                return Err(Error::AccessDenied("Classes key".into()));
            }
            self.verb = on;
            self.verb_broken = false;
            Ok(())
        }
    }

    fn with(f: impl FnOnce(&mut Settings)) -> Settings {
        let mut s = Settings::default();
        f(&mut s);
        s
    }

    #[test]
    fn a_hotkey_taken_by_another_app_keeps_the_old_one() {
        let old = Settings::default();
        let mut sys = FakeSystem {
            registered: old.hotkey.clone(),
            taken: vec!["Ctrl+Alt+K"],
            ..FakeSystem::default()
        };
        let (saved, errors) =
            apply_system_change(&mut sys, &old, with(|s| s.hotkey = "Ctrl+Alt+K".into()));
        assert_eq!(saved.hotkey, old.hotkey);
        assert_eq!(sys.registered, old.hotkey);
        assert_eq!(
            errors,
            ["Global shortcut: Ctrl+Alt+K is in use by another app"]
        );

        let (saved, errors) =
            apply_system_change(&mut sys, &old, with(|s| s.hotkey = "Ctrl+Alt+J".into()));
        assert_eq!((saved.hotkey.as_str(), errors.len()), ("Ctrl+Alt+J", 0));
        assert_eq!(sys.registered, "Ctrl+Alt+J");
    }

    #[test]
    fn an_unregistered_hotkey_is_retried_without_blaming_other_changes() {
        let old = Settings::default();
        let mut sys = FakeSystem {
            taken: vec!["Ctrl+Alt+Shift+R"],
            ..FakeSystem::default()
        };
        let (saved, errors) = apply_system_change(&mut sys, &old, with(|s| s.sounds = true));
        assert!(saved.sounds);
        assert_eq!(saved.hotkey, old.hotkey, "the user's choice is kept");
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(sys.calls, ["hotkey Ctrl+Alt+Shift+R"]);

        // The other app let go of it: the next change registers it.
        sys.taken.clear();
        apply_system_change(&mut sys, &saved, saved.clone());
        assert_eq!(sys.registered, old.hotkey);
        // Registered: nothing to do any more.
        sys.calls.clear();
        apply_system_change(
            &mut sys,
            &saved,
            with(|s| s.theme = crate::model::ThemeMode::Dark),
        );
        assert!(sys.calls.is_empty(), "{:?}", sys.calls);
    }

    #[test]
    fn failed_os_writes_leave_the_setting_as_windows_has_it() {
        let old = Settings::default();
        let mut sys = FakeSystem {
            registered: old.hotkey.clone(),
            registry_locked: true,
            ..FakeSystem::default()
        };
        let (saved, errors) = apply_system_change(
            &mut sys,
            &old,
            with(|s| {
                s.autostart = true;
                s.context_menu = true;
                s.sounds = true;
            }),
        );
        assert!(!saved.autostart && !saved.context_menu && saved.sounds);
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(errors[0].starts_with("Start with Windows: "), "{errors:?}");
        assert!(errors[1].starts_with("Explorer menu: "), "{errors:?}");

        // Turning them off fails too: they stay on, as Windows has them.
        let on = with(|s| {
            s.autostart = true;
            s.context_menu = true;
        });
        sys.entry = Some(StartupEntry::Enabled);
        sys.verb = true;
        let (saved, errors) = apply_system_change(&mut sys, &on, Settings::default());
        assert!(saved.autostart && saved.context_menu);
        assert_eq!(errors.len(), 2);
        // Nor can the entry be read: the setting stays what it was.
        sys.registry_unreadable = true;
        let (saved, _) = apply_system_change(&mut sys, &on, Settings::default());
        assert!(saved.autostart);
        sys.registry_unreadable = false;

        sys.registry_locked = false;
        let (saved, errors) = apply_system_change(&mut sys, &on, Settings::default());
        assert!(!saved.autostart && !saved.context_menu && errors.is_empty());
        assert_eq!(sys.autostart().unwrap(), StartupEntry::Missing);
        assert!(!sys.verb);
    }

    #[test]
    fn startup_follows_task_manager_and_restores_what_is_missing() {
        let on = with(|s| s.autostart = true);
        // Turned off in Task Manager: the setting follows, the entry stays.
        let mut sys = FakeSystem {
            entry: Some(StartupEntry::Disabled),
            ..FakeSystem::default()
        };
        let (s, errors) = reconcile_system_settings(&mut sys, on.clone());
        assert!(!s.autostart && errors.is_empty());
        assert!(
            !sys.calls.iter().any(|c| c.starts_with("autostart")),
            "{:?}",
            sys.calls
        );
        assert_eq!(sys.autostart().unwrap(), StartupEntry::Disabled);

        // Turned back on there: the setting follows again.
        sys.entry = Some(StartupEntry::Enabled);
        let (s, _) = reconcile_system_settings(&mut sys, Settings::default());
        assert!(s.autostart);

        // Gone (e.g. removed by an uninstall that kept the settings): the
        // setting puts it back.
        let mut sys = FakeSystem::default();
        let (s, errors) = reconcile_system_settings(&mut sys, on.clone());
        assert!(s.autostart && errors.is_empty());
        assert_eq!(sys.autostart().unwrap(), StartupEntry::Enabled);
        let mut sys = FakeSystem {
            registry_locked: true,
            ..FakeSystem::default()
        };
        let (s, errors) = reconcile_system_settings(&mut sys, on.clone());
        assert!(!s.autostart);
        assert_eq!(errors.len(), 1);

        // Unreadable (it may be turned off in Task Manager): nothing is
        // written, and the setting stays as it was.
        let mut sys = FakeSystem {
            entry: Some(StartupEntry::Disabled),
            registry_unreadable: true,
            ..FakeSystem::default()
        };
        let (s, errors) = reconcile_system_settings(&mut sys, on);
        assert!(s.autostart);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].starts_with("Start with Windows: "), "{errors:?}");
        assert!(
            !sys.calls.iter().any(|c| c.starts_with("autostart")),
            "{:?}",
            sys.calls
        );
        assert_eq!(sys.entry, Some(StartupEntry::Disabled));
    }

    #[test]
    fn startup_registers_the_hotkey_and_the_verb() {
        let saved = with(|s| s.context_menu = true);
        let mut sys = FakeSystem::default();
        let (s, errors) = reconcile_system_settings(&mut sys, saved.clone());
        assert_eq!(s, saved);
        assert!(errors.is_empty());
        assert_eq!(sys.registered, saved.hotkey);
        assert_eq!(sys.calls, ["hotkey Ctrl+Alt+Shift+R", "verb true"]);

        // A hotkey another app holds is reported but stays the setting.
        let mut sys = FakeSystem {
            taken: vec!["Ctrl+Alt+Shift+R"],
            ..FakeSystem::default()
        };
        let (s, errors) = reconcile_system_settings(&mut sys, saved.clone());
        assert_eq!(s.hotkey, saved.hotkey);
        assert_eq!(
            errors,
            ["Global shortcut: Ctrl+Alt+Shift+R is in use by another app"]
        );

        // No hotkey, verb off: nothing to do.
        let mut sys = FakeSystem::default();
        reconcile_system_settings(&mut sys, with(|s| s.hotkey.clear()));
        assert!(sys.calls.is_empty(), "{:?}", sys.calls);
    }

    #[test]
    fn startup_keeps_a_working_verb_and_repairs_a_broken_one() {
        let saved = with(|s| {
            s.hotkey.clear();
            s.context_menu = true;
        });
        // Registered by another copy that still exists: left alone.
        let mut sys = FakeSystem {
            verb: true,
            ..FakeSystem::default()
        };
        let (s, errors) = reconcile_system_settings(&mut sys, saved.clone());
        assert_eq!((s.context_menu, errors.len()), (true, 0));
        assert!(sys.calls.is_empty(), "{:?}", sys.calls);

        // Its executable is gone (moved or uninstalled): point it at us.
        let mut sys = FakeSystem {
            verb: true,
            verb_broken: true,
            ..FakeSystem::default()
        };
        reconcile_system_settings(&mut sys, saved);
        assert_eq!(sys.calls, ["verb true"]);
        assert!(sys.context_menu_usable());
    }
}

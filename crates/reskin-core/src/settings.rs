//! `settings.json`: loading (with recovery from damaged files), saving,
//! sanitising, and the global-hotkey parser.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

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

/// Loads settings. Returns the settings and whether this is the first run
/// (no settings file existed).
///
/// * missing file → defaults, first run;
/// * a file that is not a JSON object → it is moved aside to
///   `settings.json.bak-<unix ms>` and defaults are used;
/// * a JSON object with some unusable fields (wrong types) → those fields
///   fall back to their defaults, the rest are kept;
/// * a file that cannot be read at all → defaults, left untouched.
///
/// The result is always [`normalize`]d.
pub fn load(path: &Path) -> (Settings, bool) {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return (Settings::default(), true),
        Err(_) => return (Settings::default(), false),
    };
    match parse_lenient(&bytes) {
        Some(settings) => (normalize(settings), false),
        None => {
            // Best effort: if the rename fails the next save overwrites it.
            let _ = std::fs::rename(path, backup_path(path));
            (Settings::default(), false)
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
    if !(ctrl || alt || shift || win) {
        return Err(invalid("add at least one of Ctrl, Alt, Shift or Win"));
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
}

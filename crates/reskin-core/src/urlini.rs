//! Pure reader/writer for Internet Shortcut (`.url`) files.
//!
//! A `.url` file is an INI file:
//!
//! ```text
//! [{000214A0-0000-0000-C000-000000000046}]
//! Prop3=19,0
//! [InternetShortcut]
//! URL=steam://rungameid/570
//! IconFile=C:\Program Files (x86)\Steam\steam\games\0bbb630d63262dd66d2fdd0f7d37e8661a410075.ico
//! IconIndex=0
//! [InternetShortcut.W]
//! IconFile=C:+AFw-Users+AFw-Jos+AOk-+AFw-icon.ico
//! ```
//!
//! Windows writes the plain `[InternetShortcut]` section in the ANSI code
//! page and, when a value is not representable there, repeats it in
//! `[InternetShortcut.W]` encoded as UTF-7 (RFC 2152). Readers prefer the
//! `.W` value. Files written by other tools (Steam, Epic, installers) may
//! instead be UTF-16LE or UTF-8, with or without a BOM.
//!
//! The INI layer itself is generic — case-insensitive section and key
//! lookup, `;` comment lines, surrounding quotes stripped like
//! `GetPrivateProfileString` does — so it also reads `desktop.ini` files.
//! Parsing never fails: any byte sequence yields some (possibly empty)
//! structure.

/// The plain section of a `.url` file.
pub const SECTION: &str = "InternetShortcut";
/// The Unicode section; its values are UTF-7 encoded on disk.
pub const SECTION_W: &str = "InternetShortcut.W";

const KEY_URL: &str = "URL";
const KEY_ICON_FILE: &str = "IconFile";
const KEY_ICON_INDEX: &str = "IconIndex";

/// How the file's bytes were (and will be) encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextEncoding {
    /// UTF-16 little endian with a BOM (also chosen for BOM-less UTF-16LE
    /// input, which is written back with a BOM).
    Utf16Le,
    /// UTF-16 big endian with a BOM.
    Utf16Be,
    /// UTF-8 with a BOM.
    Utf8Bom,
    /// UTF-8 without a BOM, which includes plain ASCII.
    #[default]
    Utf8,
    /// Not valid UTF-8: decoded as Windows-1252 ("ANSI"; the five bytes
    /// 1252 leaves undefined map to the Latin-1 code points).
    Ansi,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Section {
    name: String,
    /// `(key, value)` in file order; values of the `.W` section are stored
    /// decoded.
    entries: Vec<(String, String)>,
}

/// A parsed `.url` (or other INI) file. Values are stored decoded, sections
/// and keys keep their original order and spelling.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UrlFile {
    sections: Vec<Section>,
    encoding: TextEncoding,
}

impl UrlFile {
    /// An empty file (UTF-8 / ASCII encoding).
    pub fn new() -> Self {
        Self::default()
    }

    /// Parses a file's raw bytes (see [`decode_text`] for the encodings).
    /// Lines before the first section header, lines without `=` and lines
    /// with an empty key are ignored, as Windows does.
    pub fn parse(bytes: &[u8]) -> Self {
        let (text, encoding) = decode_text(bytes);
        let mut sections: Vec<Section> = Vec::new();
        for raw in text.split(['\n', '\r']) {
            let line =
                raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0');
            if line.is_empty() || line.starts_with(';') {
                continue;
            }
            if let Some(rest) = line.strip_prefix('[') {
                let name = rest.split(']').next().unwrap_or(rest).trim();
                sections.push(Section {
                    name: name.to_owned(),
                    entries: Vec::new(),
                });
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            let Some(section) = sections.last_mut() else {
                continue;
            };
            if key.is_empty() {
                continue;
            }
            let value = strip_quotes(value.trim());
            let value = if ci_eq(&section.name, SECTION_W) {
                utf7_decode(value)
            } else {
                value.to_owned()
            };
            section.entries.push((key.to_owned(), value));
        }
        Self { sections, encoding }
    }

    /// The encoding [`UrlFile::to_bytes`] writes (the input's encoding).
    pub fn encoding(&self) -> TextEncoding {
        self.encoding
    }

    pub fn set_encoding(&mut self, encoding: TextEncoding) {
        self.encoding = encoding;
    }

    /// Section names in file order (duplicates included).
    pub fn section_names(&self) -> impl Iterator<Item = &str> {
        self.sections.iter().map(|s| s.name.as_str())
    }

    /// No section holds any key (empty section headers don't count).
    pub fn is_empty(&self) -> bool {
        self.sections.iter().all(|s| s.entries.is_empty())
    }

    pub fn has_section(&self, section: &str) -> bool {
        self.sections.iter().any(|s| ci_eq(&s.name, section))
    }

    /// `(key, value)` pairs of every section with this name, in order.
    pub fn entries(&self, section: &str) -> impl Iterator<Item = (&str, &str)> {
        self.sections
            .iter()
            .filter(move |s| ci_eq(&s.name, section))
            .flat_map(|s| s.entries.iter().map(|(k, v)| (k.as_str(), v.as_str())))
    }

    /// The first value of `key` in `section` (both case-insensitive).
    /// Values of `[InternetShortcut.W]` are returned decoded.
    pub fn get(&self, section: &str, key: &str) -> Option<&str> {
        self.entries(section)
            .find(|(k, _)| ci_eq(k, key))
            .map(|(_, v)| v)
    }

    /// Sets `key` in `section`: replaces the first existing value, else
    /// appends to the first section with that name, else appends a new
    /// section at the end of the file.
    pub fn set(&mut self, section: &str, key: &str, value: &str) {
        for s in self.sections.iter_mut().filter(|s| ci_eq(&s.name, section)) {
            if let Some(entry) = s.entries.iter_mut().find(|(k, _)| ci_eq(k, key)) {
                entry.1 = value.to_owned();
                return;
            }
        }
        let entry = (key.to_owned(), value.to_owned());
        match self.sections.iter_mut().find(|s| ci_eq(&s.name, section)) {
            Some(s) => s.entries.push(entry),
            None => self.sections.push(Section {
                name: section.to_owned(),
                entries: vec![entry],
            }),
        }
    }

    /// Removes every occurrence of `key` from `section`; true if any existed.
    pub fn remove(&mut self, section: &str, key: &str) -> bool {
        let mut removed = false;
        for s in self.sections.iter_mut().filter(|s| ci_eq(&s.name, section)) {
            let before = s.entries.len();
            s.entries.retain(|(k, _)| !ci_eq(k, key));
            removed |= s.entries.len() != before;
        }
        removed
    }

    /// Removes the section(s) with this name if they hold no entries.
    fn drop_section_if_empty(&mut self, section: &str) {
        if self.entries(section).next().is_none() {
            self.sections.retain(|s| !ci_eq(&s.name, section));
        }
    }

    /// A shortcut property, preferring the `[InternetShortcut.W]` value.
    pub fn shortcut_value(&self, key: &str) -> Option<&str> {
        self.get(SECTION_W, key).or_else(|| self.get(SECTION, key))
    }

    /// The target URL, if present and non-empty.
    pub fn url(&self) -> Option<&str> {
        self.shortcut_value(KEY_URL).filter(|v| !v.is_empty())
    }

    /// The custom icon file, if present and non-empty (raw: it may contain
    /// `%VARS%` or be relative to the `.url` file's folder).
    pub fn icon_file(&self) -> Option<&str> {
        self.shortcut_value(KEY_ICON_FILE).filter(|v| !v.is_empty())
    }

    /// The icon index; 0 when absent or not a number.
    pub fn icon_index(&self) -> i32 {
        self.shortcut_value(KEY_ICON_INDEX)
            .and_then(parse_int)
            .unwrap_or(0)
    }

    /// Writes a shortcut property the way Windows does: always in the plain
    /// section (non-ASCII characters become `?` there, since that section
    /// is ANSI), and additionally in `[InternetShortcut.W]` when the value
    /// is not pure ASCII. `None` removes the key from both sections. An
    /// emptied `.W` section is removed.
    pub fn set_shortcut_value(&mut self, key: &str, value: Option<&str>) {
        match value {
            Some(v) => {
                self.set(SECTION, key, &ascii_fallback(v));
                if v.is_ascii() {
                    self.remove(SECTION_W, key);
                } else {
                    self.set(SECTION_W, key, v);
                }
            }
            None => {
                self.remove(SECTION, key);
                self.remove(SECTION_W, key);
            }
        }
        self.drop_section_if_empty(SECTION_W);
    }

    pub fn set_url(&mut self, url: &str) {
        self.set_shortcut_value(KEY_URL, Some(url));
    }

    /// Sets (`Some`) or clears (`None`, `index` ignored) the custom icon.
    pub fn set_icon(&mut self, file: Option<&str>, index: i32) {
        match file {
            Some(f) => {
                self.set_shortcut_value(KEY_ICON_FILE, Some(f));
                self.set_shortcut_value(KEY_ICON_INDEX, Some(&index.to_string()));
            }
            None => {
                self.set_shortcut_value(KEY_ICON_FILE, None);
                self.set_shortcut_value(KEY_ICON_INDEX, None);
            }
        }
    }

    /// Serialises the file with CRLF line endings. Values of the `.W`
    /// section are UTF-7 encoded; line breaks inside other values (which
    /// INI cannot represent) are dropped.
    pub fn to_ini_string(&self) -> String {
        let mut out = String::new();
        for s in &self.sections {
            out.push('[');
            out.push_str(&s.name);
            out.push_str("]\r\n");
            let wide = ci_eq(&s.name, SECTION_W);
            for (k, v) in &s.entries {
                out.push_str(k);
                out.push('=');
                if wide {
                    out.push_str(&utf7_encode(v));
                } else {
                    out.extend(v.chars().filter(|&c| c != '\r' && c != '\n'));
                }
                out.push_str("\r\n");
            }
        }
        out
    }

    /// [`UrlFile::to_ini_string`] encoded in [`UrlFile::encoding`]
    /// (characters Windows-1252 cannot represent become `?` in ANSI files).
    pub fn to_bytes(&self) -> Vec<u8> {
        let text = self.to_ini_string();
        match self.encoding {
            TextEncoding::Utf16Le => [0xFF, 0xFE]
                .into_iter()
                .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
                .collect(),
            TextEncoding::Utf16Be => [0xFE, 0xFF]
                .into_iter()
                .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
                .collect(),
            TextEncoding::Utf8Bom => [0xEF, 0xBB, 0xBF].into_iter().chain(text.bytes()).collect(),
            TextEncoding::Utf8 => text.into_bytes(),
            TextEncoding::Ansi => text.chars().map(cp1252_encode).collect(),
        }
    }
}

/// Decodes INI file bytes: UTF-16LE/BE and UTF-8 BOMs are honoured,
/// BOM-less UTF-16LE is recognised by its zero high bytes, then valid UTF-8
/// is taken as is and anything else is decoded as Windows-1252.
pub fn decode_text(bytes: &[u8]) -> (String, TextEncoding) {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        (
            utf16_decode(rest, u16::from_le_bytes),
            TextEncoding::Utf16Le,
        )
    } else if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        (
            utf16_decode(rest, u16::from_be_bytes),
            TextEncoding::Utf16Be,
        )
    } else if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        (
            String::from_utf8_lossy(rest).into_owned(),
            TextEncoding::Utf8Bom,
        )
    } else if looks_like_bomless_utf16le(bytes) {
        (
            utf16_decode(bytes, u16::from_le_bytes),
            TextEncoding::Utf16Le,
        )
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => (s.to_owned(), TextEncoding::Utf8),
            Err(_) => (
                bytes.iter().map(|&b| cp1252_decode(b)).collect(),
                TextEncoding::Ansi,
            ),
        }
    }
}

fn utf16_decode(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> String {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| unit([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
}

/// ASCII text stored as UTF-16LE has a zero high byte in every unit.
fn looks_like_bomless_utf16le(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(64) & !1];
    probe.len() >= 4 && probe.chunks_exact(2).all(|c| c[0] != 0 && c[1] == 0)
}

/// Windows-1252 code points for bytes 0x80..=0x9F (0 = undefined in 1252).
const CP1252_HIGH: [u16; 32] = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC,
    0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
];

fn cp1252_decode(b: u8) -> char {
    match b {
        0x80..=0x9F => match CP1252_HIGH[usize::from(b - 0x80)] {
            0 => char::from(b),
            cp => char::from_u32(u32::from(cp)).unwrap_or(char::from(b)),
        },
        _ => char::from(b),
    }
}

fn cp1252_encode(c: char) -> u8 {
    let cp = u32::from(c);
    if cp < 0x80 || (0xA0..=0xFF).contains(&cp) {
        return cp as u8;
    }
    CP1252_HIGH
        .iter()
        .position(|&h| h != 0 && u32::from(h) == cp)
        .map(|i| 0x80 + i as u8)
        .unwrap_or_else(|| match cp {
            // the bytes 1252 leaves undefined round-trip as themselves
            0x81 | 0x8D | 0x8F | 0x90 | 0x9D => cp as u8,
            _ => b'?',
        })
}

/// Replaces every non-ASCII character with `?` (the plain section's value
/// when the real one goes to `[InternetShortcut.W]`).
fn ascii_fallback(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii() { c } else { '?' })
        .collect()
}

/// `GetPrivateProfileString` drops one pair of matching surrounding quotes.
fn strip_quotes(v: &str) -> &str {
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return &v[1..v.len() - 1];
        }
    }
    v
}

/// Case-insensitive comparison of section / key names.
fn ci_eq(a: &str, b: &str) -> bool {
    if a.is_ascii() && b.is_ascii() {
        return a.eq_ignore_ascii_case(b);
    }
    a.chars()
        .flat_map(char::to_lowercase)
        .eq(b.chars().flat_map(char::to_lowercase))
}

/// Leading optional sign and digits, like `GetPrivateProfileInt`
/// (saturating at the i32 range).
fn parse_int(s: &str) -> Option<i32> {
    let s = s.trim();
    let (neg, rest) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let magnitude = rest[..digits].bytes().fold(0i64, |acc, d| {
        (acc * 10 + i64::from(d - b'0')).min(i64::from(i32::MAX) + 1)
    });
    let value = if neg { -magnitude } else { magnitude };
    Some(value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32)
}

// ---------------------------------------------------------------------------
// UTF-7 (RFC 2152)
// ---------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_value(c: char) -> Option<u32> {
    match c {
        'A'..='Z' => Some(c as u32 - 'A' as u32),
        'a'..='z' => Some(c as u32 - 'a' as u32 + 26),
        '0'..='9' => Some(c as u32 - '0' as u32 + 52),
        '+' => Some(62),
        '/' => Some(63),
        _ => None,
    }
}

/// Decodes UTF-7. Characters outside `+…` runs pass through; a run decodes
/// its modified-base64 bits as UTF-16 and ends at the first non-base64
/// character, a terminating `-` being absorbed; `+-` is a literal `+`.
/// Leniency for hand-edited files: a `+` whose run holds too few bits for
/// a single UTF-16 unit is kept literally, as is any non-UTF-7 text.
pub fn utf7_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '+' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'-') {
            chars.next();
            out.push('+');
            continue;
        }
        let mut consumed = String::new();
        let mut units: Vec<u16> = Vec::new();
        let (mut bits, mut nbits) = (0u32, 0u32);
        while let Some(&d) = chars.peek() {
            let Some(v) = b64_value(d) else { break };
            chars.next();
            consumed.push(d);
            bits = (bits << 6) | v;
            nbits += 6;
            if nbits >= 16 {
                nbits -= 16;
                units.push((bits >> nbits) as u16);
                bits &= (1 << nbits) - 1;
            }
        }
        let dash = chars.peek() == Some(&'-');
        if dash {
            chars.next();
        }
        if units.is_empty() {
            out.push('+');
            out.push_str(&consumed);
            if dash {
                out.push('-');
            }
        } else {
            out.push_str(&String::from_utf16_lossy(&units));
        }
    }
    out
}

/// Characters UTF-7 writes directly: printable ASCII except `+`, `\` and
/// `~` (what Windows' `CP_UTF7` encoder does too). Tabs and line breaks are
/// base64-encoded so a value always stays on one INI line.
fn utf7_direct(u: u16) -> bool {
    (0x20..=0x7D).contains(&u) && u != u16::from(b'+') && u != u16::from(b'\\')
}

/// Encodes UTF-7: direct characters as is, `+` as `+-`, every other run as
/// `+<modified base64 of UTF-16BE>-` (always terminated, which any decoder
/// accepts).
pub fn utf7_encode(s: &str) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        if u == u16::from(b'+') {
            out.push_str("+-");
            i += 1;
        } else if utf7_direct(u) {
            out.push(char::from(u as u8));
            i += 1;
        } else {
            let start = i;
            while i < units.len() && !utf7_direct(units[i]) && units[i] != u16::from(b'+') {
                i += 1;
            }
            out.push('+');
            let (mut bits, mut nbits) = (0u32, 0u32);
            for &unit in &units[start..i] {
                bits = (bits << 16) | u32::from(unit);
                nbits += 16;
                while nbits >= 6 {
                    nbits -= 6;
                    out.push(char::from(B64[((bits >> nbits) & 0x3F) as usize]));
                }
                bits &= (1 << nbits) - 1;
            }
            if nbits > 0 {
                out.push(char::from(B64[((bits << (6 - nbits)) & 0x3F) as usize]));
            }
            out.push('-');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf7_rfc2152_examples() {
        assert_eq!(utf7_decode("A+ImIDkQ."), "A\u{2262}\u{0391}.");
        assert_eq!(utf7_decode("Hi Mom -+Jjo--!"), "Hi Mom -\u{263A}-!");
        assert_eq!(utf7_decode("+ZeVnLIqe-"), "日本語");
        assert_eq!(utf7_encode("日本語"), "+ZeVnLIqe-");
        assert_eq!(utf7_encode("A\u{2262}\u{0391}."), "A+ImIDkQ-.");
        assert_eq!(utf7_decode("1 +- 1"), "1 + 1");
        assert_eq!(utf7_encode("1 + 1"), "1 +- 1");
    }

    #[test]
    fn utf7_windows_backslashes_and_roundtrip() {
        assert_eq!(utf7_encode("C:\\x"), "C:+AFw-x");
        // consecutive non-direct characters share one run
        assert_eq!(utf7_encode("C:\\é"), "C:+AFwA6Q-");
        assert_eq!(utf7_decode("C:+AFwA6Q-"), "C:\\é");
        // separately terminated runs (as other encoders write them) decode too
        assert_eq!(utf7_decode("C:+AFw-Jos+AOk-"), "C:\\José");
        for s in [
            "",
            "plain",
            "a+b\\c~d",
            "tab\there",
            "😀 emoji",
            "Ünïcödé\\Pfad\\x.ico",
        ] {
            assert_eq!(utf7_decode(&utf7_encode(s)), s, "{s}");
        }
    }

    #[test]
    fn utf7_lenient_on_stray_plus() {
        assert_eq!(utf7_decode("a+b.c"), "a+b.c");
        assert_eq!(utf7_decode("x+"), "x+");
        assert_eq!(utf7_decode("x+ab-y"), "x+ab-y");
    }

    #[test]
    fn ints_and_quotes() {
        assert_eq!(parse_int(" -12abc"), Some(-12));
        assert_eq!(parse_int("+7"), Some(7));
        assert_eq!(parse_int("x"), None);
        assert_eq!(parse_int("99999999999"), Some(i32::MAX));
        assert_eq!(strip_quotes("\"a b\""), "a b");
        assert_eq!(strip_quotes("\""), "\"");
    }

    #[test]
    fn cp1252_roundtrip() {
        for b in 0u8..=255 {
            assert_eq!(cp1252_encode(cp1252_decode(b)), b, "byte {b:#x}");
        }
        assert_eq!(cp1252_decode(0x80), '€');
        assert_eq!(cp1252_encode('中'), b'?');
    }
}

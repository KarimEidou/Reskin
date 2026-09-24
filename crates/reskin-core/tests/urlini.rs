//! `.url` INI parsing and writing (`urlini`).

use reskin_core::urlini::{
    SECTION, SECTION_W, TextEncoding, UrlFile, decode_text, decode_text_with_ansi, utf7_decode,
    utf7_encode,
};

const STEAM: &str = "[{000214A0-0000-0000-C000-000000000046}]\r\n\
Prop3=19,0\r\n\
[InternetShortcut]\r\n\
IDList=\r\n\
IconIndex=0\r\n\
URL=steam://rungameid/570\r\n\
IconFile=C:\\Program Files (x86)\\Steam\\steam\\games\\0bbb630d63262dd66d2fdd0f7d37e8661a410075.ico\r\n";

const EPIC: &str = "[InternetShortcut]\n\
URL=com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true\n\
IconIndex=0\n\
IconFile=C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe\n";

/// What Windows writes for a shortcut whose icon path is not ANSI.
const UNICODE_W: &str = "[InternetShortcut]\r\n\
URL=file:///C:/Users/Jos%C3%A9/\r\n\
IconFile=C:\\Users\\Jos?\\Pictures\\?.ico\r\n\
IconIndex=2\r\n\
[InternetShortcut.W]\r\n\
IconFile=C:+AFw-Users+AFw-Jos+AOk-+AFw-Pictures+AFxmH3p6-.ico\r\n";

fn utf16le_bom(s: &str) -> Vec<u8> {
    let mut b = vec![0xFF, 0xFE];
    b.extend(s.encode_utf16().flat_map(u16::to_le_bytes));
    b
}

#[test]
fn steam_shortcut() {
    let f = UrlFile::parse(STEAM.as_bytes());
    assert_eq!(f.url(), Some("steam://rungameid/570"));
    assert_eq!(
        f.icon_file(),
        Some(
            "C:\\Program Files (x86)\\Steam\\steam\\games\\0bbb630d63262dd66d2fdd0f7d37e8661a410075.ico"
        )
    );
    assert_eq!(f.icon_index(), 0);
    assert_eq!(
        f.get("{000214A0-0000-0000-C000-000000000046}", "prop3"),
        Some("19,0")
    );
    assert_eq!(f.get(SECTION, "IDList"), Some(""));
    assert_eq!(f.encoding(), TextEncoding::Utf8);
}

#[test]
fn epic_shortcut_with_lf_endings() {
    let f = UrlFile::parse(EPIC.as_bytes());
    assert!(
        f.url()
            .unwrap()
            .starts_with("com.epicgames.launcher://apps/fn%3A4fe75bbc")
    );
    assert!(f.url().unwrap().ends_with("?action=launch&silent=true"));
    assert!(
        f.icon_file()
            .unwrap()
            .ends_with("FortniteClient-Win64-Shipping.exe")
    );
    assert_eq!(f.icon_index(), 0);
}

#[test]
fn unicode_path_prefers_the_w_section() {
    let f = UrlFile::parse(UNICODE_W.as_bytes());
    assert_eq!(f.icon_file(), Some("C:\\Users\\José\\Pictures\\星空.ico"));
    // the plain section is still readable on its own
    assert_eq!(
        f.get(SECTION, "IconFile"),
        Some("C:\\Users\\Jos?\\Pictures\\?.ico")
    );
    // keys missing from .W fall back to the plain section
    assert_eq!(f.icon_index(), 2);
    assert_eq!(f.url(), Some("file:///C:/Users/Jos%C3%A9/"));
    assert_eq!(
        f.get(SECTION_W, "iconfile"),
        Some("C:\\Users\\José\\Pictures\\星空.ico")
    );
}

#[test]
fn line_endings_are_equivalent() {
    let lf = STEAM.replace("\r\n", "\n");
    let cr = STEAM.replace("\r\n", "\r");
    let crlf = UrlFile::parse(STEAM.as_bytes());
    for text in [lf, cr] {
        let f = UrlFile::parse(text.as_bytes());
        assert_eq!(f.url(), crlf.url());
        assert_eq!(f.icon_file(), crlf.icon_file());
        assert_eq!(f.to_ini_string(), crlf.to_ini_string());
    }
}

#[test]
fn byte_order_marks_and_ansi() {
    let text = "[InternetShortcut]\r\nURL=https://例え.jp/\r\nIconFile=C:\\Ícones\\app.ico\r\nIconIndex=-3\r\n";

    let f = UrlFile::parse(&utf16le_bom(text));
    assert_eq!(f.encoding(), TextEncoding::Utf16Le);
    assert_eq!(f.url(), Some("https://例え.jp/"));
    assert_eq!(f.icon_file(), Some("C:\\Ícones\\app.ico"));
    assert_eq!(f.icon_index(), -3);

    let mut be = vec![0xFE, 0xFF];
    be.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
    let f = UrlFile::parse(&be);
    assert_eq!(f.encoding(), TextEncoding::Utf16Be);
    assert_eq!(f.url(), Some("https://例え.jp/"));

    let mut bom8 = vec![0xEF, 0xBB, 0xBF];
    bom8.extend_from_slice(text.as_bytes());
    let f = UrlFile::parse(&bom8);
    assert_eq!(f.encoding(), TextEncoding::Utf8Bom);
    assert_eq!(f.url(), Some("https://例え.jp/"));
    assert_eq!(f.icon_file(), Some("C:\\Ícones\\app.ico"));

    // UTF-16LE without a BOM
    let bare: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let f = UrlFile::parse(&bare);
    assert_eq!(f.encoding(), TextEncoding::Utf16Le);
    assert_eq!(f.icon_index(), -3);

    // ANSI (Windows-1252): 0xCD = Í, 0x80 = €; not valid UTF-8
    let mut ansi = b"[InternetShortcut]\r\nIconFile=C:\\".to_vec();
    ansi.extend_from_slice(&[0xCD, b'c', b'o', b'n', b'e', b's', 0x80]);
    ansi.extend_from_slice(b"\\app.ico\r\n");
    let f = UrlFile::parse(&ansi);
    assert_eq!(f.encoding(), TextEncoding::Ansi);
    assert_eq!(f.icon_file(), Some("C:\\Ícones€\\app.ico"));
    // written back byte-for-byte in the same encoding
    assert_eq!(UrlFile::parse(&f.to_bytes()).icon_file(), f.icon_file());
    assert_eq!(decode_text(&f.to_bytes()).1, TextEncoding::Ansi);
}

#[test]
fn missing_and_empty_keys() {
    let f = UrlFile::parse(b"[InternetShortcut]\r\nURL=https://example.com/\r\n");
    assert_eq!(f.url(), Some("https://example.com/"));
    assert_eq!(f.icon_file(), None);
    assert_eq!(f.icon_index(), 0);

    let f = UrlFile::parse(b"[InternetShortcut]\r\nIconFile=\r\nIconIndex=abc\r\n");
    assert_eq!(f.icon_file(), None, "empty IconFile means no icon");
    assert_eq!(f.icon_index(), 0, "non-numeric index defaults to 0");
    assert_eq!(f.url(), None);

    let f = UrlFile::parse(b"");
    assert_eq!(f.url(), None);
    assert!(f.to_ini_string().is_empty());

    // keys outside any section, lines without '=' and comments are ignored
    let f = UrlFile::parse(
        b"URL=orphan\r\n; comment\r\n[InternetShortcut]\r\njunk line\r\n;URL=commented\r\nURL=real\r\n",
    );
    assert_eq!(f.url(), Some("real"));

    let f = UrlFile::parse(b"[Other]\r\nURL=https://x/\r\n");
    assert_eq!(f.url(), None, "URL outside [InternetShortcut]");
}

#[test]
fn lookup_is_case_insensitive_first_value_wins_quotes_stripped() {
    let f = UrlFile::parse(
        b"[internetshortcut]\r\n url = \"https://a/\" \r\nurl=https://b/\r\nICONFILE='C:\\x.ico'\r\n",
    );
    assert_eq!(f.url(), Some("https://a/"));
    assert_eq!(f.icon_file(), Some("C:\\x.ico"));
    assert_eq!(f.get("INTERNETSHORTCUT", "Url"), Some("https://a/"));
}

#[test]
fn set_icon_ascii_round_trip_keeps_other_content() {
    let mut f = UrlFile::parse(STEAM.as_bytes());
    f.set_icon(Some("D:\\Icons\\dota.ico"), 4);
    let text = f.to_ini_string();
    assert!(text.contains("IconFile=D:\\Icons\\dota.ico\r\n"), "{text}");
    assert!(text.contains("IconIndex=4\r\n"));
    assert!(!text.contains(SECTION_W));
    assert!(text.starts_with("[{000214A0-0000-0000-C000-000000000046}]\r\nProp3=19,0\r\n"));

    let back = UrlFile::parse(&f.to_bytes());
    assert_eq!(back.icon_file(), Some("D:\\Icons\\dota.ico"));
    assert_eq!(back.icon_index(), 4);
    assert_eq!(back.url(), Some("steam://rungameid/570"));
    assert_eq!(back, f);
}

#[test]
fn set_icon_unicode_writes_both_sections() {
    let mut f = UrlFile::parse(EPIC.as_bytes());
    let path = "C:\\Users\\Zoë\\アイコン\\game.ico";
    f.set_icon(Some(path), 1);
    let text = f.to_ini_string();
    assert!(text.is_ascii(), "UTF-7 keeps the file ASCII: {text}");
    assert!(text.contains("[InternetShortcut.W]\r\n"));
    assert!(text.contains("IconFile=C:\\Users\\Zo?\\????\\game.ico\r\n"));
    assert!(text.contains("IconFile=C:+AFw-Users+AFw-Zo+AOsAXDCiMKQwszDzAFw-game.ico\r\n"));

    let back = UrlFile::parse(text.as_bytes());
    assert_eq!(back.icon_file(), Some(path));
    assert_eq!(back.icon_index(), 1);

    // switching back to an ASCII path drops the stale .W value
    let mut again = back.clone();
    again.set_icon(Some("C:\\plain.ico"), 0);
    assert_eq!(again.icon_file(), Some("C:\\plain.ico"));
    assert!(!again.to_ini_string().contains(SECTION_W));
}

#[test]
fn clearing_the_icon_removes_both_sections_keys() {
    let mut f = UrlFile::parse(UNICODE_W.as_bytes());
    f.set_icon(None, 0);
    assert_eq!(f.icon_file(), None);
    assert_eq!(f.icon_index(), 0);
    let text = f.to_ini_string();
    assert!(!text.to_ascii_lowercase().contains("iconfile"), "{text}");
    assert!(!text.to_ascii_lowercase().contains("iconindex"), "{text}");
    assert!(!text.contains(SECTION_W), "empty .W section is removed");
    assert_eq!(
        UrlFile::parse(text.as_bytes()).url(),
        Some("file:///C:/Users/Jos%C3%A9/")
    );
}

#[test]
fn has_icon_tells_whether_a_write_stuck() {
    let steam = UrlFile::parse(STEAM.as_bytes());
    let icon = "C:\\Program Files (x86)\\Steam\\steam\\games\\0bbb630d63262dd66d2fdd0f7d37e8661a410075.ico";
    assert!(steam.has_icon(Some((icon, 0))));
    assert!(!steam.has_icon(Some((icon, 1))), "another index");
    assert!(!steam.has_icon(Some(("C:\\other.ico", 0))));
    assert!(!steam.has_icon(None));

    // The Unicode path is the one in [InternetShortcut.W], not its ANSI
    // stand-in.
    let unicode = UrlFile::parse(UNICODE_W.as_bytes());
    assert!(unicode.has_icon(Some(("C:\\Users\\José\\Pictures\\星空.ico", 2))));
    assert!(!unicode.has_icon(Some(("C:\\Users\\Jos?\\Pictures\\?.ico", 2))));

    // Every icon set_icon writes (or clears) reads back as written.
    for icon in [
        Some(("C:\\Zoë\\アイコン.ico", 3)),
        Some(("D:\\a.ico", 0)),
        None,
    ] {
        let mut f = UrlFile::parse(EPIC.as_bytes());
        f.set_icon(icon.map(|(file, _)| file), icon.map_or(0, |(_, i)| i));
        assert!(UrlFile::parse(&f.to_bytes()).has_icon(icon), "{icon:?}");
    }
    // An empty IconFile is no icon.
    let empty =
        UrlFile::parse(b"[InternetShortcut]\r\nURL=https://a/\r\nIconFile=\r\nIconIndex=5\r\n");
    assert!(empty.has_icon(None));
}

#[test]
fn new_file_and_encodings_round_trip() {
    let mut f = UrlFile::new();
    f.set_url("https://example.com/ünïcode");
    f.set_icon(Some("C:\\icons\\a.ico"), 0);
    for enc in [
        TextEncoding::Utf8,
        TextEncoding::Utf8Bom,
        TextEncoding::Utf16Le,
        TextEncoding::Utf16Be,
        TextEncoding::Ansi,
    ] {
        f.set_encoding(enc);
        let back = UrlFile::parse(&f.to_bytes());
        if enc == TextEncoding::Ansi {
            // non-ASCII values live UTF-7 encoded in .W, so the ANSI output
            // is pure ASCII — indistinguishable from (and read as) UTF-8
            assert!(f.to_bytes().is_ascii());
            assert_eq!(back.encoding(), TextEncoding::Utf8);
        } else {
            assert_eq!(back.encoding(), enc);
        }
        assert_eq!(back.url(), Some("https://example.com/ünïcode"), "{enc:?}");
        assert_eq!(back.icon_file(), Some("C:\\icons\\a.ico"), "{enc:?}");
    }
    assert!(utf16le_bom("x").starts_with(&[0xFF, 0xFE]));
}

/// A tiny stand-in for the Cyrillic ANSI code page (Windows-1251), whose
/// bytes 0xC0..=0xFF are U+0410..=U+044F.
fn cp1251_decode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0xC0..=0xFF => char::from_u32(0x0410 + u32::from(b - 0xC0)).unwrap(),
            _ => char::from(b),
        })
        .collect()
}

fn cp1251_encode(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| match u32::from(c) {
            0..=0x7F => c as u8,
            cp @ 0x0410..=0x044F => (cp - 0x0410) as u8 + 0xC0,
            _ => b'?',
        })
        .collect()
}

#[test]
fn ansi_files_use_the_callers_code_page() {
    // "Иван" in Windows-1251, as a Russian system writes an ANSI .url.
    let mut bytes = b"[InternetShortcut]\r\nURL=https://x/\r\nIconFile=C:\\Users\\".to_vec();
    bytes.extend_from_slice(&[0xC8, 0xE2, 0xE0, 0xED]);
    bytes.extend_from_slice(b"\\a.ico\r\nIconIndex=2\r\n");

    let f = UrlFile::parse_with_ansi(&bytes, cp1251_decode);
    assert_eq!(f.encoding(), TextEncoding::Ansi);
    assert_eq!(f.icon_file(), Some("C:\\Users\\Иван\\a.ico"));
    assert_eq!(f.icon_index(), 2);
    // Windows-1252 would read the same bytes as mojibake.
    assert_eq!(
        UrlFile::parse(&bytes).icon_file(),
        Some("C:\\Users\\Èâàí\\a.ico")
    );
    assert_eq!(
        decode_text_with_ansi(&bytes, cp1251_decode).0,
        cp1251_decode(&bytes)
    );
    // Written back with the matching encoder: byte-identical.
    assert_eq!(f.to_bytes_with_ansi(cp1251_encode), bytes);

    // Changing the icon keeps the other values in the file's code page.
    let mut changed = f.clone();
    changed.set_icon(Some("D:\\Иконки\\b.ico"), 1);
    let written = changed.to_bytes_with_ansi(cp1251_encode);
    let back = UrlFile::parse_with_ansi(&written, cp1251_decode);
    assert_eq!(back.icon_file(), Some("D:\\Иконки\\b.ico"));
    assert_eq!(back.icon_index(), 1);
    assert_eq!(back.url(), Some("https://x/"));

    // The hook is only consulted for ANSI input.
    let utf8 = UrlFile::parse_with_ansi("[InternetShortcut]\r\nURL=é\r\n".as_bytes(), |_| {
        panic!("UTF-8 input must not reach the ANSI decoder")
    });
    assert_eq!(utf8.url(), Some("é"));
    assert_eq!(
        utf8.to_bytes_with_ansi(|_| panic!("UTF-8 output must not use the ANSI encoder")),
        "[InternetShortcut]\r\nURL=é\r\n".as_bytes()
    );
}

#[test]
fn reads_desktop_ini_files_too() {
    // folder.rs parses desktop.ini with the same reader.
    let ini = "\u{feff}[.ShellClassInfo]\r\nIconResource=C:\\Icons\\x.ico,3\r\n\
               LocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21798\r\n\
               [ViewState]\r\nMode=\r\nVid=\r\nFolderType=Pictures\r\n";
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(
        ini.trim_start_matches('\u{feff}')
            .encode_utf16()
            .flat_map(u16::to_le_bytes),
    );
    let mut f = UrlFile::parse(&bytes);
    assert_eq!(
        f.get(".shellclassinfo", "iconresource"),
        Some("C:\\Icons\\x.ico,3")
    );
    assert_eq!(f.get("ViewState", "Mode"), Some(""));
    assert!(f.remove(".ShellClassInfo", "IconResource"));
    assert!(!f.remove(".ShellClassInfo", "IconResource"));
    assert!(!f.is_empty(), "other customisations remain");
    let back = UrlFile::parse(&f.to_bytes());
    assert_eq!(back.encoding(), TextEncoding::Utf16Le);
    assert_eq!(back.get(".ShellClassInfo", "IconResource"), None);
    assert_eq!(back.get("ViewState", "FolderType"), Some("Pictures"));

    let only_icon = UrlFile::parse(b"[.ShellClassInfo]\r\nIconFile=x.ico\r\nIconIndex=0\r\n");
    let mut cleared = only_icon.clone();
    cleared.remove(".ShellClassInfo", "IconFile");
    cleared.remove(".ShellClassInfo", "IconIndex");
    assert!(cleared.is_empty(), "a header without keys counts as empty");
}

/// Deterministic xorshift so failures are reproducible.
fn rng(seed: u64) -> impl FnMut() -> u64 {
    let mut state = seed;
    move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    }
}

#[test]
fn arbitrary_bytes_never_panic_and_rewrite_stably() {
    let mut next = rng(0x2545_F491_4F6C_DD1D);
    let alphabet = b"[]=;+-\\\"' \t\r\nAZaz09\x00\xFF\xFE\xEF\xBB\xBF\x80\xC3\xA9.";
    for round in 0..3000 {
        let len = (next() % 120) as usize;
        let bytes: Vec<u8> = (0..len)
            .map(|_| {
                if round % 2 == 0 {
                    next() as u8
                } else {
                    alphabet[(next() % alphabet.len() as u64) as usize]
                }
            })
            .collect();
        let f = UrlFile::parse(&bytes);
        let _ = (f.url(), f.icon_file(), f.icon_index());
        // Whatever was read is written back without loss. (An ANSI file
        // whose remaining bytes happen to form valid UTF-8 is read back as
        // UTF-8: sniffing cannot tell the two apart, so that case is out.)
        let back = UrlFile::parse(&f.to_bytes());
        if f.encoding() == TextEncoding::Ansi && back.encoding() != TextEncoding::Ansi {
            assert!(std::str::from_utf8(&f.to_bytes()).is_ok());
            continue;
        }
        assert_eq!(back.to_ini_string(), f.to_ini_string(), "{bytes:?}");
        assert_eq!(
            back.section_names().collect::<Vec<_>>(),
            f.section_names().collect::<Vec<_>>()
        );
    }
}

#[test]
fn padded_and_quoted_values_survive_a_rewrite() {
    let text = "[InternetShortcut]\r\nURL=\"'quoted'\"\r\nIconFile=\"  C:\\padded.ico \"\r\n\
                [InternetShortcut.W]\r\nIconFile=\" +AOk-\"\r\n";
    let f = UrlFile::parse(text.as_bytes());
    assert_eq!(f.get(SECTION, "URL"), Some("'quoted'"));
    assert_eq!(f.get(SECTION, "IconFile"), Some("  C:\\padded.ico "));
    assert_eq!(f.icon_file(), Some(" é"));
    let written = f.to_ini_string();
    assert!(written.contains("URL=\"'quoted'\"\r\n"), "{written}");
    let back = UrlFile::parse(written.as_bytes());
    assert_eq!(back, f);
    // Ordinary values stay unquoted.
    let plain = UrlFile::parse(STEAM.as_bytes()).to_ini_string();
    assert!(plain.contains("URL=steam://rungameid/570\r\n"));
    assert!(!plain.contains('"'));
}

#[test]
fn utf7_round_trips_arbitrary_text() {
    let mut next = rng(0x9E37_79B9_7F4A_7C15);
    let pool: Vec<char> = "aZ09 +-/\\~!\"#$%&*;<=>@[]^_`{|}\t\r\n.:?,()'éß中😀\u{7f}\u{0}\u{ffff}"
        .chars()
        .collect();
    for _ in 0..3000 {
        let len = (next() % 24) as usize;
        let s: String = (0..len)
            .map(|_| pool[(next() % pool.len() as u64) as usize])
            .collect();
        let encoded = utf7_encode(&s);
        assert!(encoded.is_ascii(), "{s:?} -> {encoded:?}");
        assert!(
            !encoded.contains(['\r', '\n']),
            "stays on one INI line: {encoded:?}"
        );
        assert_eq!(utf7_decode(&encoded), s, "{encoded:?}");
    }
}

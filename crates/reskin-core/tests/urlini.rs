//! `.url` INI parsing and writing (`urlini`).

use reskin_core::urlini::{SECTION, SECTION_W, TextEncoding, UrlFile, decode_text};

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

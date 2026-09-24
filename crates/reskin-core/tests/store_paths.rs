//! Paths and names, atomic storage, the icon store, the design library,
//! the autosave slot, settings and hotkeys.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use reskin_core::Error;
use reskin_core::model::{ICO_SIZES, LibrarySave, Settings};
use reskin_core::paths::{self, AppDirs};
use reskin_core::settings::{self, Hotkey, Key, parse_hotkey};
use reskin_core::store::{self, Library};

/// A unique temp directory, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "reskin-store-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn join(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn file_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|d| d.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

#[test]
fn slugify_edge_cases() {
    let cases = [
        ("Google Chrome", "google-chrome"),
        ("7-Zip File Manager", "7-zip-file-manager"),
        ("  ...Visual   Studio Code!!  ", "visual-studio-code"),
        ("C:\\Program Files\\App.exe", "c-program-files-app-exe"),
        ("Ünïcödé Ñame", "n-c-d-ame"),
        ("日本語のアプリ", "icon"),
        ("🎮🎮", "icon"),
        ("", "icon"),
        ("   ", "icon"),
        ("---", "icon"),
        ("ABC123", "abc123"),
        ("a__b--c", "a-b-c"),
    ];
    for (input, want) in cases {
        assert_eq!(paths::slugify(input), want, "{input:?}");
    }
}

#[test]
fn slugify_caps_long_names() {
    let long = "Super Long Application Name That Keeps Going And Going Forever";
    let slug = paths::slugify(long);
    assert!(slug.len() <= paths::MAX_SLUG_LEN, "{slug}");
    assert!(!slug.ends_with('-') && !slug.starts_with('-'), "{slug}");
    // Cut at exactly 40 characters, mid-word if need be.
    assert_eq!(slug, "super-long-application-name-that-keeps-g");
    assert_eq!(paths::slugify(&"é".repeat(500)), "icon");
    assert_eq!(paths::slugify(&"x".repeat(500)), "x".repeat(40));
    // Multi-byte characters around the cut never split a character.
    let tricky = format!("{}ü{}", "a".repeat(39), "b".repeat(10));
    assert_eq!(paths::slugify(&tricky), "a".repeat(39));
}

#[test]
fn icon_file_names_are_content_addressed() {
    let ico = b"not really an icon, but bytes".to_vec();
    let name = paths::icon_file_name("Google Chrome", &ico);
    assert_eq!(name, paths::icon_file_name("Google Chrome", &ico));
    let hash = paths::sha256_hex(&ico);
    assert_eq!(name, format!("google-chrome-{}.ico", &hash[..12]));
    assert_ne!(name, paths::icon_file_name("Google Chrome", b"other bytes"));
    for display in ["", "日本語", &"Long Name ".repeat(30), "a/b\\c..d"] {
        let n = paths::icon_file_name(display, &ico);
        assert!(paths::is_valid_public_icon_name(&n), "{n}");
    }
    assert_eq!(hash.len(), 64);
    assert!(
        hash.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
}

#[test]
fn public_icon_name_rules() {
    let longest = format!("{}.ico", "a".repeat(64));
    for good in [
        "a.ico",
        "chrome-0123456789ab.ico",
        "-.ico",
        "0.ico",
        &longest,
    ] {
        assert!(paths::is_valid_public_icon_name(good), "{good}");
    }
    let too_long = format!("{}.ico", "a".repeat(65));
    for bad in [
        "",
        ".ico",
        "A.ico",
        "a.ICO",
        "a",
        "a.png",
        "a b.ico",
        "a/b.ico",
        r"a\b.ico",
        "..ico",
        "../a.ico",
        "a.b.ico",
        "a.ico.ico",
        "é.ico",
        &too_long,
    ] {
        assert!(!paths::is_valid_public_icon_name(bad), "{bad:?}");
    }
}

#[test]
fn windows_path_helpers_work_on_strings() {
    let desktop = r"C:\Users\Public\Desktop";
    assert!(paths::is_directly_under(
        r"C:\Users\Public\Desktop\App.lnk",
        desktop
    ));
    assert!(paths::is_directly_under(
        r"c:\USERS\public\desktop\App.lnk",
        desktop
    ));
    assert!(paths::is_directly_under(
        "C:/Users/Public/Desktop/App.lnk",
        desktop
    ));
    assert!(paths::is_directly_under(
        r"\\?\C:\Users\Public\Desktop\App.lnk",
        desktop
    ));
    assert!(paths::is_directly_under(
        r"C:\Users\Public\Desktop\\App.lnk",
        desktop
    ));
    assert!(paths::is_directly_under(r"C:\App.lnk", r"C:\"));
    assert!(!paths::is_directly_under(
        r"C:\Users\Public\Desktop\Sub\App.lnk",
        desktop
    ));
    assert!(!paths::is_directly_under(desktop, desktop));
    assert!(!paths::is_directly_under(
        r"C:\Users\Public\Desktop\",
        desktop
    ));
    assert!(!paths::is_directly_under(
        r"C:\Users\Public\DesktopX\App.lnk",
        desktop
    ));
    assert!(!paths::is_directly_under(r"C:\App.lnk", ""));

    assert_eq!(
        paths::normalize_for_compare(r"\\?\C:\Users\Public\Desktop\\"),
        r"c:\users\public\desktop"
    );
    assert_eq!(
        paths::normalize_for_compare(r"\\?\unc\Srv\Share"),
        r"\\srv\share"
    );

    for traversal in [r"C:\a\..\b", "../x", "..", r"C:\a\.. \b", "a/.../b"] {
        assert!(paths::has_parent_traversal(traversal), "{traversal}");
    }
    for fine in [r"C:\a\b", r"C:\a\..b\c", r"C:\a\b..\c", r"C:\a\.\b", "a.b"] {
        assert!(!paths::has_parent_traversal(fine), "{fine}");
    }

    for unc in [
        r"\\server\share",
        "//server/share",
        r"\\?\UNC\srv\s",
        r"\\.\UNC\srv\s",
    ] {
        assert!(paths::is_unc(unc), "{unc}");
    }
    for local in [r"C:\x", r"\\?\C:\x", r"\\.\C:\x", r"\x", "x"] {
        assert!(!paths::is_unc(local), "{local}");
    }

    assert!(paths::is_absolute_drive_path(r"C:\x"));
    assert!(paths::is_absolute_drive_path("z:/x"));
    for not_abs in [r"C:x", r"\x", "x", r"\\srv\s", "1:\\x", ""] {
        assert!(!paths::is_absolute_drive_path(not_abs), "{not_abs}");
    }
}

#[test]
fn app_dirs_layout_and_ensure() {
    let tmp = TempDir::new("dirs");
    let dirs = AppDirs::at(tmp.path());
    assert_eq!(dirs.settings_file(), dirs.roaming.join("settings.json"));
    assert_eq!(dirs.journal_file(), dirs.roaming.join("journal.json"));
    assert_eq!(dirs.library_dir(), dirs.roaming.join("library"));
    assert_eq!(dirs.autosave_file(), dirs.roaming.join("autosave.reskin"));
    assert_eq!(dirs.icons_dir(), dirs.local.join("icons"));
    assert_eq!(dirs.jobs_dir(), dirs.local.join("jobs"));
    assert_eq!(dirs.public_icons_dir(), dirs.program_data.join("icons"));
    assert!(dirs.roaming.starts_with(tmp.path()));

    dirs.ensure().unwrap();
    for d in [dirs.library_dir(), dirs.icons_dir(), dirs.jobs_dir()] {
        assert!(d.is_dir(), "{}", d.display());
    }
    // The machine-wide folder needs admin rights; ensure() leaves it alone.
    assert!(!dirs.program_data.exists());
    dirs.ensure().unwrap();

    let env = AppDirs::from_env();
    assert!(env.roaming.ends_with(paths::APP_ID));
    assert!(env.local.ends_with(paths::APP_ID));
    assert!(env.program_data.ends_with(paths::PUBLIC_DIR_NAME));
    assert_eq!(paths::APP_ID, "com.karimeidou.reskin");
}

// ---------------------------------------------------------------------------
// atomic writes and JSON
// ---------------------------------------------------------------------------

#[test]
fn write_atomic_creates_and_replaces() {
    let tmp = TempDir::new("atomic");
    let target = tmp.join("a/b/c/data.bin");
    store::write_atomic(&target, b"first version").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"first version");
    store::write_atomic(&target, b"2nd").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"2nd");
    store::write_atomic(&target, b"").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"");
    // No temp files are left behind.
    assert_eq!(file_names(target.parent().unwrap()), ["data.bin"]);
}

#[test]
fn write_atomic_failure_leaves_no_temp_file() {
    let tmp = TempDir::new("atomic-fail");
    let blocked = tmp.join("dir-in-the-way");
    fs::create_dir_all(blocked.join("child")).unwrap();
    assert!(store::write_atomic(&blocked, b"x").is_err());
    assert_eq!(file_names(tmp.path()), ["dir-in-the-way"]);
}

#[test]
fn json_helpers() {
    let tmp = TempDir::new("json");
    let path = tmp.join("x.json");
    assert_eq!(store::read_json::<Vec<u32>>(&path).unwrap(), None);
    store::write_json(&path, &vec![1u32, 2, 3]).unwrap();
    assert_eq!(
        store::read_json::<Vec<u32>>(&path).unwrap(),
        Some(vec![1, 2, 3])
    );
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains('\n') && text.ends_with('\n'), "{text:?}");

    fs::write(&path, b"\xEF\xBB\xBF[4]").unwrap();
    assert_eq!(store::read_json::<Vec<u32>>(&path).unwrap(), Some(vec![4]));
    fs::write(&path, b"[4,").unwrap();
    assert!(store::read_json::<Vec<u32>>(&path).is_err());
}

// ---------------------------------------------------------------------------
// icon store
// ---------------------------------------------------------------------------

#[test]
fn store_icon_reuses_identical_content() {
    let tmp = TempDir::new("icons");
    let dir = tmp.join("icons");
    let ico = b"\x00\x00\x01\x00pretend icon".to_vec();
    let path = store::store_icon(&dir, "My App", &ico).unwrap();
    assert_eq!(path, dir.join(paths::icon_file_name("My App", &ico)));
    assert_eq!(fs::read(&path).unwrap(), ico);
    let again = store::store_icon(&dir, "My App", &ico).unwrap();
    assert_eq!(again, path);
    // Another design with other bytes gets another file.
    let other = store::store_icon(&dir, "My App", b"other").unwrap();
    assert_ne!(other, path);
    assert_eq!(file_names(&dir).len(), 2);
}

#[test]
fn store_icon_never_overwrites_different_content() {
    let tmp = TempDir::new("icons-collide");
    let dir = tmp.path();
    let ico = b"the real icon".to_vec();
    let name = paths::icon_file_name("App", &ico);
    let stem = name.strip_suffix(".ico").unwrap();
    // Something else already sits under the hashed name (and under -2).
    fs::write(dir.join(&name), b"squatter").unwrap();
    fs::write(dir.join(format!("{stem}-2.ico")), b"second squatter").unwrap();

    let path = store::store_icon(dir, "App", &ico).unwrap();
    assert_eq!(path, dir.join(format!("{stem}-3.ico")));
    assert_eq!(fs::read(&path).unwrap(), ico);
    assert_eq!(fs::read(dir.join(&name)).unwrap(), b"squatter");
    assert_eq!(
        fs::read(dir.join(format!("{stem}-2.ico"))).unwrap(),
        b"second squatter"
    );
    // The -3 copy is found and reused next time.
    assert_eq!(store::store_icon(dir, "App", &ico).unwrap(), path);
    assert_eq!(file_names(dir).len(), 3);
}

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

fn design(id: Option<&str>, name: &str, data: &str) -> LibrarySave {
    LibrarySave {
        id: id.map(str::to_owned),
        name: name.into(),
        thumb: "iVBORw0KGgo=".into(),
        data: data.into(),
    }
}

#[test]
fn library_save_list_load_delete() {
    let tmp = TempDir::new("library");
    let lib = Library::new(tmp.join("library"));
    // `Library { dir }` is also constructible directly.
    assert_eq!(
        Library {
            dir: tmp.join("library")
        },
        lib
    );
    assert_eq!(lib.dir(), tmp.join("library"));
    assert!(lib.list().unwrap().is_empty());

    let data = r#"{"format":"reskin","layers":[{"name":"Ünïcode \"quoted\"\n"}]}"#;
    let first = lib.save(design(None, "  Neon App  ", data)).unwrap();
    assert!(store::is_valid_id(&first.id));
    assert_eq!(first.id.len(), 16);
    assert_eq!(first.name, "Neon App");
    assert!(first.bytes > 0.0);
    assert_eq!(lib.load(&first.id).unwrap(), data);

    std::thread::sleep(std::time::Duration::from_millis(5));
    let second = lib.save(design(None, "", "{}")).unwrap();
    assert_ne!(second.id, first.id);
    assert_eq!(second.name, "Untitled");

    let list = lib.list().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0], second, "newest first");
    assert_eq!(list[1], first);

    // Overwrite the older one: it becomes the newest.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let updated = lib
        .save(design(Some(&first.id), "Neon App v2", "{\"v\":2}"))
        .unwrap();
    assert_eq!(updated.id, first.id);
    assert!(updated.updated_at > first.updated_at);
    assert_eq!(lib.load(&first.id).unwrap(), "{\"v\":2}");
    let ids: Vec<String> = lib.list().unwrap().into_iter().map(|e| e.id).collect();
    assert_eq!(ids, [first.id.clone(), second.id.clone()]);

    lib.delete(&first.id).unwrap();
    lib.delete(&first.id).unwrap();
    assert!(matches!(lib.load(&first.id), Err(Error::NotFound(_))));
    assert_eq!(lib.list().unwrap().len(), 1);
}

#[test]
fn library_rejects_path_traversal_ids() {
    let tmp = TempDir::new("library-ids");
    let lib = Library::new(tmp.join("library"));
    fs::write(tmp.join("secret.reskin"), b"{}").unwrap();
    for bad in [
        "../secret",
        r"..\secret",
        "..",
        "a/b",
        r"a\b",
        "/etc/passwd",
        r"C:\x",
        "ABC",
        "a.b",
        "",
        "a b",
        &"a".repeat(65),
    ] {
        assert!(lib.load(bad).is_err(), "load {bad:?}");
        assert!(lib.delete(bad).is_err(), "delete {bad:?}");
        assert!(
            lib.save(design(Some(bad), "x", "{}")).is_err(),
            "save {bad:?}"
        );
    }
    assert!(tmp.join("secret.reskin").exists());
    // A caller-chosen valid id is fine.
    lib.save(design(Some("my-design-1"), "x", "{}")).unwrap();
    assert_eq!(lib.load("my-design-1").unwrap(), "{}");
}

#[test]
fn library_list_skips_foreign_and_broken_files() {
    let tmp = TempDir::new("library-skip");
    let dir = tmp.join("library");
    let lib = Library::new(&dir);
    let good = lib.save(design(None, "Good", "{}")).unwrap();
    fs::write(dir.join("broken.reskin"), b"{ nope").unwrap();
    fs::write(
        dir.join("foreign.reskin"),
        br#"{"format":"something-else","version":1,"id":"foreign","name":"x","thumb":"","updatedAt":1,"data":""}"#,
    )
    .unwrap();
    fs::write(
        dir.join("future.reskin"),
        br#"{"format":"reskin-library","version":9,"id":"future","name":"x","thumb":"","updatedAt":1,"data":""}"#,
    )
    .unwrap();
    fs::write(
        dir.join("Bad Name.reskin"),
        br#"{"format":"reskin-library","version":1,"id":"x","name":"x","thumb":"","updatedAt":1,"data":""}"#,
    )
    .unwrap();
    fs::write(dir.join("notes.txt"), b"hello").unwrap();
    fs::create_dir_all(dir.join("folder.reskin")).unwrap();

    let list = lib.list().unwrap();
    assert_eq!(list, vec![good]);
    assert!(matches!(lib.load("foreign"), Err(Error::Unsupported(_))));
    assert!(matches!(lib.load("future"), Err(Error::Unsupported(_))));
    assert!(lib.load("broken").is_err());
}

// ---------------------------------------------------------------------------
// autosave
// ---------------------------------------------------------------------------

#[test]
fn autosave_slot() {
    let tmp = TempDir::new("autosave");
    let file = AppDirs::at(tmp.path()).autosave_file();
    assert_eq!(store::autosave_read(&file).unwrap(), None);
    store::autosave_write(&file, None).unwrap();
    store::autosave_write(&file, Some(r#"{"layers":[]}"#)).unwrap();
    assert_eq!(
        store::autosave_read(&file).unwrap().as_deref(),
        Some(r#"{"layers":[]}"#)
    );
    store::autosave_write(&file, Some("  ")).unwrap();
    assert_eq!(store::autosave_read(&file).unwrap(), None);
    store::autosave_write(&file, Some("v2")).unwrap();
    store::autosave_write(&file, None).unwrap();
    assert!(!file.exists());
    assert_eq!(store::autosave_read(&file).unwrap(), None);
    fs::write(&file, b"\xff\xfe\x00bad").unwrap();
    assert!(store::autosave_read(&file).is_err());
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

#[test]
fn settings_first_run_and_round_trip() {
    let tmp = TempDir::new("settings");
    let path = AppDirs::at(tmp.path()).settings_file();
    let s = settings::load(&path);
    assert!(!s.onboarded, "no settings file: first run");
    assert_eq!(s, Settings::default());
    assert!(!path.exists(), "loading must not create the file");

    let changed = Settings {
        idle_opacity: 0.5,
        hotkey: "ctrl + shift + f9".into(),
        recent_colors: vec!["#FF0000".into()],
        ..Settings::default()
    };
    let saved = settings::save(&path, &changed).unwrap();
    assert_eq!(saved.hotkey, "Ctrl+Shift+F9");
    assert_eq!(saved.recent_colors, ["#ff0000"]);

    let loaded = settings::load(&path);
    assert_eq!(loaded, saved);
}

#[test]
fn the_welcome_is_due_until_it_was_finished() {
    let tmp = TempDir::new("settings-onboarded");
    let path = tmp.join("settings.json");
    // Written before the welcome was finished (the box was dragged): the
    // welcome is still due.
    let dragged = Settings {
        box_position: Some(reskin_core::model::SavedPos {
            x: 40,
            y: 60,
            monitor: None,
        }),
        ..Settings::default()
    };
    settings::save(&path, &dragged).unwrap();
    assert!(!settings::load(&path).onboarded);
    // An older file without the field: not finished either.
    fs::write(&path, br#"{"theme":"dark"}"#).unwrap();
    assert!(!settings::load(&path).onboarded);

    settings::save(
        &path,
        &Settings {
            onboarded: true,
            ..dragged
        },
    )
    .unwrap();
    assert!(settings::load(&path).onboarded);
}

#[test]
fn corrupt_settings_are_backed_up() {
    let tmp = TempDir::new("settings-corrupt");
    let path = tmp.join("settings.json");
    let bodies: [&[u8]; 4] = [b"{ this is not json", b"[1,2,3]", b"\"text\"", b""];
    for body in bodies {
        fs::write(&path, body).unwrap();
        let s = settings::load(&path);
        // A settings file existed: Reskin ran here before, no welcome.
        assert_eq!(
            s,
            Settings {
                onboarded: true,
                ..Settings::default()
            }
        );
        assert!(!path.exists());
        let backups: Vec<String> = file_names(tmp.path())
            .into_iter()
            .filter(|n| n.starts_with("settings.json.bak-"))
            .collect();
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(fs::read(tmp.join(&backups[0])).unwrap(), body);
        fs::remove_file(tmp.join(&backups[0])).unwrap();
    }
}

#[test]
fn settings_with_some_bad_fields_keep_the_good_ones() {
    let tmp = TempDir::new("settings-partial");
    let path = tmp.join("settings.json");
    fs::write(
        &path,
        br#"{"theme":"dark","idleOpacity":"very","boxSkin":"neon","sounds":1,"futureField":[1],"pixelGrid":16}"#,
    )
    .unwrap();
    let s = settings::load(&path);
    let d = Settings::default();
    assert_eq!(s.theme, reskin_core::model::ThemeMode::Dark);
    assert_eq!(s.box_skin, reskin_core::model::BoxSkin::Neon);
    assert_eq!(s.pixel_grid, 16);
    assert_eq!(s.idle_opacity, d.idle_opacity);
    assert_eq!(s.sounds, d.sounds);
    assert!(path.exists(), "a salvageable file is not moved aside");
}

#[test]
fn normalize_clamps_and_cleans() {
    let s = Settings {
        schema: 0,
        idle_opacity: 0.01,
        animation_speed: f64::NAN,
        ico_sizes: vec![512, 64, 64, 20, 0, 7],
        pixel_grid: 17,
        recent_colors: vec![
            "#AABBCC".into(),
            "#aabbcc".into(),
            "red".into(),
            "#12345".into(),
            " #11223344 ".into(),
            "#GGGGGG".into(),
        ],
        hotkey: "Ctrl+Nope".into(),
        ..Settings::default()
    };
    let n = settings::normalize(s);
    assert_eq!(n.schema, Settings::SCHEMA);
    assert_eq!(n.idle_opacity, 0.25);
    assert_eq!(n.animation_speed, 1.0);
    assert_eq!(n.ico_sizes, [16, 20, 32, 48, 64, 256]);
    assert_eq!(n.pixel_grid, 32);
    assert_eq!(n.recent_colors, ["#aabbcc", "#11223344"]);
    assert_eq!(n.hotkey, Settings::default().hotkey);

    let s = Settings {
        idle_opacity: 3.0,
        animation_speed: 9.0,
        ico_sizes: Vec::new(),
        hotkey: "   ".into(),
        recent_colors: (0..40).map(|i| format!("#0000{i:02x}")).collect(),
        ..Settings::default()
    };
    let n = settings::normalize(s);
    assert_eq!(n.idle_opacity, 1.0);
    assert_eq!(n.animation_speed, 2.0);
    assert_eq!(n.ico_sizes, [16, 32, 48, 256]);
    assert_eq!(n.hotkey, "");
    assert_eq!(n.recent_colors.len(), settings::MAX_RECENT_COLORS);
    assert_eq!(n.recent_colors[0], "#000000");

    let s = Settings {
        animation_speed: 0.1,
        idle_opacity: f64::NAN,
        ..Settings::default()
    };
    assert_eq!(settings::normalize(s.clone()).animation_speed, 0.5);
    assert_eq!(
        settings::normalize(s).idle_opacity,
        Settings::default().idle_opacity
    );

    // Defaults are already normal.
    assert_eq!(
        settings::normalize(Settings::default()),
        Settings::default()
    );
    let all = Settings {
        ico_sizes: ICO_SIZES.to_vec(),
        ..Settings::default()
    };
    assert_eq!(settings::normalize(all).ico_sizes, ICO_SIZES.to_vec());
}

// ---------------------------------------------------------------------------
// hotkeys
// ---------------------------------------------------------------------------

fn hk(s: &str) -> Hotkey {
    parse_hotkey(s)
        .unwrap_or_else(|e| panic!("{s:?}: {e}"))
        .unwrap_or_else(|| panic!("{s:?} parsed as disabled"))
}

#[test]
fn parse_hotkey_accepts() {
    let cases: &[(&str, &str, &str)] = &[
        (
            "Ctrl+Alt+Shift+R",
            "Ctrl+Alt+Shift+R",
            "Control+Alt+Shift+KeyR",
        ),
        (
            "ctrl+alt+shift+r",
            "Ctrl+Alt+Shift+R",
            "Control+Alt+Shift+KeyR",
        ),
        (" Shift + Ctrl + r ", "Ctrl+Shift+R", "Control+Shift+KeyR"),
        ("R+Alt", "Alt+R", "Alt+KeyR"),
        ("Control+5", "Ctrl+5", "Control+Digit5"),
        (
            "CommandOrControl+Shift+K",
            "Ctrl+Shift+K",
            "Control+Shift+KeyK",
        ),
        ("CmdOrCtrl+K", "Ctrl+K", "Control+KeyK"),
        ("Win+E", "Win+E", "Super+KeyE"),
        ("Super+E", "Win+E", "Super+KeyE"),
        ("Meta+E", "Win+E", "Super+KeyE"),
        ("Cmd+E", "Win+E", "Super+KeyE"),
        ("Alt+F4", "Alt+F4", "Alt+F4"),
        ("Ctrl+f24", "Ctrl+F24", "Control+F24"),
        ("Ctrl+Space", "Ctrl+Space", "Control+Space"),
        ("Ctrl+esc", "Ctrl+Escape", "Control+Escape"),
        ("Ctrl+Escape", "Ctrl+Escape", "Control+Escape"),
        ("Ctrl+PageDown", "Ctrl+PageDown", "Control+PageDown"),
        ("Ctrl+up", "Ctrl+Up", "Control+ArrowUp"),
        ("Ctrl+Plus", "Ctrl+Plus", "Control+Equal"),
        ("Ctrl+Minus", "Ctrl+Minus", "Control+Minus"),
        ("Ctrl+Backquote", "Ctrl+Backquote", "Control+Backquote"),
        (
            "Ctrl+bracketleft",
            "Ctrl+BracketLeft",
            "Control+BracketLeft",
        ),
        ("Ctrl+Quote", "Ctrl+Quote", "Control+Quote"),
        ("Ctrl+Ctrl+R", "Ctrl+R", "Control+KeyR"),
        (
            "Ctrl+Alt+Shift+Win+Delete",
            "Ctrl+Alt+Shift+Win+Delete",
            "Control+Alt+Shift+Super+Delete",
        ),
        // The accelerator spelling parses back.
        (
            "Control+Alt+Shift+KeyR",
            "Ctrl+Alt+Shift+R",
            "Control+Alt+Shift+KeyR",
        ),
        ("Super+ArrowLeft", "Win+Left", "Super+ArrowLeft"),
        ("Alt+Shift+Digit0", "Alt+Shift+0", "Alt+Shift+Digit0"),
        // Function keys type nothing, so Shift alone is enough for them.
        ("Shift+F9", "Shift+F9", "Shift+F9"),
    ];
    for (input, display, accelerator) in cases {
        let parsed = hk(input);
        assert_eq!(parsed.to_string(), *display, "{input}");
        assert_eq!(parsed.to_accelerator(), *accelerator, "{input}");
        assert_eq!(hk(display), parsed, "{display}");
        assert_eq!(hk(accelerator), parsed, "{accelerator}");
    }
    assert_eq!(
        hk("Ctrl+Alt+Shift+R"),
        Hotkey {
            ctrl: true,
            alt: true,
            shift: true,
            win: false,
            key: Key::Letter('R'),
        }
    );
    assert_eq!(hk("alt+9").key, Key::Digit(9));
    assert_eq!(hk("alt+F12").key, Key::F(12));
}

#[test]
fn parse_hotkey_disabled_and_rejected() {
    assert_eq!(parse_hotkey("").unwrap(), None);
    assert_eq!(parse_hotkey("   ").unwrap(), None);
    for bad in [
        "R",
        "F5",
        "Ctrl",
        "Ctrl+Alt",
        "Ctrl+R+T",
        "Ctrl++",
        "Ctrl+",
        "+R",
        "Ctrl+F0",
        "Ctrl+F25",
        "Ctrl+F05",
        "Ctrl+Hyper",
        "Ctrl+RR",
        "Ctrl+Key5",
        "Ctrl+Ü",
        "Ctrl+NumpadAdd",
        "Ctrl+-",
    ] {
        assert!(parse_hotkey(bad).is_err(), "{bad:?} was accepted");
    }
    // Shift alone would swallow a typeable character system-wide.
    for bad in ["Shift+A", "Shift+Digit0", "Shift+Space", "Shift+Enter"] {
        let err = parse_hotkey(bad).unwrap_err().to_string();
        assert!(err.contains("Shift alone"), "{bad:?}: {err}");
    }
    let err = parse_hotkey("Ctrl+Nope").unwrap_err().to_string();
    assert!(err.contains("Nope"), "{err}");
}

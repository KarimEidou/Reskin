//! Windows shell integration against the real shell, file system and HKCU.
//!
//! Every test is `#[ignore]`d: they run on Windows CI with
//! `cargo test -- --include-ignored`. Each works in its own temporary
//! directory, removes what it creates and restores any registry state it
//! touches (also when an assertion fails, via drop guards). All shell work
//! goes through one shared [`Sta`], exercising it concurrently.
#![cfg(windows)]

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reskin_core::Error;
use reskin_core::ico::{build_ico, parse_ico};
use reskin_core::model::{Access, IconSource, ItemKind, ItemLocation, OriginalIcon, SystemIconId};
use reskin_core::pixels::Rgba;
use reskin_core::urlini::{UrlFile, decode_text};
use reskin_core::win::sta::Sta;
use reskin_core::win::{
    access, contextmenu, desktop, extract, folder, fonts, fullscreen, known, notify, shortcut,
    sysicons, urlfile, wallpaper,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, POINT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, REG_VALUE_TYPE, RRF_NOEXPAND, RRF_RT_ANY, RegCloseKey,
    RegGetValueW, RegOpenKeyExW,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GA_ROOT, GetAncestor, GetClassNameW, HICON, IMAGE_ICON, LR_LOADFROMFILE,
    LoadImageW, WindowFromPoint,
};
use windows::core::PCWSTR;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn sta() -> &'static Sta {
    static STA: OnceLock<Sta> = OnceLock::new();
    STA.get_or_init(|| Sta::spawn().expect("start the STA worker"))
}

fn unique(tag: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("reskin-test-{tag}-{}-{nanos}", std::process::id())
}

/// A fresh directory under %TEMP%, removed (read-only bits included) on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(unique(tag));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

fn clear_read_only(path: &Path) {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(path, perms);
        }
        if meta.is_dir()
            && let Ok(entries) = std::fs::read_dir(path)
        {
            for entry in entries.flatten() {
                clear_read_only(&entry.path());
            }
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        clear_read_only(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Removes a file on drop (used for the shortcut placed on the desktop).
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

const ICO_SIZES: [u32; 4] = [16, 32, 48, 256];

fn sample(size: u32, tint: u8) -> Rgba {
    let mut img = Rgba::new(size, size);
    let r = size / 2;
    for y in 0..size {
        for x in 0..size {
            let (dx, dy) = (x as i64 - r as i64, y as i64 - r as i64);
            if dx * dx + dy * dy <= (r * r) as i64 {
                img.set_pixel(
                    x,
                    y,
                    [tint, (x * 255 / size) as u8, (y * 255 / size) as u8, 255],
                );
            }
        }
    }
    img
}

/// Writes a multi-size .ico built by `ico::build_ico`.
fn write_ico(path: &Path, tint: u8) {
    let frames: Vec<Rgba> = ICO_SIZES.iter().map(|&s| sample(s, tint)).collect();
    std::fs::write(path, build_ico(&frames).unwrap()).unwrap();
}

fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.as_ref().encode_wide().chain(Some(0)).collect()
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase().trim_end_matches('\\')
        == b.to_string_lossy().to_lowercase().trim_end_matches('\\')
}

fn windows_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()))
}

fn notepad() -> PathBuf {
    windows_dir().join(r"System32\notepad.exe")
}

/// What `location_of` must say for a path outside the special folders
/// (TEMP normally; `System` when TEMP lives under %SystemRoot%).
fn plain_location(path: &Path) -> ItemLocation {
    let lower = path.to_string_lossy().to_lowercase();
    let root = windows_dir().to_string_lossy().to_lowercase();
    if lower.starts_with(&format!("{root}\\")) {
        ItemLocation::System
    } else {
        ItemLocation::Other
    }
}

/// `%VAR%` expansion, for comparing stored icon locations.
fn expand(s: &str) -> PathBuf {
    let src = wide(s);
    let mut buf = vec![0u16; 4096];
    // SAFETY: valid NUL-terminated input and output buffer.
    let n = unsafe { ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), Some(&mut buf)) } as usize;
    if n == 0 || n > buf.len() {
        return PathBuf::from(s);
    }
    PathBuf::from(String::from_utf16_lossy(&buf[..n - 1]))
}

/// The icon file loads through the real Win32 icon loader at `size`.
fn loads_as_icon(path: &Path, size: i32) -> bool {
    let w = wide(path);
    // SAFETY: valid path; the icon is destroyed right away.
    match unsafe {
        LoadImageW(
            None,
            PCWSTR(w.as_ptr()),
            IMAGE_ICON,
            size,
            size,
            LR_LOADFROMFILE,
        )
    } {
        Ok(handle) if !handle.is_invalid() => {
            let _ = unsafe { DestroyIcon(HICON(handle.0)) };
            true
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// STA
// ---------------------------------------------------------------------------

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn sta_runs_jobs_inline_nested_and_concurrently() {
    let sta = sta().clone();
    assert!(!sta.is_current());
    assert_eq!(sta.run(|| 40 + 2).unwrap(), 42);

    let inner = sta.clone();
    let nested = sta
        .run(move || {
            assert!(inner.is_current());
            // Runs inline instead of deadlocking.
            inner.run(|| 7).unwrap()
        })
        .unwrap();
    assert_eq!(nested, 7);

    let panicked = sta.run(|| -> u32 { panic!("boom") });
    assert!(matches!(panicked, Err(Error::Other(m)) if m.contains("boom")));
    assert_eq!(sta.run(|| 1).unwrap(), 1, "the worker survives a panic");

    let handles: Vec<_> = (0..8u32)
        .map(|i| {
            let sta = sta.clone();
            std::thread::spawn(move || sta.run(move || i * i).unwrap())
        })
        .collect();
    let results: Vec<u32> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results, (0..8).map(|i| i * i).collect::<Vec<_>>());

    // A private worker stops when its last handle goes away.
    let own = Sta::spawn().unwrap();
    assert_eq!(own.try_run(|| Ok(3)).unwrap(), 3);
    drop(own);
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn shortcut_create_read_set_and_clear_icon() {
    let dir = TempDir::new("lnk");
    let lnk = dir.join("Notepad.lnk");
    let ico = dir.join("custom icon.ico");
    write_ico(&ico, 200);

    let (l, target) = (lnk.clone(), notepad());
    sta()
        .try_run(move || shortcut::create_link(&l, &target, "", None, "Reskin test"))
        .unwrap();
    let l = lnk.clone();
    let info = sta().try_run(move || shortcut::read_link(&l)).unwrap();
    assert!(
        same_path(info.target.as_deref().unwrap(), &notepad()),
        "{info:?}"
    );
    assert!(info.target_raw.is_some());
    assert_eq!(info.arguments, "");
    assert_eq!(info.icon_location, None);
    assert_eq!(info.icon_index, 0);
    assert!(info.has_idlist);
    assert!(!info.store_app);

    // set
    let (l, i) = (lnk.clone(), ico.clone());
    sta()
        .try_run(move || shortcut::set_link_icon(&l, Some((&i.to_string_lossy(), 0))))
        .unwrap();
    let l = lnk.clone();
    let info = sta().try_run(move || shortcut::read_link(&l)).unwrap();
    let (icon_path, index) = info.icon_path(&lnk).expect("icon location set");
    assert!(same_path(&icon_path, &ico), "{icon_path:?}");
    assert_eq!(index, 0);
    assert!(loads_as_icon(&icon_path, 256));
    assert!(loads_as_icon(&icon_path, 16));

    // clear
    let l = lnk.clone();
    sta()
        .try_run(move || shortcut::set_link_icon(&l, None))
        .unwrap();
    let l = lnk.clone();
    let info = sta().try_run(move || shortcut::read_link(&l)).unwrap();
    assert_eq!(info.icon_location, None);
    assert!(info.icon_path(&lnk).is_none());

    // create with arguments and an icon
    let (l2, i) = (dir.join("With args.lnk"), ico.clone());
    let l = l2.clone();
    sta()
        .try_run(move || shortcut::create_link(&l, &notepad(), "/A \"x y.txt\"", Some((&i, 0)), ""))
        .unwrap();
    let info = sta().try_run(move || shortcut::read_link(&l2)).unwrap();
    assert_eq!(info.arguments, "/A \"x y.txt\"");
    assert!(info.icon_location.is_some());
}

// ---------------------------------------------------------------------------
// Internet shortcuts
// ---------------------------------------------------------------------------

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn url_icon_set_read_and_clear() {
    let dir = TempDir::new("url");
    let url = dir.join("Example.url");
    let mut file = UrlFile::new();
    file.set_url("https://example.com/");
    std::fs::write(&url, file.to_bytes()).unwrap();

    for (name, tint) in [("site.ico", 10u8), ("Ícône 星.ico", 90)] {
        let ico = dir.join(name);
        write_ico(&ico, tint);
        let ico_str = ico.to_string_lossy().into_owned();
        let (u, s) = (url.clone(), ico_str.clone());
        sta()
            .try_run(move || urlfile::set_url_icon(&u, Some((&s, 3))))
            .unwrap();
        assert_eq!(
            urlfile::read_url_icon(&url).unwrap(),
            (Some(ico_str.clone()), 3)
        );
        let parsed = UrlFile::parse(&std::fs::read(&url).unwrap());
        assert_eq!(parsed.icon_file(), Some(ico_str.as_str()));
        assert_eq!(parsed.icon_index(), 3);
        assert_eq!(parsed.url(), Some("https://example.com/"));
    }

    let u = url.clone();
    sta()
        .try_run(move || urlfile::set_url_icon(&u, None))
        .unwrap();
    assert_eq!(urlfile::read_url_icon(&url).unwrap(), (None, 0));
    let parsed = UrlFile::parse(&std::fs::read(&url).unwrap());
    assert_eq!(parsed.icon_file(), None);
    assert_eq!(parsed.url(), Some("https://example.com/"));
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn folder_icon_set_read_and_clear() {
    let dir = TempDir::new("folder");
    let target = dir.join("Customised");
    std::fs::create_dir(&target).unwrap();
    let ico = dir.join("folder.ico");
    write_ico(&ico, 120);
    let ini = target.join("desktop.ini");

    let t = target.clone();
    assert_eq!(
        sta().try_run(move || folder::read_folder_icon(&t)).unwrap(),
        None
    );

    let (t, i) = (target.clone(), ico.clone());
    sta()
        .try_run(move || folder::set_folder_icon(&t, Some((&i, 0))))
        .unwrap();
    let t = target.clone();
    let (file, index) = sta()
        .try_run(move || folder::read_folder_icon(&t))
        .unwrap()
        .expect("folder icon set");
    assert!(same_path(&expand(&file), &ico), "{file}");
    assert_eq!(index, 0);
    // The shell may store the path with %VARS%; the file name is literal.
    let (text, _) = decode_text(&std::fs::read(&ini).unwrap());
    assert!(
        text.to_lowercase().contains("folder.ico"),
        "desktop.ini: {text}"
    );

    let t = target.clone();
    sta()
        .try_run(move || folder::set_folder_icon(&t, None))
        .unwrap();
    let t = target.clone();
    assert_eq!(
        sta().try_run(move || folder::read_folder_icon(&t)).unwrap(),
        None
    );
    if let Ok(bytes) = std::fs::read(&ini) {
        let (text, _) = decode_text(&bytes);
        assert!(
            !text.to_lowercase().contains("folder.ico"),
            "desktop.ini still names the icon: {text}"
        );
    }
}

// ---------------------------------------------------------------------------
// System icons (HKCU; restored exactly)
// ---------------------------------------------------------------------------

const HKCU_CLSID: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID";

fn key_exists(path: &str) -> bool {
    let w = wide(path);
    let mut key = HKEY::default();
    // SAFETY: valid path and out pointer; the key is closed right away.
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(w.as_ptr()),
            None,
            KEY_READ,
            &mut key,
        )
    };
    if rc == ERROR_SUCCESS {
        let _ = unsafe { RegCloseKey(key) };
        true
    } else {
        false
    }
}

/// Raw type and bytes of a value.
fn raw_value(path: &str, name: &str) -> Option<(u32, Vec<u8>)> {
    let (p, n) = (wide(path), wide(name));
    let mut kind = REG_VALUE_TYPE(0);
    let mut len = 0u32;
    // SAFETY: size query, then a read into a buffer of that size.
    unsafe {
        let flags = RRF_RT_ANY | RRF_NOEXPAND;
        let (pp, np) = (PCWSTR(p.as_ptr()), PCWSTR(n.as_ptr()));
        if RegGetValueW(
            HKEY_CURRENT_USER,
            pp,
            np,
            flags,
            Some(&mut kind),
            None,
            Some(&mut len),
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let mut data = vec![0u8; len as usize];
        let rc = RegGetValueW(
            HKEY_CURRENT_USER,
            pp,
            np,
            flags,
            Some(&mut kind),
            Some(data.as_mut_ptr() as *mut c_void),
            Some(&mut len),
        );
        (rc == ERROR_SUCCESS).then(|| {
            data.truncate(len as usize);
            (kind.0, data)
        })
    }
}

/// Everything under `CLSID\{GUID}` that Reskin may touch.
#[derive(Debug, PartialEq)]
struct RegSnapshot {
    clsid_key: bool,
    default_icon_key: bool,
    values: Vec<Option<(u32, Vec<u8>)>>,
}

fn snapshot(id: SystemIconId) -> RegSnapshot {
    let clsid = format!(r"{HKCU_CLSID}\{}", id.clsid());
    let default_icon = format!(r"{clsid}\DefaultIcon");
    RegSnapshot {
        clsid_key: key_exists(&clsid),
        default_icon_key: key_exists(&default_icon),
        values: ["", "empty", "full"]
            .iter()
            .map(|n| raw_value(&default_icon, n))
            .collect(),
    }
}

/// Restores the original override even if the test fails midway.
struct RestoreSystemIcon(SystemIconId, OriginalIcon);

impl Drop for RestoreSystemIcon {
    fn drop(&mut self) {
        let (id, original) = (self.0, self.1.clone());
        let _ = sta().try_run(move || sysicons::restore_system_icon(id, &original));
    }
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn system_icons_set_read_and_restore_exactly() {
    let dir = TempDir::new("sysicon");
    let ico = dir.join("system.ico");
    write_ico(&ico, 30);

    for id in [SystemIconId::ThisPc, SystemIconId::RecycleBinFull] {
        let before = snapshot(id);
        let original = sysicons::read_system_icon(id).unwrap();
        let guard = RestoreSystemIcon(id, original.clone());

        let i = ico.clone();
        sta()
            .try_run(move || sysicons::set_system_icon(id, &i))
            .unwrap();
        let now = sysicons::read_system_icon(id).unwrap();
        assert!(now.existed);
        assert!(same_path(Path::new(now.location.as_deref().unwrap()), &ico));
        assert_eq!(now.index, 0);
        let (effective, index) = sysicons::effective_system_icon(id).unwrap().unwrap();
        assert!(same_path(Path::new(&effective), &ico));
        assert_eq!(index, 0);

        let o = original.clone();
        sta()
            .try_run(move || sysicons::restore_system_icon(id, &o))
            .unwrap();
        assert_eq!(sysicons::read_system_icon(id).unwrap(), original);
        assert_eq!(snapshot(id), before, "{id:?} registry state not restored");
        drop(guard);
    }
}

// ---------------------------------------------------------------------------
// Inspection / extraction
// ---------------------------------------------------------------------------

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn inspect_shortcuts_executables_urls_folders_and_icons() {
    let dir = TempDir::new("inspect");
    let ico = dir.join("sample.ico");
    write_ico(&ico, 250);

    // .lnk to notepad: icon from the target's first icon group
    let lnk = dir.join("Notepad.lnk");
    let l = lnk.clone();
    sta()
        .try_run(move || shortcut::create_link(&l, &notepad(), "", None, ""))
        .unwrap();
    let l = lnk.clone();
    let item = sta().try_run(move || extract::inspect_path(&l)).unwrap();
    assert_eq!(item.kind, ItemKind::Shortcut);
    assert_eq!(item.name, "Notepad");
    assert!(item.icon.is_some());
    assert_eq!(item.icon_source, IconSource::Resource);
    assert!(!item.custom_icon);
    assert_eq!(item.access, Access::Writable);
    assert_eq!(item.location, plain_location(&lnk));
    assert!(item.link.is_some());
    assert!(
        item.target
            .as_deref()
            .unwrap()
            .to_lowercase()
            .ends_with("notepad.exe")
    );
    assert!(
        item.icon_data_url()
            .unwrap()
            .starts_with("data:image/png;base64,")
    );
    let l = lnk.clone();
    let frames = sta().try_run(move || extract::icon_frames(&l)).unwrap();
    assert!(!frames.is_empty());
    assert!(frames[0].w >= 32, "largest frame is {}", frames[0].w);
    assert!(frames.windows(2).all(|p| p[0].w >= p[1].w), "largest first");
    let ipc = extract::to_icon_frames(&frames);
    assert_eq!(ipc.len(), frames.len());
    assert_eq!((ipc[0].width, ipc[0].height), (frames[0].w, frames[0].h));
    assert_eq!(Rgba::from_png_base64(&ipc[0].png).unwrap(), frames[0]);

    // explorer.exe
    let explorer = windows_dir().join("explorer.exe");
    let item = sta()
        .try_run(move || extract::inspect_path(&explorer))
        .unwrap();
    assert_eq!(item.kind, ItemKind::Executable);
    assert_eq!(item.icon_source, IconSource::Resource);
    assert!(item.icon.is_some());

    // .url, first without then with a custom icon
    let url = dir.join("Example.url");
    let mut file = UrlFile::new();
    file.set_url("https://example.com/");
    std::fs::write(&url, file.to_bytes()).unwrap();
    let u = url.clone();
    let item = sta().try_run(move || extract::inspect_path(&u)).unwrap();
    assert_eq!(item.kind, ItemKind::InternetShortcut);
    assert_eq!(item.target.as_deref(), Some("https://example.com/"));
    assert!(item.icon.is_some());
    assert!(!item.custom_icon);
    file.set_icon(Some(&ico.to_string_lossy()), 0);
    std::fs::write(&url, file.to_bytes()).unwrap();
    let u = url.clone();
    let item = sta().try_run(move || extract::inspect_path(&u)).unwrap();
    assert!(item.custom_icon);
    assert_eq!(item.icon_source, IconSource::IcoFile);
    assert_eq!(item.icon.as_ref().map(|i| i.w), Some(256));

    // folder, plain then customised
    let sub = dir.join("Sub folder");
    std::fs::create_dir(&sub).unwrap();
    let s = sub.clone();
    let item = sta().try_run(move || extract::inspect_path(&s)).unwrap();
    assert_eq!(item.kind, ItemKind::Folder);
    assert_eq!(item.name, "Sub folder");
    assert!(item.icon.is_some());
    assert_eq!(item.icon_source, IconSource::Shell);
    let (s, i) = (sub.clone(), ico.clone());
    sta()
        .try_run(move || folder::set_folder_icon(&s, Some((&i, 0))))
        .unwrap();
    let s = sub.clone();
    let item = sta().try_run(move || extract::inspect_path(&s)).unwrap();
    assert!(item.custom_icon);
    assert_eq!(item.icon_source, IconSource::IcoFile);
    assert!(item.icon.is_some());

    // .ico file: an image whose frames are all of the icon's
    let i = ico.clone();
    let item = sta().try_run(move || extract::inspect_path(&i)).unwrap();
    assert_eq!(item.kind, ItemKind::Image);
    assert_eq!(item.icon_source, IconSource::IcoFile);
    assert_eq!(item.icon.as_ref().map(|i| i.w), Some(256));
    let i = ico.clone();
    let frames = sta().try_run(move || extract::icon_frames(&i)).unwrap();
    let sizes: Vec<u32> = frames.iter().map(|f| f.w).collect();
    let mut expected = ICO_SIZES.to_vec();
    expected.reverse();
    assert_eq!(sizes, expected);
    let parsed = parse_ico(&std::fs::read(&ico).unwrap()).unwrap();
    for (a, b) in frames.iter().zip(&parsed) {
        assert_eq!(a, &b.image);
    }

    // a PNG image: the image itself
    let png = dir.join("picture.png");
    std::fs::write(&png, sample(300, 5).encode_png()).unwrap();
    let p = png.clone();
    let item = sta().try_run(move || extract::inspect_path(&p)).unwrap();
    assert_eq!(item.kind, ItemKind::Image);
    assert_eq!(item.icon_source, IconSource::Image);
    assert_eq!(item.icon.as_ref().map(|i| (i.w, i.h)), Some((256, 256)));
    let p = png.clone();
    let frames = sta().try_run(move || extract::icon_frames(&p)).unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0], sample(300, 5));

    // missing paths are an error
    let missing = dir.join("missing.lnk");
    assert!(matches!(
        sta().try_run(move || extract::inspect_path(&missing)),
        Err(Error::NotFound(_))
    ));
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn every_system_icon_has_an_icon() {
    for id in SystemIconId::ALL {
        let item = sta()
            .try_run(move || extract::inspect_system_icon(id))
            .unwrap();
        assert_eq!(item.kind, ItemKind::SystemIcon);
        assert_eq!(item.name, id.label());
        assert_eq!(item.location, ItemLocation::System);
        assert!(item.icon.is_some(), "{id:?} has no icon");
        assert_ne!(item.icon_source, IconSource::None);
        let frames = sta()
            .try_run(move || extract::system_icon_frames(id))
            .unwrap();
        assert!(!frames.is_empty(), "{id:?} has no frames");
    }
}

// ---------------------------------------------------------------------------
// System queries
// ---------------------------------------------------------------------------

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn fonts_and_appearance_queries() {
    let fonts = sta().run(fonts::system_fonts).unwrap();
    assert!(
        fonts.iter().any(|f| f == "Segoe UI"),
        "{} fonts",
        fonts.len()
    );
    assert!(fonts.iter().all(|f| !f.starts_with('@')));
    let lower: Vec<String> = fonts.iter().map(|f| f.to_lowercase()).collect();
    assert!(
        lower.windows(2).all(|p| p[0] < p[1]),
        "sorted, no duplicates"
    );

    let info = sta().run(|| wallpaper::wallpaper_info(None)).unwrap();
    assert!(info.monitor_width > 0 && info.monitor_height > 0);
    assert!((16..=256).contains(&info.icon_size));
    assert_eq!(info.background.len(), 7);
    assert!(info.background.starts_with('#'));
    let sized = sta()
        .run(|| wallpaper::wallpaper_info(Some((1234, 567))))
        .unwrap();
    assert_eq!((sized.monitor_width, sized.monitor_height), (1234, 567));
    if let Some(accent) = sta().run(wallpaper::accent_color).unwrap() {
        assert_eq!(accent.len(), 7);
        assert!(accent.starts_with('#'));
    }
    if let Some(path) = sta().run(wallpaper::wallpaper_path).unwrap() {
        assert!(path.is_file());
    }
    let _ = wallpaper::client_area_animation();
    let _ = wallpaper::is_windows11();
    fullscreen::query_fullscreen_busy().unwrap();
    let _ = fullscreen::is_fullscreen_busy();
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn access_probe_and_locations() {
    let dir = TempDir::new("access");
    let file = dir.join("writable.txt");
    std::fs::write(&file, b"x").unwrap();
    assert_eq!(access::probe_writable(&file), Access::Writable);
    assert_eq!(access::probe_writable(&dir.0), Access::Writable);

    let locked = dir.join("locked.txt");
    std::fs::write(&locked, b"x").unwrap();
    let mut perms = std::fs::metadata(&locked).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&locked, perms).unwrap();
    assert_eq!(access::probe_writable(&locked), Access::ReadOnly);
    assert_eq!(
        access::probe_writable(&dir.join("missing.txt")),
        Access::ReadOnly
    );

    let desktop = known::desktop().unwrap();
    assert_eq!(access::location_of(&desktop), ItemLocation::UserDesktop);
    assert_eq!(
        access::location_of(&desktop.join("x.lnk")),
        ItemLocation::UserDesktop
    );
    assert_eq!(
        access::location_of(&known::public_desktop().unwrap().join("x.lnk")),
        ItemLocation::PublicDesktop
    );
    assert_eq!(
        access::location_of(&known::taskbar_pins().unwrap().join("x.lnk")),
        ItemLocation::TaskbarPin
    );
    assert_eq!(
        access::location_of(&known::common_start_menu().unwrap().join("x.lnk")),
        ItemLocation::StartMenu
    );
    assert_eq!(access::location_of(&notepad()), ItemLocation::System);
    assert_eq!(access::location_of(&file), plain_location(&file));
    for p in [
        known::program_data(),
        known::start_menu(),
        known::roaming_app_data(),
        known::local_app_data(),
    ] {
        assert!(p.unwrap().is_absolute());
    }
}

/// Puts back a pre-existing registration (e.g. a developer's install).
struct RestoreContextMenu(Option<PathBuf>);

impl Drop for RestoreContextMenu {
    fn drop(&mut self) {
        let _ = contextmenu::uninstall();
        if let Some(exe) = &self.0 {
            let _ = contextmenu::install(exe);
        }
    }
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn context_menu_round_trip() {
    let guard = RestoreContextMenu(contextmenu::installed_exe());
    let exe = std::env::temp_dir().join(unique("ctx")).join("reskin.exe");
    contextmenu::install(&exe).unwrap();
    assert!(contextmenu::is_installed());
    assert!(contextmenu::is_installed_for(&exe));
    assert_eq!(contextmenu::installed_exe(), Some(exe.clone()));
    assert!(!contextmenu::is_installed_for(Path::new(
        r"C:\elsewhere\reskin.exe"
    )));
    contextmenu::uninstall().unwrap();
    assert!(!contextmenu::is_installed());
    contextmenu::uninstall().unwrap(); // idempotent
    drop(guard);
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn notifications_and_cache_refresh() {
    let dir = TempDir::new("notify");
    notify::item_updated(&dir.0);
    notify::assoc_changed();
    let ie4uinit = notepad().with_file_name("ie4uinit.exe");
    let rebuilt = notify::rebuild_icon_cache();
    assert!(rebuilt.is_ok() || !ie4uinit.exists(), "{rebuilt:?}");
}

// ---------------------------------------------------------------------------
// Desktop icon lookup
// ---------------------------------------------------------------------------

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: u32-sized out buffer.
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
    }
    .is_ok()
        && cloaked != 0
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    // SAFETY: valid buffer.
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn desktop_icon_lookup() {
    let desktop_dir = known::desktop().unwrap();
    let lnk = desktop_dir.join(format!("{}.lnk", unique("desktop")));
    let _cleanup = RemoveOnDrop(lnk.clone());
    let l = lnk.clone();
    sta()
        .try_run(move || shortcut::create_link(&l, &notepad(), "", None, ""))
        .unwrap();
    notify::item_updated(&lnk);

    let _ = sta().run(desktop::desktop_icon_size).unwrap();

    // The desktop view picks new files up asynchronously; on a headless
    // session there may be no desktop at all (then this stays None).
    let deadline = Instant::now() + Duration::from_secs(5);
    let spot = loop {
        let l = lnk.clone();
        let spot = sta()
            .try_run(move || desktop::find_desktop_icon(&l))
            .unwrap();
        if spot.is_some() || Instant::now() >= deadline {
            break spot;
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    if let Some(spot) = spot {
        assert!(spot.rect.w > 0.0 && spot.rect.h > 0.0, "{spot:?}");
        if spot.visible {
            let (cx, cy) = spot.rect.center();
            let pt = POINT {
                x: cx as i32,
                y: cy as i32,
            };
            // SAFETY: plain window queries; the rect is in physical pixels,
            // so ask per-monitor aware (restored right after).
            let root = unsafe {
                let old = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                let root = GetAncestor(WindowFromPoint(pt), GA_ROOT);
                if !old.0.is_null() {
                    SetThreadDpiAwarenessContext(old);
                }
                root
            };
            let class = class_name(root);
            assert!(
                class == "Progman" || class == "WorkerW" || is_cloaked(root),
                "the icon centre is over {class}, not the desktop"
            );
        }
    }
    // A missing item is simply not found.
    let missing = desktop_dir.join(format!("{}.lnk", unique("absent")));
    assert_eq!(
        sta()
            .try_run(move || desktop::find_desktop_icon(&missing))
            .unwrap(),
        None
    );
}

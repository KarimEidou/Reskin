//! Windows shell integration against the real shell, file system and HKCU.
//!
//! Every test is `#[ignore]`d: they run on Windows CI with
//! `cargo test -- --include-ignored` (the elevation tests need
//! administrator rights, which CI has). Each works in its own temporary
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
use reskin_core::win::access::{AdminDir, TrustedDir};
use reskin_core::win::sta::Sta;
use reskin_core::win::{
    access, contextmenu, desktop, extract, folder, fonts, fullscreen, known, notify, shortcut,
    sysicons, urlfile, wallpaper,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE, HWND, POINT};
use windows::Win32::Globalization::{CP_ACP, WC_NO_BEST_FIT_CHARS, WideCharToMultiByte};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetKernelObjectSecurity, GetSecurityDescriptorControl,
    GetSecurityDescriptorOwner, IsWellKnownSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    PSID, SE_DACL_PROTECTED, WinBuiltinAdministratorsSid,
};
use windows::Win32::Storage::FileSystem::{
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, READ_CONTROL,
};
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
    LoadImageW, PostQuitMessage, WindowFromPoint,
};
use windows::core::{BOOL, PCSTR, PCWSTR};

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

    // A private worker survives a stray WM_QUIT and stops when its last
    // handle goes away.
    let own = Sta::spawn().unwrap();
    assert_eq!(own.try_run(|| Ok(3)).unwrap(), 3);
    // SAFETY: posts WM_QUIT to the worker's own queue.
    own.run(|| unsafe { PostQuitMessage(0) }).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        own.run(|| 4).unwrap(),
        4,
        "WM_QUIT must not stop the worker"
    );
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

/// A non-ASCII character the system ANSI code page can represent, and its
/// ANSI bytes (which must not be valid UTF-8, so the file reads as ANSI).
fn ansi_sample() -> Option<(char, Vec<u8>)> {
    ['ë', 'Ж', 'é', '中', 'α'].into_iter().find_map(|c| {
        let wide: Vec<u16> = c.to_string().encode_utf16().collect();
        let mut out = [0u8; 8];
        let mut used_default = windows::core::BOOL(0);
        // SAFETY: valid buffers; no best-fit mapping.
        let n = unsafe {
            WideCharToMultiByte(
                CP_ACP,
                WC_NO_BEST_FIT_CHARS,
                &wide,
                Some(&mut out),
                PCSTR::null(),
                Some(&mut used_default),
            )
        };
        let bytes = out[..n.max(0) as usize].to_vec();
        (n > 0 && !used_default.as_bool() && std::str::from_utf8(&bytes).is_err())
            .then_some((c, bytes))
    })
}

#[test]
#[ignore = "Windows shell integration (run with --include-ignored)"]
fn ansi_url_files_are_read_in_the_system_code_page() {
    let Some((c, ansi)) = ansi_sample() else {
        return; // a UTF-8 system code page: nothing is ANSI-only
    };
    let dir = TempDir::new("ansi");
    let url = dir.join("Ansi.url");
    let mut bytes =
        b"[InternetShortcut]\r\nURL=https://example.com/\r\nIconFile=C:\\Icons\\".to_vec();
    bytes.extend_from_slice(&ansi);
    bytes.extend_from_slice(b".ico\r\nIconIndex=5\r\n");
    std::fs::write(&url, &bytes).unwrap();
    let expected = format!("C:\\Icons\\{c}.ico");
    assert_eq!(
        urlfile::read_url_icon(&url).unwrap(),
        (Some(expected.clone()), 5)
    );
    let u = url.clone();
    let item = sta().try_run(move || extract::inspect_path(&u)).unwrap();
    assert!(item.custom_icon);
    assert_eq!(item.target.as_deref(), Some("https://example.com/"));

    // Clearing keeps the URL readable.
    let u = url.clone();
    sta()
        .try_run(move || urlfile::set_url_icon(&u, None))
        .unwrap();
    assert_eq!(urlfile::read_url_icon(&url).unwrap(), (None, 0));
    let parsed = UrlFile::parse(&std::fs::read(&url).unwrap());
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

    // An icon path outside the ANSI code page (星 is in no Western one)
    // must not degrade to '?' in desktop.ini.
    let unicode_ico = dir.join("Ícône 星.ico");
    write_ico(&unicode_ico, 140);
    for _ in 0..2 {
        // twice: once into a fresh desktop.ini, once over an existing one
        let (t, i) = (target.clone(), unicode_ico.clone());
        sta()
            .try_run(move || folder::set_folder_icon(&t, Some((&i, 0))))
            .unwrap();
        let t = target.clone();
        let (file, _) = sta()
            .try_run(move || folder::read_folder_icon(&t))
            .unwrap()
            .expect("unicode folder icon set");
        assert!(same_path(&expand(&file), &unicode_ico), "{file}");
    }
    let t = target.clone();
    sta()
        .try_run(move || folder::set_folder_icon(&t, None))
        .unwrap();
    let t = target.clone();
    assert_eq!(
        sta().try_run(move || folder::read_folder_icon(&t)).unwrap(),
        None
    );
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
        let customized_before = sysicons::is_customized(id);
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
        assert!(sysicons::is_customized(id));
        let item = sta()
            .try_run(move || extract::inspect_system_icon(id))
            .unwrap();
        assert!(item.custom_icon);
        assert_eq!(item.icon_source, IconSource::IcoFile);

        let o = original.clone();
        sta()
            .try_run(move || sysicons::restore_system_icon(id, &o))
            .unwrap();
        assert_eq!(sysicons::read_system_icon(id).unwrap(), original);
        assert_eq!(snapshot(id), before, "{id:?} registry state not restored");
        assert_eq!(sysicons::is_customized(id), customized_before);
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
    let classes = ["lnkfile", "InternetShortcut", "Directory"]
        .map(|class| format!(r"Software\Classes\{class}"));
    let existed_before = classes.clone().map(|key| key_exists(&key));
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
    for (key, existed) in classes.iter().zip(existed_before) {
        assert!(
            !key_exists(&format!(r"{key}\shell\Reskin")),
            "{key}: verb left behind"
        );
        if !existed {
            assert!(!key_exists(key), "{key}: empty class key left behind");
        }
    }
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

// ---------------------------------------------------------------------------
// Elevation: who is offered it, and the elevated helper's file access.
//
// These need administrator rights, as Windows CI has: they write to the
// Public Desktop, set owners and create symbolic links.
// ---------------------------------------------------------------------------

/// Runs a command-line tool; the test fails when it does.
fn run_tool(program: &str, args: &[&str]) {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "{program} {args:?}: {status}");
}

/// Lets everybody only read the file `path` (no inherited rights either).
fn deny_writes(path: &Path) {
    let p = path.display().to_string();
    run_tool(
        "icacls",
        &[&p, "/inheritance:r", "/grant:r", "*S-1-1-0:(R)"],
    );
}

/// A file with [`deny_writes`]: its rights are reset and it is removed on drop.
struct Denied(PathBuf);

impl Denied {
    fn new(path: PathBuf) -> Denied {
        std::fs::write(&path, b"x").unwrap();
        deny_writes(&path);
        Denied(path)
    }
}

impl Drop for Denied {
    fn drop(&mut self) {
        let p = self.0.display().to_string();
        let _ = std::process::Command::new("icacls")
            .args([p.as_str(), "/reset"])
            .status();
        let _ = std::fs::remove_file(&self.0);
    }
}

fn set_owner(path: &Path, owner: &str) {
    run_tool("icacls", &[&path.display().to_string(), "/setowner", owner]);
}

/// The account running the tests, as icacls names it.
fn current_user() -> String {
    format!(
        r"{}\{}",
        std::env::var("USERDOMAIN").unwrap(),
        std::env::var("USERNAME").unwrap()
    )
}

const ADMINISTRATORS: &str = "*S-1-5-32-544";

/// (owned by Administrators, DACL protected from inheritance) of `path`
/// itself (a link is not followed).
fn security_of(path: &Path) -> (bool, bool) {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    let file = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL.0)
        .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
        .open(path)
        .unwrap();
    let handle = HANDLE(file.as_raw_handle());
    let info = (OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION).0;
    let mut needed = 0u32;
    // SAFETY (whole block): a size query, then a buffer of that size; the
    // owner SID points into the buffer, which outlives its use.
    unsafe {
        let _ = GetKernelObjectSecurity(handle, info, None, 0, &mut needed);
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let sd = PSECURITY_DESCRIPTOR(buf.as_mut_ptr().cast());
        GetKernelObjectSecurity(handle, info, Some(sd), needed, &mut needed).unwrap();
        let mut owner = PSID::default();
        let mut defaulted = BOOL::default();
        GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted).unwrap();
        let mut control = 0u16;
        let mut revision = 0u32;
        GetSecurityDescriptorControl(sd, &mut control, &mut revision).unwrap();
        (
            IsWellKnownSid(owner, WinBuiltinAdministratorsSid).as_bool(),
            control & SE_DACL_PROTECTED.0 != 0,
        )
    }
}

fn mklink_junction(link: &Path, target: &Path) {
    run_tool(
        "cmd",
        &[
            "/c",
            "mklink",
            "/J",
            &link.display().to_string(),
            &target.display().to_string(),
        ],
    );
}

#[test]
#[ignore = "Windows shell integration as administrator (run with --include-ignored)"]
fn elevation_is_offered_only_for_links_on_the_public_desktop() {
    let public = known::public_desktop().unwrap();
    let name = unique("elevate");
    let lnk = Denied::new(public.join(format!("{name}.lnk")));
    let url = Denied::new(public.join(format!("{name}.url")));
    let txt = Denied::new(public.join(format!("{name}.txt")));
    assert_eq!(access::probe_writable(&lnk.0), Access::NeedsElevation);
    assert_eq!(access::probe_writable(&url.0), Access::NeedsElevation);
    // The helper changes nothing but .lnk / .url files there.
    assert_eq!(access::probe_writable(&txt.0), Access::ReadOnly);

    // A denied shortcut anywhere else — here under %ProgramData%, which
    // once counted — is read-only.
    let dir = TempDir(known::program_data().unwrap().join(unique("elevate")));
    std::fs::create_dir(&dir.0).unwrap();
    let elsewhere = Denied::new(dir.join("App.lnk"));
    assert_eq!(access::probe_writable(&elsewhere.0), Access::ReadOnly);

    // Where the user may create files, a new shortcut can be made.
    assert_eq!(access::probe_creatable(&dir.0), Access::Writable);
    assert_eq!(
        access::probe_creatable(&dir.join("missing")),
        Access::ReadOnly
    );
}

#[test]
#[ignore = "Windows shell integration as administrator (run with --include-ignored)"]
fn the_helpers_tree_is_created_owned_by_administrators_and_locked_down() {
    let base = TempDir::new("admin-tree");
    let icons = AdminDir::open(&base.0, &["Reskin", "icons"]).unwrap();
    assert!(same_path(icons.path(), &base.join(r"Reskin\icons")));
    for dir in [base.join("Reskin"), base.join(r"Reskin\icons")] {
        assert_eq!(security_of(&dir), (true, true), "{}", dir.display());
    }

    let name = "app-0123456789ab.ico";
    let file = icons.path().join(name);
    icons.put(name, b"one").unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"one");
    assert_eq!(security_of(&file), (true, true));
    assert_eq!(icons.read(name, 16).unwrap().as_deref(), Some(&b"one"[..]));
    assert!(icons.read(name, 2).is_err(), "larger than asked for");
    // The same bytes are kept as they are; other bytes replace them.
    let written = std::fs::metadata(&file).unwrap().modified().unwrap();
    icons.put(name, b"one").unwrap();
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        written
    );
    icons.put(name, b"two").unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"two");
    // Nothing is ever overwritten in place.
    let err = icons.create(name, b"three").unwrap_err().to_string();
    assert!(err.contains("already exists"), "{err}");
    assert_eq!(std::fs::read(&file).unwrap(), b"two");
    let files: Vec<String> = icons.files().unwrap().into_iter().map(|(n, _)| n).collect();
    assert_eq!(files, [name]);
    assert!(icons.remove(name).unwrap());
    assert!(!icons.remove(name).unwrap());
    assert_eq!(icons.read(name, 16).unwrap(), None);
    for bad in ["..", r"..\x.ico", "a/b.ico", "nul.ico", "x.ico."] {
        assert!(icons.put(bad, b"x").is_err(), "{bad}");
    }
    drop(icons);

    // A folder an earlier Reskin left writable for Users is locked down.
    let old = TempDir::new("admin-old");
    std::fs::create_dir_all(old.join(r"Reskin\results")).unwrap();
    for dir in [old.join("Reskin"), old.join(r"Reskin\results")] {
        set_owner(&dir, ADMINISTRATORS);
        assert_eq!(security_of(&dir), (true, false));
    }
    let results = AdminDir::open(&old.0, &["Reskin", "results"]).unwrap();
    for dir in [old.join("Reskin"), old.join(r"Reskin\results")] {
        assert_eq!(security_of(&dir), (true, true), "{}", dir.display());
    }
    drop(results);

    // A folder another account owns is refused, and nothing is made in it.
    let foreign = TempDir::new("admin-foreign");
    std::fs::create_dir(foreign.join("Reskin")).unwrap();
    set_owner(&foreign.join("Reskin"), &current_user());
    let err = AdminDir::open(&foreign.0, &["Reskin", "icons"])
        .err()
        .unwrap()
        .to_string();
    assert!(err.contains("belongs to another account"), "{err}");
    assert!(!foreign.join(r"Reskin\icons").exists());
}

#[test]
#[ignore = "Windows shell integration as administrator (run with --include-ignored)"]
fn the_helper_never_follows_a_planted_link() {
    let base = TempDir::new("admin-links");
    let victim = base.join("victim.txt");
    std::fs::write(&victim, b"keep").unwrap();

    // A junction where a folder of the tree belongs.
    let elsewhere = base.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    mklink_junction(&base.join("Reskin"), &elsewhere);
    let err = AdminDir::open(&base.0, &["Reskin", "icons"])
        .err()
        .unwrap()
        .to_string();
    assert!(err.contains("is a link"), "{err}");
    assert!(!elsewhere.join("icons").exists());
    std::fs::remove_dir(base.join("Reskin")).unwrap();

    let icons = AdminDir::open(&base.0, &["Reskin", "icons"]).unwrap();
    let entry = |name: &str| icons.path().join(name);
    // A symbolic link and a hard link by icon names: read refuses them, put
    // replaces the link and leaves what it leads to alone.
    std::os::windows::fs::symlink_file(&victim, entry("soft-0123456789ab.ico")).unwrap();
    std::fs::hard_link(&victim, entry("hard-0123456789ab.ico")).unwrap();
    for name in ["soft-0123456789ab.ico", "hard-0123456789ab.ico"] {
        let err = icons.read(name, 16).unwrap_err().to_string();
        assert!(err.contains("refusing"), "{name}: {err}");
        icons.put(name, b"icon").unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep", "{name}");
        assert_eq!(icons.read(name, 16).unwrap().as_deref(), Some(&b"icon"[..]));
    }
    // Removing a link removes the link.
    std::os::windows::fs::symlink_file(&victim, entry("gone-0123456789ab.ico")).unwrap();
    assert!(icons.remove("gone-0123456789ab.ico").unwrap());
    assert!(std::fs::symlink_metadata(entry("gone-0123456789ab.ico")).is_err());
    assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
    // A junction by an icon's name is replaced, never entered.
    let folder = base.join("folder");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("file.txt"), b"keep").unwrap();
    mklink_junction(&entry("junction-0123456789ab.ico"), &folder);
    icons.put("junction-0123456789ab.ico", b"icon").unwrap();
    assert_eq!(std::fs::read(folder.join("file.txt")).unwrap(), b"keep");
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
    assert_eq!(
        icons
            .read("junction-0123456789ab.ico", 16)
            .unwrap()
            .as_deref(),
        Some(&b"icon"[..])
    );
}

#[test]
#[ignore = "Windows shell integration as administrator (run with --include-ignored)"]
fn jobs_results_and_public_desktop_shortcuts_must_be_plain_files() {
    let dir = TempDir::new("plain-files");
    // The job: read once, capped, never through a link.
    let job = dir.join("0123abcd.json");
    std::fs::write(&job, b"{}").unwrap();
    assert_eq!(access::read_plain_file(&job, 16).unwrap(), b"{}");
    let err = access::read_plain_file(&job, 1).unwrap_err().to_string();
    assert!(err.contains("larger than"), "{err}");
    std::os::windows::fs::symlink_file(&job, dir.join("soft.json")).unwrap();
    let err = access::read_plain_file(&dir.join("soft.json"), 16).unwrap_err();
    assert!(err.to_string().contains("is a link"), "{err}");
    assert!(access::read_plain_file(&dir.0, 16).is_err(), "a folder");
    assert!(matches!(
        access::read_plain_file(&dir.join("missing.json"), 16),
        Err(Error::NotFound(_))
    ));

    // A Public Desktop shortcut: a plain file directly in the folder.
    let trusted = TrustedDir::open(&dir.0).unwrap();
    let lnk = dir.join("App.lnk");
    std::fs::write(&lnk, b"x").unwrap();
    trusted.check_file(&lnk).unwrap();
    std::os::windows::fs::symlink_file(&lnk, dir.join("Soft.lnk")).unwrap();
    let err = trusted.check_file(&dir.join("Soft.lnk")).unwrap_err();
    assert!(err.to_string().contains("is a link"), "{err}");
    let sub = dir.join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::fs::write(sub.join("App.lnk"), b"x").unwrap();
    let err = trusted.check_file(&sub.join("App.lnk")).unwrap_err();
    assert!(err.to_string().contains("not directly in"), "{err}");
    assert!(matches!(
        trusted.check_file(&dir.join("Missing.lnk")),
        Err(Error::NotFound(_))
    ));
    // Hard links: every name of the file is refused (writing one would
    // change the others).
    std::fs::hard_link(&lnk, dir.join("Hard.lnk")).unwrap();
    for name in ["App.lnk", "Hard.lnk"] {
        let err = trusted.check_file(&dir.join(name)).unwrap_err();
        assert!(err.to_string().contains("hard links"), "{name}: {err}");
    }
    let err = access::read_plain_file(&lnk, 16).unwrap_err();
    assert!(err.to_string().contains("hard links"), "{err}");

    // Results: the app reads only an administrator's plain files.
    let tree = TempDir::new("admin-results");
    let results = AdminDir::open(&tree.0, &["Reskin", "results"]).unwrap();
    results.create("abc.json", b"{}").unwrap();
    assert_eq!(
        access::read_admin_file(&results.path().join("abc.json"), 16)
            .unwrap()
            .as_deref(),
        Some(&b"{}"[..])
    );
    assert_eq!(
        access::read_admin_file(&results.path().join("none.json"), 16).unwrap(),
        None
    );
    let mine = dir.join("mine.json");
    std::fs::write(&mine, b"{}").unwrap();
    set_owner(&mine, &current_user());
    let err = access::read_admin_file(&mine, 16).unwrap_err().to_string();
    assert!(err.contains("does not belong to an administrator"), "{err}");
}

#[test]
#[ignore = "Windows shell integration as administrator (run with --include-ignored)"]
fn the_helper_rewrites_a_url_file_only_through_a_file_it_created() {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    let dir = TempDir::new("trusted-url");
    let url = dir.join("Site.url");
    let temp = dir.join("Site.url.reskin-tmp");
    let mut file = UrlFile::new();
    file.set_url("https://example.com/");
    std::fs::write(&url, file.to_bytes()).unwrap();

    // The helper's edit through the shell object, checked first.
    let ico = dir.join("site.ico");
    write_ico(&ico, 40);
    let ico_str = ico.to_string_lossy().into_owned();
    let (base, u, s) = (dir.0.clone(), url.clone(), ico_str.clone());
    sta()
        .try_run(move || {
            let trusted = TrustedDir::open(&base)?;
            urlfile::set_url_icon_in(&trusted, &u, Some((&s, 2)))
        })
        .unwrap();
    assert_eq!(
        urlfile::read_url_icon(&url).unwrap(),
        (Some(ico_str.clone()), 2)
    );
    let (base, u) = (dir.0.clone(), url.clone());
    sta()
        .try_run(move || {
            let trusted = TrustedDir::open(&base)?;
            urlfile::set_url_icon_in(&trusted, &u, None)
        })
        .unwrap();
    assert_eq!(urlfile::read_url_icon(&url).unwrap(), (None, 0));
    let parsed = UrlFile::parse(&std::fs::read(&url).unwrap());
    assert_eq!(parsed.url(), Some("https://example.com/"));

    // The direct rewrite: the file gets the new bytes and keeps its access
    // rules (protected here) and attributes; no temporary file stays.
    let trusted = TrustedDir::open(&dir.0).unwrap();
    let p = url.display().to_string();
    run_tool(
        "icacls",
        &[
            &p,
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-32-544:(F)",
            "*S-1-1-0:(R)",
        ],
    );
    run_tool("attrib", &["+h", &p]);
    let one = b"[InternetShortcut]\r\nURL=https://example.org/\r\n";
    trusted.replace_file(&url, one).unwrap();
    assert_eq!(std::fs::read(&url).unwrap(), one);
    assert!(security_of(&url).1, "the access rules came along");
    let attributes = std::fs::metadata(&url).unwrap().file_attributes();
    assert_ne!(attributes & HIDDEN, 0, "the attributes came along");
    assert!(std::fs::symlink_metadata(&temp).is_err());
    assert_eq!(trusted.read_file(&url, 1024).unwrap(), one);
    assert!(trusted.read_file(&url, 8).is_err(), "larger than asked for");

    // Whatever has the temporary name is removed, never written through:
    // a symbolic link, a junction, a file a crash left.
    let victim = dir.join("victim.txt");
    std::fs::write(&victim, b"keep").unwrap();
    std::os::windows::fs::symlink_file(&victim, &temp).unwrap();
    trusted.replace_file(&url, b"two").unwrap();
    assert_eq!(std::fs::read(&url).unwrap(), b"two");
    assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
    let folder = dir.join("folder");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("file.txt"), b"keep").unwrap();
    mklink_junction(&temp, &folder);
    trusted.replace_file(&url, b"three").unwrap();
    assert_eq!(std::fs::read(&url).unwrap(), b"three");
    assert_eq!(std::fs::read(folder.join("file.txt")).unwrap(), b"keep");
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
    std::fs::write(&temp, b"left by a crash").unwrap();
    trusted.replace_file(&url, b"four").unwrap();
    assert_eq!(std::fs::read(&url).unwrap(), b"four");
    assert!(std::fs::symlink_metadata(&temp).is_err());

    // The file itself must be a plain file directly in the folder; nothing
    // else is read or replaced, and what a link leads to stays as it was.
    let soft = dir.join("Soft.url");
    std::os::windows::fs::symlink_file(&victim, &soft).unwrap();
    for err in [
        trusted.replace_file(&soft, b"x").unwrap_err(),
        trusted.read_file(&soft, 1024).unwrap_err(),
        urlfile::set_url_icon_in(&trusted, &soft, Some((&ico_str, 0))).unwrap_err(),
    ] {
        assert!(err.to_string().contains("is a link"), "{err}");
    }
    assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
    std::fs::hard_link(&url, dir.join("Hard.url")).unwrap();
    let err = trusted.replace_file(&url, b"x").unwrap_err();
    assert!(err.to_string().contains("hard links"), "{err}");
    assert_eq!(std::fs::read(&url).unwrap(), b"four");
    std::fs::remove_file(dir.join("Hard.url")).unwrap();
    let sub = dir.join("sub");
    std::fs::create_dir(&sub).unwrap();
    std::fs::write(sub.join("App.url"), b"x").unwrap();
    let err = trusted
        .replace_file(&sub.join("App.url"), b"y")
        .unwrap_err();
    assert!(err.to_string().contains("not directly in"), "{err}");
    assert_eq!(std::fs::read(sub.join("App.url")).unwrap(), b"x");
    assert!(matches!(
        trusted.replace_file(&dir.join("Missing.url"), b"x"),
        Err(Error::NotFound(_))
    ));
    assert!(!dir.join("Missing.url").exists());
    run_tool("icacls", &[&p, "/reset"]);
    run_tool("attrib", &["-h", &p]);
}

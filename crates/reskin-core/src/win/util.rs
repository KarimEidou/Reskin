//! Small Win32 helpers shared by the shell modules: wide strings, COM
//! scoping and memory, error context, registry access, environment
//! expansion, icon-location strings, path comparison and HBITMAP decoding.

use std::ffi::{OsStr, OsString, c_void};
use std::fmt::Display;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, RPC_E_CHANGED_MODE,
    WIN32_ERROR,
};
use windows::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
    GetDIBits, GetObjectW, HBITMAP,
};
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::Registry::{
    HKEY, KEY_READ, KEY_WRITE, REG_DWORD, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SAM_FLAGS,
    REG_SZ, REG_VALUE_TYPE, RegCreateKeyExW, RegDeleteKeyW, RegDeleteTreeW, RegDeleteValueW,
    RegOpenKeyExW, RegQueryInfoKeyW, RegQueryValueExW, RegSetValueExW,
};
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::core::{Owned, PCWSTR, PWSTR};

use crate::pixels::{Rgba, bgra_to_rgba};
use crate::{Error, Result};

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/// NUL-terminated UTF-16 copy of `s`, for `PCWSTR` parameters.
pub(crate) fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// `PCWSTR` view of a buffer made by [`wide`]; the buffer must outlive it.
pub(crate) fn pcwstr(w: &[u16]) -> PCWSTR {
    PCWSTR(w.as_ptr())
}

/// The UTF-16 text in `buf` up to the first NUL, as an `OsString`
/// (lossless for paths).
pub(crate) fn os_from_wide(buf: &[u16]) -> OsString {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..end])
}

/// The UTF-16 text in `buf` up to the first NUL (lossy).
pub(crate) fn from_wide(buf: &[u16]) -> String {
    os_from_wide(buf).to_string_lossy().into_owned()
}

/// Takes ownership of a `CoTaskMemAlloc`ed string returned by a COM API,
/// copies it and frees it. A null pointer yields an empty string.
///
/// # Safety
/// `p` must be null or a valid NUL-terminated string allocated with
/// `CoTaskMemAlloc` that nothing else frees.
pub(crate) unsafe fn take_co_string(p: PWSTR) -> OsString {
    if p.is_null() {
        return OsString::new();
    }
    // SAFETY: per the contract `p` is a valid NUL-terminated string.
    let s = OsString::from_wide(unsafe { p.as_wide() });
    // SAFETY: the string was allocated with CoTaskMemAlloc and is ours.
    unsafe { CoTaskMemFree(Some(p.0 as *const c_void)) };
    s
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Adds "what were we doing" context to a Windows error while keeping the
/// `AccessDenied` / `NotFound` / `Cancelled` classification of
/// `From<windows_core::Error> for Error`.
pub(crate) fn with_context(e: windows_core::Error, what: impl Display) -> Error {
    match Error::from(e) {
        Error::AccessDenied(m) => Error::AccessDenied(format!("{what}: {m}")),
        Error::NotFound(m) => Error::NotFound(format!("{what}: {m}")),
        Error::Unsupported(m) => Error::Unsupported(format!("{what}: {m}")),
        Error::Other(m) => Error::Other(format!("{what}: {m}")),
        Error::Cancelled => Error::Cancelled,
    }
}

/// `.ctx("…")` on Windows results.
pub(crate) trait ResultExt<T> {
    fn ctx(self, what: impl Display) -> Result<T>;
}

impl<T> ResultExt<T> for windows_core::Result<T> {
    fn ctx(self, what: impl Display) -> Result<T> {
        self.map_err(|e| with_context(e, what))
    }
}

/// A Win32 error code with context.
pub(crate) fn win32_error(code: WIN32_ERROR, what: impl Display) -> Error {
    with_context(windows_core::Error::from(code), what)
}

// ---------------------------------------------------------------------------
// COM
// ---------------------------------------------------------------------------

/// Keeps COM initialised on the current thread for the scope's lifetime.
///
/// On the [`super::sta::Sta`] thread this only bumps COM's init count. On
/// any other thread it initialises an apartment-threaded apartment for the
/// duration of the call, so the public functions also work when called off
/// the STA (tests, the elevated helper). A thread that is already in the
/// multithreaded apartment is left as it is: COM works there too.
pub(crate) struct ComScope {
    initialized: bool,
}

impl ComScope {
    pub(crate) fn enter() -> Result<Self> {
        // SAFETY: plain COM initialisation, balanced in Drop.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        if hr == RPC_E_CHANGED_MODE {
            return Ok(Self { initialized: false });
        }
        hr.ok().ctx("initialise COM")?;
        Ok(Self { initialized: true })
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: balances the successful CoInitializeEx in `enter`.
            unsafe { CoUninitialize() };
        }
    }
}

/// An owned absolute or relative ITEMIDLIST, freed with `CoTaskMemFree`.
pub(crate) struct Pidl(pub *mut ITEMIDLIST);

impl Pidl {
    pub(crate) fn is_null(&self) -> bool {
        self.0.is_null()
    }
}

impl Drop for Pidl {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: shell PIDLs are CoTaskMemAlloc allocations we own.
            unsafe { CoTaskMemFree(Some(self.0 as *const c_void)) };
        }
    }
}

// ---------------------------------------------------------------------------
// Environment, system paths, icon locations
// ---------------------------------------------------------------------------

/// Expands `%VARIABLES%` (unknown variables are left as they are).
pub(crate) fn expand_env(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let src = wide(s);
    let mut buf = vec![0u16; 1024];
    for _ in 0..2 {
        // SAFETY: `src` is NUL-terminated and `buf` is a valid buffer.
        let needed = unsafe { ExpandEnvironmentStringsW(pcwstr(&src), Some(&mut buf)) } as usize;
        if needed == 0 {
            break;
        }
        if needed <= buf.len() {
            return from_wide(&buf);
        }
        buf.resize(needed, 0);
    }
    s.to_owned()
}

/// `%SystemRoot%\System32`.
pub(crate) fn system_dir() -> PathBuf {
    let mut buf = vec![0u16; 1024];
    // SAFETY: valid buffer.
    let n = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
    if n > 0 && n < buf.len() {
        PathBuf::from(os_from_wide(&buf[..n]))
    } else {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
        PathBuf::from(root).join("System32")
    }
}

/// Splits an icon location such as `%SystemRoot%\System32\imageres.dll,-54`
/// or `"C:\x.exe",2` into its (unexpanded, unquoted) path and index. The
/// index is taken from the last comma only when it parses as an integer;
/// otherwise the whole string is the path and the index is 0.
pub(crate) fn parse_icon_location(s: &str) -> Option<(String, i32)> {
    let s = s.trim();
    let (path, index) = match s.rsplit_once(',') {
        Some((p, i)) => match i.trim().parse::<i32>() {
            Ok(i) => (p, i),
            Err(_) => (s, 0),
        },
        None => (s, 0),
    };
    let path = strip_quotes(path.trim());
    (!path.is_empty()).then(|| (path.to_owned(), index))
}

/// The registry / desktop.ini form of an icon location.
pub(crate) fn format_icon_location(path: &str, index: i32) -> String {
    format!("{path},{index}")
}

fn strip_quotes(s: &str) -> &str {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Resolves a raw icon path the way the shell does: expands `%VARS%`,
/// strips quotes, resolves a relative path against `base` (the folder of
/// the `.lnk` / `.url` / customised folder) and, for a bare file name that
/// does not exist there, against System32 (`shell32.dll,3`).
pub(crate) fn resolve_icon_path(raw: &str, base: Option<&Path>) -> PathBuf {
    let expanded = expand_env(raw.trim());
    let p = PathBuf::from(strip_quotes(expanded.trim()));
    if p.is_absolute() {
        return p;
    }
    if let Some(base) = base {
        let joined = base.join(&p);
        if joined.exists() || p.components().count() > 1 {
            return joined;
        }
    }
    let sys = system_dir().join(&p);
    if sys.exists() {
        return sys;
    }
    match base {
        Some(base) => base.join(p),
        None => p,
    }
}

// ---------------------------------------------------------------------------
// Path comparison (Windows semantics: ordinal, case-insensitive)
// ---------------------------------------------------------------------------

fn normalized_wide(p: &OsStr) -> Vec<u16> {
    let mut v: Vec<u16> = p
        .encode_wide()
        .map(|c| {
            if c == u16::from(b'/') {
                u16::from(b'\\')
            } else {
                c
            }
        })
        .collect();
    // `\\?\C:\…` → `C:\…` (leave `\\?\UNC\…` alone: it is rare here and
    // never matches a known folder anyway)
    let verbatim: Vec<u16> = r"\\?\".encode_utf16().collect();
    if v.starts_with(&verbatim) && v.get(5) == Some(&u16::from(b':')) {
        v.drain(..4);
    }
    // Trailing separators, except a drive root's (`C:\`).
    while v.len() > 3 && v.last() == Some(&u16::from(b'\\')) {
        v.pop();
    }
    v
}

fn ordinal_ci_eq(a: &[u16], b: &[u16]) -> bool {
    // SAFETY: plain slices.
    a.len() == b.len() && unsafe { CompareStringOrdinal(a, b, true) } == CSTR_EQUAL
}

/// Ordinal case-insensitive equality of two strings (no path rules).
pub(crate) fn eq_ci(a: &OsStr, b: &OsStr) -> bool {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_wide().collect(), b.encode_wide().collect());
    ordinal_ci_eq(&a, &b)
}

/// `a` and `b` name the same path (case-insensitive, `/` ≡ `\`, trailing
/// separators ignored). Also works for shell parsing names (`::{CLSID}`).
pub(crate) fn paths_equal_ci(a: &OsStr, b: &OsStr) -> bool {
    ordinal_ci_eq(&normalized_wide(a), &normalized_wide(b))
}

/// `path` is `base` or lies below it.
pub(crate) fn path_starts_with_ci(path: &Path, base: &Path) -> bool {
    let (p, b) = (
        normalized_wide(path.as_os_str()),
        normalized_wide(base.as_os_str()),
    );
    if b.is_empty() || p.len() < b.len() || !ordinal_ci_eq(&p[..b.len()], &b) {
        return false;
    }
    p.len() == b.len() || p[b.len()] == u16::from(b'\\') || b.last() == Some(&u16::from(b'\\'))
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// An open registry key, closed on drop.
pub(crate) struct RegKey(Owned<HKEY>);

impl RegKey {
    /// Opens `root\path`; `Ok(None)` when it does not exist.
    pub(crate) fn open(root: HKEY, path: &str, access: REG_SAM_FLAGS) -> Result<Option<RegKey>> {
        let w = wide(path);
        let mut key = HKEY(std::ptr::null_mut());
        // SAFETY: valid NUL-terminated path and out pointer.
        let rc = unsafe { RegOpenKeyExW(root, pcwstr(&w), None, access, &mut key) };
        match rc {
            ERROR_SUCCESS => Ok(Some(RegKey(unsafe { Owned::new(key) }))),
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(None),
            e => Err(win32_error(e, format!("open registry key {path}"))),
        }
    }

    /// Opens `root\path` for reading and writing, creating missing keys.
    pub(crate) fn create(root: HKEY, path: &str) -> Result<RegKey> {
        let w = wide(path);
        let mut key = HKEY(std::ptr::null_mut());
        // SAFETY: valid NUL-terminated path and out pointer.
        let rc = unsafe {
            RegCreateKeyExW(
                root,
                pcwstr(&w),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_READ | KEY_WRITE,
                None,
                &mut key,
                None,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(win32_error(rc, format!("create registry key {path}")));
        }
        Ok(RegKey(unsafe { Owned::new(key) }))
    }

    /// Raw value data and type; `Ok(None)` when the value does not exist.
    /// `name` "" is the key's `(Default)` value.
    pub(crate) fn raw(&self, name: &str) -> Result<Option<(REG_VALUE_TYPE, Vec<u8>)>> {
        let w = wide(name);
        for _ in 0..4 {
            let mut kind = REG_VALUE_TYPE(0);
            let mut len = 0u32;
            // SAFETY: size query with valid out pointers.
            let rc = unsafe {
                RegQueryValueExW(
                    *self.0,
                    pcwstr(&w),
                    None,
                    Some(&mut kind),
                    None,
                    Some(&mut len),
                )
            };
            match rc {
                ERROR_SUCCESS => {}
                ERROR_FILE_NOT_FOUND => return Ok(None),
                e => return Err(win32_error(e, format!("read registry value {name:?}"))),
            }
            let mut data = vec![0u8; len as usize];
            // SAFETY: `data` holds `len` bytes.
            let rc = unsafe {
                RegQueryValueExW(
                    *self.0,
                    pcwstr(&w),
                    None,
                    Some(&mut kind),
                    Some(data.as_mut_ptr()),
                    Some(&mut len),
                )
            };
            match rc {
                ERROR_SUCCESS => {
                    data.truncate(len as usize);
                    return Ok(Some((kind, data)));
                }
                // The value grew between the two calls; ask again.
                ERROR_MORE_DATA => continue,
                ERROR_FILE_NOT_FOUND => return Ok(None),
                e => return Err(win32_error(e, format!("read registry value {name:?}"))),
            }
        }
        Err(Error::Other(format!(
            "registry value {name:?} keeps changing size"
        )))
    }

    /// A `REG_SZ` / `REG_EXPAND_SZ` value, unexpanded. `Ok(None)` when absent;
    /// `Err(Unsupported)` when the value has another type.
    pub(crate) fn string(&self, name: &str) -> Result<Option<String>> {
        match self.raw(name)? {
            None => Ok(None),
            Some((kind, data)) if kind == REG_SZ || kind == REG_EXPAND_SZ => {
                let units: Vec<u16> = data
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                Ok(Some(from_wide(&units)))
            }
            Some((kind, _)) => Err(Error::Unsupported(format!(
                "registry value {name:?} has type {} instead of a string",
                kind.0
            ))),
        }
    }

    /// A `REG_DWORD` value (also accepts a decimal string, as some tweak
    /// tools write). `Ok(None)` when absent or of another type.
    pub(crate) fn dword(&self, name: &str) -> Result<Option<u32>> {
        match self.raw(name)? {
            Some((kind, data)) if kind == REG_DWORD => Ok(data
                .get(..4)
                .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))),
            Some((kind, _)) if kind == REG_SZ || kind == REG_EXPAND_SZ => {
                Ok(self.string(name)?.and_then(|s| s.trim().parse().ok()))
            }
            _ => Ok(None),
        }
    }

    /// Writes a string value (`REG_SZ` or `REG_EXPAND_SZ`).
    pub(crate) fn set_string(
        &self,
        name: &str,
        value: impl AsRef<OsStr>,
        kind: REG_VALUE_TYPE,
    ) -> Result<()> {
        let w = wide(name);
        let bytes: Vec<u8> = wide(value).iter().flat_map(|u| u.to_le_bytes()).collect();
        // SAFETY: valid name and data buffer.
        let rc = unsafe { RegSetValueExW(*self.0, pcwstr(&w), None, kind, Some(&bytes)) };
        if rc != ERROR_SUCCESS {
            return Err(win32_error(rc, format!("write registry value {name:?}")));
        }
        Ok(())
    }

    /// Deletes a value; `Ok(false)` if it did not exist.
    pub(crate) fn delete_value(&self, name: &str) -> Result<bool> {
        let w = wide(name);
        // SAFETY: valid name.
        match unsafe { RegDeleteValueW(*self.0, pcwstr(&w)) } {
            ERROR_SUCCESS => Ok(true),
            ERROR_FILE_NOT_FOUND => Ok(false),
            e => Err(win32_error(e, format!("delete registry value {name:?}"))),
        }
    }

    /// The key has neither values nor subkeys.
    pub(crate) fn is_empty(&self) -> Result<bool> {
        let (mut subkeys, mut values) = (0u32, 0u32);
        // SAFETY: valid out pointers; every other parameter is optional.
        let rc = unsafe {
            RegQueryInfoKeyW(
                *self.0,
                None,
                None,
                None,
                Some(&mut subkeys),
                None,
                None,
                Some(&mut values),
                None,
                None,
                None,
                None,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(win32_error(rc, "query registry key"));
        }
        Ok(subkeys == 0 && values == 0)
    }
}

/// Deletes `root\path` if it exists and holds no values or subkeys.
/// Returns whether it was deleted.
pub(crate) fn delete_key_if_empty(root: HKEY, path: &str) -> Result<bool> {
    let Some(key) = RegKey::open(root, path, KEY_READ)? else {
        return Ok(false);
    };
    if !key.is_empty()? {
        return Ok(false);
    }
    drop(key);
    let w = wide(path);
    // SAFETY: valid path.
    match unsafe { RegDeleteKeyW(root, pcwstr(&w)) } {
        ERROR_SUCCESS => Ok(true),
        ERROR_FILE_NOT_FOUND => Ok(false),
        e => Err(win32_error(e, format!("delete registry key {path}"))),
    }
}

/// Deletes `root\path` with all its values and subkeys (no error if absent).
pub(crate) fn delete_tree(root: HKEY, path: &str) -> Result<()> {
    let w = wide(path);
    // SAFETY: valid path. RegDeleteTreeW removes the key's contents and the
    // key itself; RegDeleteKeyW afterwards is a no-op safety net.
    match unsafe { RegDeleteTreeW(root, pcwstr(&w)) } {
        ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => {}
        e => return Err(win32_error(e, format!("delete registry key {path}"))),
    }
    match unsafe { RegDeleteKeyW(root, pcwstr(&w)) } {
        ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
        e => Err(win32_error(e, format!("delete registry key {path}"))),
    }
}

// ---------------------------------------------------------------------------
// Bitmaps
// ---------------------------------------------------------------------------

/// Reads any HBITMAP as straight-alpha RGBA via a 32-bpp top-down DIB
/// (`GetDIBits`), un-premultiplying when the data looks premultiplied.
/// The caller keeps ownership of `hbm`.
pub(crate) fn hbitmap_to_rgba(hbm: HBITMAP) -> Result<Rgba> {
    let mut bm = BITMAP::default();
    // SAFETY: `bm` is a BITMAP-sized buffer.
    let got = unsafe {
        GetObjectW(
            hbm.into(),
            size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut BITMAP as *mut c_void),
        )
    };
    if got == 0 {
        return Err(Error::Other("GetObject failed on the icon bitmap".into()));
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    if !(1..=8192).contains(&w) || !(1..=8192).contains(&h) {
        return Err(Error::Other(format!("unexpected bitmap size {w}x{h}")));
    }
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bgra = vec![0u8; w as usize * h as usize * 4];
    // SAFETY: memory DC released below; `bgra` holds h rows of w*4 bytes.
    let lines = unsafe {
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return Err(Error::Other("CreateCompatibleDC failed".into()));
        }
        let lines = GetDIBits(
            dc,
            hbm,
            0,
            h as u32,
            Some(bgra.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        lines
    };
    if lines != h {
        return Err(Error::Other(format!(
            "GetDIBits copied {lines} of {h} rows"
        )));
    }
    bgra_to_rgba(w as u32, h as u32, &bgra).map_err(Error::Other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_locations() {
        assert_eq!(
            parse_icon_location(r"%SystemRoot%\System32\imageres.dll,-54"),
            Some((r"%SystemRoot%\System32\imageres.dll".into(), -54))
        );
        assert_eq!(
            parse_icon_location(r#""C:\a,b\x.exe", 2"#),
            Some((r"C:\a,b\x.exe".into(), 2))
        );
        assert_eq!(
            parse_icon_location(r"C:\a,b\x.ico"),
            Some((r"C:\a,b\x.ico".into(), 0))
        );
        assert_eq!(parse_icon_location("  "), None);
        assert_eq!(format_icon_location(r"C:\x.ico", 0), r"C:\x.ico,0");
    }

    #[test]
    fn path_prefixes() {
        let base = Path::new(r"C:\Users\Me\Desktop");
        assert!(path_starts_with_ci(
            Path::new(r"c:\users\me\desktop\a.lnk"),
            base
        ));
        assert!(path_starts_with_ci(
            Path::new(r"C:\Users\Me\Desktop\"),
            base
        ));
        assert!(path_starts_with_ci(
            Path::new(r"\\?\C:\Users\Me\Desktop\x"),
            base
        ));
        assert!(!path_starts_with_ci(
            Path::new(r"C:\Users\Me\Desktop2\a.lnk"),
            base
        ));
        assert!(path_starts_with_ci(Path::new(r"C:\x"), Path::new(r"C:\")));
        assert!(paths_equal_ci(OsStr::new("C:/A/b"), OsStr::new(r"c:\a\B\")));
        assert!(paths_equal_ci(
            OsStr::new("::{645FF040-5081-101B-9F08-00AA002F954E}"),
            OsStr::new("::{645ff040-5081-101b-9f08-00aa002f954e}")
        ));
    }

    #[test]
    fn env_expansion() {
        let root = std::env::var("SystemRoot").unwrap();
        assert_eq!(expand_env(r"%SystemRoot%\x"), format!(r"{root}\x"));
        assert_eq!(expand_env("no vars"), "no vars");
        assert_eq!(expand_env("%RESKIN_SURELY_UNSET%"), "%RESKIN_SURELY_UNSET%");
    }
}

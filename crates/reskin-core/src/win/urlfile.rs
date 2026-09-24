//! `.url` Internet Shortcuts.
//!
//! Reading uses the pure INI parser ([`crate::urlini`]); writing goes
//! through the shell's own `CLSID_InternetShortcut` object and its
//! `FMTID_Intshcut` property set, which also maintains the
//! `[InternetShortcut.W]` section for non-ANSI paths. Every write is
//! verified by re-reading the file; if the shell object did not persist the
//! change (seen with some third-party `.url` files), the INI is edited
//! directly instead, preserving its encoding. The elevated helper does that
//! only through a [`TrustedDir`] ([`set_url_icon_in`]), never following a
//! link.

use std::path::Path;

use windows::Win32::System::Com::StructuredStorage::{
    IPropertySetStorage, IPropertyStorage, PID_FIRST_USABLE, PROPSPEC, PROPSPEC_0, PROPVARIANT,
    PRSPEC_PROPID, PropVariantClear,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemAlloc, IPersistFile, STGC_DEFAULT,
    STGM_READWRITE,
};
use windows::Win32::System::Variant::{VT_I4, VT_LPWSTR};
use windows::Win32::UI::Shell::{
    CLSID_InternetShortcut, FMTID_Intshcut, PID_IS_ICONFILE, PID_IS_ICONINDEX,
};
use windows::core::{Interface, PCWSTR, PWSTR};

use super::access::TrustedDir;
use super::util::{
    ComScope, MAX_INI_BYTES, ResultExt, ini_bytes, parse_ini, pcwstr, read_ini, wide,
};
use crate::urlini::UrlFile;
use crate::{Error, Result, paths};

/// The custom icon of a `.url` file as stored (`IconFile`, raw — it may
/// contain `%VARS%` or be relative to the file's folder) and `IconIndex`
/// (0 when absent). `[InternetShortcut.W]` values win; an ANSI file is
/// decoded in the system code page, as Windows wrote it.
pub fn read_url_icon(path: &Path) -> Result<(Option<String>, i32)> {
    let file = read_ini(path)?;
    Ok((file.icon_file().map(str::to_owned), file.icon_index()))
}

/// Sets (`Some((icon_file, index))`) or clears (`None`) a `.url` file's
/// custom icon.
pub fn set_url_icon(path: &Path, icon: Option<(&str, i32)>) -> Result<()> {
    set_icon(path, icon, &AnyFile(path))
}

/// [`set_url_icon`] for the elevated helper: `path` must be a plain file
/// directly in `dir` (the Public Desktop; see [`TrustedDir::check_file`]),
/// checked before the shell object edits it. The direct-file fallback
/// reads and rewrites it only through `dir` ([`TrustedDir::read_file`],
/// [`TrustedDir::replace_file`]), which never follow a link.
pub fn set_url_icon_in(dir: &TrustedDir, path: &Path, icon: Option<(&str, i32)>) -> Result<()> {
    dir.check_file(path)?;
    set_icon(path, icon, &InDir { dir, path })
}

/// How the direct-file fallback reads and rewrites a `.url` file.
trait IniFile {
    fn read(&self) -> Result<UrlFile>;
    /// Replaces the file's content with `bytes` in one step.
    fn replace(&self, bytes: &[u8]) -> Result<()>;
}

/// A `.url` file the user may change: plain file access, and an atomic
/// replace through a sibling file.
struct AnyFile<'a>(&'a Path);

impl IniFile for AnyFile<'_> {
    fn read(&self) -> Result<UrlFile> {
        read_ini(self.0)
    }

    fn replace(&self, bytes: &[u8]) -> Result<()> {
        let mut tmp = self.0.as_os_str().to_owned();
        tmp.push(paths::REWRITE_TEMP_SUFFIX);
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, self.0).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
        Ok(())
    }
}

/// A `.url` file directly in a folder the elevated helper trusts.
struct InDir<'a> {
    dir: &'a TrustedDir,
    path: &'a Path,
}

impl IniFile for InDir<'_> {
    fn read(&self) -> Result<UrlFile> {
        Ok(parse_ini(&self.dir.read_file(self.path, MAX_INI_BYTES)?))
    }

    fn replace(&self, bytes: &[u8]) -> Result<()> {
        self.dir.replace_file(self.path, bytes)
    }
}

/// Writes `icon` with the shell object, verifies it on disk (read as
/// `file` reads), and falls back to rewriting the INI through `file`.
fn set_icon(path: &Path, icon: Option<(&str, i32)>, file: &dyn IniFile) -> Result<()> {
    let com = {
        let _com = ComScope::enter()?;
        write_properties(path, icon)
    };
    if com.is_ok() && file.read()?.has_icon(icon) {
        return Ok(());
    }
    // The shell object failed or silently dropped the change: edit the INI,
    // keeping every other key and the file's encoding.
    let written = file.read().and_then(|mut ini| {
        ini.set_icon(icon.map(|(f, _)| f), icon.map_or(0, |(_, i)| i));
        file.replace(&ini_bytes(&ini))
    });
    match written {
        Ok(()) if file.read()?.has_icon(icon) => Ok(()),
        Ok(()) => Err(Error::Other(format!(
            "{} did not keep the icon change",
            path.display()
        ))),
        // Report the shell's error when it was the more specific one.
        Err(e) => Err(match com {
            Err(com @ Error::AccessDenied(_)) => com,
            _ => e,
        }),
    }
}

fn prop(id: i32) -> PROPSPEC {
    PROPSPEC {
        ulKind: PRSPEC_PROPID,
        Anonymous: PROPSPEC_0 { propid: id as u32 },
    }
}

/// A `VT_LPWSTR` PROPVARIANT owning a `CoTaskMemAlloc` copy of `s`
/// (released by `PropVariantClear`).
fn lpwstr_variant(s: &str) -> Result<PROPVARIANT> {
    let w = wide(s);
    let bytes = w.len() * size_of::<u16>();
    // SAFETY: fresh allocation of `bytes` bytes, filled right away.
    let ptr = unsafe { CoTaskMemAlloc(bytes) } as *mut u16;
    if ptr.is_null() {
        return Err(Error::Other("out of memory".into()));
    }
    // SAFETY: `ptr` has room for `w.len()` u16s.
    unsafe { std::ptr::copy_nonoverlapping(w.as_ptr(), ptr, w.len()) };
    let mut value = PROPVARIANT::default();
    // SAFETY: writing the active union members of a zeroed PROPVARIANT.
    unsafe {
        let inner = &mut value.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = PWSTR(ptr);
    }
    Ok(value)
}

fn i4_variant(v: i32) -> PROPVARIANT {
    let mut value = PROPVARIANT::default();
    // SAFETY: writing the active union members of a zeroed PROPVARIANT.
    unsafe {
        let inner = &mut value.Anonymous.Anonymous;
        inner.vt = VT_I4;
        inner.Anonymous.lVal = v;
    }
    value
}

/// `CLSID_InternetShortcut` → `IPersistFile::Load(STGM_READWRITE)` →
/// `IPropertySetStorage::Open(FMTID_Intshcut)` →
/// `WriteMultiple(PID_IS_ICONFILE, PID_IS_ICONINDEX)` (or `DeleteMultiple`)
/// → `Commit` → `IPersistFile::Save`.
fn write_properties(path: &Path, icon: Option<(&str, i32)>) -> Result<()> {
    // SAFETY (whole block): COM calls with valid arguments; the PROPVARIANTs
    // we allocate are cleared after use.
    unsafe {
        let file: IPersistFile =
            CoCreateInstance(&CLSID_InternetShortcut, None, CLSCTX_INPROC_SERVER)
                .ctx("create an InternetShortcut")?;
        let w = wide(path);
        file.Load(pcwstr(&w), STGM_READWRITE)
            .ctx(format!("open {}", path.display()))?;
        let sets: IPropertySetStorage =
            file.cast().ctx("InternetShortcut → IPropertySetStorage")?;
        let props: IPropertyStorage = sets
            .Open(&FMTID_Intshcut, STGM_READWRITE.0)
            .ctx("open the Internet Shortcut properties")?;
        let specs = [prop(PID_IS_ICONFILE.0), prop(PID_IS_ICONINDEX.0)];
        match icon {
            Some((icon_file, index)) => {
                let mut values = [lpwstr_variant(icon_file)?, i4_variant(index)];
                let written = props.WriteMultiple(
                    specs.len() as u32,
                    specs.as_ptr(),
                    values.as_ptr(),
                    PID_FIRST_USABLE,
                );
                for v in &mut values {
                    let _ = PropVariantClear(v);
                }
                written.ctx("write the icon properties")?;
            }
            None => props
                .DeleteMultiple(&specs)
                .ctx("delete the icon properties")?,
        }
        props
            .Commit(STGC_DEFAULT.0 as u32)
            .ctx("commit the icon properties")?;
        file.Save(PCWSTR::null(), true)
            .ctx(format!("save {}", path.display()))?;
    }
    Ok(())
}

//! `.url` Internet Shortcuts.
//!
//! Reading uses the pure INI parser ([`crate::urlini`]); writing goes
//! through the shell's own `CLSID_InternetShortcut` object and its
//! `FMTID_Intshcut` property set, which also maintains the
//! `[InternetShortcut.W]` section for non-ANSI paths. Every write is
//! verified by re-reading the file; if the shell object did not persist the
//! change (seen with some third-party `.url` files), the INI is edited
//! directly instead, preserving its encoding.

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

use super::util::{ComScope, ResultExt, ini_bytes, pcwstr, read_ini, wide};
use crate::{Error, Result};

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
    let com = {
        let _com = ComScope::enter()?;
        write_properties(path, icon)
    };
    if com.is_ok() && persisted(path, icon)? {
        return Ok(());
    }
    // The shell object failed or silently dropped the change: edit the INI.
    match write_ini(path, icon) {
        Ok(()) if persisted(path, icon)? => Ok(()),
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

/// The file on disk now carries exactly `icon`.
fn persisted(path: &Path, icon: Option<(&str, i32)>) -> Result<bool> {
    let (file, index) = read_url_icon(path)?;
    Ok(match icon {
        Some((f, i)) => file.as_deref() == Some(f) && index == i,
        None => file.is_none(),
    })
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

/// Fallback: rewrites the INI with [`crate::urlini::UrlFile::set_icon`],
/// keeping every other key and the file's encoding (atomic replace via a
/// sibling file).
fn write_ini(path: &Path, icon: Option<(&str, i32)>) -> Result<()> {
    let mut file = read_ini(path)?;
    match icon {
        Some((f, i)) => file.set_icon(Some(f), i),
        None => file.set_icon(None, 0),
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".reskin-tmp");
    std::fs::write(&tmp, ini_bytes(&file))?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

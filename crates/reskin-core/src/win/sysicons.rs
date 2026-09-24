//! System (namespace) icons: This PC, Recycle Bin, User files, Network,
//! Control Panel.
//!
//! Per-user overrides live in
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID\{GUID}\DefaultIcon`
//! (what the Desktop Icon Settings dialog writes); the machine default is
//! `HKCR\CLSID\{GUID}\DefaultIcon`. Values are `path,index` strings.
//!
//! The Recycle Bin has three values: `empty`, `full` and `(Default)`.
//! Explorer shows `(Default)` and copies `empty` / `full` into it whenever
//! the bin changes state, so `(Default)` is derived data. Reskin treats it
//! that way:
//! - setting `empty` / `full` also writes `(Default)` when the bin is
//!   currently in that state (so the change shows immediately);
//! - restoring `empty` / `full` rewrites `(Default)` only if it still holds
//!   the value Reskin put there (i.e. it is our mirror), setting it to the
//!   restored value or deleting it when the original was absent.
//!
//! A `(Default)`-only customisation made by another tool while the bin is
//! in the state being changed is therefore replaced for good; the
//! journal records originals per state value, not `(Default)`.

use std::ffi::{OsStr, OsString};
use std::path::Path;

use windows::Win32::System::Registry::{
    HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ,
    REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::UI::Shell::{SHQUERYRBINFO, SHQueryRecycleBinW};
use windows::core::PCWSTR;

use super::util::{
    RegKey, delete_key_if_empty, expand_env, format_icon_location, parse_icon_location,
    paths_equal_ci,
};
use crate::model::{OriginalIcon, SystemIconId};
use crate::{Error, Result};

const HKCU_CLSID: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID";

fn clsid_key(id: SystemIconId) -> String {
    format!(r"{HKCU_CLSID}\{}", id.clsid())
}

fn default_icon_key(id: SystemIconId) -> String {
    format!(r"{}\DefaultIcon", clsid_key(id))
}

fn is_recycle_bin(id: SystemIconId) -> bool {
    matches!(
        id,
        SystemIconId::RecycleBinEmpty | SystemIconId::RecycleBinFull
    )
}

/// Whether the Recycle Bin (all drives) currently holds items; `None` when
/// that cannot be determined.
fn recycle_bin_is_full() -> Option<bool> {
    let mut info = SHQUERYRBINFO {
        cbSize: size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: NULL root = all drives; `info` is a valid out struct.
    unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) }.ok()?;
    Some(info.i64NumItems > 0)
}

/// The bin is (as far as we can tell) in the state `id` describes.
fn bin_in_state(id: SystemIconId) -> Option<bool> {
    recycle_bin_is_full().map(|full| full == (id == SystemIconId::RecycleBinFull))
}

fn original_from(raw: Option<String>) -> OriginalIcon {
    match raw {
        None => OriginalIcon {
            location: None,
            index: 0,
            existed: false,
        },
        Some(raw) => match parse_icon_location(&raw) {
            Some((location, index)) => OriginalIcon {
                location: Some(location),
                index,
                existed: true,
            },
            None => OriginalIcon {
                location: None,
                index: 0,
                existed: true,
            },
        },
    }
}

/// Registry type for a restored value: Windows stores icon locations that
/// use `%VARS%` as `REG_EXPAND_SZ` and plain paths as `REG_SZ`; restoring
/// by the same rule puts originals back exactly.
fn value_type(value: &str) -> REG_VALUE_TYPE {
    if value.contains('%') {
        REG_EXPAND_SZ
    } else {
        REG_SZ
    }
}

/// The value as the registry would store it for `original`.
fn value_of(original: &OriginalIcon) -> String {
    match &original.location {
        Some(location) => format_icon_location(location, original.index),
        None => String::new(),
    }
}

/// Reads the per-user override (`existed == false` when the value is
/// absent). A value of a non-string type counts as existing without a
/// location.
pub fn read_system_icon(id: SystemIconId) -> Result<OriginalIcon> {
    let Some(key) = RegKey::open(HKEY_CURRENT_USER, &default_icon_key(id), KEY_READ)? else {
        return Ok(original_from(None));
    };
    match key.string(id.value_name()) {
        Ok(raw) => Ok(original_from(raw)),
        Err(Error::Unsupported(_)) => Ok(OriginalIcon {
            location: None,
            index: 0,
            existed: true,
        }),
        Err(e) => Err(e),
    }
}

/// Points the per-user override at `icon_path` (`REG_EXPAND_SZ "path,0"`),
/// mirroring the Recycle Bin's `(Default)` as described in the module docs.
pub fn set_system_icon(id: SystemIconId, icon_path: &Path) -> Result<()> {
    let key = RegKey::create(HKEY_CURRENT_USER, &default_icon_key(id))?;
    let mut value = OsString::from(icon_path.as_os_str());
    value.push(",0");
    key.set_string(id.value_name(), &value, REG_EXPAND_SZ)?;
    if is_recycle_bin(id) && bin_in_state(id) == Some(true) {
        key.set_string("", &value, REG_EXPAND_SZ)?;
    }
    Ok(())
}

/// Writes `original` back (or deletes the value when it did not exist),
/// fixes up the Recycle Bin's `(Default)` mirror and removes the
/// `DefaultIcon` and `{GUID}` keys if they are left empty.
pub fn restore_system_icon(id: SystemIconId, original: &OriginalIcon) -> Result<()> {
    let path = default_icon_key(id);
    let key = match RegKey::open(HKEY_CURRENT_USER, &path, KEY_QUERY_VALUE | KEY_SET_VALUE)? {
        Some(key) => key,
        None if !original.existed => return Ok(()),
        None => RegKey::create(HKEY_CURRENT_USER, &path)?,
    };
    let name = id.value_name();
    let current = key.string(name).ok().flatten();
    if original.existed {
        let value = value_of(original);
        key.set_string(name, &value, value_type(&value))?;
    } else {
        key.delete_value(name)?;
    }
    if is_recycle_bin(id) && current.is_some() && bin_in_state(id) != Some(false) {
        let mirror = key.string("").ok().flatten();
        if mirror.is_some() && mirror == current {
            if original.existed {
                let value = value_of(original);
                key.set_string("", &value, value_type(&value))?;
            } else {
                key.delete_value("")?;
            }
        }
    }
    drop(key);
    if delete_key_if_empty(HKEY_CURRENT_USER, &path)? {
        delete_key_if_empty(HKEY_CURRENT_USER, &clsid_key(id))?;
    }
    Ok(())
}

/// A `path,index` registry value with the path expanded.
fn parse_expanded(raw: String) -> Option<(String, i32)> {
    parse_icon_location(&raw).map(|(p, i)| (expand_env(&p), i))
}

/// The per-user override, expanded (`None` when absent or unusable).
fn user_icon(id: SystemIconId) -> Result<Option<(String, i32)>> {
    Ok(
        RegKey::open(HKEY_CURRENT_USER, &default_icon_key(id), KEY_READ)?
            .and_then(|key| key.string(id.value_name()).ok().flatten())
            .and_then(parse_expanded),
    )
}

/// The machine default (`HKCR\CLSID\{GUID}\DefaultIcon`; the Recycle Bin
/// falls back from `empty` / `full` to `(Default)`), expanded.
fn machine_icon(id: SystemIconId) -> Result<Option<(String, i32)>> {
    let name = id.value_name();
    let machine = format!(r"CLSID\{}\DefaultIcon", id.clsid());
    let Some(key) = RegKey::open(HKEY_CLASSES_ROOT, &machine, KEY_READ)? else {
        return Ok(None);
    };
    let names: &[&str] = if name.is_empty() { &[""] } else { &[name, ""] };
    Ok(names
        .iter()
        .find_map(|n| key.string(n).ok().flatten().and_then(parse_expanded)))
}

/// The icon Explorer uses for `id`: the per-user override, else the
/// machine default (`HKCR\CLSID\{GUID}\DefaultIcon`; the Recycle Bin falls
/// back from `empty` / `full` to `(Default)`). Returns the expanded path
/// and index, `None` when neither is set.
pub fn effective_system_icon(id: SystemIconId) -> Result<Option<(String, i32)>> {
    match user_icon(id)? {
        Some(found) => Ok(Some(found)),
        None => machine_icon(id),
    }
}

/// Whether `id` shows a customised icon: a per-user override exists and
/// points somewhere other than the machine default. Windows itself may
/// write the default icons into the per-user key (the Recycle Bin's
/// `empty` / `full`, "Restore Default" in Desktop Icon Settings); that is
/// not a customisation.
pub fn is_customized(id: SystemIconId) -> bool {
    let Ok(Some((path, index))) = user_icon(id) else {
        return false;
    };
    match machine_icon(id) {
        Ok(Some((default, default_index))) => {
            index != default_index || !paths_equal_ci(OsStr::new(&path), OsStr::new(&default))
        }
        _ => true,
    }
}

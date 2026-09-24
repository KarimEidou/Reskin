//! Installed font families (DirectWrite), for the text tool.

use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection,
    IDWriteLocalizedStrings,
};
use windows::core::{BOOL, w};

use super::util::{ResultExt, from_wide};
use crate::{Error, Result};

/// Family names of the system font collection (English name when the font
/// has one, else its first name), sorted case-insensitively, without
/// duplicates and without vertical (`@`) families. Empty if DirectWrite is
/// unavailable.
pub fn system_fonts() -> Vec<String> {
    list_families().unwrap_or_default()
}

fn list_families() -> Result<Vec<String>> {
    // SAFETY (whole block): DirectWrite calls with valid out parameters.
    let mut names = unsafe {
        let factory: IDWriteFactory =
            DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).ctx("create a DirectWrite factory")?;
        let mut collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut collection, false)
            .ctx("get the system font collection")?;
        let collection =
            collection.ok_or_else(|| Error::Other("no system font collection".into()))?;
        let count = collection.GetFontFamilyCount();
        let mut names = Vec::with_capacity(count as usize);
        for i in 0..count {
            let Ok(family) = collection.GetFontFamily(i) else {
                continue;
            };
            let Ok(strings) = family.GetFamilyNames() else {
                continue;
            };
            if let Some(name) = preferred_name(&strings)
                && !name.is_empty()
                && !name.starts_with('@')
            {
                names.push(name);
            }
        }
        names
    };
    names.sort_by_cached_key(|n| (n.to_lowercase(), n.clone()));
    names.dedup_by(|a, b| a.to_lowercase() == b.to_lowercase());
    Ok(names)
}

/// The `en-us` name, else the first one.
///
/// # Safety
/// `strings` must be a live DirectWrite object (always true for a Rust
/// interface reference).
unsafe fn preferred_name(strings: &IDWriteLocalizedStrings) -> Option<String> {
    let mut index = 0u32;
    let mut exists = BOOL(0);
    // SAFETY: valid out pointers.
    let found = unsafe { strings.FindLocaleName(w!("en-us"), &mut index, &mut exists) };
    if found.is_err() || !exists.as_bool() {
        index = 0;
    }
    // SAFETY: `index` is within the list (0 always is for a family).
    let len = unsafe { strings.GetStringLength(index) }.ok()?;
    let mut buf = vec![0u16; len as usize + 1];
    // SAFETY: `buf` has room for the string and its terminator.
    unsafe { strings.GetString(index, &mut buf) }.ok()?;
    Some(from_wide(&buf))
}

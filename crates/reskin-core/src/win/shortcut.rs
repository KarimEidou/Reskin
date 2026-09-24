//! `.lnk` shortcuts through `CLSID_ShellLink` (`IShellLinkW` +
//! `IPersistFile`, `IPropertyStore` for the AppUserModelID).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PropVariantClear, PropVariantToStringAlloc,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile, STGM, STGM_READ, STGM_READWRITE,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    EXP_SZ_ICON_SIG, FOLDERID_AppsFolder, ILIsParent, IShellItem, IShellLinkDataList, IShellLinkW,
    SHCreateItemFromIDList, SHGetKnownFolderIDList, SIGDN_DESKTOPABSOLUTEPARSING,
    SLDF_HAS_EXP_ICON_SZ, SLDF_HAS_ICONLOCATION, SLGP_RAWPATH, ShellLink,
};
use windows::core::{Interface, PCWSTR, w};

use super::util::{
    ComScope, Pidl, ResultExt, expand_env, from_wide, paths_equal_ci, pcwstr, resolve_icon_path,
    take_co_string, wide,
};
use crate::{Error, Result};

/// Everything Reskin needs to know about a `.lnk`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LinkInfo {
    /// Target path as stored (`SLGP_RAWPATH`; may contain `%VARS%`).
    pub target_raw: Option<String>,
    /// Target path with environment variables expanded. `None` for links
    /// to non-file-system objects (Store apps, Control Panel items, …).
    pub target: Option<PathBuf>,
    /// Command-line arguments ("" when none).
    pub arguments: String,
    /// Working directory as stored (may contain `%VARS%`).
    pub working_dir: Option<String>,
    /// The link carries an item ID list.
    pub has_idlist: bool,
    /// Custom icon location as stored (unexpanded, possibly relative to the
    /// link's folder). `None` = the shell uses the target's icon.
    pub icon_location: Option<String>,
    pub icon_index: i32,
    /// `System.AppUserModel.ID` of the link.
    pub app_user_model_id: Option<String>,
    /// A Store / packaged app (AppsFolder) shortcut: Explorer ignores
    /// `IconLocation` for these.
    pub store_app: bool,
}

impl LinkInfo {
    /// The custom icon as an absolute path (variables expanded, relative
    /// locations resolved against the link's folder) plus its index.
    pub fn icon_path(&self, link_path: &Path) -> Option<(PathBuf, i32)> {
        let raw = self.icon_location.as_deref()?;
        Some((resolve_icon_path(raw, link_path.parent()), self.icon_index))
    }
}

/// Large enough for any path the shell link stores (it caps at
/// INFOTIPSIZE / MAX_PATH-sized fields, arguments included).
const BUF_LEN: usize = 32 * 1024;

fn new_link() -> Result<IShellLinkW> {
    // SAFETY: plain in-process COM activation.
    unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.ctx("create a ShellLink")
}

fn load(link: &IShellLinkW, path: &Path, mode: STGM) -> Result<IPersistFile> {
    let file: IPersistFile = link.cast().ctx("IShellLink → IPersistFile")?;
    let w = wide(path);
    // SAFETY: valid NUL-terminated path.
    unsafe { file.Load(pcwstr(&w), mode) }.ctx(format!("open shortcut {}", path.display()))?;
    Ok(file)
}

/// Reads a string field through one of IShellLinkW's `(buffer, len)` getters.
fn read_field(get: impl FnOnce(&mut [u16]) -> windows_core::Result<()>) -> Option<String> {
    let mut buf = vec![0u16; BUF_LEN];
    get(&mut buf).ok()?;
    let s = from_wide(&buf);
    (!s.is_empty()).then_some(s)
}

/// Reads a shortcut: target (raw and expanded), arguments, working
/// directory, custom icon, AppUserModelID and whether it is a Store app.
pub fn read_link(path: &Path) -> Result<LinkInfo> {
    let _com = ComScope::enter()?;
    let link = new_link()?;
    load(&link, path, STGM_READ)?;
    // SAFETY (whole block): IShellLinkW getters with valid buffers; the
    // WIN32_FIND_DATAW pointer is optional.
    unsafe {
        let target_raw =
            read_field(|b| link.GetPath(b, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32));
        let target = read_field(|b| link.GetPath(b, std::ptr::null_mut(), 0))
            .or_else(|| target_raw.clone())
            .map(|t| PathBuf::from(expand_env(&t)));
        let arguments = read_field(|b| link.GetArguments(b)).unwrap_or_default();
        let working_dir = read_field(|b| link.GetWorkingDirectory(b));
        let mut icon_index = 0i32;
        let icon_location = read_field(|b| link.GetIconLocation(b, &mut icon_index));
        let pidl = link.GetIDList().map(Pidl).ok().filter(|p| !p.is_null());
        let app_user_model_id = app_user_model_id(&link);
        let in_apps_folder = pidl.as_ref().is_some_and(is_in_apps_folder);
        let store_app = in_apps_folder || (app_user_model_id.is_some() && target.is_none());
        Ok(LinkInfo {
            target_raw,
            target,
            arguments,
            working_dir,
            has_idlist: pidl.is_some(),
            // Without a location the stored index is meaningless.
            icon_index: if icon_location.is_some() {
                icon_index
            } else {
                0
            },
            icon_location,
            app_user_model_id,
            store_app,
        })
    }
}

/// `System.AppUserModel.ID` from the link's property store, if any.
fn app_user_model_id(link: &IShellLinkW) -> Option<String> {
    let store: IPropertyStore = link.cast().ok()?;
    // SAFETY: GetValue returns an owned PROPVARIANT that we clear; the
    // string from PropVariantToStringAlloc is freed by take_co_string.
    unsafe {
        let mut value: PROPVARIANT = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
        let text = PropVariantToStringAlloc(&value).map(|p| take_co_string(p));
        let _ = PropVariantClear(&mut value);
        let text = text.ok()?.to_string_lossy().into_owned();
        (!text.is_empty()).then_some(text)
    }
}

/// Parsing-name prefix of items in `shell:AppsFolder`.
const APPS_FOLDER_PARSING: &str = "::{4234D49B-0245-4DF3-B780-3893943456E1}";

/// The link's ID list points into `shell:AppsFolder` (a packaged app).
fn is_in_apps_folder(pidl: &Pidl) -> bool {
    // SAFETY: `pidl` is a valid absolute ID list owned by the caller.
    unsafe {
        if let Ok(apps) = SHGetKnownFolderIDList(&FOLDERID_AppsFolder, 0, None).map(Pidl)
            && !apps.is_null()
            && ILIsParent(apps.0, pidl.0, false).as_bool()
        {
            return true;
        }
        let Ok(item) = SHCreateItemFromIDList::<IShellItem>(pidl.0) else {
            return false;
        };
        let Ok(name) = item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) else {
            return false;
        };
        let name = take_co_string(name);
        name.to_string_lossy()
            .get(..APPS_FOLDER_PARSING.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(APPS_FOLDER_PARSING))
    }
}

/// Drops `flags` from the link's data flags (if any are set).
///
/// # Safety
/// `data` must be the link's live `IShellLinkDataList`.
unsafe fn clear_link_flags(data: &IShellLinkDataList, flags: u32) -> Result<()> {
    // SAFETY: plain getters/setters on a live object.
    let current = unsafe { data.GetFlags() }.ctx("read the shortcut flags")?;
    if current & flags != 0 {
        unsafe { data.SetFlags(current & !flags) }.ctx("update the shortcut flags")?;
    }
    Ok(())
}

/// Sets (`Some((location, index))`) or clears (`None`) a shortcut's custom
/// icon: `Load(STGM_READWRITE)` → `SetIconLocation` → `Save`.
///
/// A `%VAR%` icon path is stored in an `EXP_SZ_ICON` data block that takes
/// precedence over the plain string when the link is loaded, so an existing
/// block is removed first; clearing also drops `SLDF_HAS_ICONLOCATION`, so
/// the shell falls back to the target's icon. The change is verified by
/// reading the file back.
pub fn set_link_icon(path: &Path, icon: Option<(&str, i32)>) -> Result<()> {
    let _com = ComScope::enter()?;
    let link = new_link()?;
    let file = load(&link, path, STGM_READWRITE)?;
    let has_exp_icon = SLDF_HAS_EXP_ICON_SZ.0 as u32;
    // SAFETY: COM calls on live objects; string buffers outlive the calls.
    unsafe {
        let data: IShellLinkDataList = link.cast().ctx("IShellLink → IShellLinkDataList")?;
        if data.GetFlags().is_ok_and(|f| f & has_exp_icon != 0) {
            // Absent block: nothing to remove.
            let _ = data.RemoveDataBlock(EXP_SZ_ICON_SIG);
            clear_link_flags(&data, has_exp_icon)?;
        }
        match icon {
            Some((location, index)) => {
                let w = wide(location);
                link.SetIconLocation(pcwstr(&w), index)
                    .ctx("set the shortcut icon")?;
            }
            None => {
                link.SetIconLocation(w!(""), 0)
                    .ctx("clear the shortcut icon")?;
                clear_link_flags(&data, has_exp_icon | SLDF_HAS_ICONLOCATION.0 as u32)?;
            }
        }
        file.Save(PCWSTR::null(), true)
            .ctx(format!("save shortcut {}", path.display()))?;
    }
    drop(file);
    drop(link);

    let after = read_link(path)?;
    let ok = match icon {
        Some((location, index)) => {
            after.icon_index == index
                && after.icon_location.as_deref().is_some_and(|got| {
                    paths_equal_ci(
                        OsString::from(expand_env(got)).as_os_str(),
                        OsString::from(expand_env(location)).as_os_str(),
                    )
                })
        }
        None => after.icon_location.is_none(),
    };
    if ok {
        Ok(())
    } else {
        Err(Error::Other(format!(
            "the shortcut {} did not keep the icon change (reads back {:?},{})",
            path.display(),
            after.icon_location,
            after.icon_index
        )))
    }
}

/// Creates (or overwrites) the shortcut `dest` pointing at `target`, with
/// optional arguments, custom icon and description. The working directory
/// is the target's folder, as Explorer does.
pub fn create_link(
    dest: &Path,
    target: &Path,
    args: &str,
    icon: Option<(&Path, i32)>,
    description: &str,
) -> Result<()> {
    let _com = ComScope::enter()?;
    let link = new_link()?;
    // SAFETY: every string buffer outlives the call that uses it.
    unsafe {
        let t = wide(target);
        link.SetPath(pcwstr(&t)).ctx("set the shortcut target")?;
        if !args.is_empty() {
            let a = wide(args);
            link.SetArguments(pcwstr(&a))
                .ctx("set the shortcut arguments")?;
        }
        if let Some(dir) = target.parent().filter(|_| !target.is_dir())
            && !dir.as_os_str().is_empty()
        {
            let d = wide(dir);
            link.SetWorkingDirectory(pcwstr(&d))
                .ctx("set the shortcut working directory")?;
        }
        if let Some((icon_path, index)) = icon {
            let i = wide(icon_path);
            link.SetIconLocation(pcwstr(&i), index)
                .ctx("set the shortcut icon")?;
        }
        if !description.is_empty() {
            let d = wide(description);
            link.SetDescription(pcwstr(&d))
                .ctx("set the shortcut description")?;
        }
        let file: IPersistFile = link.cast().ctx("IShellLink → IPersistFile")?;
        let w = wide(dest);
        file.Save(pcwstr(&w), true)
            .ctx(format!("save shortcut {}", dest.display()))?;
    }
    Ok(())
}

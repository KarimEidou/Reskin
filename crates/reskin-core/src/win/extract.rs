//! What a dropped item is, and its current icon (the extraction ladder).
//!
//! The ladder, tried in order until one yields frames:
//! 1. an explicit icon location (`.lnk` IconLocation, `.url` IconFile,
//!    `desktop.ini`, the system-icon registry value) or the item/target
//!    itself:
//!    - `.ico` files of at most `ico::MAX_READ_ICO_BYTES` → every frame
//!      (`ico::parse_ico`; WIC as fallback);
//!    - PE files (exe, dll, icl, mun, cpl, …) → the `RT_GROUP_ICON` group,
//!      rebuilt byte-exactly into an `.ico` (within the same limit) by
//!      [`crate::grpicon`] from a module mapped with
//!      `LoadLibraryExW(LOAD_LIBRARY_AS_DATAFILE |
//!      LOAD_LIBRARY_AS_IMAGE_RESOURCE)`; index ≥ 0 is the n-th group in
//!      `EnumResourceNamesW` order, index < 0 the resource id `-index`
//!      (`ExtractIcon` semantics). Windows 10+ keeps many system icons in
//!      `%SystemRoot%\SystemResources\<name>.mun`, which is tried too;
//!    - images → decoded with WIC;
//! 2. the shell: `IShellItemImageFactory::GetImage(256, ICONONLY |
//!    BIGGERSIZEOK)` → `GetDIBits` → straight RGBA → corner-icon
//!    normalisation. Whatever Explorer can draw, this returns.
//!
//! All functions use COM; the app calls them on the STA.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{GENERIC_READ, HMODULE, SIZE};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppPBGRA, GUID_WICPixelFormat32bppRGBA,
    IWICBitmapDecoder, IWICBitmapFrameDecode, IWICBitmapSource, IWICImagingFactory,
    WICBitmapDitherTypeNone, WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom,
    WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PropVariantClear, PropVariantToUInt16,
};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::LibraryLoader::{
    EnumResourceNamesW, FindResourceW, LOAD_LIBRARY_AS_DATAFILE, LOAD_LIBRARY_AS_IMAGE_RESOURCE,
    LoadLibraryExW, LoadResource, LockResource, SizeofResource,
};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_BIGGERSIZEOK,
    SIIGBF_ICONONLY,
};
use windows::Win32::UI::WindowsAndMessaging::{RT_GROUP_ICON, RT_ICON};
use windows::core::{BOOL, Interface, Owned, PCWSTR, w};

use super::access::{location_of, probe_writable};
use super::folder::read_folder_icon;
use super::known;
use super::shortcut::{LinkInfo, read_link};
use super::sysicons::{effective_system_icon, is_customized};
use super::util::{
    ComScope, ResultExt, hbitmap_to_rgba, pcwstr, read_ini, resolve_icon_path, wide,
};
use crate::model::{Access, IconFrame, IconSource, ItemKind, ItemLocation, SystemIconId};
use crate::pixels::{Rgba, b64_encode, normalize_corner_icon, png_data_url};
use crate::{Error, Result, grpicon, ico};

/// Largest preview [`Inspected::icon`] carries.
const PREVIEW_MAX: u32 = 256;
/// Image files are scaled to fit this for editing ([`icon_frames`]).
const EDIT_MAX: u32 = 1024;
/// Sizes asked from the shell when every frame is wanted; the first
/// request may return a bigger image (BIGGERSIZEOK).
const SHELL_SIZES_ALL: [u32; 4] = [256, 48, 32, 16];
const SHELL_SIZES_PREVIEW: [u32; 1] = [256];
/// Frames read from one multi-frame image at most.
const MAX_WIC_FRAMES: u32 = 64;

const IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff",
];

/// A dropped item, classified, with its current icon.
#[derive(Debug, Clone)]
pub struct Inspected {
    pub kind: ItemKind,
    /// File stem (folder name for folders, label for system icons).
    pub name: String,
    /// The item's path (`::{CLSID}` for system icons).
    pub path: PathBuf,
    /// Shortcut target / URL / AppUserModelID, for display.
    pub target: Option<String>,
    pub location: ItemLocation,
    pub access: Access,
    /// Best preview of the current icon (≤256 px, straight alpha); the
    /// image itself (scaled to fit 256) for image files.
    pub icon: Option<Rgba>,
    pub icon_source: IconSource,
    /// The item has an explicit icon location (IconLocation, IconFile,
    /// desktop.ini icon, a per-user system-icon override that differs from
    /// the Windows default).
    pub custom_icon: bool,
    /// Store (AppsFolder) shortcut: Explorer ignores its IconLocation.
    pub store_app: bool,
    /// Shortcut details for `.lnk` items.
    pub link: Option<LinkInfo>,
}

impl Inspected {
    /// The preview as a `data:image/png;base64,` URL (`ItemInfo::icon`).
    pub fn icon_data_url(&self) -> Option<String> {
        self.icon.as_ref().map(|i| png_data_url(&i.encode_png()))
    }
}

/// Frames as IPC [`IconFrame`]s (base64 PNG, straight alpha), in order.
pub fn to_icon_frames(frames: &[Rgba]) -> Vec<IconFrame> {
    frames
        .iter()
        .map(|f| IconFrame {
            width: f.w,
            height: f.h,
            png: b64_encode(&f.encode_png()),
        })
        .collect()
}

/// Where an item's icon comes from before the shell fallback.
#[derive(Debug, Clone)]
enum IconRef {
    /// An icon file / PE resource at `index` (`ExtractIcon` semantics).
    Location { file: PathBuf, index: i32 },
    /// The item is an image.
    Image(PathBuf),
}

struct Plan {
    primary: Option<IconRef>,
    /// Parsing names for the shell fallback, tried in order.
    shell: Vec<OsString>,
    custom: bool,
    target: Option<String>,
    link: Option<LinkInfo>,
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

fn is_image_extension(ext: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&ext)
}

/// Classifies a path by type and extension (case-insensitive).
pub fn classify(path: &Path) -> ItemKind {
    if path.is_dir() {
        return ItemKind::Folder;
    }
    match extension(path).as_deref() {
        Some("lnk") => ItemKind::Shortcut,
        Some("url") => ItemKind::InternetShortcut,
        Some("exe") => ItemKind::Executable,
        Some("reskin") => ItemKind::Project,
        Some(e) if is_image_extension(e) => ItemKind::Image,
        _ => ItemKind::File,
    }
}

fn display_name(path: &Path, kind: ItemKind) -> String {
    let name = if kind == ItemKind::Folder {
        path.file_name()
    } else {
        path.file_stem()
    };
    name.map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

/// Icon of a shortcut target without IconLocation: exe/dll → first group,
/// .ico → its frames; anything else is left to the shell.
fn target_icon(target: &Path) -> Option<IconRef> {
    if !target.is_file() {
        return None;
    }
    match extension(target).as_deref() {
        Some("exe" | "dll" | "ico") => Some(IconRef::Location {
            file: target.to_path_buf(),
            index: 0,
        }),
        _ => None,
    }
}

fn plan_for(path: &Path, kind: ItemKind) -> Plan {
    let mut plan = Plan {
        primary: None,
        shell: vec![path.as_os_str().to_owned()],
        custom: false,
        target: None,
        link: None,
    };
    match kind {
        ItemKind::Shortcut => {
            if let Ok(link) = read_link(path) {
                plan.custom = link.icon_location.is_some();
                plan.primary = if link.store_app {
                    None
                } else if let Some((file, index)) = link.icon_path(path) {
                    Some(IconRef::Location { file, index })
                } else {
                    link.target.as_deref().and_then(target_icon)
                };
                plan.target = link
                    .target
                    .as_ref()
                    .map(|t| t.display().to_string())
                    .or_else(|| link.app_user_model_id.clone())
                    .or_else(|| link.target_raw.clone());
                plan.link = Some(link);
            }
        }
        ItemKind::InternetShortcut => {
            if let Ok(url) = read_ini(path) {
                if let Some(file) = url.icon_file() {
                    plan.custom = true;
                    plan.primary = Some(IconRef::Location {
                        file: resolve_icon_path(file, path.parent()),
                        index: url.icon_index(),
                    });
                }
                plan.target = url.url().map(str::to_owned);
            }
        }
        ItemKind::Folder => {
            if let Ok(Some((file, index))) = read_folder_icon(path) {
                plan.custom = true;
                plan.primary = Some(IconRef::Location {
                    file: resolve_icon_path(&file, Some(path)),
                    index,
                });
            }
        }
        ItemKind::Executable => {
            plan.primary = Some(IconRef::Location {
                file: path.to_path_buf(),
                index: 0,
            });
        }
        ItemKind::Image => plan.primary = Some(IconRef::Image(path.to_path_buf())),
        ItemKind::Project | ItemKind::File | ItemKind::SystemIcon => {}
    }
    plan
}

fn system_plan(id: SystemIconId) -> Plan {
    let parsing = format!("::{}", id.clsid());
    let mut shell = vec![OsString::from(&parsing)];
    match id {
        SystemIconId::UserFiles => shell.extend(std::env::var_os("USERPROFILE")),
        // Legacy "My Network Places".
        SystemIconId::Network => shell.push("::{208D2C60-3AEA-1069-A2D7-08002B30309D}".into()),
        // Category view, then "All Control Panel Items".
        SystemIconId::ControlPanel => shell.extend([
            OsString::from("::{26EE0668-A00A-44D7-9371-BEB064C98683}"),
            OsString::from("::{21EC2020-3AEA-1069-A2DD-08002B30309D}"),
        ]),
        _ => {}
    }
    Plan {
        primary: effective_system_icon(id)
            .ok()
            .flatten()
            .map(|(file, index)| IconRef::Location {
                file: PathBuf::from(file),
                index,
            }),
        shell,
        custom: is_customized(id),
        target: None,
        link: None,
    }
}

/// Classifies `path` and reads its current icon preview, target, location,
/// access and shortcut details. Fails only if the path does not exist.
pub fn inspect_path(path: &Path) -> Result<Inspected> {
    if !path.exists() {
        return Err(Error::NotFound(path.display().to_string()));
    }
    let _com = ComScope::enter()?;
    let kind = classify(path);
    let plan = plan_for(path, kind);
    let (frames, icon_source) = load_icon(&plan, PREVIEW_MAX, &SHELL_SIZES_PREVIEW);
    Ok(Inspected {
        kind,
        name: display_name(path, kind),
        path: path.to_path_buf(),
        target: plan.target,
        location: location_of(path),
        access: probe_writable(path),
        icon: preview(&frames),
        icon_source,
        custom_icon: plan.custom,
        store_app: plan.link.as_ref().is_some_and(|l| l.store_app),
        link: plan.link,
    })
}

/// Every frame of the item's current icon, largest first, one per size
/// (the highest colour depth). Image files yield the image itself scaled
/// to fit 1024 px (`.ico` files: all their frames).
pub fn icon_frames(path: &Path) -> Result<Vec<Rgba>> {
    if !path.exists() {
        return Err(Error::NotFound(path.display().to_string()));
    }
    let _com = ComScope::enter()?;
    let plan = plan_for(path, classify(path));
    let (frames, _) = load_icon(&plan, EDIT_MAX, &SHELL_SIZES_ALL);
    if frames.is_empty() {
        return Err(Error::NotFound(format!(
            "no icon could be read for {}",
            path.display()
        )));
    }
    Ok(frames)
}

/// A system icon as an item: its effective icon (per-user override, else
/// the machine default, else the shell's rendering).
pub fn inspect_system_icon(id: SystemIconId) -> Result<Inspected> {
    let _com = ComScope::enter()?;
    let plan = system_plan(id);
    let (frames, icon_source) = load_icon(&plan, PREVIEW_MAX, &SHELL_SIZES_PREVIEW);
    Ok(Inspected {
        kind: ItemKind::SystemIcon,
        name: id.label().to_owned(),
        path: PathBuf::from(format!("::{}", id.clsid())),
        target: None,
        location: ItemLocation::System,
        // Per-user overrides live in HKCU.
        access: Access::Writable,
        icon: preview(&frames),
        icon_source,
        custom_icon: plan.custom,
        store_app: false,
        link: None,
    })
}

/// Every frame of a system icon's effective icon, largest first.
pub fn system_icon_frames(id: SystemIconId) -> Result<Vec<Rgba>> {
    let _com = ComScope::enter()?;
    let (frames, _) = load_icon(&system_plan(id), EDIT_MAX, &SHELL_SIZES_ALL);
    if frames.is_empty() {
        return Err(Error::NotFound(format!("no icon for {}", id.label())));
    }
    Ok(frames)
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

fn load_icon(plan: &Plan, fit: u32, shell_sizes: &[u32]) -> (Vec<Rgba>, IconSource) {
    if let Some(source) = &plan.primary
        && let Ok((frames, kind)) = load_ref(source, fit)
    {
        let frames = tidy(frames);
        if !frames.is_empty() {
            return (frames, kind);
        }
    }
    for name in &plan.shell {
        if let Ok(frames) = shell_frames(name, shell_sizes) {
            let frames = tidy(frames);
            if !frames.is_empty() {
                return (frames, IconSource::Shell);
            }
        }
    }
    (Vec::new(), IconSource::None)
}

fn load_ref(source: &IconRef, fit: u32) -> Result<(Vec<Rgba>, IconSource)> {
    match source {
        IconRef::Location { file, index } => location_frames(file, *index),
        IconRef::Image(path) if extension(path).as_deref() == Some("ico") => {
            Ok((ico_file_frames(path)?, IconSource::IcoFile))
        }
        IconRef::Image(path) => Ok((vec![wic_image(path, fit)?], IconSource::Image)),
    }
}

fn location_frames(file: &Path, index: i32) -> Result<(Vec<Rgba>, IconSource)> {
    match extension(file).as_deref() {
        Some("ico") => Ok((ico_file_frames(file)?, IconSource::IcoFile)),
        Some(e) if is_image_extension(e) => {
            Ok((vec![wic_image(file, PREVIEW_MAX)?], IconSource::Image))
        }
        _ => Ok((pe_frames(file, index)?, IconSource::Resource)),
    }
}

/// Largest first (stable), one frame per size, blank frames dropped.
fn tidy(mut frames: Vec<Rgba>) -> Vec<Rgba> {
    frames.retain(|f| f.w > 0 && f.h > 0 && !f.is_blank());
    frames.sort_by_key(|f| std::cmp::Reverse(u64::from(f.w) * u64::from(f.h)));
    let mut seen = Vec::new();
    frames.retain(|f| {
        let fresh = !seen.contains(&(f.w, f.h));
        seen.push((f.w, f.h));
        fresh
    });
    frames
}

fn fit_within(w: u32, h: u32, max: u32) -> (u32, u32) {
    if w.max(h) <= max {
        return (w, h);
    }
    let scale = f64::from(max) / f64::from(w.max(h));
    let dim = |v: u32| ((f64::from(v) * scale).round() as u32).clamp(1, max);
    (dim(w), dim(h))
}

/// The best frame ≤256 px, else the largest scaled down to fit 256.
fn preview(frames: &[Rgba]) -> Option<Rgba> {
    frames
        .iter()
        .filter(|f| f.w.max(f.h) <= PREVIEW_MAX)
        .max_by_key(|f| f.w.max(f.h))
        .cloned()
        .or_else(|| {
            frames.iter().max_by_key(|f| f.w.max(f.h)).map(|f| {
                let (w, h) = fit_within(f.w, f.h, PREVIEW_MAX);
                f.resize(w, h)
            })
        })
}

// --- (a) .ico files ---------------------------------------------------------

/// Every frame of an `.ico` file. A file over [`ico::MAX_READ_ICO_BYTES`]
/// is an error (the ladder moves on to the shell), not read.
fn ico_file_frames(path: &Path) -> Result<Vec<Rgba>> {
    let bytes = ico::read_ico_file(path)?;
    match ico::parse_ico(&bytes) {
        Ok(frames) => Ok(frames.into_iter().map(|f| f.image).collect()),
        // Some icons use encodings the `ico` crate rejects; WIC reads them.
        Err(_) => wic_all_frames(path, PREVIEW_MAX),
    }
}

// --- (b) PE resources -------------------------------------------------------

/// A resource name: an integer id or a (NUL-terminated) string.
enum ResName {
    Id(u16),
    Name(Vec<u16>),
}

impl ResName {
    /// # Safety
    /// `p` must be an integer resource or a valid NUL-terminated string.
    unsafe fn from_raw(p: PCWSTR) -> Self {
        if (p.0 as usize) >> 16 == 0 {
            ResName::Id(p.0 as usize as u16)
        } else {
            // SAFETY: a string resource name per the contract.
            let mut name = unsafe { p.as_wide() }.to_vec();
            name.push(0);
            ResName::Name(name)
        }
    }

    fn as_pcwstr(&self) -> PCWSTR {
        match self {
            // MAKEINTRESOURCEW
            ResName::Id(id) => PCWSTR(usize::from(*id) as *const u16),
            ResName::Name(name) => PCWSTR(name.as_ptr()),
        }
    }
}

unsafe extern "system" fn collect_name(
    _module: HMODULE,
    _kind: PCWSTR,
    name: PCWSTR,
    param: isize,
) -> BOOL {
    // SAFETY: `param` is the `&mut Vec<ResName>` passed by `group_names`,
    // which outlives the enumeration; `name` is valid during the callback.
    unsafe {
        let names = &mut *(param as *mut Vec<ResName>);
        names.push(ResName::from_raw(name));
    }
    BOOL(1)
}

/// `RT_GROUP_ICON` names in `EnumResourceNamesW` order (named resources
/// first, then ids ascending — the order `ExtractIcon` indexes).
fn group_names(module: HMODULE) -> Vec<ResName> {
    let mut names: Vec<ResName> = Vec::new();
    // SAFETY: the callback only touches `names`, which outlives the call.
    let _ = unsafe {
        EnumResourceNamesW(
            Some(module),
            RT_GROUP_ICON,
            Some(collect_name),
            &mut names as *mut Vec<ResName> as isize,
        )
    };
    names
}

/// The data of a resource of the loaded `module`, borrowed from its image:
/// nothing is copied here, whatever size the resource claims
/// ([`grpicon::rebuild_ico`] bounds what it copies).
fn resource_data<'m>(module: &'m Owned<HMODULE>, name: &ResName, kind: PCWSTR) -> Result<&'m [u8]> {
    // SAFETY: `module` is a loaded image; the resource data stays mapped
    // while it is loaded, which the returned borrow of `module` ensures.
    unsafe {
        let info = FindResourceW(Some(**module), name.as_pcwstr(), kind);
        if info.is_invalid() {
            return Err(Error::NotFound("icon resource".into()));
        }
        let size = SizeofResource(Some(**module), info) as usize;
        let data = LoadResource(Some(**module), info).ctx("load an icon resource")?;
        let ptr = LockResource(data) as *const u8;
        if ptr.is_null() || size == 0 {
            return Err(Error::NotFound("empty icon resource".into()));
        }
        Ok(std::slice::from_raw_parts(ptr, size))
    }
}

/// The icon group `index` of a PE file rebuilt into `.ico` bytes (within
/// the limits of [`grpicon::rebuild_ico`]).
fn pe_group_ico(file: &Path, index: i32) -> Result<Vec<u8>> {
    let w = wide(file);
    // SAFETY: data-file mapping only; nothing in the module runs.
    let module = unsafe {
        LoadLibraryExW(
            pcwstr(&w),
            None,
            LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE,
        )
    }
    .ctx(format!("load {}", file.display()))?;
    // SAFETY: we own the module handle; FreeLibrary on drop.
    let module = unsafe { Owned::new(module) };
    let group = if index >= 0 {
        group_names(*module)
            .into_iter()
            .nth(index as usize)
            .ok_or_else(|| Error::NotFound(format!("{} has no icon #{index}", file.display())))?
    } else {
        let id = u16::try_from(index.unsigned_abs())
            .map_err(|_| Error::NotFound(format!("icon id {index} is out of range")))?;
        ResName::Id(id)
    };
    let directory = resource_data(&module, &group, RT_GROUP_ICON)?;
    grpicon::rebuild_ico(directory, |id| {
        resource_data(&module, &ResName::Id(id), RT_ICON).ok()
    })
}

/// `%SystemRoot%\SystemResources\<name>.mun`, where Windows 10 1903+ keeps
/// the icons of many system DLLs.
fn mun_for(file: &Path) -> Option<PathBuf> {
    if extension(file).as_deref() == Some("mun") {
        return None;
    }
    let mut name = file.file_name()?.to_owned();
    name.push(".mun");
    let mun = known::windows_dir()
        .ok()?
        .join("SystemResources")
        .join(name);
    mun.is_file().then_some(mun)
}

fn pe_frames(file: &Path, index: i32) -> Result<Vec<Rgba>> {
    let decode = |ico: Vec<u8>| -> Result<Vec<Rgba>> {
        Ok(ico::parse_ico(&ico)?.into_iter().map(|f| f.image).collect())
    };
    match pe_group_ico(file, index).and_then(decode) {
        Ok(frames) => Ok(frames),
        Err(e) => match mun_for(file) {
            Some(mun) => pe_group_ico(&mun, index).and_then(decode).map_err(|_| e),
            None => Err(e),
        },
    }
}

// --- images (WIC) -----------------------------------------------------------

fn wic_factory() -> Result<IWICImagingFactory> {
    // SAFETY: plain in-process COM activation.
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
        .ctx("create the WIC imaging factory")
}

fn wic_decoder(factory: &IWICImagingFactory, path: &Path) -> Result<IWICBitmapDecoder> {
    let w = wide(path);
    // SAFETY: valid NUL-terminated path.
    unsafe {
        factory.CreateDecoderFromFilename(
            pcwstr(&w),
            None,
            GENERIC_READ,
            WICDecodeMetadataCacheOnDemand,
        )
    }
    .ctx(format!("decode {}", path.display()))
}

/// One frame as straight RGBA, scaled (in premultiplied space) to fit `fit`.
fn wic_frame(
    factory: &IWICImagingFactory,
    frame: &IWICBitmapFrameDecode,
    fit: u32,
) -> Result<Rgba> {
    // SAFETY (whole block): WIC calls with valid arguments and a buffer of
    // exactly stride × height bytes.
    unsafe {
        let mut source: IWICBitmapSource = frame.cast().ctx("WIC frame → bitmap source")?;
        let (mut w, mut h) = (0u32, 0u32);
        source.GetSize(&mut w, &mut h).ctx("read the image size")?;
        if w == 0 || h == 0 {
            return Err(Error::Other("the image is empty".into()));
        }
        if w.max(h) > fit {
            let (nw, nh) = fit_within(w, h, fit);
            let premultiplied = factory
                .CreateFormatConverter()
                .ctx("create a WIC converter")?;
            premultiplied
                .Initialize(
                    &source,
                    &GUID_WICPixelFormat32bppPBGRA,
                    WICBitmapDitherTypeNone,
                    None,
                    0.0,
                    WICBitmapPaletteTypeCustom,
                )
                .ctx("convert the image")?;
            let scaler = factory.CreateBitmapScaler().ctx("create a WIC scaler")?;
            scaler
                .Initialize(&premultiplied, nw, nh, WICBitmapInterpolationModeFant)
                .ctx("scale the image")?;
            source = scaler.cast().ctx("WIC scaler → bitmap source")?;
            (w, h) = (nw, nh);
        }
        let converter = factory
            .CreateFormatConverter()
            .ctx("create a WIC converter")?;
        converter
            .Initialize(
                &source,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .ctx("convert the image to RGBA")?;
        let stride = w * 4;
        let mut pixels = vec![0u8; stride as usize * h as usize];
        converter
            .CopyPixels(std::ptr::null(), stride, &mut pixels)
            .ctx("read the image pixels")?;
        Rgba::from_raw(w, h, pixels).map_err(Error::Other)
    }
}

/// An image file's first frame, EXIF-orientation applied, fit to `fit`.
fn wic_image(path: &Path, fit: u32) -> Result<Rgba> {
    let factory = wic_factory()?;
    let decoder = wic_decoder(&factory, path)?;
    // SAFETY: frame 0 always exists for a successfully opened decoder.
    let frame = unsafe { decoder.GetFrame(0) }.ctx("read the first image frame")?;
    let image = wic_frame(&factory, &frame, fit)?;
    Ok(match exif_orientation(&frame) {
        Some(o) => orient(&image, o),
        None => image,
    })
}

/// Every frame of a multi-frame image (e.g. an .ico WIC can read).
fn wic_all_frames(path: &Path, fit: u32) -> Result<Vec<Rgba>> {
    let factory = wic_factory()?;
    let decoder = wic_decoder(&factory, path)?;
    // SAFETY: frame indices below the reported count.
    let count = unsafe { decoder.GetFrameCount() }.ctx("count image frames")?;
    let frames: Vec<Rgba> = (0..count.min(MAX_WIC_FRAMES))
        .filter_map(|i| unsafe { decoder.GetFrame(i) }.ok())
        .filter_map(|frame| wic_frame(&factory, &frame, fit).ok())
        .collect();
    if frames.is_empty() {
        return Err(Error::Other(format!(
            "no readable frames in {}",
            path.display()
        )));
    }
    Ok(frames)
}

/// EXIF orientation (1–8) of a JPEG / TIFF frame, if tagged.
fn exif_orientation(frame: &IWICBitmapFrameDecode) -> Option<u16> {
    // SAFETY: metadata queries into a PROPVARIANT we clear afterwards.
    unsafe {
        let reader = frame.GetMetadataQueryReader().ok()?;
        for query in [w!("/app1/ifd/{ushort=274}"), w!("/ifd/{ushort=274}")] {
            let mut value = PROPVARIANT::default();
            if reader.GetMetadataByName(query, &mut value).is_ok() {
                let orientation = PropVariantToUInt16(&value).ok();
                let _ = PropVariantClear(&mut value);
                if let Some(o) = orientation.filter(|o| (1..=8).contains(o)) {
                    return Some(o);
                }
            }
        }
    }
    None
}

/// Applies an EXIF orientation so the image displays upright:
/// 2 mirror, 3 rotate 180°, 4 flip, 5 transpose, 6 rotate 90° clockwise,
/// 7 transverse, 8 rotate 90° counter-clockwise.
fn orient(img: &Rgba, orientation: u16) -> Rgba {
    if !(2..=8).contains(&orientation) {
        return img.clone();
    }
    let (w, h) = (img.w, img.h);
    let (ow, oh) = if orientation >= 5 { (h, w) } else { (w, h) };
    let mut out = Rgba::new(ow, oh);
    for y in 0..oh {
        for x in 0..ow {
            let (sx, sy) = match orientation {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (y, h - 1 - x),
                7 => (w - 1 - y, h - 1 - x),
                _ => (w - 1 - y, x),
            };
            out.set_pixel(x, y, img.pixel(sx, sy));
        }
    }
    out
}

// --- (c) the shell ------------------------------------------------------------

/// Renders `name` (a path or `::{CLSID}`) with `IShellItemImageFactory` at
/// each size (icon only; the first request accepts a bigger image).
fn shell_frames(name: &std::ffi::OsStr, sizes: &[u32]) -> Result<Vec<Rgba>> {
    let w = wide(name);
    // SAFETY: valid NUL-terminated parsing name.
    let factory: IShellItemImageFactory = unsafe { SHCreateItemFromParsingName(pcwstr(&w), None) }
        .ctx(format!("find {}", name.to_string_lossy()))?;
    let mut frames = Vec::new();
    for (i, &size) in sizes.iter().enumerate() {
        let flags: SIIGBF = if i == 0 {
            SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK
        } else {
            SIIGBF_ICONONLY
        };
        let side = size as i32;
        // SAFETY: we own the returned bitmap (DeleteObject on drop).
        let Ok(bitmap) = (unsafe { factory.GetImage(SIZE { cx: side, cy: side }, flags) }) else {
            continue;
        };
        let bitmap = unsafe { Owned::new(bitmap) };
        if let Ok(image) = hbitmap_to_rgba(*bitmap)
            && !image.is_blank()
        {
            frames.push(normalize_corner_icon(&image));
        }
    }
    if frames.is_empty() {
        return Err(Error::NotFound(format!(
            "the shell has no icon for {}",
            name.to_string_lossy()
        )));
    }
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbered(w: u32, h: u32) -> Rgba {
        let mut img = Rgba::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.set_pixel(x, y, [(y * w + x) as u8, 0, 0, 255]);
            }
        }
        img
    }

    fn red(img: &Rgba) -> Vec<Vec<u8>> {
        (0..img.h)
            .map(|y| (0..img.w).map(|x| img.pixel(x, y)[0]).collect())
            .collect()
    }

    #[test]
    fn exif_orientations() {
        // a b      stored 2×3:  0 1
        // c d                   2 3
        // e f                   4 5
        let img = numbered(2, 3);
        assert_eq!(red(&orient(&img, 1)), red(&img));
        assert_eq!(
            red(&orient(&img, 2)),
            vec![vec![1, 0], vec![3, 2], vec![5, 4]]
        );
        assert_eq!(
            red(&orient(&img, 3)),
            vec![vec![5, 4], vec![3, 2], vec![1, 0]]
        );
        assert_eq!(
            red(&orient(&img, 4)),
            vec![vec![4, 5], vec![2, 3], vec![0, 1]]
        );
        assert_eq!(red(&orient(&img, 5)), vec![vec![0, 2, 4], vec![1, 3, 5]]);
        // 90° clockwise
        assert_eq!(red(&orient(&img, 6)), vec![vec![4, 2, 0], vec![5, 3, 1]]);
        assert_eq!(red(&orient(&img, 7)), vec![vec![5, 3, 1], vec![4, 2, 0]]);
        // 90° counter-clockwise
        assert_eq!(red(&orient(&img, 8)), vec![vec![1, 3, 5], vec![0, 2, 4]]);
    }

    #[test]
    fn frames_are_sorted_and_deduplicated() {
        let f = |s: u32, v: u8| Rgba::filled(s, s, [v, 0, 0, 255]);
        let tidied = tidy(vec![
            f(16, 1),
            f(48, 2),
            f(16, 3),
            Rgba::new(32, 32),
            f(256, 4),
        ]);
        let sizes: Vec<u32> = tidied.iter().map(|i| i.w).collect();
        assert_eq!(sizes, vec![256, 48, 16]);
        assert_eq!(tidied[2].pixel(0, 0)[0], 1, "first of equal sizes wins");
        assert_eq!(fit_within(4000, 1000, 1024), (1024, 256));
        assert_eq!(fit_within(10, 5000, 256), (1, 256));
        assert_eq!(preview(&[f(512, 9)]).map(|p| p.w), Some(256));
        assert_eq!(preview(&tidied).map(|p| p.w), Some(256));
    }

    #[test]
    fn classification() {
        let dir = std::env::temp_dir();
        assert_eq!(classify(&dir), ItemKind::Folder);
        assert_eq!(classify(Path::new("x.LNK")), ItemKind::Shortcut);
        assert_eq!(classify(Path::new("x.url")), ItemKind::InternetShortcut);
        assert_eq!(classify(Path::new("x.Exe")), ItemKind::Executable);
        assert_eq!(classify(Path::new("x.jpeg")), ItemKind::Image);
        assert_eq!(classify(Path::new("x.ICO")), ItemKind::Image);
        assert_eq!(classify(Path::new("x.reskin")), ItemKind::Project);
        assert_eq!(classify(Path::new("x.txt")), ItemKind::File);
        assert_eq!(classify(Path::new("noext")), ItemKind::File);
        assert_eq!(
            display_name(Path::new(r"C:\a\Game.lnk"), ItemKind::Shortcut),
            "Game"
        );
        assert_eq!(
            display_name(Path::new(r"C:\a\My.Folder"), ItemKind::Folder),
            "My.Folder"
        );
    }
}

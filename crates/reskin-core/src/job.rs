//! Jobs for the elevated helper (`reskin.exe --elevated-apply <job>`).
//!
//! Changing a shortcut on the Public Desktop needs admin rights. The app
//! itself never runs elevated: it writes a self-contained job file
//! (absolute targets plus the embedded `.ico` bytes) to its jobs folder,
//! launches itself with `runas`, and reads the result back from
//! `%ProgramData%\Reskin\results\<job id>.json` ([`result_file`]), a
//! folder only administrators can write to. It trusts that file only when
//! it agrees with the helper's exit code ([`result_for`]).
//!
//! The elevated side trusts nothing in the job. It checks the path it was
//! given ([`job_id_of`]), reads the file once and works on those bytes only
//! ([`run_job`]), so nothing can change between validation and use.
//! [`validate_job`] accepts only `.lnk` / `.url` files directly on the
//! Public Desktop ([`is_elevation_target`], the same rule the app's access
//! probe uses), icon names matching `^[a-z0-9-]{1,64}\.ico$` that are not
//! DOS device names (written into or deleted from
//! `%ProgramData%\Reskin\icons`; one name never carries two different
//! icons, and is never both written and deleted, in one job), and icons
//! that parse and are at most [`ico::MAX_ICO_BYTES`]. [`execute_job`] then
//! runs the validated ops through a [`JobExec`] (the real one lives in the
//! app's `helper.rs`). How the helper keeps its file system work away from
//! links planted in user-writable folders is described in
//! `docs/ARCHITECTURE.md` ("Elevation").
//!
//! Exit codes of the helper: [`EXIT_OK`], [`EXIT_INVALID`] (unreadable or
//! rejected job), [`EXIT_FAILED`] (at least one op failed).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::model::OriginalIcon;
use crate::{Error, Result, ico, now_ms, paths, store};

/// Job file format version.
pub const JOB_VERSION: u32 = 1;
/// Most ops one job may carry.
pub const MAX_JOB_OPS: usize = 64;
/// Longest job id.
pub const MAX_JOB_ID_LEN: usize = 64;
/// Longest accepted target path (in characters).
pub const MAX_TARGET_LEN: usize = 1024;
/// Longest icon location a restore op may write (in characters).
pub const MAX_LOCATION_LEN: usize = 1024;
/// Icon indices (or negated resource ids) a restore op may write.
pub const MAX_ICON_INDEX: i32 = 65535;

/// Every op succeeded.
pub const EXIT_OK: i32 = 0;
/// The job could not be read or failed validation; nothing was changed.
pub const EXIT_INVALID: i32 = 2;
/// At least one op failed (the others were still attempted).
pub const EXIT_FAILED: i32 = 3;

/// Base64 length of the largest acceptable icon.
const MAX_ICO_B64_LEN: usize = ico::MAX_ICO_BYTES.div_ceil(3) * 4;

/// Largest job file the helper will read: every op at its size limit plus
/// generous room for paths and JSON syntax.
pub const MAX_JOB_FILE_BYTES: u64 = (MAX_JOB_OPS * (MAX_ICO_B64_LEN + 16 * 1024)) as u64;

/// Folder of `%ProgramData%\Reskin` holding the Public-Desktop icons.
pub const ICONS_DIR: &str = "icons";
/// Folder of `%ProgramData%\Reskin` the helper writes its results to.
pub const RESULTS_DIR: &str = "results";
/// Result files at least this old are removed by the next helper run (the
/// app reads its result as soon as the helper exits, but cannot delete it).
pub const RESULT_TTL: Duration = Duration::from_secs(60 * 60);
/// Largest result file the app reads: [`MAX_JOB_OPS`] results with long
/// messages fit many times over.
pub const MAX_RESULT_FILE_BYTES: u64 = 1024 * 1024;

/// A job file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElevatedJob {
    pub version: u32,
    /// `[a-z0-9-]{1,64}`; also the job file's stem.
    pub id: String,
    /// Unix ms.
    pub created_at: f64,
    pub ops: Vec<JobOp>,
}

/// One change for the helper to make.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum JobOp {
    /// Store `ico_b64` as `%ProgramData%\Reskin\icons\<icon_name>` and
    /// point the `.lnk` at it.
    SetShortcutIcon {
        target: String,
        icon_name: String,
        ico_b64: String,
    },
    /// Same for a `.url` file.
    SetUrlIcon {
        target: String,
        icon_name: String,
        ico_b64: String,
    },
    /// Put a `.lnk`'s icon back (`location: None` clears it).
    RestoreShortcutIcon {
        target: String,
        location: Option<String>,
        index: i32,
    },
    /// Same for a `.url` file.
    RestoreUrlIcon {
        target: String,
        location: Option<String>,
        index: i32,
    },
    /// Delete `%ProgramData%\Reskin\icons\<icon_name>` unless a shortcut on
    /// the Public Desktop still uses it. Runs after every other op.
    DeleteIcon { icon_name: String },
}

/// The two kinds of file the helper edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LinkKind {
    /// `.lnk`
    Shortcut,
    /// `.url`
    Url,
}

impl LinkKind {
    /// For a target path, by extension (case-insensitive).
    pub fn of(target: &str) -> Option<LinkKind> {
        match paths::extension_of(target)?.as_str() {
            "lnk" => Some(LinkKind::Shortcut),
            "url" => Some(LinkKind::Url),
            _ => None,
        }
    }

    /// The extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            LinkKind::Shortcut => "lnk",
            LinkKind::Url => "url",
        }
    }
}

impl JobOp {
    /// A set-icon op for `target` (kind chosen by its extension) that
    /// embeds `ico` under its content-hashed name
    /// ([`paths::icon_file_name`]).
    pub fn set_icon(target: &str, name: &str, ico: &[u8]) -> Result<JobOp> {
        let target = target.to_owned();
        let icon_name = paths::icon_file_name(name, ico);
        let ico_b64 = STANDARD.encode(ico);
        match LinkKind::of(&target) {
            Some(LinkKind::Shortcut) => Ok(JobOp::SetShortcutIcon {
                target,
                icon_name,
                ico_b64,
            }),
            Some(LinkKind::Url) => Ok(JobOp::SetUrlIcon {
                target,
                icon_name,
                ico_b64,
            }),
            None => Err(unsupported_target(&target)),
        }
    }

    /// A restore op putting `original` back on `target`.
    pub fn restore_icon(target: &str, original: &OriginalIcon) -> Result<JobOp> {
        let target = target.to_owned();
        let location = original.location.clone();
        let index = original.index;
        match LinkKind::of(&target) {
            Some(LinkKind::Shortcut) => Ok(JobOp::RestoreShortcutIcon {
                target,
                location,
                index,
            }),
            Some(LinkKind::Url) => Ok(JobOp::RestoreUrlIcon {
                target,
                location,
                index,
            }),
            None => Err(unsupported_target(&target)),
        }
    }

    /// An op deleting the Public-Desktop icon `icon_name` (a file name in
    /// `%ProgramData%\Reskin\icons`).
    pub fn delete_icon(icon_name: &str) -> JobOp {
        JobOp::DeleteIcon {
            icon_name: icon_name.to_owned(),
        }
    }

    /// The `.lnk` / `.url` the op changes (`None` for [`JobOp::DeleteIcon`]).
    pub fn target(&self) -> Option<&str> {
        match self {
            JobOp::SetShortcutIcon { target, .. }
            | JobOp::SetUrlIcon { target, .. }
            | JobOp::RestoreShortcutIcon { target, .. }
            | JobOp::RestoreUrlIcon { target, .. } => Some(target),
            JobOp::DeleteIcon { .. } => None,
        }
    }
}

fn unsupported_target(target: &str) -> Error {
    Error::Unsupported(format!(
        "{target}: only .lnk and .url files can be changed with administrator rights"
    ))
}

/// A new job with a fresh id.
pub fn new_job(ops: Vec<JobOp>) -> ElevatedJob {
    ElevatedJob {
        version: JOB_VERSION,
        id: store::new_id(),
        created_at: now_ms(),
        ops,
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// A job that passed [`validate_job`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedJob {
    pub id: String,
    pub ops: Vec<ValidatedOp>,
}

/// A validated op with decoded icon bytes and resolved destination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidatedOp {
    SetIcon {
        link: LinkKind,
        /// The `.lnk` / `.url` on the Public Desktop.
        target: String,
        /// Absolute path of the `.ico` to write (`<public icons>\<name>`).
        dest: String,
        /// The decoded, validated `.ico`.
        ico: Vec<u8>,
    },
    RestoreIcon {
        link: LinkKind,
        target: String,
        /// `None` clears the custom icon.
        location: Option<String>,
        index: i32,
    },
    DeleteIcon {
        /// Absolute path of the `.ico` to delete (`<public icons>\<name>`).
        dest: String,
    },
}

impl ValidatedOp {
    /// The `.lnk` / `.url` the op changes (`None` for deletions).
    pub fn target(&self) -> Option<&str> {
        match self {
            ValidatedOp::SetIcon { target, .. } | ValidatedOp::RestoreIcon { target, .. } => {
                Some(target)
            }
            ValidatedOp::DeleteIcon { .. } => None,
        }
    }

    /// The kind of file the op changes (`None` for deletions).
    pub fn link(&self) -> Option<LinkKind> {
        match self {
            ValidatedOp::SetIcon { link, .. } | ValidatedOp::RestoreIcon { link, .. } => {
                Some(*link)
            }
            ValidatedOp::DeleteIcon { .. } => None,
        }
    }

    /// The icon file the op writes or deletes.
    fn icon_dest(&self) -> Option<&str> {
        match self {
            ValidatedOp::SetIcon { dest, .. } | ValidatedOp::DeleteIcon { dest } => Some(dest),
            ValidatedOp::RestoreIcon { .. } => None,
        }
    }
}

fn invalid(why: impl std::fmt::Display) -> Error {
    Error::Other(format!("invalid elevated job: {why}"))
}

/// `[a-z0-9-]{1,64}`.
pub fn is_valid_job_id(id: &str) -> bool {
    (1..=MAX_JOB_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Characters Windows does not allow in file names (besides the drive
/// colon and separators, handled separately).
fn is_illegal_path_char(c: char) -> bool {
    c < ' ' || matches!(c, '<' | '>' | '"' | '|' | '?' | '*' | ':')
}

/// DOS device names, which Win32 maps to devices even with an extension.
fn is_reserved_device_name(file_name: &str) -> bool {
    let base = file_name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    let upper = base.to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let mut chars = upper.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: Vec<char> = chars.collect();
    (prefix == "COM" || prefix == "LPT")
        && rest.len() == 1
        && (rest[0].is_ascii_digit() || matches!(rest[0], '¹' | '²' | '³'))
}

/// A folder given to the validator by the helper itself must be a plain
/// absolute local path, or nothing would be safe to compare against.
fn check_trusted_dir(dir: &str, what: &str) -> Result<()> {
    if !paths::is_absolute_drive_path(dir)
        || paths::has_parent_traversal(dir)
        || dir.chars().skip(2).any(is_illegal_path_char)
    {
        return Err(invalid(format!(
            "the {what} folder {dir:?} is not an absolute local path"
        )));
    }
    Ok(())
}

/// Validates a target path for `link`: an absolute drive path, not UNC,
/// without `..`, wildcards or illegal characters, naming a `.lnk`/`.url`
/// file directly inside `public_desktop`.
fn check_target(
    target: &str,
    link: LinkKind,
    public_desktop: &str,
) -> std::result::Result<(), String> {
    if target.chars().count() > MAX_TARGET_LEN {
        return Err("the target path is too long".into());
    }
    if paths::is_unc(target) {
        return Err(format!("{target:?} is a network path"));
    }
    if !paths::is_absolute_drive_path(target) {
        return Err(format!(
            "{target:?} is not an absolute path on a local drive"
        ));
    }
    if paths::has_parent_traversal(target) {
        return Err(format!("{target:?} contains '..'"));
    }
    // Skip the drive letter and its colon.
    if target.chars().skip(2).any(is_illegal_path_char) {
        return Err(format!(
            "{target:?} contains characters not allowed in paths"
        ));
    }
    if !paths::is_directly_under(target, public_desktop) {
        return Err(format!("{target:?} is not directly on the Public Desktop"));
    }
    let file_name = paths::file_name_of(target);
    if is_reserved_device_name(file_name) {
        return Err(format!("{file_name:?} is a reserved device name"));
    }
    if LinkKind::of(target) != Some(link) {
        return Err(format!(
            "{target:?} must be a .{} file for this operation",
            link.extension()
        ));
    }
    Ok(())
}

/// Whether the helper accepts `target` as the target of a job op: a `.lnk`
/// or `.url` file directly inside `public_desktop` (see [`validate_job`]
/// for every rule). The app's access probe asks for elevation for exactly
/// these files, so an approved UAC prompt never ends in a rejected job.
pub fn is_elevation_target(target: &str, public_desktop: &str) -> bool {
    check_trusted_dir(public_desktop, "Public Desktop").is_ok()
        && LinkKind::of(target)
            .is_some_and(|link| check_target(target, link, public_desktop).is_ok())
}

/// Checks the file name of an icon in the public icons folder.
fn check_icon_name(icon_name: &str) -> std::result::Result<(), String> {
    if !paths::is_valid_public_icon_name(icon_name) {
        return Err(format!(
            "icon name {icon_name:?} must match [a-z0-9-]{{1,64}}.ico"
        ));
    }
    // `con.ico`, `nul.ico`, `com1.ico`, … match the pattern, but Win32 opens
    // such names as devices (the printer port, the null device): the helper
    // would write the icon to a device and point the target at no file.
    // Content-hashed names (`<slug>-<hash>.ico`) never look like this.
    if is_reserved_device_name(icon_name) {
        return Err(format!("icon name {icon_name:?} is a reserved device name"));
    }
    Ok(())
}

/// Decodes and checks an embedded icon.
fn check_icon(icon_name: &str, ico_b64: &str) -> std::result::Result<Vec<u8>, String> {
    check_icon_name(icon_name)?;
    if ico_b64.len() > MAX_ICO_B64_LEN {
        return Err(format!(
            "the icon is larger than {} KB",
            ico::MAX_ICO_BYTES / 1024
        ));
    }
    let bytes = STANDARD
        .decode(ico_b64)
        .map_err(|e| format!("the icon data is not valid base64: {e}"))?;
    if bytes.len() > ico::MAX_ICO_BYTES {
        return Err(format!(
            "the icon is larger than {} KB",
            ico::MAX_ICO_BYTES / 1024
        ));
    }
    ico::validate_ico(&bytes).map_err(|e| format!("the icon is not a valid .ico: {e}"))?;
    Ok(bytes)
}

/// Checks a restore op's icon location; empty means "no custom icon".
fn check_location(
    location: Option<&str>,
    index: i32,
) -> std::result::Result<Option<String>, String> {
    if !(-MAX_ICON_INDEX..=MAX_ICON_INDEX).contains(&index) {
        return Err(format!("icon index {index} is out of range"));
    }
    let Some(location) = location else {
        return Ok(None);
    };
    if location.chars().count() > MAX_LOCATION_LEN {
        return Err("the icon location is too long".into());
    }
    if location.chars().any(char::is_control) {
        return Err("the icon location contains control characters".into());
    }
    // A network icon on an all-users shortcut would make every user's
    // Explorer authenticate to that host (leaking NTLM hashes). Originals on
    // the Public Desktop are local in practice, so refuse UNC and device
    // paths (`\\server\…`, `//server/…`, `\\?\UNC\…`, `\\.\…`) outright.
    let trimmed = location.trim_start_matches('"').trim_start();
    if paths::is_unc(trimmed) || trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return Err("network icon locations are not allowed".into());
    }
    Ok((!location.trim().is_empty()).then(|| location.to_owned()))
}

/// Validates everything in `job` against the Public Desktop folder and
/// the machine-wide icons folder (both supplied by the elevated process
/// itself, never taken from the job). See the module docs for the rules.
pub fn validate_job(
    job: &ElevatedJob,
    public_desktop: &str,
    public_icons_dir: &str,
) -> Result<ValidatedJob> {
    if job.version != JOB_VERSION {
        return Err(invalid(format!("unsupported version {}", job.version)));
    }
    if !is_valid_job_id(&job.id) {
        return Err(invalid(format!("bad id {:?}", job.id)));
    }
    if job.ops.is_empty() {
        return Err(invalid("it has no operations"));
    }
    if job.ops.len() > MAX_JOB_OPS {
        return Err(invalid(format!(
            "{} operations (at most {MAX_JOB_OPS})",
            job.ops.len()
        )));
    }
    check_trusted_dir(public_desktop, "Public Desktop")?;
    check_trusted_dir(public_icons_dir, "icons")?;
    let icons_dir = public_icons_dir.trim_end_matches(['\\', '/']);

    let mut ops: Vec<ValidatedOp> = Vec::with_capacity(job.ops.len());
    // Icon file → index in `ops` of the first op writing or deleting it.
    let mut icon_ops: HashMap<String, usize> = HashMap::new();
    for (n, op) in job.ops.iter().enumerate() {
        let validated = match op {
            JobOp::SetShortcutIcon {
                target,
                icon_name,
                ico_b64,
            }
            | JobOp::SetUrlIcon {
                target,
                icon_name,
                ico_b64,
            } => {
                let link = if matches!(op, JobOp::SetShortcutIcon { .. }) {
                    LinkKind::Shortcut
                } else {
                    LinkKind::Url
                };
                check_target(target, link, public_desktop)
                    .and_then(|()| check_icon(icon_name, ico_b64))
                    .map(|ico| ValidatedOp::SetIcon {
                        link,
                        target: target.clone(),
                        dest: format!("{icons_dir}\\{icon_name}"),
                        ico,
                    })
            }
            JobOp::RestoreShortcutIcon {
                target,
                location,
                index,
            }
            | JobOp::RestoreUrlIcon {
                target,
                location,
                index,
            } => {
                let link = if matches!(op, JobOp::RestoreShortcutIcon { .. }) {
                    LinkKind::Shortcut
                } else {
                    LinkKind::Url
                };
                check_target(target, link, public_desktop)
                    .and_then(|()| check_location(location.as_deref(), *index))
                    .map(|location| ValidatedOp::RestoreIcon {
                        link,
                        target: target.clone(),
                        location,
                        index: *index,
                    })
            }
            JobOp::DeleteIcon { icon_name } => {
                check_icon_name(icon_name).map(|()| ValidatedOp::DeleteIcon {
                    dest: format!("{icons_dir}\\{icon_name}"),
                })
            }
        };
        let validated = validated.map_err(|why| invalid(format!("operation {}: {why}", n + 1)))?;
        // Two ops may share an icon file only if both write the same bytes
        // (otherwise the second write would change the first target's
        // icon) or both delete it: a job never deletes an icon it writes.
        if let Some(dest) = validated.icon_dest() {
            match icon_ops.get(dest) {
                Some(&first) => {
                    let name = paths::file_name_of(dest);
                    let conflict = match (&ops[first], &validated) {
                        (
                            ValidatedOp::SetIcon { ico: a, .. },
                            ValidatedOp::SetIcon { ico: b, .. },
                        ) => (a != b).then(|| {
                            format!(
                                "{name} is also written by operation {} with different content",
                                first + 1
                            )
                        }),
                        (ValidatedOp::DeleteIcon { .. }, ValidatedOp::DeleteIcon { .. }) => None,
                        _ => Some(format!(
                            "{name} is both written and deleted (with operation {})",
                            first + 1
                        )),
                    };
                    if let Some(why) = conflict {
                        return Err(invalid(format!("operation {}: {why}", n + 1)));
                    }
                }
                None => {
                    icon_ops.insert(dest.to_owned(), ops.len());
                }
            }
        }
        ops.push(validated);
    }
    Ok(ValidatedJob {
        id: job.id.clone(),
        ops,
    })
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// The side effects of a job, implemented with COM by the app's
/// `helper.rs` and faked in tests.
pub trait JobExec {
    /// Writes an icon file (creating its folder). Skipping the write when
    /// an identical file already exists is up to the implementation.
    fn write_icon(&mut self, dest: &str, bytes: &[u8]) -> Result<()>;
    /// Sets (`Some((location, index))`) or clears (`None`) a `.lnk` icon.
    fn set_shortcut_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()>;
    /// Sets or clears a `.url` icon.
    fn set_url_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()>;
    /// Deletes an icon file unless a shortcut on the Public Desktop still
    /// uses it; `Ok(false)` when it was kept for that reason. A file that
    /// does not exist counts as deleted.
    fn delete_icon(&mut self, dest: &str) -> Result<bool>;
    /// Tells the shell the item changed.
    fn notify(&mut self, target: &str);
}

/// Outcome of one op.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    pub message: String,
    /// The icon the target now uses (set-icon ops that succeeded).
    pub icon_path: Option<String>,
}

/// Contents of a result file ([`result_file`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub id: String,
    /// Every op succeeded.
    pub ok: bool,
    /// One per op, in order. Empty when the job was rejected.
    pub results: Vec<OpResult>,
    /// Why the whole job was rejected (unreadable or invalid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl JobResult {
    /// A result for a job that was not run at all.
    pub fn rejected(id: &str, error: &Error) -> JobResult {
        JobResult {
            id: id.to_owned(),
            ok: false,
            results: Vec::new(),
            error: Some(error.to_string()),
        }
    }

    /// What the helper's exit code alone says about job `id` with `ops`
    /// ops, for when its result file cannot be read: every op succeeded
    /// ([`EXIT_OK`]), the job was refused ([`EXIT_INVALID`]), or something
    /// failed without saying what (anything else: every op counts as
    /// failed, so nothing is recorded as done that may not be).
    pub fn from_exit_code(id: &str, code: i32, ops: usize) -> JobResult {
        let all = |ok: bool, message: &str| {
            (0..ops)
                .map(|_| OpResult {
                    ok,
                    message: message.to_owned(),
                    icon_path: None,
                })
                .collect()
        };
        match code {
            EXIT_OK => JobResult {
                id: id.to_owned(),
                ok: true,
                results: all(true, "done"),
                error: None,
            },
            EXIT_INVALID => JobResult::rejected(
                id,
                &Error::Other("the elevated helper refused the job".into()),
            ),
            _ => JobResult {
                id: id.to_owned(),
                ok: false,
                results: all(
                    false,
                    &format!("the elevated helper failed (exit code {code})"),
                ),
                error: None,
            },
        }
    }

    /// The helper's process exit code for this result.
    pub fn exit_code(&self) -> i32 {
        if self.error.is_some() {
            EXIT_INVALID
        } else if self.ok {
            EXIT_OK
        } else {
            EXIT_FAILED
        }
    }
}

fn set_link_icon(
    exec: &mut impl JobExec,
    link: LinkKind,
    target: &str,
    icon: Option<(&str, i32)>,
) -> Result<()> {
    match link {
        LinkKind::Shortcut => exec.set_shortcut_icon(target, icon),
        LinkKind::Url => exec.set_url_icon(target, icon),
    }
}

fn run_op(op: &ValidatedOp, exec: &mut impl JobExec) -> OpResult {
    let outcome = match op {
        ValidatedOp::SetIcon {
            link,
            target,
            dest,
            ico,
        } => exec
            .write_icon(dest, ico)
            .and_then(|()| set_link_icon(exec, *link, target, Some((dest, 0))))
            .map(|()| ("icon applied", Some(dest.clone()))),
        ValidatedOp::RestoreIcon {
            link,
            target,
            location,
            index,
        } => set_link_icon(
            exec,
            *link,
            target,
            location.as_deref().map(|l| (l, *index)),
        )
        .map(|()| ("icon restored", None)),
        ValidatedOp::DeleteIcon { dest } => exec.delete_icon(dest).map(|deleted| {
            let message = if deleted {
                "icon deleted"
            } else {
                "icon kept: a Public Desktop shortcut still uses it"
            };
            (message, None)
        }),
    };
    match outcome {
        Ok((message, icon_path)) => {
            if let Some(target) = op.target() {
                exec.notify(target);
            }
            OpResult {
                ok: true,
                message: message.to_owned(),
                icon_path,
            }
        }
        Err(e) => OpResult {
            ok: false,
            message: e.to_string(),
            icon_path: None,
        },
    }
}

/// Runs every op — write the icon, point the target at it, notify the
/// shell — continuing after failures. Deletions run last, so they see the
/// targets as the other ops left them. Results are in op order.
pub fn execute_job(job: &ValidatedJob, exec: &mut impl JobExec) -> JobResult {
    let mut results: Vec<Option<OpResult>> = vec![None; job.ops.len()];
    for deletions in [false, true] {
        for (op, slot) in job.ops.iter().zip(results.iter_mut()) {
            if matches!(op, ValidatedOp::DeleteIcon { .. }) == deletions {
                *slot = Some(run_op(op, exec));
            }
        }
    }
    let results: Vec<OpResult> = results.into_iter().flatten().collect();
    JobResult {
        id: job.id.clone(),
        ok: results.iter().all(|r| r.ok),
        results,
        error: None,
    }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// The id of the job in `job_path` (the helper's command-line argument):
/// an absolute path on a local drive, without `..`, naming `<id>.json`
/// with a valid id ([`is_valid_job_id`]). Network and device paths are
/// refused before the elevated helper opens anything.
pub fn job_id_of(job_path: &str) -> Result<String> {
    if paths::is_unc(job_path)
        || !paths::is_absolute_drive_path(job_path)
        || paths::has_parent_traversal(job_path)
    {
        return Err(invalid(format!(
            "{job_path:?} is not an absolute path on a local drive"
        )));
    }
    let name = paths::file_name_of(job_path);
    match name.strip_suffix(".json") {
        Some(id) if is_valid_job_id(id) => Ok(id.to_owned()),
        _ => Err(invalid(format!("{name:?} is not a job file name"))),
    }
}

/// Writes `job` to `<dir>\<id>.json` (atomically) and returns the path.
pub fn write_job(dir: &Path, job: &ElevatedJob) -> Result<PathBuf> {
    if !is_valid_job_id(&job.id) {
        return Err(invalid(format!("bad id {:?}", job.id)));
    }
    let path = dir.join(format!("{}.json", job.id));
    store::write_json(&path, job)?;
    Ok(path)
}

/// Parses the bytes of a job file, refusing more than
/// [`MAX_JOB_FILE_BYTES`]. A malformed file is reported by position only:
/// the report goes to the unelevated app and must not echo file content.
pub fn parse_job(bytes: &[u8]) -> Result<ElevatedJob> {
    if bytes.len() as u64 > MAX_JOB_FILE_BYTES {
        return Err(invalid("the job file is too large"));
    }
    serde_json::from_slice(store::strip_bom(bytes)).map_err(|e| {
        invalid(format!(
            "the job file is malformed (line {}, column {})",
            e.line(),
            e.column()
        ))
    })
}

/// The helper's work on job `id`, given the bytes of its job file (read
/// once by the caller) or why they could not be read: parse, check that the
/// job carries the id its file is named after, validate, execute. The
/// caller writes the result.
pub fn run_job(
    id: &str,
    bytes: Result<Vec<u8>>,
    public_desktop: &str,
    public_icons_dir: &str,
    exec: &mut impl JobExec,
) -> JobResult {
    let validated = bytes
        .and_then(|b| parse_job(&b))
        .and_then(|job| {
            if job.id == id {
                Ok(job)
            } else {
                Err(invalid(format!("the job in {id}.json has id {:?}", job.id)))
            }
        })
        .and_then(|job| validate_job(&job, public_desktop, public_icons_dir));
    match validated {
        Ok(validated) => execute_job(&validated, exec),
        Err(e) => JobResult::rejected(id, &e),
    }
}

/// The name of job `id`'s result file: `<id>.json`.
pub fn result_file_name(id: &str) -> String {
    format!("{id}.json")
}

/// Where the helper writes the result of job `id`: `<results_dir>\<id>.json`.
pub fn result_file(results_dir: &Path, id: &str) -> PathBuf {
    results_dir.join(result_file_name(id))
}

/// The bytes of a result file.
pub fn encode_result(result: &JobResult) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(result)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// What the app records for job `id` with `ops` ops, which the helper
/// finished with exit code `code`, given the result file it read (`None`
/// when there was none it could trust). The file counts only when it is
/// the result of this job and agrees with the exit code: one op result per
/// op, or none for a rejected job. Otherwise the exit code alone decides
/// ([`JobResult::from_exit_code`]).
pub fn result_for(id: &str, code: i32, ops: usize, file: Option<&[u8]>) -> JobResult {
    file.and_then(|bytes| serde_json::from_slice::<JobResult>(store::strip_bom(bytes)).ok())
        .filter(|r| {
            let consistent = match r.error {
                Some(_) => !r.ok && r.results.is_empty(),
                None => r.results.len() == ops && r.ok == r.results.iter().all(|o| o.ok),
            };
            consistent && r.id == id && r.exit_code() == code
        })
        .unwrap_or_else(|| JobResult::from_exit_code(id, code, ops))
}

/// A file in the results folder that the helper may remove: a result file
/// ([`result_file`]) at least [`RESULT_TTL`] old.
pub fn is_stale_result(file_name: &str, age: Duration) -> bool {
    file_name.strip_suffix(".json").is_some_and(is_valid_job_id) && age >= RESULT_TTL
}

/// A name the helper may create, open or delete inside one of its folders:
/// one path component of at most 255 characters, without separators,
/// wildcards, control or other characters Windows refuses, not `.`/`..`,
/// not ending in a dot or space (Windows would strip them and open another
/// name), and not a DOS device name.
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 255
        && !name
            .chars()
            .any(|c| is_illegal_path_char(c) || c == '\\' || c == '/')
        && !name.ends_with(['.', ' '])
        && !is_reserved_device_name(name)
}

/// Whether the final path of an opened file (`GetFinalPathNameByHandleW`,
/// e.g. `\\?\C:\ProgramData\Reskin\results\x.json`) is exactly the path
/// that was opened, compared like every other path check here
/// ([`paths::normalize_for_compare`]). It is not when a link anywhere
/// along the way redirected the open.
pub fn final_path_matches(expected: &str, final_path: &str) -> bool {
    let expected = paths::normalize_for_compare(expected);
    !expected.is_empty() && expected == paths::normalize_for_compare(final_path)
}

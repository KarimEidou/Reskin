//! Jobs for the elevated helper (`reskin.exe --elevated-apply <job>`).
//!
//! Changing a shortcut on the Public Desktop needs admin rights. The app
//! itself never runs elevated: it writes a self-contained job file
//! (absolute targets plus the embedded `.ico` bytes) to its jobs folder,
//! launches itself with `runas`, and reads `<job>.result.json` back.
//!
//! The elevated side trusts nothing in the job. [`validate_job`] accepts
//! only `.lnk` / `.url` files directly on the Public Desktop, icon names
//! matching `^[a-z0-9-]{1,64}\.ico$` that are not DOS device names
//! (written into `%ProgramData%\Reskin\icons`; one name never carries two
//! different icons in a job), and icons that parse and are at most
//! [`ico::MAX_ICO_BYTES`]. [`execute_job`] then runs the validated ops
//! through a [`JobExec`] (the real one lives in `win::elevate`).
//!
//! Exit codes of the helper: [`EXIT_OK`], [`EXIT_INVALID`] (unreadable or
//! rejected job), [`EXIT_FAILED`] (at least one op failed).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

use crate::model::OriginalIcon;
use crate::store::io_error;
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

    pub fn target(&self) -> &str {
        match self {
            JobOp::SetShortcutIcon { target, .. }
            | JobOp::SetUrlIcon { target, .. }
            | JobOp::RestoreShortcutIcon { target, .. }
            | JobOp::RestoreUrlIcon { target, .. } => target,
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
}

impl ValidatedOp {
    pub fn target(&self) -> &str {
        match self {
            ValidatedOp::SetIcon { target, .. } | ValidatedOp::RestoreIcon { target, .. } => target,
        }
    }

    pub fn link(&self) -> LinkKind {
        match self {
            ValidatedOp::SetIcon { link, .. } | ValidatedOp::RestoreIcon { link, .. } => *link,
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

/// Decodes and checks an embedded icon.
fn check_icon(icon_name: &str, ico_b64: &str) -> std::result::Result<Vec<u8>, String> {
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
    // Destination → index in `ops` of the first op writing it.
    let mut writers: HashMap<String, usize> = HashMap::new();
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
        };
        let validated = validated.map_err(|why| invalid(format!("operation {}: {why}", n + 1)))?;
        // Two ops may share an icon file only if they carry the same bytes;
        // otherwise the second write would change the first target's icon
        // (or fail against the file the first op just wrote).
        if let ValidatedOp::SetIcon { dest, ico, .. } = &validated {
            match writers.get(dest) {
                Some(&first) => {
                    if let ValidatedOp::SetIcon { ico: first_ico, .. } = &ops[first]
                        && first_ico != ico
                    {
                        return Err(invalid(format!(
                            "operation {}: {} is also written by operation {} with different content",
                            n + 1,
                            paths::file_name_of(dest),
                            first + 1
                        )));
                    }
                }
                None => {
                    writers.insert(dest.clone(), ops.len());
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

/// The side effects of a job, implemented with COM by `win::elevate` and
/// faked in tests.
pub trait JobExec {
    /// Writes an icon file (creating its folder). Skipping the write when
    /// an identical file already exists is up to the implementation.
    fn write_icon(&mut self, dest: &str, bytes: &[u8]) -> Result<()>;
    /// Sets (`Some((location, index))`) or clears (`None`) a `.lnk` icon.
    fn set_shortcut_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()>;
    /// Sets or clears a `.url` icon.
    fn set_url_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()>;
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

/// Contents of `<job>.result.json`.
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
    };
    match outcome {
        Ok((message, icon_path)) => {
            exec.notify(op.target());
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

/// Runs every op in order — write the icon, point the target at it,
/// notify the shell — continuing after failures.
pub fn execute_job(job: &ValidatedJob, exec: &mut impl JobExec) -> JobResult {
    let results: Vec<OpResult> = job.ops.iter().map(|op| run_op(op, exec)).collect();
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

/// Where the helper writes its result: `<job stem>.result.json` next to the
/// job (`jobs\abc.json` → `jobs\abc.result.json`).
pub fn result_path(job_path: &Path) -> PathBuf {
    job_path.with_extension("result.json")
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

/// Reads a job file, refusing files larger than [`MAX_JOB_FILE_BYTES`].
pub fn read_job(path: &Path) -> Result<ElevatedJob> {
    let meta = std::fs::metadata(path).map_err(|e| io_error(e, "reading", path))?;
    if meta.len() > MAX_JOB_FILE_BYTES {
        return Err(invalid(format!("{} is too large", path.display())));
    }
    match store::read_json(path) {
        Ok(Some(job)) => Ok(job),
        Ok(None) => Err(Error::NotFound(path.display().to_string())),
        Err(e) => Err(invalid(e)),
    }
}

/// Writes the result next to the job.
pub fn write_result(job_path: &Path, result: &JobResult) -> Result<()> {
    store::write_json(&result_path(job_path), result)
}

/// Reads the result the helper left next to the job, if any.
pub fn read_result(job_path: &Path) -> Result<Option<JobResult>> {
    store::read_json(&result_path(job_path))
}

/// The whole elevated helper: read, validate and execute the job at
/// `job_path`, write `<job>.result.json`, and return the exit code.
///
/// A result file is written even for rejected jobs so the waiting app can
/// show why. If even that write fails the exit code still tells.
pub fn run_job_file(
    job_path: &Path,
    public_desktop: &str,
    public_icons_dir: &str,
    exec: &mut impl JobExec,
) -> i32 {
    let fallback_id = job_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let result = match read_job(job_path)
        .and_then(|job| validate_job(&job, public_desktop, public_icons_dir))
    {
        Ok(validated) => execute_job(&validated, exec),
        Err(e) => JobResult::rejected(&fallback_id, &e),
    };
    let _ = write_result(job_path, &result);
    result.exit_code()
}

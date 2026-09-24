//! Crash-safe file storage: atomic writes, JSON helpers, the
//! content-hashed icon store, the design library and the autosave slot.

use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::model::{LibraryEntry, LibrarySave};
use crate::{Error, Result, now_ms, paths};

/// Maps an I/O error to [`Error`], naming the action and the path while
/// keeping the access-denied / not-found distinction.
pub(crate) fn io_error(e: io::Error, action: &str, path: &Path) -> Error {
    let msg = format!("{action} {}: {e}", path.display());
    match e.kind() {
        io::ErrorKind::PermissionDenied => Error::AccessDenied(msg),
        io::ErrorKind::NotFound => Error::NotFound(msg),
        _ => Error::Other(msg),
    }
}

/// Process-wide counter that makes ids and temp names unique even when the
/// clock does not advance between calls.
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_seed() -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{nanos}:{}:{n}:{:?}",
        std::process::id(),
        std::thread::current().id()
    )
}

/// A fresh identifier: 16 characters of `[a-z0-9]` (hex of a SHA-256 over
/// the time, process id, thread and a process-wide counter). Safe to use
/// as a file name. Used for library designs, journal entries and jobs.
pub fn new_id() -> String {
    paths::sha256_hex(unique_seed().as_bytes())[..16].to_owned()
}

// ---------------------------------------------------------------------------
// Atomic writes and JSON
// ---------------------------------------------------------------------------

/// The directory a file lives in (`.` for a bare file name).
fn parent_dir(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// Writes `bytes` to a new, uniquely named, fully synced temp file in
/// `dir` and returns its path. The temp file is removed on failure.
fn write_temp(dir: &Path, hint: &str, bytes: &[u8]) -> Result<PathBuf> {
    const ATTEMPTS: u32 = 16;
    for _ in 0..ATTEMPTS {
        let suffix = &paths::sha256_hex(unique_seed().as_bytes())[..12];
        let tmp = dir.join(format!(".{hint}.{suffix}.tmp"));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error(e, "creating", &tmp)),
        };
        let written = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        return match written {
            Ok(()) => Ok(tmp),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(io_error(e, "writing", &tmp))
            }
        };
    }
    Err(Error::Other(format!(
        "could not create a temporary file in {}",
        dir.display()
    )))
}

/// Errors Windows reports while another process (virus scanner, indexer,
/// backup tool) briefly holds a file open.
fn is_transient_lock(e: &io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    e.kind() == io::ErrorKind::PermissionDenied
        || (cfg!(windows)
            && matches!(
                e.raw_os_error(),
                Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
            ))
}

/// `rename` that replaces the destination (MoveFileExW with
/// MOVEFILE_REPLACE_EXISTING on Windows). On Windows, transient locks by
/// other processes are retried briefly.
fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    const ATTEMPTS: u32 = if cfg!(windows) { 6 } else { 1 };
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < ATTEMPTS && is_transient_lock(&e) => {
                std::thread::sleep(Duration::from_millis(15 * u64::from(attempt)));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Makes a completed rename durable (POSIX needs the directory synced;
/// NTFS journals the rename itself).
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn file_hint(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned())
}

/// Replaces `path` with `bytes` atomically: the data goes to a synced temp
/// file in the same directory which is then renamed over the destination,
/// so readers see either the old or the new content, never a mix. Parent
/// directories are created as needed.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = parent_dir(path);
    fs::create_dir_all(&dir).map_err(|e| io_error(e, "creating", &dir))?;
    let tmp = write_temp(&dir, &file_hint(path), bytes)?;
    if let Err(e) = rename_replacing(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(io_error(e, "replacing", path));
    }
    sync_dir(&dir);
    Ok(())
}

/// Skips a UTF-8 byte-order mark (Notepad adds one when users hand-edit).
pub(crate) fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

/// Reads and parses a JSON file; `Ok(None)` when it does not exist.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e, "reading", path)),
    };
    serde_json::from_slice(strip_bom(&bytes))
        .map(Some)
        .map_err(|e| Error::Other(format!("{} is not valid: {e}", path.display())))
}

/// Serialises `value` as pretty JSON and writes it atomically.
pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

// ---------------------------------------------------------------------------
// Icon store
// ---------------------------------------------------------------------------

/// How many `-2`, `-3`, … variants [`store_icon`] tries before giving up.
const MAX_ICON_VARIANTS: u32 = 99;

/// `Some(true)` when `path` holds exactly `bytes`, `Some(false)` when it
/// holds something else, `None` when it does not exist.
fn same_content(path: &Path, bytes: &[u8]) -> Result<Option<bool>> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e, "inspecting", path)),
    };
    if !meta.is_file() || meta.len() != bytes.len() as u64 {
        return Ok(Some(false));
    }
    match fs::read(path) {
        Ok(existing) => Ok(Some(existing == bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e, "reading", path)),
    }
}

/// Creates `dest` with `bytes` only if it does not exist yet. Returns
/// `false` when something else created it first.
///
/// The data is written to a synced temp file and hard-linked into place:
/// linking fails instead of replacing, so an existing icon is never
/// overwritten and a crash never leaves a half-written icon under its
/// final name. File systems without hard links fall back to an
/// existence check followed by a rename.
fn create_new_file(dir: &Path, dest: &Path, bytes: &[u8]) -> Result<bool> {
    let tmp = write_temp(dir, &file_hint(dest), bytes)?;
    let placed = match fs::hard_link(&tmp, dest) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) if dest.exists() => Ok(false),
        Err(_) => fs::rename(&tmp, dest)
            .map(|()| true)
            .map_err(|e| io_error(e, "writing", dest)),
    };
    // After a successful rename the temp name is gone already.
    let _ = fs::remove_file(&tmp);
    if matches!(placed, Ok(true)) {
        sync_dir(dir);
    }
    placed
}

/// Stores an `.ico` in `dir` under its content-hashed name
/// ([`paths::icon_file_name`]) and returns the full path.
///
/// An existing file with identical content is reused. A file is never
/// overwritten: if the name is taken by different content (a truncated
/// hash collision or a damaged file), `-2`, `-3`, … are appended.
pub fn store_icon(dir: &Path, name: &str, ico: &[u8]) -> Result<PathBuf> {
    fs::create_dir_all(dir).map_err(|e| io_error(e, "creating", dir))?;
    let base = paths::icon_file_name(name, ico);
    let stem = base.strip_suffix(".ico").unwrap_or(&base);

    let mut variant = 1;
    // Losing a creation race re-examines the same name; bound the total
    // work so a file that keeps appearing and vanishing cannot spin.
    let mut budget = MAX_ICON_VARIANTS * 4;
    while variant <= MAX_ICON_VARIANTS && budget > 0 {
        budget -= 1;
        let file_name = if variant == 1 {
            base.clone()
        } else {
            format!("{stem}-{variant}.ico")
        };
        let dest = dir.join(file_name);
        match same_content(&dest, ico)? {
            Some(true) => return Ok(dest),
            Some(false) => variant += 1,
            None => {
                if create_new_file(dir, &dest, ico)? {
                    return Ok(dest);
                }
            }
        }
    }
    Err(Error::Other(format!(
        "could not find a free file name for {base} in {}",
        dir.display()
    )))
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/// `format` marker of library files.
pub const LIBRARY_FORMAT: &str = "reskin-library";
/// Current library file version.
pub const LIBRARY_VERSION: u32 = 1;
/// Extension of library files.
pub const LIBRARY_EXT: &str = "reskin";
/// Longest accepted library id.
pub const MAX_ID_LEN: usize = 64;

/// On-disk wrapper around a saved design.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFile {
    format: String,
    version: u32,
    id: String,
    name: String,
    thumb: String,
    updated_at: f64,
    /// The `.reskin` project JSON, stored verbatim as a string.
    data: String,
}

/// Everything but the (potentially large) design data, for listing.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryHeader {
    format: String,
    version: u32,
    name: String,
    thumb: String,
    updated_at: f64,
}

/// True for ids made only of `[a-z0-9-]`, 1..=64 characters. Anything else
/// is refused before it gets near a path, which rules out traversal.
pub fn is_valid_id(id: &str) -> bool {
    (1..=MAX_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Saved designs: one `<id>.reskin` JSON file each in `dir`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Library {
    dir: PathBuf,
}

impl Library {
    pub fn new(dir: impl Into<PathBuf>) -> Library {
        Library { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path_for(&self, id: &str) -> Result<PathBuf> {
        if !is_valid_id(id) {
            return Err(Error::Other(format!("invalid library id {id:?}")));
        }
        Ok(self.dir.join(format!("{id}.{LIBRARY_EXT}")))
    }

    /// Every readable design, most recently updated first. Files that are
    /// not library files, cannot be parsed, or have names that are not
    /// valid ids are skipped. A missing folder is an empty library.
    pub fn list(&self) -> Result<Vec<LibraryEntry>> {
        let read_dir = match fs::read_dir(&self.dir) {
            Ok(r) => r,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_error(e, "listing", &self.dir)),
        };
        let mut out = Vec::new();
        for dirent in read_dir.flatten() {
            let path = dirent.path();
            if path.extension().and_then(|e| e.to_str()) != Some(LIBRARY_EXT) {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_valid_id(id) {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(header) = serde_json::from_slice::<LibraryHeader>(strip_bom(&bytes)) else {
                continue;
            };
            if header.format != LIBRARY_FORMAT || header.version != LIBRARY_VERSION {
                continue;
            }
            out.push(LibraryEntry {
                // The file name is authoritative: it is what `load` opens.
                id: id.to_owned(),
                name: header.name,
                thumb: header.thumb,
                updated_at: header.updated_at,
                bytes: bytes.len() as f64,
            });
        }
        out.sort_by(|a, b| {
            b.updated_at
                .total_cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// Creates (`id: None`) or overwrites a design and returns its entry.
    pub fn save(&self, save: LibrarySave) -> Result<LibraryEntry> {
        let (id, path) = match save.id {
            Some(id) => {
                let path = self.path_for(&id)?;
                (id, path)
            }
            None => self.fresh_id()?,
        };
        let name = match save.name.trim() {
            "" => "Untitled".to_owned(),
            trimmed => trimmed.to_owned(),
        };
        let file = LibraryFile {
            format: LIBRARY_FORMAT.to_owned(),
            version: LIBRARY_VERSION,
            id: id.clone(),
            name,
            thumb: save.thumb,
            updated_at: now_ms(),
            data: save.data,
        };
        let mut bytes = serde_json::to_vec_pretty(&file)?;
        bytes.push(b'\n');
        write_atomic(&path, &bytes)?;
        Ok(LibraryEntry {
            id,
            name: file.name,
            thumb: file.thumb,
            updated_at: file.updated_at,
            bytes: bytes.len() as f64,
        })
    }

    fn fresh_id(&self) -> Result<(String, PathBuf)> {
        for _ in 0..16 {
            let id = new_id();
            let path = self.path_for(&id)?;
            if !path.exists() {
                return Ok((id, path));
            }
        }
        Err(Error::Other("could not allocate a library id".into()))
    }

    /// The `.reskin` data exactly as it was saved.
    pub fn load(&self, id: &str) -> Result<String> {
        let path = self.path_for(id)?;
        let file: LibraryFile = match read_json(&path) {
            Ok(Some(f)) => f,
            Ok(None) => {
                return Err(Error::NotFound(format!(
                    "design {id} is not in the library"
                )));
            }
            Err(e) => return Err(e),
        };
        if file.format != LIBRARY_FORMAT {
            return Err(Error::Unsupported(format!(
                "{} is not a Reskin library file",
                path.display()
            )));
        }
        if file.version != LIBRARY_VERSION {
            return Err(Error::Unsupported(format!(
                "design {id} was saved by a newer Reskin (format version {})",
                file.version
            )));
        }
        Ok(file.data)
    }

    /// Removes a design. Deleting a design that does not exist succeeds.
    pub fn delete(&self, id: &str) -> Result<()> {
        let path = self.path_for(id)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(e, "deleting", &path)),
        }
    }
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

/// Writes the crash-recovery autosave, or removes it for `None`.
pub fn autosave_write(file: &Path, data: Option<&str>) -> Result<()> {
    match data {
        Some(data) => write_atomic(file, data.as_bytes()),
        None => match fs::remove_file(file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(e, "deleting", file)),
        },
    }
}

/// The autosave, if one exists and is not empty.
pub fn autosave_read(file: &Path) -> Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(s) if s.trim().is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::InvalidData => Err(Error::Other(format!(
            "{} is not valid UTF-8",
            file.display()
        ))),
        Err(e) => Err(io_error(e, "reading", file)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_safe() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..2000 {
            let id = new_id();
            assert_eq!(id.len(), 16);
            assert!(is_valid_id(&id));
            assert!(seen.insert(id));
        }
    }

    #[test]
    fn id_validation() {
        assert!(is_valid_id("abc-123"));
        for bad in [
            "",
            "ABC",
            "a/b",
            r"a\b",
            "..",
            "a.b",
            "a b",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn bom_is_ignored() {
        assert_eq!(strip_bom(b"\xEF\xBB\xBF{}"), b"{}");
        assert_eq!(strip_bom(b"{}"), b"{}");
    }
}

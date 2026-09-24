//! Where Reskin keeps its files, how stored icons are named, and the
//! string-level path checks the elevated helper relies on.
//!
//! Folder names match the bundle identifier so the uninstaller's "delete
//! app data" option covers them:
//!
//! * `%APPDATA%\com.karimeidou.reskin\` — `settings.json`, `journal.json`,
//!   `library\*.reskin`, `autosave.reskin`
//! * `%LOCALAPPDATA%\com.karimeidou.reskin\` — `icons\` (content-hashed,
//!   never overwritten) and `jobs\` (elevated helper jobs)
//! * `%ProgramData%\Reskin\icons\` — icons for Public-Desktop items, written
//!   by the elevated helper
//!
//! The path predicates at the bottom work on *strings* with Windows
//! semantics (drive letters, `\` and `/` separators, case-insensitive), so
//! they behave identically on every host and can be unit tested on Linux.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Bundle identifier; also the per-user data folder name.
pub const APP_ID: &str = "com.karimeidou.reskin";

/// Folder under `%ProgramData%` shared by all users.
pub const PUBLIC_DIR_NAME: &str = "Reskin";

/// Longest slug [`slugify`] produces.
pub const MAX_SLUG_LEN: usize = 40;

/// Number of hex digits of the content hash used in icon file names.
pub const ICON_HASH_LEN: usize = 12;

/// Longest stem accepted by [`is_valid_public_icon_name`].
pub const MAX_PUBLIC_ICON_STEM: usize = 64;

/// The three roots Reskin writes to. See the module docs for the layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDirs {
    /// Roaming per-user data (`%APPDATA%\com.karimeidou.reskin`).
    pub roaming: PathBuf,
    /// Local per-user data (`%LOCALAPPDATA%\com.karimeidou.reskin`).
    pub local: PathBuf,
    /// Machine-wide data (`%ProgramData%\Reskin`); only the elevated
    /// helper writes here.
    pub program_data: PathBuf,
}

impl AppDirs {
    /// Resolves the folders from the environment.
    ///
    /// On Windows this reads `APPDATA`, `LOCALAPPDATA` and `ProgramData`,
    /// falling back to the conventional locations under `USERPROFILE` /
    /// `ALLUSERSPROFILE` / `SystemDrive` if a variable is missing. On other
    /// hosts (tests, tooling) it uses XDG-style folders under `$HOME`.
    pub fn from_env() -> AppDirs {
        let (roaming_base, local_base, program_base) = base_dirs();
        AppDirs {
            roaming: roaming_base.join(APP_ID),
            local: local_base.join(APP_ID),
            program_data: program_base.join(PUBLIC_DIR_NAME),
        }
    }

    /// Everything under one root (tests): `<root>/roaming`, `<root>/local`
    /// and `<root>/program-data`.
    pub fn at(root: impl AsRef<Path>) -> AppDirs {
        let root = root.as_ref();
        AppDirs {
            roaming: root.join("roaming"),
            local: root.join("local"),
            program_data: root.join("program-data"),
        }
    }

    /// `settings.json` (roaming).
    pub fn settings_file(&self) -> PathBuf {
        self.roaming.join("settings.json")
    }

    /// `journal.json` (roaming): the apply/restore history.
    pub fn journal_file(&self) -> PathBuf {
        self.roaming.join("journal.json")
    }

    /// Saved designs, one `<id>.reskin` per design (roaming).
    pub fn library_dir(&self) -> PathBuf {
        self.roaming.join("library")
    }

    /// Crash-recovery autosave of the open design (roaming).
    pub fn autosave_file(&self) -> PathBuf {
        self.roaming.join("autosave.reskin")
    }

    /// Content-hashed `.ico` files applied to the user's items (local).
    pub fn icons_dir(&self) -> PathBuf {
        self.local.join("icons")
    }

    /// Job files handed to the elevated helper (local).
    pub fn jobs_dir(&self) -> PathBuf {
        self.local.join("jobs")
    }

    /// Icons for Public-Desktop items (`%ProgramData%\Reskin\icons`).
    pub fn public_icons_dir(&self) -> PathBuf {
        self.program_data.join("icons")
    }

    /// Creates the per-user folders (not the machine-wide one, which needs
    /// admin rights and is created by the elevated helper).
    pub fn ensure(&self) -> crate::Result<()> {
        for dir in [
            self.roaming.clone(),
            self.library_dir(),
            self.local.clone(),
            self.icons_dir(),
            self.jobs_dir(),
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|e| crate::store::io_error(e, "creating", &dir))?;
        }
        Ok(())
    }
}

/// A non-empty environment variable as a path.
fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// `(roaming, local, machine-wide)` base folders.
#[cfg(windows)]
fn base_dirs() -> (PathBuf, PathBuf, PathBuf) {
    let profile = env_dir("USERPROFILE").unwrap_or_else(std::env::temp_dir);
    let roaming = env_dir("APPDATA").unwrap_or_else(|| profile.join(r"AppData\Roaming"));
    let local = env_dir("LOCALAPPDATA").unwrap_or_else(|| profile.join(r"AppData\Local"));
    let program = env_dir("ProgramData")
        .or_else(|| env_dir("ALLUSERSPROFILE"))
        .or_else(|| {
            env_dir("SystemDrive").map(|d| PathBuf::from(format!("{}\\ProgramData", d.display())))
        })
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    (roaming, local, program)
}

/// `(roaming, local, machine-wide)` base folders.
#[cfg(not(windows))]
fn base_dirs() -> (PathBuf, PathBuf, PathBuf) {
    let home = env_dir("HOME").unwrap_or_else(std::env::temp_dir);
    let config = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config"));
    let data = env_dir("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share"));
    // There is no machine-wide equivalent that a normal user may write, and
    // nothing outside Windows uses it; keep it next to the local data.
    (config, data.clone(), data)
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// Turns a display name into a file-name-safe slug: lowercase ASCII letters
/// and digits are kept, every other run of characters becomes one `-`,
/// leading/trailing dashes are dropped, and the result is at most
/// [`MAX_SLUG_LEN`] characters. An empty result becomes `"icon"`.
pub fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len().min(MAX_SLUG_LEN * 2));
    let mut pending_dash = false;
    for c in name.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(c);
            if slug.len() >= MAX_SLUG_LEN {
                break;
            }
        } else {
            pending_dash = true;
        }
    }
    // The slug is pure ASCII, so any byte index is a char boundary.
    slug.truncate(MAX_SLUG_LEN);
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "icon".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap_or('0'));
    }
    out
}

/// Content-addressed file name for a stored icon:
/// `<slug>-<first 12 hex digits of sha256(ico)>.ico`.
///
/// The result always satisfies [`is_valid_public_icon_name`].
pub fn icon_file_name(name: &str, ico: &[u8]) -> String {
    let hash = sha256_hex(ico);
    format!("{}-{}.ico", slugify(name), &hash[..ICON_HASH_LEN])
}

/// True when `name` matches `^[a-z0-9-]{1,64}\.ico$` — the only file names
/// the elevated helper writes into `%ProgramData%\Reskin\icons`.
pub fn is_valid_public_icon_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".ico") else {
        return false;
    };
    (1..=MAX_PUBLIC_ICON_STEM).contains(&stem.len())
        && stem
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

// ---------------------------------------------------------------------------
// Windows-style path strings
// ---------------------------------------------------------------------------

fn is_sep(c: char) -> bool {
    c == '\\' || c == '/'
}

/// ASCII case-insensitive `starts_with`.
fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Canonical form of a Windows path for equality / prefix tests:
///
/// * `/` becomes `\`;
/// * the `\\?\` prefix is removed (`\\?\UNC\server\share` → `\\server\share`);
/// * lowercase;
/// * runs of separators collapse to one (a leading `\\` of a UNC path is kept);
/// * trailing separators are removed (`C:\` → `c:`).
///
/// This does not resolve `.`/`..` or touch the file system; callers that
/// need safety reject such components separately.
pub fn normalize_for_compare(path: &str) -> String {
    let unified: String = path
        .chars()
        .map(|c| if c == '/' { '\\' } else { c })
        .collect();
    let stripped = if starts_with_ci(&unified, r"\\?\UNC\") {
        format!(r"\\{}", &unified[r"\\?\UNC\".len()..])
    } else if let Some(rest) = unified.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        unified
    };
    let lower = stripped.to_lowercase();

    let mut out = String::with_capacity(lower.len());
    let mut rest = lower.as_str();
    if let Some(r) = rest.strip_prefix(r"\\") {
        out.push_str(r"\\");
        rest = r.trim_start_matches('\\');
    }
    let mut prev_sep = false;
    for c in rest.chars() {
        if c == '\\' {
            if !prev_sep {
                out.push(c);
            }
            prev_sep = true;
        } else {
            out.push(c);
            prev_sep = false;
        }
    }
    while out.ends_with('\\') {
        out.pop();
    }
    out
}

/// True when `child` names an entry *directly* inside `dir` (not the
/// directory itself and not a subfolder), comparing case-insensitively
/// after [`normalize_for_compare`].
pub fn is_directly_under(child: &str, dir: &str) -> bool {
    let child = normalize_for_compare(child);
    let dir = normalize_for_compare(dir);
    if dir.is_empty() {
        return false;
    }
    let Some(rest) = child.strip_prefix(dir.as_str()) else {
        return false;
    };
    match rest.strip_prefix('\\') {
        Some(name) => !name.is_empty() && !name.contains('\\'),
        None => false,
    }
}

/// True when any component of `path` would walk up a directory.
///
/// Besides the literal `..`, Windows trims trailing dots and spaces from
/// path components (`".. "` is `".."`), so any component consisting only of
/// dots and spaces with at least two dots is treated as traversal.
pub fn has_parent_traversal(path: &str) -> bool {
    path.split(is_sep).any(|component| {
        component.chars().all(|c| c == '.' || c == ' ')
            && component.chars().filter(|&c| c == '.').count() >= 2
    })
}

/// True for network paths: `\\server\share`, `//server/share` and the
/// `\\?\UNC\` / `\\.\UNC\` forms. Local device-namespace paths such as
/// `\\?\C:\…` are not UNC.
pub fn is_unc(path: &str) -> bool {
    let unified: String = path
        .chars()
        .map(|c| if c == '/' { '\\' } else { c })
        .collect();
    if starts_with_ci(&unified, r"\\?\UNC\") || starts_with_ci(&unified, r"\\.\UNC\") {
        return true;
    }
    if unified.starts_with(r"\\?\") || unified.starts_with(r"\\.\") {
        return false;
    }
    unified.starts_with(r"\\")
}

/// True for a fully qualified drive path such as `C:\Users` or `c:/x`
/// (drive letter, colon, separator). Relative (`C:foo`), rooted (`\foo`),
/// UNC and device paths are not.
pub fn is_absolute_drive_path(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(d), Some(':'), Some(s)) if d.is_ascii_alphabetic() && is_sep(s)
    )
}

/// The last component of a Windows-style path string.
pub fn file_name_of(path: &str) -> &str {
    path.rsplit(is_sep).next().unwrap_or(path)
}

/// Lowercase extension (without the dot) of the last component, if any.
pub fn extension_of(path: &str) -> Option<String> {
    let name = file_name_of(path);
    let (stem, ext) = name.rsplit_once('.')?;
    (!stem.is_empty() && !ext.is_empty()).then(|| ext.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_basics() {
        assert_eq!(slugify("Google Chrome"), "google-chrome");
        assert_eq!(slugify("  --Hello__World!!  "), "hello-world");
        assert_eq!(slugify(""), "icon");
        assert_eq!(slugify("日本語"), "icon");
        assert_eq!(slugify("Café Olé"), "caf-ol");
    }

    #[test]
    fn slug_is_capped_without_trailing_dash() {
        let s = slugify(&"ab ".repeat(40));
        assert!(s.len() <= MAX_SLUG_LEN, "{s}");
        assert!(!s.ends_with('-'));
        assert_eq!(slugify(&"a".repeat(39)).len(), 39);
        assert_eq!(slugify(&"a".repeat(100)).len(), MAX_SLUG_LEN);
        // 39 letters, a separator, more letters: the cut lands after the
        // dash, which must be trimmed again.
        assert_eq!(slugify(&format!("{} bcd", "a".repeat(39))), "a".repeat(39));
    }

    #[test]
    fn sha_hex_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn normalize_forms() {
        assert_eq!(
            normalize_for_compare(r"C:\Users\Public\"),
            r"c:\users\public"
        );
        assert_eq!(
            normalize_for_compare("C:/Users//Public"),
            r"c:\users\public"
        );
        assert_eq!(normalize_for_compare(r"\\?\C:\X"), r"c:\x");
        assert_eq!(normalize_for_compare(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(normalize_for_compare(r"\\srv\\share\"), r"\\srv\share");
        assert_eq!(normalize_for_compare(r"C:\"), "c:");
    }

    #[test]
    fn extension_helpers() {
        assert_eq!(extension_of(r"C:\a\App.LNK").as_deref(), Some("lnk"));
        assert_eq!(extension_of(r"C:\a.b\noext"), None);
        assert_eq!(extension_of(r"C:\a\.lnk"), None);
        assert_eq!(file_name_of("C:/a/b.url"), "b.url");
    }
}

//! The apply journal (`journal.json`): every icon change Reskin makes, so
//! it can be undone, restored and recovered after a crash.
//!
//! Life of an entry:
//!
//! ```text
//! begin() ──► Pending ──commit()──► Applied ──(re-apply)──► Superseded
//!                │                     │                        │
//!              fail()            undo / restore          undo of the newer
//!                ▼                     ▼                  entry re-activates
//!              Failed               Restored                    ▼
//!                                                             Applied
//! ```
//!
//! * [`Journal::begin`] persists a *pending* entry **before** the caller
//!   touches the target; [`Journal::commit`] marks it applied afterwards.
//!   A crash in between leaves a pending entry that
//!   [`Journal::reconcile`] resolves on the next start by probing the
//!   target.
//! * Applying over an already reskinned target starts a *chain*: the new
//!   entry keeps the chain's first `original` (the icon from before
//!   Reskin ever touched the target), records `supersedes`, and the older
//!   entry becomes `Superseded` on commit. At most one entry per target is
//!   `Applied`.
//! * Restores are planned purely ([`Journal::plan_undo`],
//!   [`Journal::plan_restore_target`], [`Journal::plan_restore_all`]),
//!   executed by the caller, then recorded with [`Journal::finish_plan`].
//!   A restore that may meet other processes is asked for as
//!   [`RestoreStep`]s ([`Journal::undo_steps`],
//!   [`Journal::restore_all_steps`]), each planned with
//!   [`Journal::plan_step`] under the lock right before it runs.
//! * The extra entries of one apply (matching Start-menu and taskbar pins)
//!   carry the main entry's id as their `group`; undoing the main entry
//!   undoes them too ([`Journal::undo_steps`]).
//!
//! Targets are compared case-insensitively after
//! [`paths::normalize_for_compare`]; system icons use their slug as the
//! target. The file is rewritten atomically after every mutation.
//!
//! Several processes share the file: the app, and `--restore-all` run from
//! a terminal or the uninstaller while the app may still be running. Every
//! read-modify-write therefore holds an exclusive lock on
//! `journal.json.lock` (`LockFileEx` on Windows) and starts from the file as
//! it is on disk: each mutation takes the lock and reloads first, and
//! [`Journal::locked`] holds it across several steps (plan a step, execute
//! it, record it). A journal never writes back entries another process has
//! changed since it last read them; readers catch up with
//! [`Journal::refresh`].

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, OpenOptions, TryLockError};
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::Value;

use crate::model::{EntryState, HistoryEntry, OriginalIcon, SystemIconId, TargetKind};
use crate::store::io_error;
use crate::{Error, Result, now_ms, paths, store};

/// Version of `journal.json`.
pub const JOURNAL_VERSION: u32 = 1;

/// How long a journal operation waits for another process to release the
/// journal lock. Holders keep it for one quick read-modify-write, or one
/// shell write while restoring, never across a UAC prompt.
pub const LOCK_TIMEOUT: Duration = Duration::from_secs(30);

/// How often a waiting operation retries the lock.
const LOCK_POLL: Duration = Duration::from_millis(20);

/// [`Journal::reconcile_settled`] leaves pending entries younger than this
/// alone when their target does not show the icon yet: in another process
/// the apply may still be under way (it can wait up to five minutes on a
/// UAC prompt between journaling and committing).
pub const IN_FLIGHT_GRACE: Duration = Duration::from_secs(10 * 60);

/// At most this many finished (restored / failed / superseded) entries are
/// kept; the oldest restored and failed ones go first.
pub const MAX_INACTIVE_ENTRIES: usize = 500;

/// [`Journal::gc_icons`] leaves icons younger than this alone, so an icon
/// that was just stored (or reused: [`store::store_icon`] refreshes the
/// modification time of a file it reuses) but whose entry is not begun yet
/// survives a GC running concurrently.
pub const GC_GRACE: Duration = Duration::from_secs(10 * 60);

/// What the caller is about to apply.
#[derive(Debug, Clone, PartialEq)]
pub struct NewEntry {
    pub kind: TargetKind,
    /// Absolute path of the target. Ignored for system icons, whose target
    /// is always their slug.
    pub target: String,
    pub name: String,
    pub system_icon: Option<SystemIconId>,
    /// The stored `.ico` the target will point at.
    pub icon_path: String,
    /// The target's icon right now. Replaced by the chain's first original
    /// when the target is already reskinned.
    pub original: OriginalIcon,
    /// Applied through the elevated helper.
    pub elevated: bool,
    /// 48 px PNG thumbnail (base64).
    pub thumb: Option<String>,
    pub design_name: Option<String>,
    /// The main entry of the apply this entry belongs to (for the matching
    /// pins an apply also changes); `None` for a main entry.
    pub group: Option<String>,
}

/// What a target looks like now, for [`Journal::reconcile`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// The target uses the entry's icon: the change went through.
    PointsToIcon,
    /// The target exists but uses some other icon.
    PointsElsewhere,
    /// The target no longer exists.
    Missing,
}

/// Outcome of [`Journal::reconcile`] (entry ids).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    /// Pending entries found applied and committed.
    pub applied: Vec<String>,
    /// Pending entries marked failed.
    pub failed: Vec<String>,
    /// Pending entries left pending because another process may still be
    /// applying them ([`Journal::reconcile_settled`]).
    pub in_flight: Vec<String>,
}

impl ReconcileReport {
    /// Nothing was committed or failed.
    pub fn is_empty(&self) -> bool {
        self.applied.is_empty() && self.failed.is_empty()
    }
}

/// What a restore puts on the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreTo {
    /// The icon from before Reskin touched the target.
    Original(OriginalIcon),
    /// An earlier Reskin icon (undoing a re-apply): point the target at
    /// this `.ico`, index 0.
    Icon(String),
    /// The target is a shortcut Reskin created: delete it.
    Delete,
}

/// Which entries a plan changes when it succeeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanScope {
    /// Undo one entry; `previous` (if any) becomes the active entry again.
    Undo { previous: Option<String> },
    /// Full restore: every entry of the target's chain becomes `Restored`.
    Full { chain: Vec<String> },
}

/// One restore, planned with [`Journal::plan_step`] under the journal lock
/// right before it runs, so that it matches the journal as it is on disk
/// then — whatever other processes did since it was asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreStep {
    /// Undo this entry ([`Journal::plan_undo`]).
    Undo(String),
    /// Put this target back as it was before Reskin changed it
    /// ([`Journal::plan_restore_target`]).
    Target(String),
}

/// A restore to carry out on one target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestorePlan {
    /// The target's active entry.
    pub entry_id: String,
    pub kind: TargetKind,
    pub target: String,
    pub name: String,
    pub system_icon: Option<SystemIconId>,
    /// The entry was applied through the elevated helper, so restoring it
    /// needs elevation too.
    pub elevated: bool,
    pub to: RestoreTo,
    pub scope: PlanScope,
}

/// What [`parse_journal`] made of a journal file.
#[derive(Debug)]
enum Parsed {
    /// Everything was readable.
    Intact(Vec<HistoryEntry>, BTreeMap<String, String>),
    /// The file is a version-1 journal, but some entries (or the failure
    /// notes) could not be read and were dropped.
    Salvaged(Vec<HistoryEntry>, BTreeMap<String, String>),
    /// A journal with another version (written by a newer Reskin).
    OtherVersion(u64),
    /// Not a journal at all (truncated, not JSON, wrong shape).
    Damaged,
}

/// Parses `journal.json`, keeping every entry that is readable on its own
/// so one damaged entry does not cost the originals of all the others.
fn parse_journal(body: &[u8]) -> Parsed {
    let Ok(Value::Object(mut root)) = serde_json::from_slice::<Value>(body) else {
        return Parsed::Damaged;
    };
    match root.get("version").map(Value::as_u64) {
        Some(Some(v)) if v == u64::from(JOURNAL_VERSION) => {}
        Some(Some(v)) => return Parsed::OtherVersion(v),
        _ => return Parsed::Damaged,
    }
    let Some(Value::Array(raw)) = root.remove("entries") else {
        return Parsed::Damaged;
    };
    let total = raw.len();
    let entries: Vec<HistoryEntry> = raw
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect();
    let (failures, failures_ok) = match root.remove("failures") {
        None | Some(Value::Null) => (BTreeMap::new(), true),
        Some(v) => match serde_json::from_value(v) {
            Ok(f) => (f, true),
            Err(_) => (BTreeMap::new(), false),
        },
    };
    if entries.len() == total && failures_ok {
        Parsed::Intact(entries, failures)
    } else {
        Parsed::Salvaged(entries, failures)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalFileRef<'a> {
    version: u32,
    entries: &'a [HistoryEntry],
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    failures: &'a BTreeMap<String, String>,
}

/// An exclusive lock on a journal's lock file, shared with every other
/// process; released on drop.
struct FileLock(fs::File);

impl FileLock {
    /// Waits up to `timeout` for the lock on `path` (created if missing).
    fn acquire(path: &Path, timeout: Duration) -> Result<FileLock> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            fs::create_dir_all(dir).map_err(|e| io_error(e, "creating", dir))?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|e| io_error(e, "opening", path))?;
        let started = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(FileLock(file)),
                Err(TryLockError::WouldBlock) if started.elapsed() < timeout => {
                    std::thread::sleep(LOCK_POLL);
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(Error::Other(format!(
                        "Reskin's history is in use by another Reskin process (restoring \
                         icons, or the uninstaller); waited {} s for {}. Try again when it \
                         has finished.",
                        timeout.as_secs(),
                        path.display()
                    )));
                }
                Err(TryLockError::Error(e)) => return Err(io_error(e, "locking", path)),
            }
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // Closing the handle releases the lock too, but Windows may do that
        // lazily; unlock right away so a waiting process gets it at once.
        let _ = self.0.unlock();
    }
}

/// The journal, persisted at `path` as
/// `{ "version": 1, "entries": [HistoryEntry…], "failures": {id: message} }`.
#[derive(Debug, Clone)]
pub struct Journal {
    path: PathBuf,
    /// Oldest first.
    entries: Vec<HistoryEntry>,
    /// Why entries failed (`fail` / `reconcile`), by entry id.
    failures: BTreeMap<String, String>,
    /// Where a damaged journal found on disk was saved.
    recovered: Option<PathBuf>,
    /// SHA-256 of the file as last read or written, so a reload can skip
    /// parsing a file nobody changed. `None` forces the next reload.
    seen: Option<String>,
    /// Inside [`Journal::locked`]: the lock is held and the entries are
    /// fresh from disk.
    held: bool,
}

/// Comparison key for targets (paths case-insensitively, slugs as-is).
fn target_key(target: &str) -> String {
    paths::normalize_for_compare(target)
}

impl Journal {
    /// Opens the journal at `path`. A missing file is an empty journal.
    ///
    /// Damage is contained: entries that cannot be read on their own are
    /// dropped, the untouched file is copied to `journal.json.bak-<unix ms>`
    /// (see [`Journal::recovered_backup`]) and the readable rest is written
    /// back. A file that is not a journal at all is moved to that backup
    /// name and an empty journal is returned. A journal with another
    /// version (written by a newer Reskin) is refused rather than clobbered.
    /// The same holds whenever a later operation reloads the file.
    pub fn load(path: impl Into<PathBuf>) -> Result<Journal> {
        let mut journal = Journal {
            path: path.into(),
            entries: Vec::new(),
            failures: BTreeMap::new(),
            recovered: None,
            seen: None,
            held: false,
        };
        // No folder, no journal: don't create one just to lock it.
        if journal
            .path
            .parent()
            .is_some_and(|d| !d.as_os_str().is_empty() && !d.exists())
        {
            return Ok(journal);
        }
        journal.locked(|_| Ok(()))?;
        Ok(journal)
    }

    /// `journal.json` → `journal.json.lock`, the file every process locks.
    fn lock_path(&self) -> PathBuf {
        let mut name = self
            .path
            .file_name()
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| "journal.json".into());
        name.push(".lock");
        self.path.with_file_name(name)
    }

    /// Runs `f` holding the journal lock, on the journal as it is on disk:
    /// no other process changes the file until `f` returns, and mutations
    /// inside `f` do not lock again. Use it to build, execute and record a
    /// plan as one step. Waits up to [`LOCK_TIMEOUT`] for the lock.
    ///
    /// Within one process, callers must serialise access to the `Journal`
    /// themselves (the app keeps it in a mutex) and take that first.
    pub fn locked<T>(&mut self, f: impl FnOnce(&mut Journal) -> Result<T>) -> Result<T> {
        if self.held {
            return f(self);
        }
        let lock = FileLock::acquire(&self.lock_path(), LOCK_TIMEOUT)?;
        self.held = true;
        let outcome = panic::catch_unwind(AssertUnwindSafe(|| {
            self.reload().and_then(|()| f(&mut *self))
        }));
        self.held = false;
        drop(lock);
        outcome.unwrap_or_else(|payload| panic::resume_unwind(payload))
    }

    /// Picks up changes another process made to the file.
    pub fn refresh(&mut self) -> Result<()> {
        self.locked(|_| Ok(()))
    }

    /// Replaces the in-memory state with the file's (under the lock), unless
    /// the file is unchanged since it was last read or written. See
    /// [`Journal::load`] for how damage is handled.
    fn reload(&mut self) -> Result<()> {
        let bytes = match fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.entries.clear();
                self.failures.clear();
                self.seen = None;
                return Ok(());
            }
            Err(e) => return Err(io_error(e, "reading", &self.path)),
        };
        let digest = paths::sha256_hex(&bytes);
        if self.seen.as_deref() == Some(digest.as_str()) {
            return Ok(());
        }
        match parse_journal(store::strip_bom(&bytes)) {
            Parsed::Intact(entries, failures) => {
                self.entries = entries;
                self.failures = failures;
                self.seen = Some(digest);
            }
            Parsed::Salvaged(entries, mut failures) => {
                // Keep the original first; only then replace it.
                let backup = self.backup_path();
                fs::copy(&self.path, &backup).map_err(|e| io_error(e, "backing up", &self.path))?;
                self.recovered = Some(backup);
                failures.retain(|id, _| entries.iter().any(|e| &e.id == id));
                self.entries = entries;
                self.failures = failures;
                self.persist()?;
            }
            Parsed::OtherVersion(v) => {
                return Err(Error::Unsupported(format!(
                    "{} has version {v}; this Reskin understands version {JOURNAL_VERSION}",
                    self.path.display(),
                )));
            }
            Parsed::Damaged => {
                let backup = self.backup_path();
                fs::rename(&self.path, &backup)
                    .map_err(|e| io_error(e, "moving aside", &self.path))?;
                self.recovered = Some(backup);
                self.entries.clear();
                self.failures.clear();
                self.seen = None;
            }
        }
        Ok(())
    }

    /// `journal.json` → `journal.json.bak-<unix ms>`.
    fn backup_path(&self) -> PathBuf {
        let name = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "journal.json".to_owned());
        self.path
            .with_file_name(format!("{name}.bak-{}", now_ms() as u64))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Set when the journal found on disk (at [`Journal::load`] or a later
    /// reload) was damaged: the untouched file was saved here (entries it
    /// could still read were kept).
    pub fn recovered_backup(&self) -> Option<&Path> {
        self.recovered.as_deref()
    }

    /// Every entry, oldest first.
    pub fn entries(&self) -> &[HistoryEntry] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&HistoryEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// Why an entry failed, if it did and a reason was recorded.
    pub fn failure(&self, id: &str) -> Option<&str> {
        self.failures.get(id).map(String::as_str)
    }

    /// Entries not yet committed or failed.
    pub fn pending(&self) -> Vec<&HistoryEntry> {
        self.entries
            .iter()
            .filter(|e| e.state == EntryState::Pending)
            .collect()
    }

    /// Every entry for `target`, oldest first.
    pub fn entries_for(&self, target: &str) -> Vec<&HistoryEntry> {
        let key = target_key(target);
        self.entries
            .iter()
            .filter(|e| target_key(&e.target) == key)
            .collect()
    }

    /// The applied entry for `target` (what the target shows now).
    pub fn active_for(&self, target: &str) -> Option<&HistoryEntry> {
        let key = target_key(target);
        self.entries
            .iter()
            .rev()
            .find(|e| e.state == EntryState::Applied && target_key(&e.target) == key)
    }

    /// The icon `target` had before Reskin first changed it, if Reskin has
    /// an active (or in-flight) change on it.
    pub fn original_for(&self, target: &str) -> Option<&OriginalIcon> {
        let key = target_key(target);
        self.active_for(target)
            .or_else(|| {
                self.entries
                    .iter()
                    .rev()
                    .find(|e| e.state == EntryState::Pending && target_key(&e.target) == key)
            })
            .map(|e| &e.original)
    }

    fn index_of(&self, id: &str) -> Result<usize> {
        self.entries
            .iter()
            .position(|e| e.id == id)
            .ok_or_else(|| Error::NotFound(format!("history entry {id}")))
    }

    fn fresh_id(&self) -> String {
        loop {
            let id = store::new_id();
            if self.get(&id).is_none() {
                return id;
            }
        }
    }

    /// Records a change about to be made and persists it as `Pending`
    /// before returning, so the caller may then touch the target.
    ///
    /// If the target already has an applied entry, the new entry inherits
    /// that chain's first `original` and supersedes it (and stays a
    /// `CreatedShortcut` when the chain started as one). Fails if another
    /// change to the same target is still pending.
    pub fn begin(&mut self, new: NewEntry) -> Result<String> {
        self.locked(|j| j.begin_locked(new))
    }

    fn begin_locked(&mut self, new: NewEntry) -> Result<String> {
        let NewEntry {
            kind,
            mut target,
            name,
            system_icon,
            icon_path,
            original,
            elevated,
            thumb,
            design_name,
            group,
        } = new;
        if let Some(id) = system_icon {
            target = id.slug().to_owned();
        }
        if target.trim().is_empty() {
            return Err(Error::Other("a history entry needs a target".into()));
        }
        let key = target_key(&target);
        if self
            .entries
            .iter()
            .any(|e| e.state == EntryState::Pending && target_key(&e.target) == key)
        {
            return Err(Error::Other(format!(
                "another change to {name} is still in progress"
            )));
        }
        let (original, supersedes, kind) = match self.active_for(&target) {
            Some(active) => (
                active.original.clone(),
                Some(active.id.clone()),
                if active.kind == TargetKind::CreatedShortcut {
                    TargetKind::CreatedShortcut
                } else {
                    kind
                },
            ),
            None => (original, None, kind),
        };
        let id = self.fresh_id();
        self.entries.push(HistoryEntry {
            id: id.clone(),
            kind,
            target,
            name,
            system_icon,
            icon_path,
            original,
            state: EntryState::Pending,
            elevated,
            thumb,
            design_name,
            applied_at: now_ms(),
            restored_at: None,
            supersedes,
            group,
        });
        if let Err(e) = self.persist() {
            // Nothing was recorded, so the caller must not touch the target.
            self.entries.retain(|e| e.id != id);
            return Err(e);
        }
        Ok(id)
    }

    /// Marks entry `i` applied and the entry it supersedes superseded.
    fn activate(&mut self, i: usize) {
        self.entries[i].state = EntryState::Applied;
        if let Some(prev) = self.entries[i].supersedes.clone()
            && let Some(p) = self.entries.iter_mut().find(|e| e.id == prev)
            && p.state == EntryState::Applied
        {
            p.state = EntryState::Superseded;
        }
    }

    /// The target now uses the entry's icon: `Pending` → `Applied`, and the
    /// entry it supersedes → `Superseded`. Committing an applied entry is a
    /// no-op.
    pub fn commit(&mut self, id: &str) -> Result<()> {
        self.locked(|j| {
            let i = j.index_of(id)?;
            match j.entries[i].state {
                EntryState::Pending => {}
                EntryState::Applied => return Ok(()),
                other => {
                    return Err(Error::Other(format!(
                        "cannot commit history entry {id}: it is {other:?}"
                    )));
                }
            }
            j.activate(i);
            j.persist()
        })
    }

    /// Applying failed: `Pending` → `Failed`, remembering `message`.
    /// Failing an already failed entry is a no-op.
    pub fn fail(&mut self, id: &str, message: &str) -> Result<()> {
        self.locked(|j| {
            let i = j.index_of(id)?;
            match j.entries[i].state {
                EntryState::Pending => {}
                EntryState::Failed => return Ok(()),
                other => {
                    return Err(Error::Other(format!(
                        "cannot fail history entry {id}: it is {other:?}"
                    )));
                }
            }
            j.entries[i].state = EntryState::Failed;
            j.failures.insert(id.to_owned(), message.to_owned());
            j.persist()
        })
    }

    /// The target was restored to its original icon. Marking the applied
    /// entry also marks every superseded entry of its chain restored, since
    /// the whole chain is undone. Marking a restored entry is a no-op.
    pub fn mark_restored(&mut self, id: &str) -> Result<()> {
        self.locked(|j| {
            let i = j.index_of(id)?;
            let now = now_ms();
            match j.entries[i].state {
                EntryState::Restored => return Ok(()),
                EntryState::Applied => {
                    let key = target_key(&j.entries[i].target);
                    for e in &mut j.entries {
                        if e.state == EntryState::Superseded && target_key(&e.target) == key {
                            e.state = EntryState::Restored;
                            e.restored_at = Some(now);
                        }
                    }
                }
                EntryState::Superseded => {}
                other => {
                    return Err(Error::Other(format!(
                        "cannot mark history entry {id} restored: it is {other:?}"
                    )));
                }
            }
            j.entries[i].state = EntryState::Restored;
            j.entries[i].restored_at = Some(now);
            j.persist()
        })
    }

    // -- restore planning ---------------------------------------------------

    fn plan_for(&self, entry: &HistoryEntry, to: RestoreTo, scope: PlanScope) -> RestorePlan {
        RestorePlan {
            entry_id: entry.id.clone(),
            kind: entry.kind,
            target: entry.target.clone(),
            name: entry.name.clone(),
            system_icon: entry.system_icon,
            elevated: entry.elevated,
            to,
            scope,
        }
    }

    /// Plans undoing entry `id`, which must be the target's applied entry.
    ///
    /// If it replaced an earlier Reskin icon, the target is re-pointed at
    /// that icon ([`RestoreTo::Icon`]) and the earlier entry becomes active
    /// again. Otherwise the original comes back ([`RestoreTo::Original`]),
    /// or a shortcut Reskin created is deleted ([`RestoreTo::Delete`]).
    pub fn plan_undo(&self, id: &str) -> Result<RestorePlan> {
        let entry = &self.entries[self.index_of(id)?];
        if entry.state != EntryState::Applied {
            return Err(Error::Other(format!(
                "only the current icon can be undone; entry {id} is {:?}",
                entry.state
            )));
        }
        let previous = entry
            .supersedes
            .as_deref()
            .and_then(|p| self.get(p))
            .filter(|p| p.state == EntryState::Superseded);
        let to = match previous {
            Some(p) => RestoreTo::Icon(p.icon_path.clone()),
            None if entry.kind == TargetKind::CreatedShortcut => RestoreTo::Delete,
            None => RestoreTo::Original(entry.original.clone()),
        };
        let scope = PlanScope::Undo {
            previous: previous.map(|p| p.id.clone()),
        };
        Ok(self.plan_for(entry, to, scope))
    }

    /// The steps undoing entry `id` together with the entries applied with
    /// it — its group, e.g. matching pins — that are still their targets'
    /// applied entries; `id` comes first. Fails, like
    /// [`Journal::plan_undo`], when `id` is not its target's current icon.
    pub fn undo_steps(&self, id: &str) -> Result<Vec<RestoreStep>> {
        self.plan_undo(id)?;
        let group = self
            .entries
            .iter()
            .filter(|e| e.group.as_deref() == Some(id) && e.state == EntryState::Applied)
            .map(|e| RestoreStep::Undo(e.id.clone()));
        Ok(std::iter::once(RestoreStep::Undo(id.to_owned()))
            .chain(group)
            .collect())
    }

    /// One step per target Reskin has an applied change on, oldest first
    /// (the targets of [`Journal::plan_restore_all`]).
    pub fn restore_all_steps(&self) -> Vec<RestoreStep> {
        self.plan_restore_all()
            .into_iter()
            .map(|p| RestoreStep::Target(p.target))
            .collect()
    }

    /// Plans `step` on the journal as it is now. `None` when nothing is
    /// left to do: the target has no applied change any more, or the entry
    /// to undo was restored meanwhile. Undoing an entry that a newer change
    /// replaced since fails, as [`Journal::plan_undo`] does.
    pub fn plan_step(&self, step: &RestoreStep) -> Result<Option<RestorePlan>> {
        match step {
            RestoreStep::Undo(id) => match self.get(id) {
                Some(e) if e.state == EntryState::Restored => Ok(None),
                _ => self.plan_undo(id).map(Some),
            },
            RestoreStep::Target(target) => Ok(self.plan_restore_target(target)),
        }
    }

    /// Full restore of the chain whose applied entry is `active`.
    fn full_plan(&self, active: &HistoryEntry) -> RestorePlan {
        let key = target_key(&active.target);
        let chain: Vec<&HistoryEntry> = self
            .entries
            .iter()
            .filter(|e| {
                e.id == active.id
                    || (e.state == EntryState::Superseded && target_key(&e.target) == key)
            })
            .collect();
        let to = if chain.iter().any(|e| e.kind == TargetKind::CreatedShortcut) {
            RestoreTo::Delete
        } else {
            RestoreTo::Original(active.original.clone())
        };
        let scope = PlanScope::Full {
            chain: chain.iter().map(|e| e.id.clone()).collect(),
        };
        self.plan_for(active, to, scope)
    }

    /// Plans restoring `target` to its original icon (or deleting it if
    /// Reskin created it). `None` when Reskin has no applied change on it.
    pub fn plan_restore_target(&self, target: &str) -> Option<RestorePlan> {
        self.active_for(target).map(|active| self.full_plan(active))
    }

    /// One full-restore plan per target with an applied entry, oldest
    /// first. Pending entries are not included: run [`Journal::reconcile`]
    /// first (e.g. in `--restore-all`) so a change interrupted by a crash
    /// is restored too.
    pub fn plan_restore_all(&self) -> Vec<RestorePlan> {
        let mut seen = HashSet::new();
        let mut plans: Vec<RestorePlan> = self
            .entries
            .iter()
            .rev()
            .filter(|e| e.state == EntryState::Applied)
            .filter(|e| seen.insert(target_key(&e.target)))
            .map(|active| self.full_plan(active))
            .collect();
        plans.reverse();
        plans
    }

    /// Records the outcome of a plan. On success an undo marks its entry
    /// `Restored` and re-activates the previous entry; a full restore marks
    /// the whole chain `Restored`. A failed plan changes nothing, so it can
    /// be retried. Finishing a plan twice is harmless.
    ///
    /// A plan is only valid while its entry is the target's applied one.
    /// If the journal changed in between (another apply superseded the
    /// entry), the plan is stale: nothing is recorded and an error is
    /// returned, since marking it would leave two applied entries for one
    /// target. Plan, execute and finish within one [`Journal::locked`]
    /// call; a plan executed outside the lock (behind a UAC prompt) is
    /// planned again there afterwards ([`Journal::plan_step`]) and finished
    /// only if nothing changed.
    pub fn finish_plan(&mut self, plan: &RestorePlan, ok: bool) -> Result<()> {
        if !ok {
            return Ok(());
        }
        self.locked(|j| j.finish_plan_locked(plan))
    }

    fn finish_plan_locked(&mut self, plan: &RestorePlan) -> Result<()> {
        let i = self.index_of(&plan.entry_id)?;
        match self.entries[i].state {
            EntryState::Applied => {}
            EntryState::Restored => return Ok(()),
            other => {
                return Err(Error::Other(format!(
                    "cannot record the restore of history entry {}: it is {other:?} now",
                    plan.entry_id
                )));
            }
        }
        let now = now_ms();
        let restore = |entries: &mut [HistoryEntry], id: &str| {
            if let Some(e) = entries.iter_mut().find(|e| e.id == id)
                && e.state != EntryState::Restored
            {
                e.state = EntryState::Restored;
                e.restored_at = Some(now);
            }
        };
        match &plan.scope {
            PlanScope::Undo { previous } => {
                restore(&mut self.entries, &plan.entry_id);
                if let Some(prev) = previous
                    && let Some(p) = self.entries.iter_mut().find(|e| &e.id == prev)
                    && p.state == EntryState::Superseded
                {
                    p.state = EntryState::Applied;
                }
            }
            PlanScope::Full { chain } => {
                for id in chain {
                    restore(&mut self.entries, id);
                }
            }
        }
        self.persist()
    }

    // -- crash recovery -----------------------------------------------------

    /// Resolves entries left pending by a crash between `begin` and
    /// `commit`: each is committed when `probe` finds the target using its
    /// icon, and failed otherwise. Only for the app at startup, when no
    /// apply can be under way; other processes use
    /// [`Journal::reconcile_settled`].
    pub fn reconcile(
        &mut self,
        probe: impl FnMut(&HistoryEntry) -> Probe,
    ) -> Result<ReconcileReport> {
        self.reconcile_settled(probe, Duration::ZERO)
    }

    /// [`Journal::reconcile`] for a process that may run alongside the app
    /// (`--restore-all`): a pending entry younger than `grace` whose target
    /// does not use its icon yet may be an apply the app is still making,
    /// so it stays pending (listed in [`ReconcileReport::in_flight`]).
    pub fn reconcile_settled(
        &mut self,
        mut probe: impl FnMut(&HistoryEntry) -> Probe,
        grace: Duration,
    ) -> Result<ReconcileReport> {
        self.locked(|j| {
            let now = now_ms();
            let mut report = ReconcileReport::default();
            for i in 0..j.entries.len() {
                if j.entries[i].state != EntryState::Pending {
                    continue;
                }
                let id = j.entries[i].id.clone();
                let young = now - j.entries[i].applied_at < grace.as_millis() as f64;
                let reason = match probe(&j.entries[i]) {
                    Probe::PointsToIcon => {
                        j.activate(i);
                        report.applied.push(id);
                        continue;
                    }
                    Probe::PointsElsewhere if young => {
                        report.in_flight.push(id);
                        continue;
                    }
                    Probe::PointsElsewhere => "Reskin stopped before the icon was applied",
                    Probe::Missing => "the item no longer exists",
                };
                j.entries[i].state = EntryState::Failed;
                j.failures.insert(id.clone(), reason.to_owned());
                report.failed.push(id);
            }
            if !report.is_empty() {
                j.persist()?;
            }
            Ok(report)
        })
    }

    // -- icon garbage collection -------------------------------------------

    /// Icons still in use or needed for undo/restore: those of pending,
    /// applied and superseded entries.
    pub fn referenced_icons(&self) -> HashSet<PathBuf> {
        self.referenced_except(&HashSet::new())
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }

    /// Icon paths of pending, applied and superseded entries not in `done`.
    fn referenced_except(&self, done: &HashSet<&str>) -> Vec<&str> {
        self.entries
            .iter()
            .filter(|e| {
                matches!(
                    e.state,
                    EntryState::Pending | EntryState::Applied | EntryState::Superseded
                ) && !done.contains(e.id.as_str())
            })
            .filter(|e| !e.icon_path.is_empty())
            .map(|e| e.icon_path.as_str())
            .collect()
    }

    /// File names of icons directly in `dir` that entries of this journal
    /// point at and that no entry needs any more once `plans` succeeded
    /// (every entry they restore is then `Restored`).
    ///
    /// For the machine-wide Public-Desktop icons, which only the elevated
    /// helper can delete: unlike [`Journal::gc_icons`] this never lists the
    /// folder, whose other files may belong to other users' journals. Paths
    /// and file names compare as in [`Journal::gc_icons_older_than`].
    pub fn icons_released_by(&self, plans: &[RestorePlan], dir: &str) -> Vec<String> {
        let done: HashSet<&str> = plans
            .iter()
            .flat_map(|p| match &p.scope {
                PlanScope::Undo { .. } => vec![p.entry_id.as_str()],
                PlanScope::Full { chain } => chain.iter().map(String::as_str).collect(),
            })
            .collect();
        let still_needed = self.referenced_except(&done);
        let keep_paths: HashSet<String> = still_needed
            .iter()
            .map(|p| paths::normalize_for_compare(p))
            .collect();
        let keep_names: HashSet<String> = still_needed
            .iter()
            .map(|p| paths::file_name_of(p).to_lowercase())
            .collect();
        let released: BTreeSet<&str> = self
            .entries
            .iter()
            .map(|e| e.icon_path.as_str())
            .filter(|p| paths::is_directly_under(p, dir))
            .filter(|p| {
                let name = paths::file_name_of(p);
                paths::is_valid_public_icon_name(name)
                    && !keep_names.contains(&name.to_lowercase())
                    && !keep_paths.contains(&paths::normalize_for_compare(p))
            })
            .map(paths::file_name_of)
            .collect();
        released.into_iter().map(str::to_owned).collect()
    }

    /// Deletes `*.ico` files in `dir` that no entry references, skipping
    /// files younger than [`GC_GRACE`]. Returns how many were deleted.
    ///
    /// The grace period makes it safe to run while another thread is
    /// between [`store::store_icon`] and [`Journal::begin`]; icons of a
    /// change that was restored moments ago are collected by a later run.
    /// Use [`Journal::gc_icons_older_than`] with `Duration::ZERO` only when
    /// no apply can be in flight.
    pub fn gc_icons(&self, dir: &Path) -> Result<u32> {
        self.gc_icons_older_than(dir, GC_GRACE)
    }

    /// [`Journal::gc_icons`] with an explicit grace period
    /// (`Duration::ZERO` collects everything unreferenced).
    ///
    /// Only regular files ending in `.ico` directly in `dir` are touched.
    /// Paths are compared case-insensitively; a file is also kept when a
    /// referenced icon has the same file name (content-hashed names make
    /// that the same icon), which errs on the side of keeping files when
    /// the directory was spelled differently (8.3 names, junctions). Files
    /// that cannot be deleted are left for the next run.
    pub fn gc_icons_older_than(&self, dir: &Path, min_age: Duration) -> Result<u32> {
        let referenced = self.referenced_icons();
        let mut keep_paths = HashSet::new();
        let mut keep_names = HashSet::new();
        for path in &referenced {
            let s = path.to_string_lossy();
            keep_paths.insert(paths::normalize_for_compare(&s));
            keep_names.insert(paths::file_name_of(&s).to_lowercase());
        }
        let read_dir = match fs::read_dir(dir) {
            Ok(r) => r,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(io_error(e, "listing", dir)),
        };
        let now = SystemTime::now();
        let mut removed = 0;
        for dirent in read_dir.flatten() {
            if !dirent.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let file_name = dirent.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let lower = name.to_lowercase();
            if !lower.ends_with(".ico") || keep_names.contains(&lower) {
                continue;
            }
            let path = dirent.path();
            if keep_paths.contains(&paths::normalize_for_compare(&path.to_string_lossy())) {
                continue;
            }
            if !min_age.is_zero() {
                let modified = dirent.metadata().and_then(|m| m.modified());
                // Unknown or future timestamps count as young.
                let old_enough = modified
                    .ok()
                    .and_then(|m| now.duration_since(m).ok())
                    .is_some_and(|age| age >= min_age);
                if !old_enough {
                    continue;
                }
            }
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    // -- persistence ----------------------------------------------------------

    /// Drops the oldest finished entries beyond [`MAX_INACTIVE_ENTRIES`]:
    /// restored and failed ones first, then superseded ones (whose loss
    /// only makes an undo go straight back to the original).
    fn prune(&mut self) {
        let inactive = self
            .entries
            .iter()
            .filter(|e| !matches!(e.state, EntryState::Pending | EntryState::Applied))
            .count();
        let Some(mut excess) = inactive.checked_sub(MAX_INACTIVE_ENTRIES) else {
            return;
        };
        if excess == 0 {
            return;
        }
        let mut drop = vec![false; self.entries.len()];
        for pass in [
            &[EntryState::Restored, EntryState::Failed][..],
            &[EntryState::Superseded][..],
        ] {
            for (i, e) in self.entries.iter().enumerate() {
                if excess == 0 {
                    break;
                }
                if pass.contains(&e.state) {
                    drop[i] = true;
                    excess -= 1;
                }
            }
        }
        let mut flags = drop.into_iter();
        self.entries.retain(|_| !flags.next().unwrap_or(false));
        let ids: HashSet<&str> = self.entries.iter().map(|e| e.id.as_str()).collect();
        self.failures.retain(|id, _| ids.contains(id.as_str()));
    }

    /// Writes the journal (under the lock: only called inside
    /// [`Journal::locked`]). If the write fails, the next operation reloads
    /// the file, so what is not on disk is not kept either.
    fn persist(&mut self) -> Result<()> {
        debug_assert!(self.held, "journal written without its lock");
        self.prune();
        let mut bytes = serde_json::to_vec_pretty(&JournalFileRef {
            version: JOURNAL_VERSION,
            entries: &self.entries,
            failures: &self.failures,
        })?;
        bytes.push(b'\n');
        self.seen = None;
        store::write_atomic(&self.path, &bytes)?;
        self.seen = Some(paths::sha256_hex(&bytes));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_lock_times_out_with_a_clear_error_and_frees_on_drop() {
        let dir = std::env::temp_dir().join(format!(
            "reskin-lock-timeout-{}-{}",
            std::process::id(),
            now_ms() as u64
        ));
        let path = dir.join("journal.json.lock");
        let held = FileLock::acquire(&path, Duration::ZERO).unwrap();
        let started = Instant::now();
        let err = FileLock::acquire(&path, Duration::from_millis(150))
            .err()
            .unwrap()
            .to_string();
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(err.contains("in use by another Reskin process"), "{err}");
        assert!(err.contains("journal.json.lock"), "{err}");
        drop(held);
        assert!(FileLock::acquire(&path, Duration::ZERO).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}

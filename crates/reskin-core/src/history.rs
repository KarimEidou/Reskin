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
//!
//! Targets are compared case-insensitively after
//! [`paths::normalize_for_compare`]; system icons use their slug as the
//! target. The file is rewritten atomically after every mutation.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::model::{EntryState, HistoryEntry, OriginalIcon, SystemIconId, TargetKind};
use crate::store::io_error;
use crate::{Error, Result, now_ms, paths, store};

/// Version of `journal.json`.
pub const JOURNAL_VERSION: u32 = 1;

/// At most this many finished (restored / failed / superseded) entries are
/// kept; the oldest restored and failed ones go first.
pub const MAX_INACTIVE_ENTRIES: usize = 500;

/// [`Journal::gc_icons`] leaves icons younger than this alone, so an icon
/// that was just stored but whose entry is not begun yet survives a GC
/// running concurrently.
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
}

impl ReconcileReport {
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

#[derive(Deserialize)]
struct VersionProbe {
    version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalFile {
    // `version` is read through `VersionProbe` first.
    entries: Vec<HistoryEntry>,
    #[serde(default)]
    failures: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalFileRef<'a> {
    version: u32,
    entries: &'a [HistoryEntry],
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    failures: &'a BTreeMap<String, String>,
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
    /// Where a damaged journal was moved on load.
    recovered: Option<PathBuf>,
}

/// Comparison key for targets (paths case-insensitively, slugs as-is).
fn target_key(target: &str) -> String {
    paths::normalize_for_compare(target)
}

impl Journal {
    /// Opens the journal at `path`. A missing file is an empty journal. A
    /// damaged file is moved aside to `journal.json.bak-<unix ms>` (see
    /// [`Journal::recovered_backup`]) and an empty journal is returned; a
    /// journal written by a newer Reskin is refused rather than clobbered.
    pub fn load(path: impl Into<PathBuf>) -> Result<Journal> {
        let path = path.into();
        let mut journal = Journal {
            path,
            entries: Vec::new(),
            failures: BTreeMap::new(),
            recovered: None,
        };
        let bytes = match fs::read(&journal.path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(journal),
            Err(e) => return Err(io_error(e, "reading", &journal.path)),
        };
        let body = store::strip_bom(&bytes);
        let version = serde_json::from_slice::<VersionProbe>(body).map(|p| p.version);
        if let Ok(v) = version
            && v != JOURNAL_VERSION
        {
            return Err(Error::Unsupported(format!(
                "{} has version {v}; this Reskin understands version {JOURNAL_VERSION}",
                journal.path.display(),
            )));
        }
        match (version, serde_json::from_slice::<JournalFile>(body)) {
            (Ok(_), Ok(file)) => {
                journal.entries = file.entries;
                journal.failures = file.failures;
            }
            _ => {
                let name = journal
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "journal.json".to_owned());
                let backup = journal
                    .path
                    .with_file_name(format!("{name}.bak-{}", now_ms() as u64));
                fs::rename(&journal.path, &backup)
                    .map_err(|e| io_error(e, "moving aside", &journal.path))?;
                journal.recovered = Some(backup);
            }
        }
        Ok(journal)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Set when [`Journal::load`] found a damaged journal and moved it here.
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
        let i = self.index_of(id)?;
        match self.entries[i].state {
            EntryState::Pending => {}
            EntryState::Applied => return Ok(()),
            other => {
                return Err(Error::Other(format!(
                    "cannot commit history entry {id}: it is {other:?}"
                )));
            }
        }
        self.activate(i);
        self.persist()
    }

    /// Applying failed: `Pending` → `Failed`, remembering `message`.
    /// Failing an already failed entry is a no-op.
    pub fn fail(&mut self, id: &str, message: &str) -> Result<()> {
        let i = self.index_of(id)?;
        match self.entries[i].state {
            EntryState::Pending => {}
            EntryState::Failed => return Ok(()),
            other => {
                return Err(Error::Other(format!(
                    "cannot fail history entry {id}: it is {other:?}"
                )));
            }
        }
        self.entries[i].state = EntryState::Failed;
        self.failures.insert(id.to_owned(), message.to_owned());
        self.persist()
    }

    /// The target was restored to its original icon. Marking the applied
    /// entry also marks every superseded entry of its chain restored, since
    /// the whole chain is undone. Marking a restored entry is a no-op.
    pub fn mark_restored(&mut self, id: &str) -> Result<()> {
        let i = self.index_of(id)?;
        let now = now_ms();
        match self.entries[i].state {
            EntryState::Restored => return Ok(()),
            EntryState::Applied => {
                let key = target_key(&self.entries[i].target);
                for e in &mut self.entries {
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
        self.entries[i].state = EntryState::Restored;
        self.entries[i].restored_at = Some(now);
        self.persist()
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
    /// first.
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
    /// be retried.
    pub fn finish_plan(&mut self, plan: &RestorePlan, ok: bool) -> Result<()> {
        if !ok {
            return Ok(());
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
    /// icon, and failed otherwise.
    pub fn reconcile(
        &mut self,
        mut probe: impl FnMut(&HistoryEntry) -> Probe,
    ) -> Result<ReconcileReport> {
        let mut report = ReconcileReport::default();
        for i in 0..self.entries.len() {
            if self.entries[i].state != EntryState::Pending {
                continue;
            }
            let id = self.entries[i].id.clone();
            let reason = match probe(&self.entries[i]) {
                Probe::PointsToIcon => {
                    self.activate(i);
                    report.applied.push(id);
                    continue;
                }
                Probe::PointsElsewhere => "Reskin stopped before the icon was applied",
                Probe::Missing => "the item no longer exists",
            };
            self.entries[i].state = EntryState::Failed;
            self.failures.insert(id.clone(), reason.to_owned());
            report.failed.push(id);
        }
        if !report.is_empty() {
            self.persist()?;
        }
        Ok(report)
    }

    // -- icon garbage collection -------------------------------------------

    /// Icons still in use or needed for undo/restore: those of pending,
    /// applied and superseded entries.
    pub fn referenced_icons(&self) -> HashSet<PathBuf> {
        self.entries
            .iter()
            .filter(|e| {
                matches!(
                    e.state,
                    EntryState::Pending | EntryState::Applied | EntryState::Superseded
                )
            })
            .filter(|e| !e.icon_path.is_empty())
            .map(|e| PathBuf::from(&e.icon_path))
            .collect()
    }

    /// Deletes `*.ico` files in `dir` that no entry references, skipping
    /// files younger than [`GC_GRACE`]. Returns how many were deleted.
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

    fn persist(&mut self) -> Result<()> {
        self.prune();
        store::write_json(
            &self.path,
            &JournalFileRef {
                version: JOURNAL_VERSION,
                entries: &self.entries,
                failures: &self.failures,
            },
        )
    }
}

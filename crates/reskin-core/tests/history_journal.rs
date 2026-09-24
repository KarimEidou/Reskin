//! The apply journal: begin/commit, crash reconciliation, chains, undo,
//! restore plans, persistence, icon GC and the size cap.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use reskin_core::Error;
use reskin_core::history::{
    GC_GRACE, Journal, MAX_INACTIVE_ENTRIES, NewEntry, PlanScope, Probe, RestoreTo,
};
use reskin_core::model::{EntryState, HistoryEntry, OriginalIcon, SystemIconId, TargetKind};

/// A unique temp directory, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "reskin-journal-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn journal_path(&self) -> PathBuf {
        self.0.join("journal.json")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const APP: &str = r"C:\Users\Kim\Desktop\App.lnk";

fn original(location: &str, index: i32) -> OriginalIcon {
    OriginalIcon {
        location: Some(location.into()),
        index,
        existed: true,
    }
}

fn entry(target: &str, icon: &str, current: OriginalIcon) -> NewEntry {
    NewEntry {
        kind: TargetKind::Shortcut,
        target: target.into(),
        name: "App".into(),
        system_icon: None,
        icon_path: icon.into(),
        original: current,
        elevated: false,
        thumb: Some("dGh1bWI=".into()),
        design_name: Some("Neon".into()),
    }
}

fn state(j: &Journal, id: &str) -> EntryState {
    j.get(id).unwrap().state
}

/// begin + commit.
fn apply(j: &mut Journal, target: &str, icon: &str, current: OriginalIcon) -> String {
    let id = j.begin(entry(target, icon, current)).unwrap();
    j.commit(&id).unwrap();
    id
}

/// Three applies on one target; the caller reads the target's current icon
/// each time, which after the first apply is Reskin's own.
fn chain_of_three(j: &mut Journal) -> [String; 3] {
    let a = apply(j, APP, r"C:\icons\a.ico", original(r"C:\Apps\app.exe", 2));
    let b = apply(j, APP, r"C:\icons\b.ico", original(r"C:\icons\a.ico", 0));
    let c = apply(j, APP, r"C:\icons\c.ico", original(r"C:\icons\b.ico", 0));
    [a, b, c]
}

#[test]
fn begin_persists_pending_then_commit_applies() {
    let tmp = TempDir::new("commit");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    assert!(j.entries().is_empty());

    let id = j
        .begin(entry(APP, r"C:\icons\a.ico", original("app.exe", 0)))
        .unwrap();
    // On disk before the caller touches the target.
    let on_disk = Journal::load(tmp.journal_path()).unwrap();
    assert_eq!(on_disk.pending().len(), 1);
    assert_eq!(on_disk.get(&id).unwrap().state, EntryState::Pending);
    assert!(j.active_for(APP).is_none());
    assert_eq!(j.original_for(APP), Some(&original("app.exe", 0)));

    j.commit(&id).unwrap();
    let e = j.active_for(&APP.to_uppercase()).unwrap();
    assert_eq!(e.id, id);
    assert_eq!(e.state, EntryState::Applied);
    assert_eq!(e.supersedes, None);
    assert!(e.applied_at > 0.0);
    assert_eq!(e.restored_at, None);
    assert_eq!(e.design_name.as_deref(), Some("Neon"));
    // Case and separators do not matter.
    assert!(j.active_for("c:/users/kim/desktop/app.lnk").is_some());
    assert!(j.pending().is_empty());
    assert_eq!(
        Journal::load(tmp.journal_path()).unwrap().entries(),
        j.entries()
    );
    // Committing again is harmless.
    j.commit(&id).unwrap();
}

#[test]
fn invalid_transitions_are_refused() {
    let tmp = TempDir::new("transitions");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let id = j.begin(entry(APP, "a.ico", original("x", 0))).unwrap();
    // A second change to the same target while one is in flight.
    let err = j.begin(entry(APP, "b.ico", original("x", 0))).unwrap_err();
    assert!(err.to_string().contains("in progress"), "{err}");

    j.fail(&id, "disk full").unwrap();
    assert_eq!(state(&j, &id), EntryState::Failed);
    assert_eq!(j.failure(&id), Some("disk full"));
    j.fail(&id, "again").unwrap();
    assert!(j.commit(&id).is_err());

    let ok = apply(&mut j, APP, "c.ico", original("x", 0));
    assert!(j.fail(&ok, "late").is_err());
    assert!(matches!(j.commit("nope"), Err(Error::NotFound(_))));
    assert!(matches!(j.fail("nope", "x"), Err(Error::NotFound(_))));
    assert!(matches!(j.mark_restored("nope"), Err(Error::NotFound(_))));
    assert!(j.begin(entry("  ", "d.ico", original("x", 0))).is_err());
}

#[test]
fn crash_between_begin_and_commit_reconciles_as_applied() {
    let tmp = TempDir::new("reconcile-applied");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let first = apply(&mut j, APP, "a.ico", original("app.exe", 1));
    let id = j.begin(entry(APP, "b.ico", original("a.ico", 0))).unwrap();
    drop(j); // crash: commit never happens

    let mut j = Journal::load(tmp.journal_path()).unwrap();
    assert_eq!(j.pending().len(), 1);
    let mut probed = Vec::new();
    let report = j
        .reconcile(|e| {
            probed.push(e.id.clone());
            Probe::PointsToIcon
        })
        .unwrap();
    assert_eq!(probed, vec![id.clone()]);
    assert_eq!(report.applied, vec![id.clone()]);
    assert!(report.failed.is_empty());
    assert_eq!(state(&j, &id), EntryState::Applied);
    assert_eq!(state(&j, &first), EntryState::Superseded);
    assert_eq!(j.active_for(APP).unwrap().id, id);

    let reloaded = Journal::load(tmp.journal_path()).unwrap();
    assert_eq!(reloaded.entries(), j.entries());
    // Nothing left to do.
    assert!(j.reconcile(|_| Probe::Missing).unwrap().is_empty());
}

#[test]
fn crash_between_begin_and_commit_reconciles_as_failed() {
    let tmp = TempDir::new("reconcile-failed");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let first = apply(&mut j, APP, "a.ico", original("app.exe", 1));
    let elsewhere = j.begin(entry(APP, "b.ico", original("a.ico", 0))).unwrap();
    let gone_target = r"C:\Users\Kim\Desktop\Gone.lnk";
    let gone = j
        .begin(entry(gone_target, "g.ico", original("g.exe", 0)))
        .unwrap();
    drop(j);

    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let report = j
        .reconcile(|e| {
            if e.target == gone_target {
                Probe::Missing
            } else {
                Probe::PointsElsewhere
            }
        })
        .unwrap();
    assert!(report.applied.is_empty());
    assert_eq!(report.failed, vec![elsewhere.clone(), gone.clone()]);
    assert_eq!(state(&j, &elsewhere), EntryState::Failed);
    assert_eq!(state(&j, &gone), EntryState::Failed);
    assert!(j.failure(&gone).unwrap().contains("no longer exists"));
    assert!(j.failure(&elsewhere).is_some());
    // The earlier change is still what the target shows.
    assert_eq!(state(&j, &first), EntryState::Applied);
    assert_eq!(j.active_for(APP).unwrap().id, first);

    let reloaded = Journal::load(tmp.journal_path()).unwrap();
    assert_eq!(reloaded.failure(&gone), j.failure(&gone));
    // A new apply works again after reconciliation.
    apply(&mut j, APP, "c.ico", original("a.ico", 0));
}

#[test]
fn chains_keep_the_first_original() {
    let tmp = TempDir::new("chain");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let [a, b, c] = chain_of_three(&mut j);
    let first_original = original(r"C:\Apps\app.exe", 2);

    let (ea, eb, ec) = (j.get(&a).unwrap(), j.get(&b).unwrap(), j.get(&c).unwrap());
    for e in [ea, eb, ec] {
        assert_eq!(e.original, first_original, "{}", e.id);
    }
    assert_eq!(ea.supersedes, None);
    assert_eq!(eb.supersedes.as_deref(), Some(a.as_str()));
    assert_eq!(ec.supersedes.as_deref(), Some(b.as_str()));
    assert_eq!(ea.state, EntryState::Superseded);
    assert_eq!(eb.state, EntryState::Superseded);
    assert_eq!(ec.state, EntryState::Applied);
    assert_eq!(j.active_for(APP).unwrap().id, c);
    assert_eq!(j.original_for(APP), Some(&first_original));
    assert_eq!(j.entries_for(&APP.to_lowercase()).len(), 3);

    // While a re-apply is pending, the previous entry is still active.
    let d = j
        .begin(entry(APP, r"C:\icons\d.ico", original("c.ico", 0)))
        .unwrap();
    assert_eq!(j.get(&d).unwrap().original, first_original);
    assert_eq!(j.active_for(APP).unwrap().id, c);
    j.commit(&d).unwrap();
    assert_eq!(state(&j, &c), EntryState::Superseded);
}

#[test]
fn undo_repoints_to_the_previous_icon() {
    let tmp = TempDir::new("undo");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let [a, b, c] = chain_of_three(&mut j);

    // Only the applied entry can be undone.
    assert!(j.plan_undo(&b).is_err());
    assert!(j.plan_undo("missing").is_err());

    let plan = j.plan_undo(&c).unwrap();
    assert_eq!(plan.entry_id, c);
    assert_eq!(plan.target, APP);
    assert_eq!(plan.to, RestoreTo::Icon(r"C:\icons\b.ico".into()));
    assert_eq!(
        plan.scope,
        PlanScope::Undo {
            previous: Some(b.clone())
        }
    );
    // A failed restore changes nothing.
    j.finish_plan(&plan, false).unwrap();
    assert_eq!(state(&j, &c), EntryState::Applied);

    j.finish_plan(&plan, true).unwrap();
    assert_eq!(state(&j, &c), EntryState::Restored);
    assert!(j.get(&c).unwrap().restored_at.is_some());
    assert_eq!(state(&j, &b), EntryState::Applied);
    assert_eq!(j.active_for(APP).unwrap().id, b);

    let plan = j.plan_undo(&b).unwrap();
    assert_eq!(plan.to, RestoreTo::Icon(r"C:\icons\a.ico".into()));
    j.finish_plan(&plan, true).unwrap();
    assert_eq!(j.active_for(APP).unwrap().id, a);

    let plan = j.plan_undo(&a).unwrap();
    assert_eq!(
        plan.to,
        RestoreTo::Original(original(r"C:\Apps\app.exe", 2))
    );
    assert_eq!(plan.scope, PlanScope::Undo { previous: None });
    j.finish_plan(&plan, true).unwrap();
    assert!(j.active_for(APP).is_none());
    assert!(j.entries().iter().all(|e| e.state == EntryState::Restored));
    assert_eq!(
        Journal::load(tmp.journal_path()).unwrap().entries(),
        j.entries()
    );
}

#[test]
fn created_shortcuts_are_deleted_on_undo_and_restore() {
    let tmp = TempDir::new("created");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let target = r"C:\Users\Kim\Desktop\Tool (Reskin).lnk";
    let mut created = entry(target, "t1.ico", OriginalIcon::default());
    created.kind = TargetKind::CreatedShortcut;
    let first = j.begin(created).unwrap();
    j.commit(&first).unwrap();
    assert_eq!(j.plan_undo(&first).unwrap().to, RestoreTo::Delete);

    // Re-applying to the created shortcut keeps it a created shortcut.
    let second = apply(&mut j, target, "t2.ico", original("t1.ico", 0));
    assert_eq!(j.get(&second).unwrap().kind, TargetKind::CreatedShortcut);
    assert_eq!(
        j.plan_undo(&second).unwrap().to,
        RestoreTo::Icon("t1.ico".into())
    );
    let plan = j.plan_restore_target(target).unwrap();
    assert_eq!(plan.to, RestoreTo::Delete);
    assert_eq!(
        plan.scope,
        PlanScope::Full {
            chain: vec![first.clone(), second.clone()]
        }
    );
}

#[test]
fn restore_all_plans_one_full_restore_per_target() {
    let tmp = TempDir::new("restore-all");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let t1 = r"C:\Users\Kim\Desktop\One.lnk";
    let t2 = r"C:\Users\Kim\Desktop\Two.url";
    let t3 = r"C:\Users\Kim\Desktop\Three (Reskin).lnk";
    let t4 = r"C:\Users\Kim\Desktop\Four.lnk";
    let t5 = r"C:\Users\Kim\Desktop\Five.lnk";

    let one_a = apply(&mut j, t1, "1a.ico", original("one.exe", 0));
    let one_b = apply(&mut j, t1, "1b.ico", original("1a.ico", 0));
    let mut two = entry(t2, "2.ico", original("steam.exe", 0));
    two.kind = TargetKind::InternetShortcut;
    two.elevated = true;
    let two = j.begin(two).unwrap();
    j.commit(&two).unwrap();
    let mut three = entry(t3, "3.ico", OriginalIcon::default());
    three.kind = TargetKind::CreatedShortcut;
    let three = j.begin(three).unwrap();
    j.commit(&three).unwrap();
    let four = apply(&mut j, t4, "4.ico", original("four.exe", 0));
    j.mark_restored(&four).unwrap();
    let five = j
        .begin(entry(t5, "5.ico", original("five.exe", 0)))
        .unwrap();
    j.fail(&five, "locked").unwrap();
    let mut sys = entry("ignored", "sys.ico", original("imageres.dll", -55));
    sys.kind = TargetKind::SystemIcon;
    sys.system_icon = Some(SystemIconId::ThisPc);
    let sys = j.begin(sys).unwrap();
    j.commit(&sys).unwrap();

    let plans = j.plan_restore_all();
    let targets: Vec<&str> = plans.iter().map(|p| p.target.as_str()).collect();
    assert_eq!(targets, [t1, t2, t3, "this-pc"]);

    assert_eq!(plans[0].entry_id, one_b);
    assert_eq!(plans[0].to, RestoreTo::Original(original("one.exe", 0)));
    assert_eq!(
        plans[0].scope,
        PlanScope::Full {
            chain: vec![one_a.clone(), one_b.clone()]
        }
    );
    assert_eq!(plans[1].kind, TargetKind::InternetShortcut);
    assert!(plans[1].elevated);
    assert_eq!(plans[2].to, RestoreTo::Delete);
    assert_eq!(plans[3].system_icon, Some(SystemIconId::ThisPc));
    assert_eq!(
        plans[3].to,
        RestoreTo::Original(original("imageres.dll", -55))
    );
    for p in &plans {
        assert!(matches!(p.to, RestoreTo::Original(_) | RestoreTo::Delete));
    }
    assert_eq!(
        j.plan_restore_target(&t1.to_uppercase()),
        Some(plans[0].clone())
    );
    assert_eq!(j.plan_restore_target(t4), None);

    // One restore fails: it stays applied and can be retried.
    for (i, p) in plans.iter().enumerate() {
        j.finish_plan(p, i != 1).unwrap();
    }
    for id in [&one_a, &one_b, &three, &sys] {
        assert_eq!(state(&j, id), EntryState::Restored, "{id}");
    }
    assert_eq!(state(&j, &two), EntryState::Applied);
    assert_eq!(j.plan_restore_all().len(), 1);
    assert_eq!(
        j.referenced_icons(),
        HashSet::from([PathBuf::from("2.ico")])
    );
}

#[test]
fn mark_restored_finishes_the_whole_chain() {
    let tmp = TempDir::new("mark-restored");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let other = apply(
        &mut j,
        r"C:\Users\Kim\Desktop\Other.lnk",
        "o.ico",
        original("o.exe", 0),
    );
    let [a, b, c] = chain_of_three(&mut j);
    j.mark_restored(&c).unwrap();
    for id in [&a, &b, &c] {
        assert_eq!(state(&j, id), EntryState::Restored);
    }
    assert_eq!(state(&j, &other), EntryState::Applied);
    j.mark_restored(&c).unwrap();
    let pending = j.begin(entry(APP, "p.ico", original("x", 0))).unwrap();
    assert!(j.mark_restored(&pending).is_err());
}

#[test]
fn system_icons_are_keyed_by_slug() {
    let tmp = TempDir::new("system");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let mut first = entry("Recycle Bin", "r1.ico", original("imageres.dll", -55));
    first.kind = TargetKind::SystemIcon;
    first.system_icon = Some(SystemIconId::RecycleBinEmpty);
    let mut second = first.clone();
    second.icon_path = "r2.ico".into();
    second.original = original("r1.ico", 0);
    second.target = "whatever the caller passed".into();

    let a = j.begin(first).unwrap();
    j.commit(&a).unwrap();
    assert_eq!(j.get(&a).unwrap().target, "recycle-bin-empty");
    let b = j.begin(second).unwrap();
    j.commit(&b).unwrap();
    assert_eq!(state(&j, &a), EntryState::Superseded);
    let active = j.active_for("Recycle-Bin-Empty").unwrap();
    assert_eq!(active.id, b);
    assert_eq!(active.original, original("imageres.dll", -55));
    assert!(j.active_for("recycle-bin-full").is_none());
}

#[test]
fn persistence_round_trips_everything() {
    let tmp = TempDir::new("persist");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    chain_of_three(&mut j);
    let failed = j
        .begin(entry(r"C:\x\Y.lnk", "y.ico", original("y", 0)))
        .unwrap();
    j.fail(&failed, "nope").unwrap();

    let reloaded = Journal::load(tmp.journal_path()).unwrap();
    assert_eq!(reloaded.entries(), j.entries());
    assert_eq!(reloaded.failure(&failed), Some("nope"));
    assert_eq!(reloaded.path(), tmp.journal_path());
    assert_eq!(reloaded.recovered_backup(), None);

    let raw: serde_json::Value =
        serde_json::from_slice(&fs::read(tmp.journal_path()).unwrap()).unwrap();
    assert_eq!(raw["version"], 1);
    assert_eq!(raw["entries"].as_array().unwrap().len(), 4);
    assert_eq!(raw["entries"][0]["iconPath"], r"C:\icons\a.ico");
    assert_eq!(raw["failures"][failed.as_str()], "nope");
    // No temp files are left next to the journal.
    let names: Vec<String> = fs::read_dir(tmp.path())
        .unwrap()
        .map(|d| d.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["journal.json"]);
}

#[test]
fn damaged_journals_are_moved_aside_and_newer_ones_refused() {
    let tmp = TempDir::new("damaged");
    fs::write(tmp.journal_path(), b"{\"version\":1,\"entries\":[{\"id\":").unwrap();
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    assert!(j.entries().is_empty());
    let backup = j.recovered_backup().unwrap().to_path_buf();
    assert!(
        backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("journal.json.bak-")
    );
    assert_eq!(
        fs::read(&backup).unwrap(),
        b"{\"version\":1,\"entries\":[{\"id\":"
    );
    assert!(!tmp.journal_path().exists());
    apply(&mut j, APP, "a.ico", original("x", 0));
    assert_eq!(
        Journal::load(tmp.journal_path()).unwrap().entries().len(),
        1
    );

    let newer = TempDir::new("newer");
    let body = br#"{"version":2,"entries":[],"shiny":true}"#;
    fs::write(newer.journal_path(), body).unwrap();
    assert!(matches!(
        Journal::load(newer.journal_path()),
        Err(Error::Unsupported(_))
    ));
    assert_eq!(fs::read(newer.journal_path()).unwrap(), body);
}

#[test]
fn a_failed_write_in_begin_records_nothing() {
    let tmp = TempDir::new("begin-fails");
    let mut j = Journal::load(tmp.journal_path()).unwrap();
    // A directory where the journal file should go makes the write fail.
    fs::create_dir_all(tmp.journal_path().join("blocker")).unwrap();
    assert!(j.begin(entry(APP, "a.ico", original("x", 0))).is_err());
    assert!(j.entries().is_empty());
    assert!(j.pending().is_empty());
}

// ---------------------------------------------------------------------------
// Icon GC
// ---------------------------------------------------------------------------

fn touch(path: &Path) {
    fs::write(path, b"ico").unwrap();
}

fn age(path: &Path, by: Duration) {
    let file = fs::File::options().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - by).unwrap();
}

#[test]
fn gc_keeps_referenced_icons_and_deletes_others() {
    let tmp = TempDir::new("gc");
    let icons = tmp.path().join("icons");
    fs::create_dir_all(icons.join("nested.ico")).unwrap();
    let p = |name: &str| icons.join(name);
    for name in [
        "applied.ico",
        "superseded.ico",
        "pending.ico",
        "restored.ico",
        "failed.ico",
        "orphan.ico",
        "Mixed-Case.ICO",
        "notes.txt",
        "icon.ico.bak",
    ] {
        touch(&p(name));
    }

    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let s = |path: PathBuf| path.to_string_lossy().into_owned();
    apply(&mut j, APP, &s(p("superseded.ico")), original("x", 0));
    apply(&mut j, APP, &s(p("applied.ico")), original("x", 0));
    j.begin(entry(r"C:\P.lnk", &s(p("pending.ico")), original("x", 0)))
        .unwrap();
    let restored = apply(&mut j, r"C:\R.lnk", &s(p("restored.ico")), original("x", 0));
    j.mark_restored(&restored).unwrap();
    let failed = j
        .begin(entry(r"C:\F.lnk", &s(p("failed.ico")), original("x", 0)))
        .unwrap();
    j.fail(&failed, "x").unwrap();
    // Referenced with different case and separators.
    let mixed = s(p("mixed-case.ico")).to_uppercase().replace('/', "\\");
    apply(&mut j, r"C:\M.lnk", &mixed, original("x", 0));

    let referenced = j.referenced_icons();
    assert_eq!(referenced.len(), 4);
    assert!(referenced.contains(&p("pending.ico")));
    assert!(!referenced.contains(&p("restored.ico")));

    // Fresh files are protected by the grace period.
    assert_eq!(j.gc_icons(&icons).unwrap(), 0);
    assert!(p("orphan.ico").exists());

    assert_eq!(j.gc_icons_older_than(&icons, Duration::ZERO).unwrap(), 3);
    for kept in [
        "applied.ico",
        "superseded.ico",
        "pending.ico",
        "Mixed-Case.ICO",
        "notes.txt",
        "icon.ico.bak",
    ] {
        assert!(p(kept).exists(), "{kept} was deleted");
    }
    for gone in ["restored.ico", "failed.ico", "orphan.ico"] {
        assert!(!p(gone).exists(), "{gone} was kept");
    }
    assert!(icons.join("nested.ico").is_dir());
    // A missing folder has nothing to collect.
    assert_eq!(j.gc_icons(&tmp.path().join("nope")).unwrap(), 0);
}

#[test]
fn gc_collects_old_unreferenced_icons_after_the_grace_period() {
    let tmp = TempDir::new("gc-grace");
    let icons = tmp.path().join("icons");
    fs::create_dir_all(&icons).unwrap();
    let old = icons.join("old.ico");
    let young = icons.join("young.ico");
    touch(&old);
    touch(&young);
    age(&old, GC_GRACE + Duration::from_secs(60));
    age(&young, GC_GRACE / 2);
    let j = Journal::load(tmp.journal_path()).unwrap();
    assert_eq!(j.gc_icons(&icons).unwrap(), 1);
    assert!(!old.exists());
    assert!(young.exists());
}

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

fn fabricated(id: &str, target: &str, state: EntryState) -> HistoryEntry {
    HistoryEntry {
        id: id.into(),
        kind: TargetKind::Shortcut,
        target: target.into(),
        name: id.into(),
        system_icon: None,
        icon_path: format!("{id}.ico"),
        original: OriginalIcon::default(),
        state,
        elevated: false,
        thumb: None,
        design_name: None,
        applied_at: 1.0,
        restored_at: None,
        supersedes: None,
    }
}

fn write_journal(path: &Path, entries: &[HistoryEntry], failures: &BTreeMap<String, String>) {
    let body = serde_json::json!({ "version": 1, "entries": entries, "failures": failures });
    fs::write(path, serde_json::to_vec(&body).unwrap()).unwrap();
}

#[test]
fn journal_keeps_at_most_500_inactive_entries_dropping_restored_and_failed_first() {
    let tmp = TempDir::new("cap");
    let mut entries = Vec::new();
    let mut failures = BTreeMap::new();
    for i in 0..5 {
        let id = format!("f{i}");
        failures.insert(id.clone(), "boom".to_owned());
        entries.push(fabricated(
            &id,
            &format!(r"C:\f{i}.lnk"),
            EntryState::Failed,
        ));
    }
    for i in 0..10 {
        entries.push(fabricated(
            &format!("s{i}"),
            &format!(r"C:\s{i}.lnk"),
            EntryState::Superseded,
        ));
    }
    for i in 0..500 {
        entries.push(fabricated(
            &format!("r{i}"),
            &format!(r"C:\r{i}.lnk"),
            EntryState::Restored,
        ));
    }
    entries.push(fabricated("a0", r"C:\a0.lnk", EntryState::Applied));
    write_journal(&tmp.journal_path(), &entries, &failures);

    let mut j = Journal::load(tmp.journal_path()).unwrap();
    assert_eq!(j.entries().len(), 516);
    // Any mutation persists, and persisting enforces the cap.
    let new = j
        .begin(entry(r"C:\new.lnk", "n.ico", original("x", 0)))
        .unwrap();

    let ids: HashSet<&str> = j.entries().iter().map(|e| e.id.as_str()).collect();
    let inactive = j
        .entries()
        .iter()
        .filter(|e| !matches!(e.state, EntryState::Applied | EntryState::Pending))
        .count();
    assert_eq!(inactive, MAX_INACTIVE_ENTRIES);
    // The 15 oldest restored/failed entries went; superseded ones stayed.
    for i in 0..5 {
        assert!(!ids.contains(format!("f{i}").as_str()));
        assert_eq!(j.failure(&format!("f{i}")), None);
    }
    for i in 0..10 {
        assert!(!ids.contains(format!("r{i}").as_str()), "r{i}");
        assert!(ids.contains(format!("s{i}").as_str()), "s{i}");
    }
    assert!(ids.contains("r10"));
    assert!(ids.contains("a0"));
    assert!(ids.contains(new.as_str()));
    assert_eq!(
        Journal::load(tmp.journal_path()).unwrap().entries(),
        j.entries()
    );
}

#[test]
fn journal_cap_falls_back_to_the_oldest_superseded_entries() {
    let tmp = TempDir::new("cap-superseded");
    let mut entries = Vec::new();
    for i in 0..3 {
        entries.push(fabricated(
            &format!("r{i}"),
            &format!(r"C:\r{i}.lnk"),
            EntryState::Restored,
        ));
    }
    for i in 0..510 {
        entries.push(fabricated(
            &format!("s{i}"),
            &format!(r"C:\s{i}.lnk"),
            EntryState::Superseded,
        ));
    }
    write_journal(&tmp.journal_path(), &entries, &BTreeMap::new());

    let mut j = Journal::load(tmp.journal_path()).unwrap();
    let id = j
        .begin(entry(r"C:\new.lnk", "n.ico", original("x", 0)))
        .unwrap();
    j.commit(&id).unwrap();
    let ids: Vec<&str> = j.entries().iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids.len(), MAX_INACTIVE_ENTRIES + 1);
    assert_eq!(ids[0], "s10");
    assert_eq!(ids[MAX_INACTIVE_ENTRIES - 1], "s509");
    assert_eq!(ids[MAX_INACTIVE_ENTRIES], id);
}

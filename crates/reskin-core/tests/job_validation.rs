//! Elevated-helper job validation (allow/deny matrix) and execution against
//! a recording fake executor.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use reskin_core::ico::{self, MAX_ICO_BYTES};
use reskin_core::job::{
    self, EXIT_FAILED, EXIT_INVALID, EXIT_OK, ElevatedJob, JobExec, JobOp, JobResult, LinkKind,
    MAX_JOB_OPS, ValidatedJob, ValidatedOp,
};
use reskin_core::model::OriginalIcon;
use reskin_core::pixels::Rgba;
use reskin_core::{Error, Result};

const DESKTOP: &str = r"C:\Users\Public\Desktop";
const ICONS: &str = r"C:\ProgramData\Reskin\icons";
const ICON_NAME: &str = "app-0123456789ab.ico";

/// A unique temp directory, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        static N: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "reskin-job-{tag}-{}-{}",
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
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ico_bytes() -> Vec<u8> {
    ico::build_ico(&[
        Rgba::filled(16, 16, [200, 30, 30, 255]),
        Rgba::filled(32, 32, [30, 200, 30, 128]),
    ])
    .unwrap()
}

fn ico_b64() -> String {
    STANDARD.encode(ico_bytes())
}

fn set_lnk(target: &str) -> JobOp {
    JobOp::SetShortcutIcon {
        target: target.into(),
        icon_name: ICON_NAME.into(),
        ico_b64: ico_b64(),
    }
}

fn set_url(target: &str) -> JobOp {
    JobOp::SetUrlIcon {
        target: target.into(),
        icon_name: ICON_NAME.into(),
        ico_b64: ico_b64(),
    }
}

fn with_icon(icon_name: &str, ico_b64: String) -> JobOp {
    JobOp::SetShortcutIcon {
        target: format!(r"{DESKTOP}\App.lnk"),
        icon_name: icon_name.into(),
        ico_b64,
    }
}

fn restore_lnk(target: &str, location: Option<&str>, index: i32) -> JobOp {
    JobOp::RestoreShortcutIcon {
        target: target.into(),
        location: location.map(str::to_owned),
        index,
    }
}

fn job(ops: Vec<JobOp>) -> ElevatedJob {
    ElevatedJob {
        version: 1,
        id: "job-1".into(),
        created_at: 0.0,
        ops,
    }
}

fn validate(ops: Vec<JobOp>) -> Result<ValidatedJob> {
    job::validate_job(&job(ops), DESKTOP, ICONS)
}

#[track_caller]
fn assert_ok(op: JobOp) -> ValidatedOp {
    match validate(vec![op.clone()]) {
        Ok(mut v) => v.ops.remove(0),
        Err(e) => panic!("{op:?} was rejected: {e}"),
    }
}

#[track_caller]
fn assert_rejected(op: JobOp, needle: &str) {
    match validate(vec![op.clone()]) {
        Ok(_) => panic!("{op:?} was accepted"),
        Err(e) => {
            let msg = e.to_string();
            assert!(msg.contains(needle), "{op:?}: {msg:?} lacks {needle:?}");
            assert!(msg.contains("operation 1"), "{msg}");
        }
    }
}

// ---------------------------------------------------------------------------
// Allowed
// ---------------------------------------------------------------------------

#[test]
fn good_shortcut_and_url_on_the_public_desktop() {
    let op = assert_ok(set_lnk(r"C:\Users\Public\Desktop\App.lnk"));
    assert_eq!(
        op,
        ValidatedOp::SetIcon {
            link: LinkKind::Shortcut,
            target: r"C:\Users\Public\Desktop\App.lnk".into(),
            dest: format!(r"{ICONS}\{ICON_NAME}"),
            ico: ico_bytes(),
        }
    );
    let op = assert_ok(set_url(r"C:\Users\Public\Desktop\Steam Game.url"));
    assert_eq!(op.link(), LinkKind::Url);
    assert_eq!(op.target(), r"C:\Users\Public\Desktop\Steam Game.url");
}

#[test]
fn comparison_is_case_insensitive_and_separator_tolerant() {
    assert_ok(set_lnk(r"c:\users\PUBLIC\desktop\App.LNK"));
    assert_ok(set_lnk("C:/Users/Public/Desktop/App.lnk"));
    assert_ok(set_url(r"C:\Users\Public\Desktop\Site.URL"));
    // A trailing separator on the trusted folders does not matter.
    let v = job::validate_job(
        &job(vec![set_lnk(r"C:\Users\Public\Desktop\App.lnk")]),
        r"C:\Users\Public\Desktop\",
        r"C:\ProgramData\Reskin\icons\",
    )
    .unwrap();
    match &v.ops[0] {
        ValidatedOp::SetIcon { dest, .. } => assert_eq!(dest, &format!(r"{ICONS}\{ICON_NAME}")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn restore_ops_are_validated() {
    let target = r"C:\Users\Public\Desktop\App.lnk";
    assert_eq!(
        assert_ok(restore_lnk(
            target,
            Some(r"%SystemRoot%\System32\shell32.dll"),
            -3
        )),
        ValidatedOp::RestoreIcon {
            link: LinkKind::Shortcut,
            target: target.into(),
            location: Some(r"%SystemRoot%\System32\shell32.dll".into()),
            index: -3,
        }
    );
    // Clearing, and an empty location meaning "clear".
    for location in [None, Some(""), Some("   ")] {
        match assert_ok(restore_lnk(target, location, 0)) {
            ValidatedOp::RestoreIcon { location, .. } => assert_eq!(location, None),
            other => panic!("{other:?}"),
        }
    }
    assert_ok(restore_lnk(target, Some("x.dll"), 65535));
    assert_ok(restore_lnk(target, Some("x.dll"), -65535));
    assert_ok(restore_lnk(target, Some(&"a".repeat(1024)), 0));
    let url = assert_ok(JobOp::RestoreUrlIcon {
        target: r"C:\Users\Public\Desktop\Site.url".into(),
        location: Some(r"C:\Games\game.exe".into()),
        index: 0,
    });
    assert_eq!(url.link(), LinkKind::Url);
}

#[test]
fn up_to_the_op_limit_is_fine() {
    let ops: Vec<JobOp> = (0..MAX_JOB_OPS)
        .map(|i| restore_lnk(&format!(r"{DESKTOP}\App {i}.lnk"), None, 0))
        .collect();
    assert_eq!(validate(ops).unwrap().ops.len(), MAX_JOB_OPS);
}

// ---------------------------------------------------------------------------
// Denied targets
// ---------------------------------------------------------------------------

#[test]
fn targets_outside_the_public_desktop_are_rejected() {
    for target in [
        r"C:\Users\Public\Desktop\Games\App.lnk",
        r"C:\Users\Bob\Desktop\App.lnk",
        r"C:\Users\Public\DesktopEvil\App.lnk",
        r"D:\Users\Public\Desktop\App.lnk",
        r"C:\Users\Public\App.lnk",
        r"C:\Users\Public\Desktop\.\App.lnk",
    ] {
        assert_rejected(set_lnk(target), "not directly on the Public Desktop");
    }
    // The desktop folder itself.
    assert_rejected(
        set_lnk(r"C:\Users\Public\Desktop"),
        "not directly on the Public Desktop",
    );
}

#[test]
fn parent_traversal_is_rejected() {
    for target in [
        r"C:\Users\Public\Desktop\..\Desktop\App.lnk",
        r"C:\Users\Public\Desktop\..\..\..\Windows\System32\App.lnk",
        r"C:\Users\Public\Desktop\.. \App.lnk",
        "C:/Users/Public/Desktop/../Desktop/App.lnk",
    ] {
        assert_rejected(set_lnk(target), "'..'");
    }
}

#[test]
fn network_and_device_paths_are_rejected() {
    for target in [
        r"\\server\share\App.lnk",
        r"\\server\share\Users\Public\Desktop\App.lnk",
        "//server/share/App.lnk",
        r"\\?\UNC\server\share\App.lnk",
    ] {
        assert_rejected(set_lnk(target), "network path");
    }
    assert_rejected(
        set_lnk(r"\\?\C:\Users\Public\Desktop\App.lnk"),
        "not an absolute path",
    );
    assert_rejected(
        set_lnk(r"\\.\C:\Users\Public\Desktop\App.lnk"),
        "not an absolute path",
    );
}

#[test]
fn relative_paths_are_rejected() {
    for target in [
        "App.lnk",
        r"Desktop\App.lnk",
        r"C:App.lnk",
        r"\Users\Public\Desktop\App.lnk",
        "",
    ] {
        assert_rejected(set_lnk(target), "not an absolute path");
    }
}

#[test]
fn extension_must_match_the_op() {
    assert_rejected(set_lnk(r"C:\Users\Public\Desktop\Site.url"), ".lnk file");
    assert_rejected(set_url(r"C:\Users\Public\Desktop\App.lnk"), ".url file");
    for target in [
        r"C:\Users\Public\Desktop\App.exe",
        r"C:\Users\Public\Desktop\App.lnk.exe",
        r"C:\Users\Public\Desktop\App",
        r"C:\Users\Public\Desktop\App.lnk ",
        r"C:\Users\Public\Desktop\App.lnk.",
        r"C:\Users\Public\Desktop\.lnk",
    ] {
        assert_rejected(set_lnk(target), ".lnk file");
    }
    assert_rejected(
        restore_lnk(r"C:\Users\Public\Desktop\Site.url", None, 0),
        ".lnk file",
    );
}

#[test]
fn illegal_characters_and_device_names_are_rejected() {
    for target in [
        r"C:\Users\Public\Desktop\App?.lnk",
        r"C:\Users\Public\Desktop\*.lnk",
        r"C:\Users\Public\Desktop\A<b>.lnk",
        r"C:\Users\Public\Desktop\A|b.lnk",
        r#"C:\Users\Public\Desktop\A"b.lnk"#,
        r"C:\Users\Public\Desktop\App.lnk:evil.lnk",
        "C:\\Users\\Public\\Desktop\\A\u{1}b.lnk",
        "C:\\Users\\Public\\Desktop\\A\nb.lnk",
    ] {
        assert_rejected(set_lnk(target), "not allowed in paths");
    }
    for target in [
        r"C:\Users\Public\Desktop\CON.lnk",
        r"C:\Users\Public\Desktop\nul .lnk",
        r"C:\Users\Public\Desktop\com1.lnk",
        r"C:\Users\Public\Desktop\LPT9.x.lnk",
        r"C:\Users\Public\Desktop\COM¹.lnk",
    ] {
        assert_rejected(set_lnk(target), "reserved device name");
    }
    // Merely starting like a device name is fine.
    assert_ok(set_lnk(r"C:\Users\Public\Desktop\Console.lnk"));
    assert_ok(set_lnk(r"C:\Users\Public\Desktop\COM10.lnk"));
}

#[test]
fn unicode_look_alikes_of_the_desktop_folder_are_rejected() {
    // U+212A KELVIN SIGN lowercases to 'k' but NTFS treats it as a
    // different character, so this is a different folder.
    assert_rejected(
        set_lnk("C:\\Users\\Public\\Des\u{212A}top\\App.lnk"),
        "not directly on the Public Desktop",
    );
    // Non-ASCII file names directly on the desktop are fine.
    assert_ok(set_lnk("C:\\Users\\Public\\Desktop\\Café Ünïcode.lnk"));
}

#[test]
fn overlong_targets_are_rejected() {
    let target = format!(r"{DESKTOP}\{}.lnk", "a".repeat(1100));
    assert_rejected(set_lnk(&target), "too long");
}

// ---------------------------------------------------------------------------
// Denied icons
// ---------------------------------------------------------------------------

#[test]
fn bad_icon_names_are_rejected() {
    for name in [
        "App.ico",
        "APP-1.ico",
        "a/b.ico",
        r"a\b.ico",
        "..ico",
        "../x.ico",
        r"..\x.ico",
        "a.b.ico",
        "a b.ico",
        "icon",
        "icon.png",
        "icon.ICO",
        "",
        ".ico",
        "x.ico ",
        "\u{e9}.ico",
    ] {
        assert_rejected(with_icon(name, ico_b64()), "icon name");
    }
    let too_long = format!("{}.ico", "a".repeat(65));
    assert_rejected(with_icon(&too_long, ico_b64()), "icon name");
    let longest = format!("{}.ico", "a".repeat(64));
    assert_ok(with_icon(&longest, ico_b64()));
    assert_ok(with_icon("a.ico", ico_b64()));
    assert_ok(with_icon("-.ico", ico_b64()));
}

#[test]
fn device_icon_names_are_rejected() {
    // They match the pattern, but Win32 opens them as devices.
    for name in [
        "con.ico", "prn.ico", "aux.ico", "nul.ico", "com1.ico", "com0.ico", "lpt9.ico",
    ] {
        assert_rejected(with_icon(name, ico_b64()), "reserved device name");
    }
    for name in ["con-1.ico", "nul0.ico", "com10.ico", "console.ico"] {
        assert_ok(with_icon(name, ico_b64()));
    }
}

#[test]
fn one_icon_name_cannot_carry_two_different_icons() {
    let other = STANDARD.encode(ico::build_ico(&[Rgba::filled(16, 16, [0, 0, 255, 255])]).unwrap());
    let err = validate(vec![
        set_lnk(r"C:\Users\Public\Desktop\A.lnk"),
        restore_lnk(r"C:\Users\Public\Desktop\B.lnk", None, 0),
        JobOp::SetUrlIcon {
            target: r"C:\Users\Public\Desktop\C.url".into(),
            icon_name: ICON_NAME.into(),
            ico_b64: other,
        },
    ])
    .unwrap_err()
    .to_string();
    assert!(err.contains("operation 3"), "{err}");
    assert!(err.contains("operation 1"), "{err}");
    assert!(err.contains(ICON_NAME), "{err}");

    // Sharing one icon file between targets is fine when the bytes agree.
    let v = validate(vec![
        set_lnk(r"C:\Users\Public\Desktop\A.lnk"),
        set_url(r"C:\Users\Public\Desktop\C.url"),
    ])
    .unwrap();
    assert_eq!(v.ops.len(), 2);
}

#[test]
fn oversize_icons_are_rejected() {
    // A plausible ICO header followed by padding past the limit.
    let mut big = vec![0u8, 0, 1, 0, 1, 0];
    big.resize(MAX_ICO_BYTES + 1, 0);
    assert_rejected(with_icon(ICON_NAME, STANDARD.encode(&big)), "larger than");
    // Base64 text that is too long is refused before decoding.
    assert_rejected(
        with_icon(ICON_NAME, "A".repeat(MAX_ICO_BYTES / 3 * 4 + 8)),
        "larger than",
    );
}

#[test]
fn non_ico_bytes_are_rejected() {
    assert_rejected(
        with_icon(ICON_NAME, STANDARD.encode(b"hello, world")),
        "not a valid .ico",
    );
    let png = Rgba::filled(4, 4, [1, 2, 3, 255]).encode_png();
    assert_rejected(
        with_icon(ICON_NAME, STANDARD.encode(png)),
        "not a valid .ico",
    );
    // A cursor file is not an icon.
    let mut cur = ico_bytes();
    cur[2] = 2;
    assert_rejected(
        with_icon(ICON_NAME, STANDARD.encode(cur)),
        "not a valid .ico",
    );
    assert_rejected(with_icon(ICON_NAME, String::new()), "not a valid .ico");
}

#[test]
fn bad_base64_is_rejected() {
    for text in [
        "!!!not base64!!!",
        "AAAA AAAA",
        "AAA",
        "AAAA\nAAAA",
        "SGVsbG8=x",
    ] {
        assert_rejected(with_icon(ICON_NAME, text.into()), "base64");
    }
}

// ---------------------------------------------------------------------------
// Denied restores and jobs
// ---------------------------------------------------------------------------

#[test]
fn bad_restore_locations_are_rejected() {
    let target = r"C:\Users\Public\Desktop\App.lnk";
    for location in [
        "C:\\x.dll\n",
        "C:\\x\u{0}.dll",
        "\u{7}bell",
        "C:\\x\u{9b}.dll",
    ] {
        assert_rejected(restore_lnk(target, Some(location), 0), "control characters");
    }
    assert_rejected(restore_lnk(target, Some(&"a".repeat(1025)), 0), "too long");
    assert_rejected(restore_lnk(target, Some("x.dll"), 65536), "out of range");
    assert_rejected(restore_lnk(target, Some("x.dll"), -65536), "out of range");
    assert_rejected(restore_lnk(target, None, i32::MIN), "out of range");
}

#[test]
fn op_count_is_bounded() {
    let err = validate(Vec::new()).unwrap_err().to_string();
    assert!(err.contains("no operations"), "{err}");
    let ops: Vec<JobOp> = (0..=MAX_JOB_OPS)
        .map(|i| restore_lnk(&format!(r"{DESKTOP}\App {i}.lnk"), None, 0))
        .collect();
    let err = validate(ops).unwrap_err().to_string();
    assert!(err.contains("65 operations"), "{err}");
}

#[test]
fn job_ids_and_versions_are_checked() {
    let op = set_lnk(r"C:\Users\Public\Desktop\App.lnk");
    for id in ["", "Job", "../x", r"a\b", "a b", "a.b", &"a".repeat(65)] {
        let mut j = job(vec![op.clone()]);
        j.id = id.to_owned();
        let err = job::validate_job(&j, DESKTOP, ICONS).unwrap_err();
        assert!(err.to_string().contains("bad id"), "{id:?}: {err}");
    }
    let mut j = job(vec![op.clone()]);
    j.id = "0123456789abcdef-x".into();
    assert!(job::validate_job(&j, DESKTOP, ICONS).is_ok());
    let mut j = job(vec![op]);
    j.version = 2;
    let err = job::validate_job(&j, DESKTOP, ICONS).unwrap_err();
    assert!(err.to_string().contains("version"), "{err}");
}

#[test]
fn the_first_bad_op_is_named() {
    let err = validate(vec![
        set_lnk(r"C:\Users\Public\Desktop\A.lnk"),
        set_lnk(r"C:\Users\Public\Desktop\B.lnk"),
        set_lnk(r"C:\Windows\C.lnk"),
    ])
    .unwrap_err()
    .to_string();
    assert!(err.contains("operation 3"), "{err}");
}

#[test]
fn untrusted_folder_arguments_reject_everything() {
    for (desktop, icons) in [
        ("", ICONS),
        ("Desktop", ICONS),
        (r"\\server\Desktop", ICONS),
        (r"C:\Users\..\Public\Desktop", ICONS),
        (r"C:\Users\Public\Desk*", ICONS),
        (DESKTOP, ""),
        (DESKTOP, "icons"),
        (DESKTOP, r"\\server\icons"),
    ] {
        // A target that would be "directly under" the bad folder.
        let j = job(vec![set_lnk(&format!(r"{desktop}\App.lnk"))]);
        let err = job::validate_job(&j, desktop, icons)
            .expect_err(&format!("{desktop:?} / {icons:?} accepted"))
            .to_string();
        assert!(
            err.contains("is not an absolute local path"),
            "{desktop:?} / {icons:?}: {err}"
        );
    }
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

#[test]
fn json_wire_format() {
    let j = ElevatedJob {
        version: 1,
        id: "abc".into(),
        created_at: 5.0,
        ops: vec![
            JobOp::SetUrlIcon {
                target: "t.url".into(),
                icon_name: "n.ico".into(),
                ico_b64: "AAAA".into(),
            },
            restore_lnk("t.lnk", None, 2),
        ],
    };
    let json = serde_json::to_string(&j).unwrap();
    assert_eq!(
        json,
        r#"{"version":1,"id":"abc","createdAt":5.0,"ops":[{"type":"setUrlIcon","target":"t.url","iconName":"n.ico","icoB64":"AAAA"},{"type":"restoreShortcutIcon","target":"t.lnk","location":null,"index":2}]}"#
    );
    assert_eq!(serde_json::from_str::<ElevatedJob>(&json).unwrap(), j);
}

#[test]
fn unknown_fields_and_ops_are_refused() {
    let unknown_op =
        r#"{"version":1,"id":"a","createdAt":0,"ops":[{"type":"deleteFile","target":"x"}]}"#;
    assert!(serde_json::from_str::<ElevatedJob>(unknown_op).is_err());
    let extra_op_field = r#"{"version":1,"id":"a","createdAt":0,"ops":[{"type":"restoreUrlIcon","target":"x","location":null,"index":0,"dest":"C:\\evil"}]}"#;
    assert!(serde_json::from_str::<ElevatedJob>(extra_op_field).is_err());
    let extra_job_field = r#"{"version":1,"id":"a","createdAt":0,"ops":[],"iconsDir":"C:\\evil"}"#;
    assert!(serde_json::from_str::<ElevatedJob>(extra_job_field).is_err());
}

#[test]
fn op_constructors_pick_the_kind_by_extension() {
    let ico = ico_bytes();
    let op = JobOp::set_icon(r"C:\Users\Public\Desktop\App.LNK", "My App", &ico).unwrap();
    match &op {
        JobOp::SetShortcutIcon {
            icon_name, ico_b64, ..
        } => {
            assert_eq!(
                icon_name,
                &reskin_core::paths::icon_file_name("My App", &ico)
            );
            assert_eq!(STANDARD.decode(ico_b64).unwrap(), ico);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(op.target(), r"C:\Users\Public\Desktop\App.LNK");
    assert_ok(op);
    assert!(matches!(
        JobOp::set_icon(r"C:\Users\Public\Desktop\Site.url", "Site", &ico).unwrap(),
        JobOp::SetUrlIcon { .. }
    ));
    assert!(matches!(
        JobOp::set_icon(r"C:\Users\Public\Desktop\App.exe", "App", &ico),
        Err(Error::Unsupported(_))
    ));
    let original = OriginalIcon {
        location: Some("shell32.dll".into()),
        index: 4,
        existed: true,
    };
    assert_eq!(
        JobOp::restore_icon(r"C:\Users\Public\Desktop\Site.url", &original).unwrap(),
        JobOp::RestoreUrlIcon {
            target: r"C:\Users\Public\Desktop\Site.url".into(),
            location: Some("shell32.dll".into()),
            index: 4,
        }
    );
    assert!(JobOp::restore_icon("C:\\x\\folder", &original).is_err());
}

#[test]
fn new_jobs_get_fresh_valid_ids() {
    let a = job::new_job(vec![set_lnk(r"C:\Users\Public\Desktop\App.lnk")]);
    let b = job::new_job(Vec::new());
    assert_ne!(a.id, b.id);
    assert!(job::is_valid_job_id(&a.id));
    assert_eq!(a.version, job::JOB_VERSION);
    assert!(a.created_at > 0.0);
    assert!(job::validate_job(&a, DESKTOP, ICONS).is_ok());
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Records every call; fails the ones it is told to.
#[derive(Default)]
struct FakeExec {
    calls: Vec<String>,
    fail_write: HashSet<String>,
    fail_set: HashSet<String>,
}

fn fmt_icon(icon: Option<(&str, i32)>) -> String {
    match icon {
        Some((location, index)) => format!("{location},{index}"),
        None => "none".into(),
    }
}

impl JobExec for FakeExec {
    fn write_icon(&mut self, dest: &str, bytes: &[u8]) -> Result<()> {
        self.calls.push(format!("write {dest} {}", bytes.len()));
        if self.fail_write.contains(dest) {
            return Err(Error::AccessDenied(format!("{dest} is read-only")));
        }
        Ok(())
    }

    fn set_shortcut_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()> {
        self.calls.push(format!("lnk {target} {}", fmt_icon(icon)));
        if self.fail_set.contains(target) {
            return Err(Error::Other(format!("{target} is locked")));
        }
        Ok(())
    }

    fn set_url_icon(&mut self, target: &str, icon: Option<(&str, i32)>) -> Result<()> {
        self.calls.push(format!("url {target} {}", fmt_icon(icon)));
        if self.fail_set.contains(target) {
            return Err(Error::Other(format!("{target} is locked")));
        }
        Ok(())
    }

    fn notify(&mut self, target: &str) {
        self.calls.push(format!("notify {target}"));
    }
}

#[test]
fn execute_runs_every_op_and_continues_after_failures() {
    let lnk = r"C:\Users\Public\Desktop\App.lnk";
    let url = r"C:\Users\Public\Desktop\Game.url";
    let lnk2 = r"C:\Users\Public\Desktop\Other.lnk";
    let url2 = r"C:\Users\Public\Desktop\Site.url";
    let validated = validate(vec![
        set_lnk(lnk),
        set_url(url),
        restore_lnk(lnk2, Some("shell32.dll"), 3),
        JobOp::RestoreUrlIcon {
            target: url2.into(),
            location: None,
            index: 0,
        },
    ])
    .unwrap();
    let mut exec = FakeExec {
        fail_set: [url.to_owned()].into(),
        ..FakeExec::default()
    };
    let result = job::execute_job(&validated, &mut exec);
    let dest = format!(r"{ICONS}\{ICON_NAME}");
    let size = ico_bytes().len();
    assert_eq!(
        exec.calls,
        vec![
            format!("write {dest} {size}"),
            format!("lnk {lnk} {dest},0"),
            format!("notify {lnk}"),
            format!("write {dest} {size}"),
            format!("url {url} {dest},0"),
            format!("lnk {lnk2} shell32.dll,3"),
            format!("notify {lnk2}"),
            format!("url {url2} none"),
            format!("notify {url2}"),
        ]
    );
    assert_eq!(result.id, "job-1");
    assert!(!result.ok);
    assert_eq!(result.exit_code(), EXIT_FAILED);
    let oks: Vec<bool> = result.results.iter().map(|r| r.ok).collect();
    assert_eq!(oks, [true, false, true, true]);
    assert_eq!(result.results[0].icon_path.as_deref(), Some(dest.as_str()));
    assert_eq!(result.results[1].icon_path, None);
    assert!(result.results[1].message.contains("locked"));
    assert_eq!(result.results[2].icon_path, None);
}

#[test]
fn a_failed_icon_write_skips_setting_it() {
    let lnk = r"C:\Users\Public\Desktop\App.lnk";
    let validated = validate(vec![set_lnk(lnk)]).unwrap();
    let dest = format!(r"{ICONS}\{ICON_NAME}");
    let mut exec = FakeExec {
        fail_write: [dest.clone()].into(),
        ..FakeExec::default()
    };
    let result = job::execute_job(&validated, &mut exec);
    assert_eq!(
        exec.calls,
        vec![format!("write {dest} {}", ico_bytes().len())]
    );
    assert!(!result.ok);
    assert!(result.results[0].message.contains("read-only"));
}

#[test]
fn all_ok_exits_zero() {
    let validated = validate(vec![set_lnk(r"C:\Users\Public\Desktop\App.lnk")]).unwrap();
    let result = job::execute_job(&validated, &mut FakeExec::default());
    assert!(result.ok);
    assert_eq!(result.error, None);
    assert_eq!(result.exit_code(), EXIT_OK);
}

// ---------------------------------------------------------------------------
// Files and the helper entry point
// ---------------------------------------------------------------------------

#[test]
fn result_path_sits_next_to_the_job() {
    let job_path = Path::new("jobs").join("abc.json");
    assert_eq!(
        job::result_path(&job_path),
        Path::new("jobs").join("abc.result.json")
    );
    assert_eq!(
        job::result_path(Path::new("abc")),
        Path::new("abc.result.json")
    );
}

#[test]
fn helper_round_trip_through_files() {
    let tmp = TempDir::new("roundtrip");
    let j = job::new_job(vec![set_lnk(r"C:\Users\Public\Desktop\App.lnk")]);
    let path = job::write_job(tmp.path(), &j).unwrap();
    assert_eq!(path, tmp.path().join(format!("{}.json", j.id)));
    assert_eq!(job::read_job(&path).unwrap(), j);
    assert_eq!(job::read_result(&path).unwrap(), None);

    let mut exec = FakeExec::default();
    assert_eq!(job::run_job_file(&path, DESKTOP, ICONS, &mut exec), EXIT_OK);
    assert_eq!(exec.calls.len(), 3);
    let result = job::read_result(&path).unwrap().unwrap();
    assert_eq!(result.id, j.id);
    assert!(result.ok);
    assert_eq!(result.results.len(), 1);
}

#[test]
fn helper_rejects_invalid_and_unreadable_jobs() {
    let tmp = TempDir::new("invalid");
    // Valid JSON, invalid job: nothing runs, the reason is reported.
    let j = job::new_job(vec![set_lnk(r"C:\Users\Bob\Desktop\App.lnk")]);
    let path = job::write_job(tmp.path(), &j).unwrap();
    let mut exec = FakeExec::default();
    assert_eq!(
        job::run_job_file(&path, DESKTOP, ICONS, &mut exec),
        EXIT_INVALID
    );
    assert!(exec.calls.is_empty());
    let result: JobResult = job::read_result(&path).unwrap().unwrap();
    assert!(!result.ok);
    assert_eq!(result.exit_code(), EXIT_INVALID);
    assert!(result.error.unwrap().contains("Public Desktop"));

    // Garbage.
    let garbage = tmp.path().join("garbage.json");
    fs::write(&garbage, b"{ not json").unwrap();
    assert_eq!(
        job::run_job_file(&garbage, DESKTOP, ICONS, &mut exec),
        EXIT_INVALID
    );
    let result = job::read_result(&garbage).unwrap().unwrap();
    assert_eq!(result.id, "garbage");
    assert!(result.error.is_some());

    // Missing.
    let missing = tmp.path().join("missing.json");
    assert_eq!(
        job::run_job_file(&missing, DESKTOP, ICONS, &mut exec),
        EXIT_INVALID
    );
    assert!(exec.calls.is_empty());

    // Bad ids are refused before touching the file system.
    let mut bad = job::new_job(Vec::new());
    bad.id = "../escape".into();
    assert!(job::write_job(tmp.path(), &bad).is_err());
}

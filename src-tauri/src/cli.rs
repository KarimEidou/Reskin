//! Command-line handling.
//!
//! Early modes (handled in `main()` before Tauri starts):
//! - `--elevated-apply <job.json>`: the elevated helper (exit 0/2/3)
//! - `--restore-all [--quiet]`: restore every icon Reskin changed
//! - `--self-test`: print a JSON health report
//!
//! In-app flags: `--edit <path>…` (Explorer verb; forwarded to the running
//! instance by single-instance), `--autostart`, `--smoke-test
//! [--capture-handoff]`.

use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppArgs {
    pub smoke: bool,
    pub capture_handoff: bool,
    pub autostart: bool,
    pub edit: Vec<PathBuf>,
}

impl AppArgs {
    pub fn parse(args: &[String]) -> Self {
        let mut out = AppArgs::default();
        let mut it = args.iter().skip(1);
        while let Some(a) = it.next() {
            match a.as_str() {
                "--smoke-test" => out.smoke = true,
                "--capture-handoff" => out.capture_handoff = true,
                "--autostart" => out.autostart = true,
                "--edit" => {
                    if let Some(p) = it.next() {
                        out.edit.push(PathBuf::from(p));
                    }
                }
                other if !other.starts_with("--") && out.edit.is_empty() => {
                    // A bare path (e.g. dropped on the exe) behaves like --edit.
                    out.edit.push(PathBuf::from(other));
                }
                _ => {}
            }
        }
        out
    }
}

/// Runs a helper mode if one was requested and returns its exit code.
pub fn run_early(args: &[String]) -> Option<i32> {
    let flag = |f: &str| args.iter().any(|a| a == f);
    let value_of = |f: &str| {
        args.iter()
            .position(|a| a == f)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    if flag("--self-test") {
        return Some(crate::selftest::run());
    }
    if flag("--elevated-apply") {
        let Some(job) = value_of("--elevated-apply") else {
            return Some(crate::helper::EXIT_INVALID);
        };
        return Some(crate::helper::elevated_apply(&job));
    }
    if flag("--restore-all") {
        return Some(crate::helper::restore_all(flag("--quiet")));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_flags() {
        let a = AppArgs::parse(&s(&["reskin.exe", "--smoke-test", "--capture-handoff"]));
        assert!(a.smoke && a.capture_handoff && !a.autostart);
        let a = AppArgs::parse(&s(&["reskin.exe", "--edit", "C:\\a b\\x.lnk"]));
        assert_eq!(a.edit, vec![PathBuf::from("C:\\a b\\x.lnk")]);
        let a = AppArgs::parse(&s(&["reskin.exe", "C:\\x.lnk"]));
        assert_eq!(a.edit.len(), 1);
    }
}

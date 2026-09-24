//! Memory of Reskin plus its WebView2 child processes, logged by the smoke
//! test (idle after start, and after the handoffs with the editor hidden
//! again) so a regression shows in every CI run: the working set (what is
//! resident right now; shared DLL pages count once per process) and the
//! private bytes (what the processes committed for themselves — the number a
//! leak makes grow). See docs/ARCHITECTURE.md, "Performance".

use std::collections::{HashMap, HashSet};

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const MB: u64 = 1024 * 1024;

/// Private bytes of the whole process tree above which the smoke test
/// warns: worth a look, not yet a failure.
pub const PRIVATE_SOFT_BUDGET: u64 = 450 * MB;
/// Private bytes of the whole process tree above which the smoke test fails.
pub const PRIVATE_HARD_CEILING: u64 = 700 * MB;

/// Memory of one process, or of several summed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub working_set: u64,
    pub private: u64,
}

impl std::ops::AddAssign for Usage {
    fn add_assign(&mut self, other: Self) {
        self.working_set += other.working_set;
        self.private += other.private;
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MemoryReport {
    /// This process.
    pub own: Usage,
    /// Every descendant process (WebView2's browser, GPU, renderer and
    /// utility processes), summed.
    pub children: Usage,
    pub child_count: usize,
    /// Private bytes of the largest child.
    pub largest_child: u64,
}

impl MemoryReport {
    pub fn total(&self) -> Usage {
        let mut total = self.own;
        total += self.children;
        total
    }

    /// How the tree's private bytes compare with the budgets.
    pub fn verdict(&self) -> Verdict {
        verdict(self.total().private)
    }
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / MB as f64
}

impl std::fmt::Display for MemoryReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let total = self.total();
        write!(
            f,
            "private {:.1} MB (reskin {:.1} MB + {} child processes {:.1} MB, largest {:.1} MB), \
             working set {:.1} MB (reskin {:.1} MB + children {:.1} MB)",
            mb(total.private),
            mb(self.own.private),
            self.child_count,
            mb(self.children.private),
            mb(self.largest_child),
            mb(total.working_set),
            mb(self.own.working_set),
            mb(self.children.working_set),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    /// Above `PRIVATE_SOFT_BUDGET`.
    OverBudget,
    /// Above `PRIVATE_HARD_CEILING`.
    OverCeiling,
}

pub fn verdict(private: u64) -> Verdict {
    if private > PRIVATE_HARD_CEILING {
        Verdict::OverCeiling
    } else if private > PRIVATE_SOFT_BUDGET {
        Verdict::OverBudget
    } else {
        Verdict::Ok
    }
}

fn usage(pid: u32) -> Option<Usage> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS_EX {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        let ok = GetProcessMemoryInfo(
            h,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
        .is_ok();
        let _ = CloseHandle(h);
        ok.then_some(Usage {
            working_set: counters.WorkingSetSize as u64,
            private: counters.PrivateUsage as u64,
        })
    }
}

/// When a process was created (FILETIME ticks), if it can be opened.
fn created(pid: u32) -> Option<u64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut creation = FILETIME::default();
        let (mut exit, mut kernel, mut user) = (creation, creation, creation);
        let ok = GetProcessTimes(h, &mut creation, &mut exit, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| ticks(creation))
    }
}

fn ticks(t: FILETIME) -> u64 {
    (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)
}

/// Parent pid of every running process.
fn process_tree() -> HashMap<u32, u32> {
    let mut parents = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return parents;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(HANDLE(snap.0));
    }
    parents
}

/// Every process below `root` in `parents` (child pid → parent pid), with
/// `created` telling when a process started (None: it cannot be opened, so
/// it is not one of ours and its memory cannot be read either). A process
/// keeps its parent's pid after the parent exits, and Windows reuses pids:
/// a process older than the one that holds its parent's pid now is an
/// orphan of an earlier process (explorer.exe, say), not a child.
fn descendants(
    parents: &HashMap<u32, u32>,
    root: u32,
    created: impl Fn(u32) -> Option<u64>,
) -> HashSet<u32> {
    let mut found: HashSet<u32> = HashSet::new();
    let mut frontier = vec![(root, created(root))];
    while let Some((p, p_created)) = frontier.pop() {
        for (&child, &parent) in parents {
            if parent != p || child == root || child == 0 || found.contains(&child) {
                continue;
            }
            let Some(c_created) = created(child) else {
                continue;
            };
            if p_created.is_some_and(|t| c_created < t) {
                continue;
            }
            found.insert(child);
            frontier.push((child, Some(c_created)));
        }
    }
    found
}

pub fn measure() -> MemoryReport {
    let me = unsafe { GetCurrentProcessId() };
    let mut report = MemoryReport {
        own: usage(me).unwrap_or_default(),
        ..Default::default()
    };
    for pid in descendants(&process_tree(), me, created) {
        if let Some(u) = usage(pid) {
            report.children += u;
            report.child_count += 1;
            report.largest_child = report.largest_child.max(u.private);
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creation times: every process in `order` started after the ones before it.
    fn started(order: &[u32]) -> impl Fn(u32) -> Option<u64> + '_ {
        |pid| order.iter().position(|&p| p == pid).map(|i| i as u64)
    }

    #[test]
    fn descendants_cover_the_whole_tree_and_nothing_else() {
        // 10 → 11 → 12, 10 → 13; 20 is unrelated, 14's parent 99 is gone.
        let parents = HashMap::from([(10, 1), (11, 10), (12, 11), (13, 10), (20, 1), (14, 99)]);
        let order = [1, 20, 99, 14, 10, 11, 13, 12];
        assert_eq!(
            descendants(&parents, 10, started(&order)),
            HashSet::from([11, 12, 13])
        );
        assert!(descendants(&parents, 12, started(&order)).is_empty());
    }

    #[test]
    fn descendants_survive_a_reused_pid_loop() {
        // A reused pid can make a process look like its own ancestor.
        let parents = HashMap::from([(10, 12), (11, 10), (12, 11)]);
        assert_eq!(
            descendants(&parents, 10, started(&[10, 11, 12])),
            HashSet::from([11, 12])
        );
    }

    #[test]
    fn orphans_of_an_earlier_holder_of_the_pid_are_not_children() {
        // 30 (and its child 31) were started by an earlier process 10 that
        // exited; the pid went to reskin, whose own child is 11.
        let parents = HashMap::from([(30, 10), (31, 30), (11, 10)]);
        assert_eq!(
            descendants(&parents, 10, started(&[30, 31, 10, 11])),
            HashSet::from([11])
        );
    }

    #[test]
    fn processes_that_cannot_be_opened_are_not_children() {
        let parents = HashMap::from([(11, 10), (12, 10), (13, 12)]);
        // 12 cannot be opened: neither it nor what it started is counted.
        assert_eq!(
            descendants(&parents, 10, started(&[10, 11, 13])),
            HashSet::from([11])
        );
    }

    #[test]
    fn budgets() {
        assert_eq!(verdict(300 * MB), Verdict::Ok);
        assert_eq!(verdict(PRIVATE_SOFT_BUDGET), Verdict::Ok);
        assert_eq!(verdict(PRIVATE_SOFT_BUDGET + 1), Verdict::OverBudget);
        assert_eq!(verdict(PRIVATE_HARD_CEILING), Verdict::OverBudget);
        assert_eq!(verdict(PRIVATE_HARD_CEILING + 1), Verdict::OverCeiling);
    }

    #[test]
    fn report_sums_and_prints_private_and_working_set() {
        let report = MemoryReport {
            own: Usage {
                working_set: 20 * MB,
                private: 10 * MB,
            },
            children: Usage {
                working_set: 350 * MB,
                private: 290 * MB,
            },
            child_count: 6,
            largest_child: 120 * MB,
        };
        assert_eq!(
            report.total(),
            Usage {
                working_set: 370 * MB,
                private: 300 * MB
            }
        );
        assert_eq!(report.verdict(), Verdict::Ok);
        assert_eq!(
            report.to_string(),
            "private 300.0 MB (reskin 10.0 MB + 6 child processes 290.0 MB, largest 120.0 MB), \
             working set 370.0 MB (reskin 20.0 MB + children 350.0 MB)"
        );
    }
}

//! Working-set measurement of Reskin plus its WebView2 child processes
//! (logged by the smoke test to keep an eye on the idle footprint).

use std::collections::{HashMap, HashSet};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Debug, Clone, Copy, Default)]
pub struct MemoryReport {
    /// Working set of this process (bytes).
    pub own: u64,
    /// Working set of every descendant process, e.g. WebView2 (bytes).
    pub children: u64,
    pub child_count: usize,
}

impl MemoryReport {
    pub fn total(&self) -> u64 {
        self.own + self.children
    }
}

impl std::fmt::Display for MemoryReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        const MB: f64 = 1024.0 * 1024.0;
        write!(
            f,
            "{:.1} MB total (reskin {:.1} MB + {} child processes {:.1} MB)",
            self.total() as f64 / MB,
            self.own as f64 / MB,
            self.child_count,
            self.children as f64 / MB
        )
    }
}

fn working_set(pid: u32) -> Option<u64> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let ok = GetProcessMemoryInfo(h, &mut counters, counters.cb).is_ok();
        let _ = CloseHandle(h);
        ok.then_some(counters.WorkingSetSize as u64)
    }
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

pub fn measure() -> MemoryReport {
    let me = unsafe { GetCurrentProcessId() };
    let parents = process_tree();
    // Breadth-first over the children of `me`.
    let mut descendants: HashSet<u32> = HashSet::new();
    let mut frontier = vec![me];
    while let Some(p) = frontier.pop() {
        for (&child, &parent) in &parents {
            if parent == p && child != me && child != 0 && descendants.insert(child) {
                frontier.push(child);
            }
        }
    }
    let mut report = MemoryReport {
        own: working_set(me).unwrap_or(0),
        ..Default::default()
    };
    for pid in descendants {
        if let Some(ws) = working_set(pid) {
            report.children += ws;
            report.child_count += 1;
        }
    }
    report
}

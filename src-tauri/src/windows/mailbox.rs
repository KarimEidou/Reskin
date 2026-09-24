//! Rust → editor command mailbox.
//!
//! Tauri events sent to a window that was created hidden can be dropped
//! (tauri#15652), so the editor long-polls `editor_next(after)` instead. Each
//! command gets a monotonically increasing sequence number. Commands stay
//! queued until a later poll proves they were received (`after >= seq`), so
//! a reloaded page — whose in-flight poll was orphaned — still gets them.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use reskin_core::model::{EditorCmd, Envelope};

/// How long a poll waits before returning a heartbeat.
pub const HEARTBEAT: Duration = Duration::from_secs(25);
const MAX_QUEUED: usize = 256;

#[derive(Clone, Default)]
pub struct Mailbox(Arc<Shared>);

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    cv: Condvar,
}

#[derive(Default)]
struct Inner {
    seq: u32,
    queue: VecDeque<Envelope>,
    last_poll: Option<Instant>,
    waiting: u32,
}

impl Mailbox {
    /// Queues a command and wakes the waiting poll. Returns its seq.
    pub fn push(&self, cmd: EditorCmd) -> u32 {
        let mut g = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.seq = g.seq.wrapping_add(1).max(1);
        let seq = g.seq;
        g.queue.push_back(Envelope { seq, cmd });
        while g.queue.len() > MAX_QUEUED {
            g.queue.pop_front();
        }
        drop(g);
        self.0.cv.notify_all();
        seq
    }

    /// Blocks until there are commands with `seq > after` or `timeout`
    /// elapses (then returns a single heartbeat envelope).
    pub fn next(&self, after: u32, timeout: Duration) -> Vec<Envelope> {
        let deadline = Instant::now() + timeout;
        let mut g = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        // Everything up to `after` has been received by the page.
        g.queue.retain(|e| e.seq > after);
        g.last_poll = Some(Instant::now());
        g.waiting += 1;
        let out = loop {
            let ready: Vec<Envelope> = g.queue.iter().filter(|e| e.seq > after).cloned().collect();
            if !ready.is_empty() {
                break ready;
            }
            let now = Instant::now();
            if now >= deadline {
                g.seq = g.seq.wrapping_add(1).max(1);
                break vec![Envelope {
                    seq: g.seq,
                    cmd: EditorCmd::Heartbeat,
                }];
            }
            g = self
                .0
                .cv
                .wait_timeout(g, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        };
        g.waiting -= 1;
        g.last_poll = Some(Instant::now());
        out
    }

    /// The editor page is alive: a poll is waiting right now or one
    /// finished within `grace`.
    pub fn is_alive(&self, grace: Duration) -> bool {
        let g = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.waiting > 0 || g.last_poll.is_some_and(|t| t.elapsed() <= grace)
    }

    /// Drops queued commands (used when the editor is recreated).
    pub fn reset(&self) {
        let mut g = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.queue.clear();
        g.last_poll = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivers_in_order_and_keeps_until_acked() {
        let mb = Mailbox::default();
        let a = mb.push(EditorCmd::Reveal { session: 1 });
        let b = mb.push(EditorCmd::Expand {
            session: 1,
            morph: true,
        });
        let got = mb.next(0, Duration::from_millis(10));
        assert_eq!(got.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![a, b]);
        // A reloaded page polling from 0 still receives them.
        assert_eq!(mb.next(0, Duration::from_millis(10)).len(), 2);
        // Polling past them acknowledges them.
        let hb = mb.next(b, Duration::from_millis(10));
        assert!(matches!(hb[0].cmd, EditorCmd::Heartbeat));
        assert!(hb[0].seq > b);
        assert!(mb.is_alive(Duration::from_secs(1)));
    }

    #[test]
    fn wakes_waiting_poll() {
        let mb = Mailbox::default();
        let mb2 = mb.clone();
        let t = std::thread::spawn(move || mb2.next(0, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(50));
        mb.push(EditorCmd::Clear { session: 2 });
        let got = t.join().unwrap();
        assert!(matches!(got[0].cmd, EditorCmd::Clear { session: 2 }));
    }
}

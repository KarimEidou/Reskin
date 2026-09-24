//! The single-threaded-apartment (STA) worker that runs all shell work.
//!
//! Shell COM objects (`IShellLink`, `IShellWindows`, WIC, …) belong on an
//! apartment-threaded thread that pumps window messages: calls into Explorer
//! are marshalled as window messages and some shell objects create hidden
//! windows. [`Sta`] owns one such thread. Jobs travel over a channel; the
//! thread waits with `MsgWaitForMultipleObjectsEx` on a wake event *and* its
//! message queue, so it runs jobs promptly and keeps dispatching messages
//! while idle.
//!
//! Tauri commands are async: they call [`Sta::run`] inside
//! `spawn_blocking`, never on the main thread.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread::{self, ThreadId};

use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED};
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Threading::{CreateEventW, INFINITE, SetEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_NOREMOVE,
    PM_REMOVE, PeekMessageW, QS_ALLINPUT, TranslateMessage, WM_QUIT,
};
use windows::core::PCWSTR;

use super::util::ResultExt;
use crate::{Error, Result};

type Job = Box<dyn FnOnce() + Send + 'static>;

enum Msg {
    Run(Job),
    /// Sent when the last [`Sta`] handle is dropped.
    Quit,
}

/// Auto-reset event that wakes the worker. Shared by the handles and the
/// worker; closed when the last of them lets go.
struct WakeEvent(HANDLE);

// SAFETY: an event handle may be signalled and waited on from any thread.
unsafe impl Send for WakeEvent {}
// SAFETY: see above; the handle is never mutated after creation.
unsafe impl Sync for WakeEvent {}

impl WakeEvent {
    fn signal(&self) {
        // SAFETY: the handle stays valid while `self` exists.
        let _ = unsafe { SetEvent(self.0) };
    }
}

impl Drop for WakeEvent {
    fn drop(&mut self) {
        // SAFETY: we own the handle and nothing uses it any more.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct Shared {
    jobs: Sender<Msg>,
    wake: Arc<WakeEvent>,
    thread: ThreadId,
}

impl Drop for Shared {
    fn drop(&mut self) {
        // The worker is detached rather than joined: the last handle may be
        // dropped on the worker itself (a job holding a clone).
        let _ = self.jobs.send(Msg::Quit);
        self.wake.signal();
    }
}

/// Handle to the STA worker thread. Cheap to clone; the thread exits when
/// the last handle is dropped (after finishing already queued jobs).
#[derive(Clone)]
pub struct Sta {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Sta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sta")
            .field("thread", &self.shared.thread)
            .finish()
    }
}

impl Sta {
    /// Starts the worker thread and waits until COM is initialised on it.
    pub fn spawn() -> Result<Sta> {
        // SAFETY: unnamed auto-reset event, initially not signalled.
        let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
            .ctx("create the shell worker's wake event")?;
        let wake = Arc::new(WakeEvent(event));
        let (jobs, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_wake = Arc::clone(&wake);
        let handle = thread::Builder::new()
            .name("reskin-sta".into())
            .spawn(move || worker(rx, worker_wake, ready_tx))
            .map_err(|e| Error::Other(format!("could not start the shell worker thread: {e}")))?;
        let thread = handle.thread().id();
        ready_rx
            .recv()
            .map_err(|_| Error::Other("the shell worker thread exited while starting".into()))??;
        Ok(Sta {
            shared: Arc::new(Shared { jobs, wake, thread }),
        })
    }

    /// True when called on the worker thread itself.
    pub fn is_current(&self) -> bool {
        thread::current().id() == self.shared.thread
    }

    /// Runs `f` on the worker and blocks until it returns. Called from the
    /// worker itself (a job that calls `run`), `f` runs inline, so nested
    /// calls cannot deadlock. A panic inside `f` is caught and reported as
    /// an error; `Err` is also returned when the worker has stopped.
    pub fn run<R: Send + 'static>(&self, f: impl FnOnce() -> R + Send + 'static) -> Result<R> {
        if self.is_current() {
            return catch_unwind(AssertUnwindSafe(f)).map_err(panic_error);
        }
        let (tx, rx) = mpsc::sync_channel(1);
        let job: Job = Box::new(move || {
            let _ = tx.send(catch_unwind(AssertUnwindSafe(f)));
        });
        self.shared.jobs.send(Msg::Run(job)).map_err(|_| gone())?;
        self.shared.wake.signal();
        match rx.recv() {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(payload)) => Err(panic_error(payload)),
            Err(_) => Err(gone()),
        }
    }

    /// [`Sta::run`] for jobs that return a `Result` themselves.
    pub fn try_run<R: Send + 'static>(
        &self,
        f: impl FnOnce() -> Result<R> + Send + 'static,
    ) -> Result<R> {
        self.run(f)?
    }
}

fn gone() -> Error {
    Error::Other("the shell worker thread has stopped".into())
}

fn panic_error(payload: Box<dyn Any + Send>) -> Error {
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into());
    Error::Other(format!("shell job panicked: {message}"))
}

fn worker(rx: Receiver<Msg>, wake: Arc<WakeEvent>, ready: Sender<Result<()>>) {
    // SAFETY: plain COM initialisation, balanced below.
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    if let Err(e) = hr.ok().ctx("initialise COM on the shell worker") {
        let _ = ready.send(Err(e));
        return;
    }
    let mut msg = MSG::default();
    // Create the thread's message queue before announcing readiness.
    // SAFETY: valid MSG out pointer.
    let _ = unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE) };
    let _ = ready.send(Ok(()));
    drop(ready);

    'pump: loop {
        loop {
            match rx.try_recv() {
                // Jobs catch their own panics (see `Sta::run`).
                Ok(Msg::Run(job)) => job(),
                Ok(Msg::Quit) | Err(TryRecvError::Disconnected) => break 'pump,
                Err(TryRecvError::Empty) => break,
            }
        }
        // SAFETY: standard message loop on this thread's queue.
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            // The worker's lifetime belongs to the `Sta` handles: a stray
            // WM_QUIT (PostQuitMessage from a shell extension or a COM
            // modal loop) must not stop all shell work for the rest of the
            // session. Retrieving it clears the thread's quit state.
            if msg.message == WM_QUIT {
                continue;
            }
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        // Sleep until a job is queued or a message arrives.
        // SAFETY: the event handle is kept alive by `wake`.
        let woke = unsafe {
            MsgWaitForMultipleObjectsEx(Some(&[wake.0]), INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
        };
        if woke == WAIT_FAILED {
            // Cannot wait any more (should never happen): stop rather than
            // spin; callers get "worker has stopped" errors.
            break;
        }
    }
    // Dropping the receiver fails any job queued after Quit.
    drop(rx);
    // SAFETY: balances the successful CoInitializeEx above.
    unsafe { CoUninitialize() };
}

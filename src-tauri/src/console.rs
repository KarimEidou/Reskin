//! Release builds use the GUI subsystem; helper modes that print (e.g.
//! `--self-test`) attach to the parent console when stdout isn't redirected.

pub fn attach_parent() {
    use windows::Win32::System::Console::{
        ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_OUTPUT_HANDLE,
    };
    unsafe {
        let redirected = GetStdHandle(STD_OUTPUT_HANDLE)
            .map(|h| !h.is_invalid() && !h.0.is_null())
            .unwrap_or(false);
        if !redirected {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

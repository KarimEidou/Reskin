//! Reskin's platform logic, kept out of the Tauri crate so it can be unit
//! tested on any host. Windows-only shell integration lives in the `win`
//! module (compiled on Windows only).

pub mod geom;
pub mod grpicon;
pub mod history;
pub mod ico;
pub mod job;
pub mod model;
pub mod paths;
pub mod pixels;
pub mod settings;
pub mod store;
pub mod urlini;

#[cfg(windows)]
pub mod win;

/// Error type shared by the core modules. `AccessDenied` is distinguished
/// because it triggers the elevation / personal-copy flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    AccessDenied(String),
    NotFound(String),
    Unsupported(String),
    /// The user cancelled (UAC prompt, dialog).
    Cancelled,
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::AccessDenied(m) => write!(f, "access denied: {m}"),
            Error::NotFound(m) => write!(f, "not found: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
            Error::Cancelled => write!(f, "cancelled"),
            Error::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

impl From<String> for Error {
    fn from(m: String) -> Self {
        Error::Other(m)
    }
}

impl From<&str> for Error {
    fn from(m: &str) -> Self {
        Error::Other(m.to_owned())
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::PermissionDenied => Error::AccessDenied(e.to_string()),
            std::io::ErrorKind::NotFound => Error::NotFound(e.to_string()),
            _ => Error::Other(e.to_string()),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Other(format!("json: {e}"))
    }
}

#[cfg(windows)]
impl From<windows_core::Error> for Error {
    fn from(e: windows_core::Error) -> Self {
        // E_ACCESSDENIED / HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)
        const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
        const CANCELLED: i32 = 0x8007_04C7_u32 as i32; // ERROR_CANCELLED
        const NOT_FOUND: [i32; 2] = [0x8007_0002_u32 as i32, 0x8007_0003_u32 as i32];
        let code = e.code().0;
        if code == E_ACCESSDENIED {
            Error::AccessDenied(e.message())
        } else if code == CANCELLED {
            Error::Cancelled
        } else if NOT_FOUND.contains(&code) {
            Error::NotFound(e.message())
        } else {
            Error::Other(format!("{} (0x{:08X})", e.message(), code as u32))
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Unix time in milliseconds.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

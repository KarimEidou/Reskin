//! `reskin.exe --self-test`: prints a JSON health report and exits 0 when
//! every check passes. Used by the installer round-trip in CI.

use reskin_core::model::{SelfTest, SelfTestCheck};

pub fn run() -> i32 {
    crate::console::attach_parent();
    let mut checks = Vec::new();
    checks.push(check("webview2", webview2_version));
    checks.push(check("app-data", app_data_writable));
    checks.push(check("known-folders", || {
        let desktop = reskin_core::win::known::desktop().map_err(|e| e.to_string())?;
        let public = reskin_core::win::known::public_desktop().map_err(|e| e.to_string())?;
        Ok(format!(
            "desktop={} public={}",
            desktop.display(),
            public.display()
        ))
    }));
    checks.push(check("journal", || {
        let dirs = reskin_core::paths::AppDirs::from_env();
        let j =
            reskin_core::history::Journal::load(dirs.journal_file()).map_err(|e| e.to_string())?;
        Ok(format!("{} entries", j.entries().len()))
    }));
    checks.push(check("icon-store", || {
        let dirs = reskin_core::paths::AppDirs::from_env();
        let dir = dirs.icons_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let probe = dir.join(".self-test");
        std::fs::write(&probe, b"ok").map_err(|e| e.to_string())?;
        std::fs::remove_file(&probe).map_err(|e| e.to_string())?;
        Ok(dir.display().to_string())
    }));
    checks.push(check("executable", || {
        std::env::current_exe()
            .map(|p| p.display().to_string())
            .map_err(|e| e.to_string())
    }));
    let report = SelfTest {
        version: env!("CARGO_PKG_VERSION").to_string(),
        ok: checks.iter().all(|c| c.ok),
        checks,
    };
    let json = serde_json::to_string_pretty(&report).unwrap_or_default();
    println!("{json}");
    crate::log::line(&format!("self-test ok={}", report.ok));
    if report.ok { 0 } else { 1 }
}

fn check(name: &str, f: impl FnOnce() -> Result<String, String>) -> SelfTestCheck {
    match f() {
        Ok(detail) => SelfTestCheck {
            name: name.into(),
            ok: true,
            detail,
        },
        Err(detail) => SelfTestCheck {
            name: name.into(),
            ok: false,
            detail,
        },
    }
}

fn webview2_version() -> Result<String, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::core::{PCWSTR, PWSTR};
    unsafe {
        let mut out = PWSTR::null();
        GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut out)
            .map_err(|e| format!("WebView2 runtime not found: {e}"))?;
        if out.is_null() {
            return Err("WebView2 runtime not found".into());
        }
        let v = out.to_string().unwrap_or_default();
        CoTaskMemFree(Some(out.0 as *const _));
        Ok(v)
    }
}

fn app_data_writable() -> Result<String, String> {
    let dir = reskin_core::paths::AppDirs::from_env().roaming;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let probe = dir.join(".self-test");
    std::fs::write(&probe, b"ok").map_err(|e| e.to_string())?;
    std::fs::remove_file(&probe).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

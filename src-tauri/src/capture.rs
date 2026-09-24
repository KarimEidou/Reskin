//! Screen capture of a rectangle (GDI BitBlt of the composed desktop), used
//! by `--smoke-test --capture-handoff` to prove the box ⇄ editor handoff
//! never shows an empty frame.

use reskin_core::model::Rect;
use reskin_core::pixels::{Rgba, bgra_to_rgba};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
    CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HGDIOBJ,
    ReleaseDC, SRCCOPY, SelectObject,
};

/// Captures `r` (physical screen px). Alpha is forced opaque.
pub fn screen(r: Rect) -> Option<Rgba> {
    let (x, y, w, h) = (r.x as i32, r.y as i32, r.w as i32, r.h as i32);
    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let ok = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT).is_ok();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        SelectObject(mem, old);
        let lines = if ok {
            GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                Some(buf.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if lines == 0 {
            return None;
        }
        for px in buf.chunks_exact_mut(4) {
            px[3] = 255;
        }
        bgra_to_rgba(w as u32, h as u32, &buf).ok()
    }
}

/// Mean absolute per-channel difference (0..=255) of two same-size images.
pub fn diff(a: &Rgba, b: &Rgba) -> f64 {
    if a.w != b.w || a.h != b.h || a.data.is_empty() {
        return 255.0;
    }
    let sum: u64 = a
        .data
        .chunks_exact(4)
        .zip(b.data.chunks_exact(4))
        .map(|(p, q)| {
            (0..3)
                .map(|i| (p[i] as i32 - q[i] as i32).unsigned_abs() as u64)
                .sum::<u64>()
        })
        .sum();
    sum as f64 / (a.data.len() / 4 * 3) as f64
}

/// A capture that is (almost) entirely black says nothing about what was
/// on screen (no interactive desktop, secure desktop, no GPU output).
pub fn is_black(img: &Rgba) -> bool {
    let bright = img
        .data
        .chunks_exact(4)
        .filter(|p| p[0] > 8 || p[1] > 8 || p[2] > 8)
        .count();
    bright * 100 < img.data.len() / 4
}

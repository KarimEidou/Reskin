//! Building and parsing `.ico` files.
//!
//! Frames smaller than 256 px are stored as 32-bit BMP (DIB + AND mask),
//! the 256 px frame as PNG. `ico`'s automatic `encode` would PNG every frame
//! and pick soft-alpha paths the legacy shell renders poorly, so the choice
//! is explicit here.

use crate::model::SizedPng;
use crate::pixels::Rgba;

/// Hard limit on the .ico files Reskin writes (and the elevated helper
/// accepts).
pub const MAX_ICO_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameEncoding {
    Bmp,
    Png,
}

/// How a frame of a given size is stored.
pub fn encoding_for(size: u32) -> FrameEncoding {
    if size >= 256 {
        FrameEncoding::Png
    } else {
        FrameEncoding::Bmp
    }
}

/// Builds an .ico from square RGBA frames. Frames are written smallest
/// first; duplicate sizes keep the last one. Every frame below 256 px is a
/// 32-bpp BMP with an AND mask; 256 px is PNG.
pub fn build_ico(frames: &[Rgba]) -> Result<Vec<u8>, String> {
    if frames.is_empty() {
        return Err("an icon needs at least one frame".into());
    }
    let mut sorted: Vec<&Rgba> = Vec::new();
    for f in frames {
        if f.w != f.h {
            return Err(format!("icon frames must be square, got {}x{}", f.w, f.h));
        }
        if f.w == 0 || f.w > 256 {
            return Err(format!("icon frame size {} is out of range 1..=256", f.w));
        }
        sorted.retain(|g| g.w != f.w);
        sorted.push(f);
    }
    sorted.sort_by_key(|f| f.w);

    let blobs: Vec<Vec<u8>> = sorted
        .iter()
        .map(|f| match encoding_for(f.w) {
            FrameEncoding::Bmp => encode_bmp_frame(f),
            FrameEncoding::Png => f.encode_png(),
        })
        .collect();

    let count = sorted.len();
    let mut out = Vec::new();
    // ICONDIR
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(count as u16).to_le_bytes());
    let mut offset = 6 + 16 * count;
    for (f, blob) in sorted.iter().zip(&blobs) {
        let dim = if f.w >= 256 { 0u8 } else { f.w as u8 };
        out.push(dim); // width
        out.push(dim); // height
        out.push(0); // colour count
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bit count
        out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += blob.len();
    }
    for blob in &blobs {
        out.extend_from_slice(blob);
    }
    if out.len() > MAX_ICO_BYTES {
        return Err(format!(
            "icon is {} KB, larger than the {} KB limit",
            out.len() / 1024,
            MAX_ICO_BYTES / 1024
        ));
    }
    Ok(out)
}

/// BITMAPINFOHEADER + bottom-up BGRA XOR bitmap + 1-bpp AND mask.
fn encode_bmp_frame(f: &Rgba) -> Vec<u8> {
    let (w, h) = (f.w, f.h);
    let mask_stride = w.div_ceil(32) * 4;
    let xor_len = (w * h * 4) as usize;
    let and_len = (mask_stride * h) as usize;
    let mut out = Vec::with_capacity(40 + xor_len + and_len);
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(w as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&((h * 2) as i32).to_le_bytes()); // biHeight (xor + and)
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&((xor_len + and_len) as u32).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for y in (0..h).rev() {
        for x in 0..w {
            let [r, g, b, a] = f.pixel(x, y);
            if a == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                out.extend_from_slice(&[b, g, r, a]);
            }
        }
    }
    for y in (0..h).rev() {
        let mut row = vec![0u8; mask_stride as usize];
        for x in 0..w {
            if f.pixel(x, y)[3] == 0 {
                row[(x / 8) as usize] |= 0x80 >> (x % 8);
            }
        }
        out.extend_from_slice(&row);
    }
    out
}

/// Builds an .ico from the base64 PNGs the editor sends.
pub fn build_ico_from_pngs(images: &[SizedPng]) -> Result<Vec<u8>, String> {
    let mut frames = Vec::with_capacity(images.len());
    for img in images {
        let rgba = Rgba::from_png_base64(&img.png)?;
        if rgba.w != img.size || rgba.h != img.size {
            return Err(format!(
                "image for size {} is {}x{}",
                img.size, rgba.w, rgba.h
            ));
        }
        frames.push(rgba);
    }
    build_ico(&frames)
}

/// One decoded frame of an .ico.
#[derive(Debug, Clone)]
pub struct IcoFrame {
    pub image: Rgba,
    pub encoding: FrameEncoding,
    pub bits_per_pixel: u16,
}

/// Parses every frame of an .ico (largest first). Frames that fail to
/// decode are skipped; an error is returned only if none decode.
pub fn parse_ico(bytes: &[u8]) -> Result<Vec<IcoFrame>, String> {
    let dir = ico::IconDir::read(std::io::Cursor::new(bytes)).map_err(|e| format!("ico: {e}"))?;
    if dir.resource_type() != ico::ResourceType::Icon {
        return Err("not an icon (cursor file)".into());
    }
    let mut frames = Vec::new();
    for entry in dir.entries() {
        let Ok(img) = entry.decode() else { continue };
        let (w, h) = (img.width(), img.height());
        let Ok(rgba) = Rgba::from_raw(w, h, img.into_rgba_data()) else {
            continue;
        };
        frames.push(IcoFrame {
            image: rgba,
            encoding: if entry.is_png() {
                FrameEncoding::Png
            } else {
                FrameEncoding::Bmp
            },
            bits_per_pixel: entry.bits_per_pixel(),
        });
    }
    if frames.is_empty() {
        return Err("the icon has no readable frames".into());
    }
    frames.sort_by(|a, b| (b.image.w, b.bits_per_pixel).cmp(&(a.image.w, a.bits_per_pixel)));
    Ok(frames)
}

/// The best frame for display: the largest, preferring 32 bpp.
pub fn best_frame(frames: &[IcoFrame]) -> Option<&IcoFrame> {
    frames.iter().max_by_key(|f| (f.image.w, f.bits_per_pixel))
}

/// Strict structural validation used by the elevated helper: parses, has
/// at least one frame, square frames ≤256, within the size limit.
pub fn validate_ico(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_ICO_BYTES {
        return Err("icon too large".into());
    }
    if bytes.len() < 6 || bytes[0..4] != [0, 0, 1, 0] {
        return Err("not an .ico header".into());
    }
    let frames = parse_ico(bytes)?;
    for f in &frames {
        if f.image.w != f.image.h || f.image.w > 256 {
            return Err("unexpected frame geometry".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ICO_SIZES;

    fn sample(size: u32) -> Rgba {
        let mut img = Rgba::new(size, size);
        for y in 0..size {
            for x in 0..size {
                let a = if x < size / 2 { 255 } else { 128 };
                img.set_pixel(
                    x,
                    y,
                    [(x * 255 / size) as u8, (y * 255 / size) as u8, 77, a],
                );
            }
        }
        img
    }

    #[test]
    fn roundtrip_all_sizes_with_expected_encodings() {
        let frames: Vec<Rgba> = ICO_SIZES.iter().map(|&s| sample(s)).collect();
        let bytes = build_ico(&frames).unwrap();
        let parsed = parse_ico(&bytes).unwrap();
        assert_eq!(parsed.len(), ICO_SIZES.len());
        for f in &parsed {
            let expect = encoding_for(f.image.w);
            assert_eq!(f.encoding, expect, "size {}", f.image.w);
            assert_eq!(f.bits_per_pixel, 32, "size {}", f.image.w);
            assert_eq!(f.image, sample(f.image.w), "pixels differ at {}", f.image.w);
        }
        assert_eq!(best_frame(&parsed).unwrap().image.w, 256);
        validate_ico(&bytes).unwrap();
    }

    #[test]
    fn rejects_bad_input() {
        assert!(build_ico(&[]).is_err());
        assert!(build_ico(&[Rgba::new(10, 12)]).is_err());
        assert!(build_ico(&[Rgba::new(512, 512)]).is_err());
        assert!(validate_ico(b"hello").is_err());
        assert!(parse_ico(&[0, 0, 1, 0, 0, 0]).is_err());
    }

    #[test]
    fn from_pngs_checks_sizes() {
        let ok = SizedPng {
            size: 16,
            png: sample(16).to_png_base64(),
        };
        assert!(build_ico_from_pngs(std::slice::from_ref(&ok)).is_ok());
        let bad = SizedPng {
            size: 32,
            png: sample(16).to_png_base64(),
        };
        assert!(build_ico_from_pngs(&[bad]).is_err());
    }
}

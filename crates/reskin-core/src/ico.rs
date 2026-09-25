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

/// Largest frame edge [`parse_ico`] decodes, in pixels: the editor's
/// working size. A frame's own header (BITMAPINFOHEADER or PNG IHDR) sets
/// what decoding it allocates, so a few bytes could otherwise ask for
/// gigabytes; bigger frames are skipped before anything is allocated.
pub const MAX_FRAME_PX: u32 = 1024;

/// Most pixels [`parse_ico`] decodes from one icon, broken frames
/// included: sixteen frames of [`MAX_FRAME_PX`]. Real icons stay far below
/// it; the frames after it is spent are skipped, so many frames cannot add
/// up to gigabytes either.
pub const MAX_DECODE_PX: u64 = 16 * MAX_FRAME_PX as u64 * MAX_FRAME_PX as u64;

/// ICONDIR and ICONDIRENTRY sizes.
const DIR_HEADER_LEN: usize = 6;
const DIR_ENTRY_LEN: usize = 16;

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

/// Checks an .ico's directory against the file before the `ico` crate
/// reads it, which allocates the data size every entry claims up front:
/// the directory must fit in the file, each entry's data must lie inside
/// it, and all of them together may claim no more than the file holds.
fn check_directory(bytes: &[u8]) -> Result<(), String> {
    let count = match bytes.get(4..DIR_HEADER_LEN) {
        Some(&[lo, hi]) => usize::from(u16::from_le_bytes([lo, hi])),
        _ => return Err("ico: the header is cut short".into()),
    };
    let entries = bytes
        .get(DIR_HEADER_LEN..DIR_HEADER_LEN + count * DIR_ENTRY_LEN)
        .ok_or("ico: the directory is cut short")?;
    let len = bytes.len() as u64;
    let mut claimed = 0u64;
    for (i, entry) in entries.chunks_exact(DIR_ENTRY_LEN).enumerate() {
        // dwBytesInRes at 8, dwImageOffset at 12.
        let field = |at: usize| {
            u64::from(u32::from_le_bytes([
                entry[at],
                entry[at + 1],
                entry[at + 2],
                entry[at + 3],
            ]))
        };
        let (size, offset) = (field(8), field(12));
        if offset + size > len {
            return Err(format!("ico: image {i} lies outside the file"));
        }
        claimed += size;
    }
    if claimed > len {
        return Err("ico: the images claim more data than the file holds".into());
    }
    Ok(())
}

/// Parses every frame of an .ico (largest first). Frames that fail to
/// decode are skipped, and so are frames over [`MAX_FRAME_PX`] and those
/// after [`MAX_DECODE_PX`] is spent; an error is returned only if none
/// decode.
pub fn parse_ico(bytes: &[u8]) -> Result<Vec<IcoFrame>, String> {
    check_directory(bytes)?;
    let dir = ico::IconDir::read(std::io::Cursor::new(bytes)).map_err(|e| format!("ico: {e}"))?;
    if dir.resource_type() != ico::ResourceType::Icon {
        return Err("not an icon (cursor file)".into());
    }
    let mut budget = MAX_DECODE_PX;
    let mut frames = Vec::new();
    for entry in dir.entries() {
        // `IconDir::read` took the size from the frame's own header, which
        // is what `decode` allocates for before it reads any pixels. (Where
        // that header is unreadable, `decode` fails on it first.)
        let (w, h) = (entry.width(), entry.height());
        let pixels = u64::from(w) * u64::from(h);
        if w > MAX_FRAME_PX || h > MAX_FRAME_PX || pixels > budget {
            continue;
        }
        budget -= pixels;
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

    /// An .ico listing `images` (encoded frames), laid out one after
    /// another. The directory's width and height bytes say "256 or more",
    /// leaving the size to each image's own header.
    fn ico_of(images: &[Vec<u8>]) -> Vec<u8> {
        let mut out = vec![0, 0, 1, 0];
        out.extend_from_slice(&(images.len() as u16).to_le_bytes());
        let mut offset = DIR_HEADER_LEN + DIR_ENTRY_LEN * images.len();
        for image in images {
            out.extend_from_slice(&[0, 0, 0, 0]);
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&32u16.to_le_bytes());
            out.extend_from_slice(&(image.len() as u32).to_le_bytes());
            out.extend_from_slice(&(offset as u32).to_le_bytes());
            offset += image.len();
        }
        for image in images {
            out.extend_from_slice(image);
        }
        out
    }

    #[test]
    fn the_directory_must_fit_in_the_file() {
        let bytes = ico_of(&[encode_bmp_frame(&sample(16))]);
        assert_eq!(check_directory(&bytes), Ok(()));
        parse_ico(&bytes).unwrap();

        // Cut short in the header, in the directory, in the image.
        for len in [5, DIR_HEADER_LEN + DIR_ENTRY_LEN - 1, bytes.len() - 1] {
            assert!(check_directory(&bytes[..len]).is_err(), "{len} bytes");
            assert!(parse_ico(&bytes[..len]).is_err(), "{len} bytes");
        }

        // A 22-byte file whose image claims almost 4 GiB, or starts far past
        // its end.
        let mut huge = bytes[..DIR_HEADER_LEN + DIR_ENTRY_LEN].to_vec();
        huge[14..18].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
        assert!(check_directory(&huge).is_err());
        let mut far = bytes.clone();
        far[18..22].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(check_directory(&far).is_err());

        // Two entries sharing one image claim twice what the file holds.
        let mut shared = ico_of(&[encode_bmp_frame(&sample(16)), Vec::new()]);
        let (first, second) = (DIR_HEADER_LEN, DIR_HEADER_LEN + DIR_ENTRY_LEN);
        let size_and_offset = shared[first + 8..first + 16].to_vec();
        shared[second + 8..second + 16].copy_from_slice(&size_and_offset);
        assert!(check_directory(&shared).is_err());
    }

    #[test]
    fn frames_over_the_size_limit_are_skipped() {
        let wide = Rgba::filled(MAX_FRAME_PX + 1, 1, [9, 8, 7, 255]);
        let tall = Rgba::filled(1, MAX_FRAME_PX + 1, [9, 8, 7, 255]);
        let widest = Rgba::filled(MAX_FRAME_PX, 1, [1, 2, 3, 255]);
        let bytes = ico_of(&[
            encode_bmp_frame(&tall),
            wide.encode_png(),
            widest.encode_png(),
            encode_bmp_frame(&sample(16)),
        ]);
        let parsed = parse_ico(&bytes).unwrap();
        let sizes: Vec<(u32, u32)> = parsed.iter().map(|f| (f.image.w, f.image.h)).collect();
        assert_eq!(sizes, [(MAX_FRAME_PX, 1), (16, 16)]);
        assert_eq!(parsed[0].image, widest);
        // Nothing within the limit: nothing readable.
        assert!(parse_ico(&ico_of(&[encode_bmp_frame(&tall)])).is_err());
    }

    #[test]
    fn frames_after_the_decode_budget_are_skipped() {
        let full = Rgba::filled(MAX_FRAME_PX, MAX_FRAME_PX, [40, 80, 120, 255]).encode_png();
        let fit = (MAX_DECODE_PX / u64::from(MAX_FRAME_PX * MAX_FRAME_PX)) as usize;
        let parsed = parse_ico(&ico_of(&vec![full; fit + 1])).unwrap();
        assert_eq!(parsed.len(), fit);
    }
}

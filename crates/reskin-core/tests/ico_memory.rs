//! `ico::parse_ico` on hostile input: whatever an icon's headers claim,
//! parsing it allocates no more than decoding real frames of the allowed
//! size would. This binary counts the bytes each thread allocates and
//! refuses any single request over [`REFUSE_OVER`], so a regression aborts
//! it ("memory allocation of … bytes failed") instead of exhausting the
//! machine.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use reskin_core::ico::{MAX_DECODE_PX, parse_ico};
use reskin_core::pixels::Rgba;

/// Largest single allocation granted: well above the 4 MiB one frame of
/// `ico::MAX_FRAME_PX` decodes to.
const REFUSE_OVER: usize = 64 << 20;

thread_local! {
    /// Bytes allocated on this thread; a reallocation counts its new size.
    static ALLOCATED: Cell<u64> = const { Cell::new(0) };
}

struct Counting;

impl Counting {
    /// Counts `size` against this thread, or refuses it.
    fn grant(size: usize) -> bool {
        if size > REFUSE_OVER {
            return false;
        }
        // Fails only while the thread is being torn down: not counted then.
        let _ = ALLOCATED.try_with(|a| a.set(a.get() + size as u64));
        true
    }
}

// SAFETY: every request is passed to `System` unchanged, or refused with a
// null pointer, which `GlobalAlloc` allows.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !Self::grant(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !Self::grant(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: the caller upholds `GlobalAlloc::alloc_zeroed`'s contract.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if !Self::grant(new_size) {
            return std::ptr::null_mut();
        }
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract, and
        // `ptr` came from `System` through this allocator.
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: as for `realloc`.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// How many frames `parse_ico(bytes)` returns, and the bytes it allocated.
fn parse_counting(bytes: &[u8]) -> (Result<usize, String>, u64) {
    let before = ALLOCATED.with(Cell::get);
    let frames = parse_ico(bytes).map(|frames| frames.len());
    (frames, ALLOCATED.with(Cell::get) - before)
}

/// An .ico listing `images`, laid out one after another. The directory's
/// width and height bytes say "256 or more", leaving the size to each
/// image's own header.
fn ico_of(images: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![0, 0, 1, 0];
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * images.len();
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

/// The BITMAPINFOHEADER of a `w`×`h` 32-bpp frame, and no pixels.
fn bmp_header(w: i32, h: i32) -> Vec<u8> {
    let mut out = Vec::with_capacity(40);
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&w.to_le_bytes());
    // Colour rows and mask rows.
    out.extend_from_slice(&(h * 2).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&[0; 24]);
    out
}

/// CRC-32 as PNG chunks use it.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

/// A 1×1 PNG whose IHDR says it is `w`×`h`.
fn png_claiming(w: u32, h: u32) -> Vec<u8> {
    let mut png = Rgba::filled(1, 1, [0, 0, 0, 255]).encode_png();
    // Signature (8), then IHDR: length (4), type (4), data (13), CRC (4).
    png[16..20].copy_from_slice(&w.to_be_bytes());
    png[20..24].copy_from_slice(&h.to_be_bytes());
    let crc = crc32(&png[12..29]);
    png[29..33].copy_from_slice(&crc.to_be_bytes());
    png
}

#[test]
fn a_frame_header_cannot_ask_for_gigabytes() {
    // 62 bytes: a 65535×65535 32-bpp bitmap, 16 GiB decoded.
    let bitmap = ico_of(&[bmp_header(65535, 65535)]);
    assert_eq!(bitmap.len(), 62);
    // A PNG of 1×(2³¹−1) pixels, 8 GiB decoded.
    let png = ico_of(&[png_claiming(1, 0x7FFF_FFFF)]);
    for (name, bytes) in [("bitmap", &bitmap), ("png", &png)] {
        let (frames, allocated) = parse_counting(bytes);
        assert!(frames.is_err(), "{name}: {frames:?}");
        assert!(allocated < 1 << 20, "{name}: {allocated} bytes");
    }
}

#[test]
fn the_directory_cannot_claim_more_than_the_file_holds() {
    // 22 bytes: one image of almost 4 GiB.
    let mut huge = ico_of(&[Vec::new()]);
    huge[14..18].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
    assert_eq!(huge.len(), 22);
    // 4096 entries sharing one small image: each would be copied.
    let image = bmp_header(16, 16);
    let mut shared = ico_of(&vec![Vec::new(); 4096]);
    let first = shared.len() as u32;
    shared.extend_from_slice(&image);
    for entry in shared[6..6 + 16 * 4096].chunks_exact_mut(16) {
        entry[8..12].copy_from_slice(&(image.len() as u32).to_le_bytes());
        entry[12..16].copy_from_slice(&first.to_le_bytes());
    }
    for (name, bytes) in [("huge", &huge), ("shared", &shared)] {
        let (frames, allocated) = parse_counting(bytes);
        assert!(frames.is_err(), "{name}: {frames:?}");
        assert!(allocated < 1 << 20, "{name}: {allocated} bytes");
    }
}

#[test]
fn broken_frames_cannot_add_up_to_gigabytes() {
    // 256 frames that claim 1024×1024 but hold no pixels: decoding each
    // allocates 4 MiB before finding that out. 14 KB of file, 1 GiB.
    let bytes = ico_of(&vec![bmp_header(1024, 1024); 256]);
    let (frames, allocated) = parse_counting(&bytes);
    assert!(frames.is_err(), "{frames:?}");
    let budget = MAX_DECODE_PX * 4 + (1 << 20);
    assert!(allocated <= budget, "{allocated} bytes, budget {budget}");
}

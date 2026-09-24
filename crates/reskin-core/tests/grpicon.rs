//! `grpicon::rebuild_ico` against icons built by `ico::build_ico`: an .ico is
//! split into the form a PE file stores it in (an `RT_GROUP_ICON` directory
//! plus `RT_ICON` blobs keyed by id) and rebuilt.

use std::collections::HashMap;

use reskin_core::grpicon::{GroupEntry, parse_group, rebuild_ico};
use reskin_core::ico::{build_ico, parse_ico};
use reskin_core::model::ICO_SIZES;
use reskin_core::pixels::Rgba;

fn sample(size: u32) -> Rgba {
    let mut img = Rgba::new(size, size);
    for y in 0..size {
        for x in 0..size {
            let a = if (x + y) % 3 == 0 {
                0
            } else {
                200 + (x % 56) as u8
            };
            img.set_pixel(x, y, [(x * 7) as u8, (y * 5) as u8, (size % 251) as u8, a]);
        }
    }
    img
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> usize {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as usize
}

/// Converts an .ico into resource form: a GRPICONDIR whose 14-byte entries
/// carry the given RT_ICON ids, and the image blobs keyed by id.
fn to_group(ico: &[u8], ids: &[u16]) -> (Vec<u8>, HashMap<u16, Vec<u8>>) {
    let count = usize::from(u16_at(ico, 4));
    assert_eq!(count, ids.len(), "one id per frame");
    let mut group = ico[..6].to_vec();
    let mut blobs = HashMap::new();
    for (i, &id) in ids.iter().enumerate() {
        let entry = &ico[6 + i * 16..6 + (i + 1) * 16];
        group.extend_from_slice(&entry[..12]);
        group.extend_from_slice(&id.to_le_bytes());
        let (size, offset) = (u32_at(entry, 8), u32_at(entry, 12));
        blobs.insert(id, ico[offset..offset + size].to_vec());
    }
    (group, blobs)
}

fn all_sizes_ico() -> Vec<u8> {
    let frames: Vec<Rgba> = ICO_SIZES.iter().map(|&s| sample(s)).collect();
    build_ico(&frames).unwrap()
}

#[test]
fn rebuild_is_byte_identical_and_parses_the_same_frames() {
    let ico = all_sizes_ico();
    let ids: Vec<u16> = (1..=ICO_SIZES.len() as u16).collect();
    let (group, blobs) = to_group(&ico, &ids);
    let rebuilt = rebuild_ico(&group, |id| blobs.get(&id).cloned()).unwrap();
    assert_eq!(rebuilt, ico);

    let original = parse_ico(&ico).unwrap();
    let parsed = parse_ico(&rebuilt).unwrap();
    assert_eq!(parsed.len(), ICO_SIZES.len());
    for (a, b) in original.iter().zip(&parsed) {
        assert_eq!(a.image, b.image);
        assert_eq!(a.encoding, b.encoding);
        assert_eq!(a.bits_per_pixel, b.bits_per_pixel);
    }
}

#[test]
fn arbitrary_resource_ids_are_followed() {
    let ico = build_ico(&[sample(16), sample(48), sample(256)]).unwrap();
    let ids = [305, 2, 60_000];
    let (group, blobs) = to_group(&ico, &ids);
    let entries = parse_group(&group).unwrap();
    assert_eq!(
        entries.iter().map(|e| e.id).collect::<Vec<_>>(),
        ids.to_vec()
    );
    assert_eq!(
        entries[0],
        GroupEntry {
            width: 16,
            height: 16,
            color_count: 0,
            reserved: 0,
            planes: 1,
            bit_count: 32,
            bytes_in_res: blobs[&305].len() as u32,
            id: 305,
        }
    );
    assert_eq!(entries[2].width, 0, "256 px is stored as 0");
    let rebuilt = rebuild_ico(&group, |id| blobs.get(&id).cloned()).unwrap();
    assert_eq!(rebuilt, ico);
}

#[test]
fn missing_images_are_skipped() {
    let ico = build_ico(&[sample(16), sample(32), sample(48)]).unwrap();
    let (group, mut blobs) = to_group(&ico, &[1, 2, 3]);
    blobs.remove(&2);
    let rebuilt = rebuild_ico(&group, |id| blobs.get(&id).cloned()).unwrap();
    assert_eq!(u16_at(&rebuilt, 4), 2);
    let parsed = parse_ico(&rebuilt).unwrap();
    let sizes: Vec<u32> = parsed.iter().map(|f| f.image.w).collect();
    assert_eq!(sizes, vec![48, 16]);
    // the surviving frames decode exactly like the original's
    let original = parse_ico(&ico).unwrap();
    let original_48 = original.iter().find(|f| f.image.w == 48).unwrap();
    let original_16 = original.iter().find(|f| f.image.w == 16).unwrap();
    assert_eq!(parsed[0].image, original_48.image);
    assert_eq!(parsed[1].image, original_16.image);

    let err = rebuild_ico(&group, |_| None);
    assert!(err.is_err(), "no images at all must be an error");
}

#[test]
fn malformed_groups_error_without_panicking() {
    let ico = build_ico(&[sample(16), sample(32)]).unwrap();
    let (group, blobs) = to_group(&ico, &[1, 2]);
    let get = |id: u16| blobs.get(&id).cloned();

    // truncated anywhere: header or entries
    for len in 0..group.len() {
        assert!(
            rebuild_ico(&group[..len], get).is_err(),
            "truncated to {len} bytes"
        );
    }
    // zero entries
    let mut zero = group.clone();
    zero[4] = 0;
    zero[5] = 0;
    assert!(rebuild_ico(&zero, get).is_err());
    // cursor directory / unknown type
    for kind in [0u8, 2, 7] {
        let mut bad = group.clone();
        bad[2] = kind;
        assert!(rebuild_ico(&bad, get).is_err(), "idType {kind}");
    }
    // a count far larger than the data
    let mut huge = group.clone();
    huge[4] = 0xFF;
    huge[5] = 0xFF;
    assert!(rebuild_ico(&huge, get).is_err());
}

#[test]
fn random_bytes_never_panic() {
    // Deterministic xorshift so failures are reproducible.
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..2000 {
        let len = (next() % 80) as usize;
        let mut bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
        if len >= 6 && next() % 2 == 0 {
            // make a plausible header so the entry parser is exercised
            bytes[2] = 1;
            bytes[3] = 0;
            bytes[5] = 0;
        }
        let _ = parse_group(&bytes);
        let _ = rebuild_ico(&bytes, |id| (id % 3 != 0).then(|| vec![id as u8; 3]));
    }
}

//! Rebuilding an `.ico` file from a PE icon group.
//!
//! Executables and DLLs store an icon as one `RT_GROUP_ICON` resource (a
//! GRPICONDIR directory) whose entries point at the individual images — the
//! `RT_ICON` resources — by resource id instead of by file offset. Turning a
//! group back into an ICO file only means rewriting that directory with file
//! offsets and appending the image blobs unchanged, which yields an exact,
//! lossless copy of every frame (what Explorer itself renders).
//!
//! Layouts (all little endian):
//!
//! ```text
//! GRPICONDIR      idReserved u16, idType u16 (1 = icon), idCount u16
//! GRPICONDIRENTRY bWidth u8, bHeight u8, bColorCount u8, bReserved u8,
//!                 wPlanes u16, wBitCount u16, dwBytesInRes u32, nId u16   (14 bytes)
//! ICONDIR         same 6-byte header as GRPICONDIR
//! ICONDIRENTRY    same first 12 bytes, then dwBytesInRes u32, dwImageOffset u32 (16 bytes)
//! ```
//!
//! Resources in the wild are frequently malformed, and any program's can be
//! crafted, so everything is bounds checked and a bad directory is an
//! error, never a panic. What a group makes Reskin allocate is bounded
//! too: at most [`MAX_GROUP_ENTRIES`] entries, each image fetched once
//! however often the group lists it, and a rebuilt icon of at most
//! [`ico::MAX_READ_ICO_BYTES`], checked before anything is copied.

use std::collections::HashSet;

use crate::{Error, Result, ico};

const HEADER_LEN: usize = 6;
const GROUP_ENTRY_LEN: usize = 14;
const ICO_ENTRY_LEN: usize = 16;
/// `idType` of icon directories (cursors use 2).
const TYPE_ICON: u16 = 1;

/// Most entries an icon group may have. Real groups have a few dozen at
/// most (every size in three colour depths).
pub const MAX_GROUP_ENTRIES: usize = 256;

/// One `GRPICONDIRENTRY` of an icon group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupEntry {
    /// Width in pixels, 0 meaning 256.
    pub width: u8,
    /// Height in pixels, 0 meaning 256.
    pub height: u8,
    pub color_count: u8,
    pub reserved: u8,
    pub planes: u16,
    pub bit_count: u16,
    /// Size of the image as recorded in the group (informational; the
    /// rebuilt file uses the actual length of the `RT_ICON` blob).
    pub bytes_in_res: u32,
    /// Resource id of the `RT_ICON` image.
    pub id: u16,
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// Parses a `RT_GROUP_ICON` resource into its entries (in directory order).
pub fn parse_group(group: &[u8]) -> Result<Vec<GroupEntry>> {
    if group.len() < HEADER_LEN {
        return Err(Error::Other(format!(
            "icon group is truncated ({} bytes, the header alone needs {HEADER_LEN})",
            group.len()
        )));
    }
    let kind = u16_at(group, 2);
    if kind != TYPE_ICON {
        return Err(Error::Unsupported(format!(
            "resource directory type {kind} is not an icon group"
        )));
    }
    let count = usize::from(u16_at(group, 4));
    if count == 0 {
        return Err(Error::Other("icon group has no entries".into()));
    }
    if count > MAX_GROUP_ENTRIES {
        return Err(Error::Unsupported(format!(
            "icon group has {count} entries, more than the {MAX_GROUP_ENTRIES} an icon may have"
        )));
    }
    let needed = HEADER_LEN + count * GROUP_ENTRY_LEN;
    if group.len() < needed {
        return Err(Error::Other(format!(
            "icon group is truncated: {count} entries need {needed} bytes, got {}",
            group.len()
        )));
    }
    Ok((0..count)
        .map(|i| {
            let at = HEADER_LEN + i * GROUP_ENTRY_LEN;
            GroupEntry {
                width: group[at],
                height: group[at + 1],
                color_count: group[at + 2],
                reserved: group[at + 3],
                planes: u16_at(group, at + 4),
                bit_count: u16_at(group, at + 6),
                bytes_in_res: u32_at(group, at + 8),
                id: u16_at(group, at + 12),
            }
        })
        .collect())
}

/// Rebuilds a standalone `.ico` from a `RT_GROUP_ICON` resource.
///
/// `get_icon(id)` lends the raw bytes of the `RT_ICON` resource with that
/// id (a BMP DIB or a PNG), so only what goes into the result is copied.
/// It is asked once per id; an entry that lists an id again names the same
/// image and is left out. Entries whose image is missing or empty
/// are skipped; it is an error when none remain, and when the images add
/// up to an icon over [`ico::MAX_READ_ICO_BYTES`]. Entry fields are copied
/// verbatim except the size, which is the actual blob length, and the
/// offset, which is computed.
pub fn rebuild_ico<'a>(
    group: &[u8],
    get_icon: impl Fn(u16) -> Option<&'a [u8]>,
) -> Result<Vec<u8>> {
    let entries = parse_group(group)?;
    let mut fetched = HashSet::with_capacity(entries.len());
    let mut frames: Vec<(GroupEntry, &[u8])> = Vec::with_capacity(entries.len());
    let mut total = HEADER_LEN;
    for e in entries {
        if !fetched.insert(e.id) {
            continue;
        }
        let Some(blob) = get_icon(e.id).filter(|b| !b.is_empty()) else {
            continue;
        };
        total = total.saturating_add(ICO_ENTRY_LEN + blob.len());
        if total > ico::MAX_READ_ICO_BYTES {
            return Err(Error::Unsupported(format!(
                "the icon group's images take more than the {} MB an icon may have",
                ico::MAX_READ_ICO_BYTES >> 20
            )));
        }
        frames.push((e, blob));
    }
    if frames.is_empty() {
        return Err(Error::NotFound(
            "none of the icon group's images could be loaded".into(),
        ));
    }

    let count = frames.len();
    let header_len = HEADER_LEN + count * ICO_ENTRY_LEN;
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&TYPE_ICON.to_le_bytes());
    // `count` ≤ MAX_GROUP_ENTRIES, so this cannot truncate.
    out.extend_from_slice(&(count as u16).to_le_bytes());
    let mut offset = header_len;
    for (e, blob) in &frames {
        out.extend_from_slice(&[e.width, e.height, e.color_count, e.reserved]);
        out.extend_from_slice(&e.planes.to_le_bytes());
        out.extend_from_slice(&e.bit_count.to_le_bytes());
        // Both fit in u32: `total` is at most MAX_READ_ICO_BYTES.
        out.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        out.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += blob.len();
    }
    for (_, blob) in &frames {
        out.extend_from_slice(blob);
    }
    debug_assert_eq!(out.len(), total);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn group(entries: &[(u8, u16)]) -> Vec<u8> {
        let mut g = vec![0, 0, 1, 0];
        g.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for &(size, id) in entries {
            g.extend_from_slice(&[size, size, 0, 0, 1, 0, 32, 0]);
            g.extend_from_slice(&4u32.to_le_bytes());
            g.extend_from_slice(&id.to_le_bytes());
        }
        g
    }

    #[test]
    fn offsets_follow_the_directory() {
        let g = group(&[(16, 7), (32, 9)]);
        let (seven, nine) = ([7u8; 7], [9u8; 9]);
        let ico = rebuild_ico(&g, |id| match id {
            7 => Some(&seven[..]),
            9 => Some(&nine[..]),
            _ => None,
        })
        .unwrap();
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 2, 0]);
        // first entry: 7 bytes at 6 + 2 * 16 = 38
        assert_eq!(u32_at(&ico, 6 + 8), 7);
        assert_eq!(u32_at(&ico, 6 + 12), 38);
        // second entry: 9 bytes at 45
        assert_eq!(u32_at(&ico, 22 + 8), 9);
        assert_eq!(u32_at(&ico, 22 + 12), 45);
        assert_eq!(ico.len(), 38 + 7 + 9);
        assert_eq!(&ico[38..45], &[7; 7]);
    }

    #[test]
    fn skips_missing_and_empty_images() {
        let g = group(&[(16, 1), (32, 2), (48, 3)]);
        let ico = rebuild_ico(&g, |id| match id {
            2 => Some(&[1, 2, 3][..]),
            3 => Some(&[][..]),
            _ => None,
        })
        .unwrap();
        assert_eq!(u16_at(&ico, 4), 1);
        assert_eq!(ico[6], 32);
        assert!(rebuild_ico(&g, |_| None).is_err());
    }

    #[test]
    fn an_image_listed_again_is_fetched_and_copied_once() {
        // Every entry but the last names image 1: without the check, a
        // crafted group copies one image as often as it lists it.
        let mut entries = vec![(16, 1); MAX_GROUP_ENTRIES - 1];
        entries.push((32, 2));
        let (one, two) = ([1u8; 1000], [2u8; 3]);
        let asked = RefCell::new(Vec::new());
        let ico = rebuild_ico(&group(&entries), |id| {
            asked.borrow_mut().push(id);
            match id {
                1 => Some(&one[..]),
                2 => Some(&two[..]),
                _ => None,
            }
        })
        .unwrap();
        assert_eq!(asked.into_inner(), [1, 2]);
        assert_eq!(u16_at(&ico, 4), 2);
        assert_eq!((ico[6], ico[22]), (16, 32));
        assert_eq!(ico.len(), HEADER_LEN + 2 * ICO_ENTRY_LEN + 1000 + 3);
    }

    #[test]
    fn a_group_may_have_at_most_max_entries() {
        let blob = [1u8; 4];
        let entries = |n: usize| -> Vec<(u8, u16)> { (1..=n as u16).map(|id| (16, id)).collect() };
        let full = group(&entries(MAX_GROUP_ENTRIES));
        assert_eq!(parse_group(&full).unwrap().len(), MAX_GROUP_ENTRIES);
        let ico = rebuild_ico(&full, |_| Some(&blob[..])).unwrap();
        assert_eq!(usize::from(u16_at(&ico, 4)), MAX_GROUP_ENTRIES);

        let over = group(&entries(MAX_GROUP_ENTRIES + 1));
        assert!(parse_group(&over).is_err());
        let asked = RefCell::new(0);
        let refused = rebuild_ico(&over, |_| {
            *asked.borrow_mut() += 1;
            Some(&blob[..])
        });
        assert!(refused.is_err());
        assert_eq!(asked.into_inner(), 0, "nothing is fetched");
    }

    #[test]
    fn the_rebuilt_icon_may_take_up_to_the_read_limit() {
        const MIB: usize = 1 << 20;
        // Fifteen images of 1 MiB (all the same bytes, borrowed once), and
        // a last one that fills the icon exactly up to the limit, or one
        // byte past it.
        let big = vec![7u8; MIB];
        let fill = ico::MAX_READ_ICO_BYTES - HEADER_LEN - 16 * ICO_ENTRY_LEN - 15 * MIB;
        let entries: Vec<(u8, u16)> = (1..=16).map(|id| (0, id)).collect();
        let g = group(&entries);
        for (last, fits) in [(vec![8u8; fill], true), (vec![8u8; fill + 1], false)] {
            let rebuilt = rebuild_ico(&g, |id| Some(if id == 16 { &last[..] } else { &big[..] }));
            match rebuilt {
                Ok(ico) => {
                    assert!(fits, "{} bytes were accepted", ico.len());
                    assert_eq!(ico.len(), ico::MAX_READ_ICO_BYTES);
                }
                Err(e) => assert!(!fits, "{e}"),
            }
        }
    }
}

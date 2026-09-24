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
//! Resources in the wild are frequently malformed, so everything is bounds
//! checked and a bad directory is an error, never a panic.

use crate::{Error, Result};

const HEADER_LEN: usize = 6;
const GROUP_ENTRY_LEN: usize = 14;
const ICO_ENTRY_LEN: usize = 16;
/// `idType` of icon directories (cursors use 2).
const TYPE_ICON: u16 = 1;

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
/// `get_icon(id)` returns the raw bytes of the `RT_ICON` resource with that
/// id (a BMP DIB or a PNG). Entries whose image is missing or empty are
/// skipped; it is an error when none remain. Entry fields are copied
/// verbatim except the size, which is the actual blob length, and the
/// offset, which is computed.
pub fn rebuild_ico(group: &[u8], get_icon: impl Fn(u16) -> Option<Vec<u8>>) -> Result<Vec<u8>> {
    let entries = parse_group(group)?;
    let frames: Vec<(GroupEntry, Vec<u8>)> = entries
        .into_iter()
        .filter_map(|e| get_icon(e.id).filter(|b| !b.is_empty()).map(|b| (e, b)))
        .collect();
    if frames.is_empty() {
        return Err(Error::NotFound(
            "none of the icon group's images could be loaded".into(),
        ));
    }

    let count = frames.len();
    let header_len = HEADER_LEN + count * ICO_ENTRY_LEN;
    let total = frames
        .iter()
        .try_fold(header_len, |acc, (_, blob)| acc.checked_add(blob.len()))
        .filter(|&t| u32::try_from(t).is_ok())
        .ok_or_else(|| Error::Other("icon group is too large for an .ico file".into()))?;

    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&TYPE_ICON.to_le_bytes());
    // `count` ≤ the group's u16 entry count, so this cannot truncate.
    out.extend_from_slice(&(count as u16).to_le_bytes());
    let mut offset = header_len;
    for (e, blob) in &frames {
        out.extend_from_slice(&[e.width, e.height, e.color_count, e.reserved]);
        out.extend_from_slice(&e.planes.to_le_bytes());
        out.extend_from_slice(&e.bit_count.to_le_bytes());
        // Both fit in u32: `total` was checked above.
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
        let ico = rebuild_ico(&g, |id| Some(vec![id as u8; id as usize])).unwrap();
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
            2 => Some(vec![1, 2, 3]),
            3 => Some(Vec::new()),
            _ => None,
        })
        .unwrap();
        assert_eq!(u16_at(&ico, 4), 1);
        assert_eq!(ico[6], 32);
        assert!(rebuild_ico(&g, |_| None).is_err());
    }
}

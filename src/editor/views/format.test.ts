import { describe, expect, it } from 'vitest';
import { dayGroup, formatBytes, pngSrc, shortPath, timeAgo } from './format';

const now = new Date(2026, 8, 24, 15, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime();

describe('format', () => {
  it('says how long ago', () => {
    expect(timeAgo(now - 10_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(at(24, 12), now)).toBe('3 h ago');
    expect(timeAgo(at(23, 22), now)).toBe('yesterday');
    expect(timeAgo(at(20, 9), now)).toBe('4 days ago');
    expect(timeAgo(at(1, 9), now)).toMatch(/1|Sep/);
  });

  it('groups by day', () => {
    expect(dayGroup(at(24, 1), now)).toBe('Today');
    expect(dayGroup(at(23, 23), now)).toBe('Yesterday');
    expect(dayGroup(at(20, 10), now)).toBe('This week');
    expect(dayGroup(new Date(2026, 5, 2).getTime(), now)).toMatch(/2026/);
  });

  it('shortens long paths from the start', () => {
    expect(shortPath('C:\\Users\\me\\Desktop\\Steam.lnk')).toBe('C:\\Users\\me\\Desktop\\Steam.lnk');
    const long = 'C:\\Users\\someone\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Steam\\Steam.lnk';
    const s = shortPath(long, 40);
    expect(s.startsWith('…\\')).toBe(true);
    expect(s.endsWith('Steam\\Steam.lnk')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(40);
  });

  it('formats sizes and image sources', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(48 * 1024)).toBe('48 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
    expect(pngSrc('AAAA')).toBe('data:image/png;base64,AAAA');
    expect(pngSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(pngSrc(null)).toBeNull();
  });
});

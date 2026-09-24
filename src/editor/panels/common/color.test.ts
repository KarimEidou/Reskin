import { describe, expect, it, vi } from 'vitest';

const saved: string[][] = [];
vi.mock('$lib/settings/store.svelte', () => ({
  settings: () => ({ recentColors: ['#111111', '#222222'] }),
  updateSettings: vi.fn(async (patch: { recentColors: string[] }) => {
    saved.push(patch.recentColors);
    return patch;
  }),
}));

const { hexOf, rememberColor, rgbaOf, withRecent } = await import('./color');

describe('recent colours', () => {
  it('puts the newest colour first, without duplicates, at most 16', () => {
    expect(withRecent(['#aaaaaa', '#bbbbbb'], '#BBBBBB')).toEqual(['#bbbbbb', '#aaaaaa']);
    expect(withRecent([], '#12345680')).toEqual(['#12345680']);
    expect(withRecent(['#aaaaaa'], 'red')).toEqual(['#aaaaaa']);
    const many = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`);
    const next = withRecent(many, '#ffffff');
    expect(next).toHaveLength(16);
    expect(next[0]).toBe('#ffffff');
    expect(next).not.toContain('#00000f');
  });

  it('saves committed colours to settings', () => {
    rememberColor({ r: 255, g: 0, b: 0, a: 1 });
    expect(saved.at(-1)).toEqual(['#ff0000', '#111111', '#222222']);
    rememberColor('#111111');
    expect(saved.at(-1)?.[0]).toBe('#111111');
  });

  it('converts between hex and engine colours', () => {
    expect(hexOf({ r: 255, g: 128.4, b: 0, a: 0.5 })).toBe('#ff800080');
    expect(rgbaOf('#00ff00')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(rgbaOf('nonsense')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });
});

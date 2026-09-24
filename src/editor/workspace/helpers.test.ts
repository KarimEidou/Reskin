import { describe, expect, it } from 'vitest';
import { TOOL_ORDER, createTools } from '$engine/index';
import type { ItemInfo } from '$lib/ipc/types';
import { applyBlockedReason, MODE_INFO, MODE_ORDER, orderedModes, preferredMode } from './apply-modes';
import { fromHsv, hexOf, hueCss, parseColorInput, pushRecent, svFromPoint, toHsv } from './color-picker';
import { filterFonts } from './fonts';
import { gradientCss } from './gradient-css';
import { groupOf, missingFromRail, RAIL_GROUPS, railOrder, SELECTION_TOOLS, SYMMETRY_TOOLS } from './tool-groups';

describe('tool rail groups', () => {
  it('shows every engine tool exactly once, in the engine rail order', () => {
    expect(railOrder()).toEqual([...TOOL_ORDER]);
    expect(missingFromRail()).toEqual([]);
    expect(new Set(railOrder()).size).toBe(railOrder().length);
  });

  it('finds a tool’s group', () => {
    expect(groupOf('selectEllipse').tools).toEqual(['selectRect', 'selectEllipse', 'lasso', 'magicWand']);
    expect(groupOf('gradient').id).toBe('fill');
    expect(() => groupOf('nope' as never)).toThrow();
  });

  it('marks symmetry tools the engine replicates', () => {
    const tools = createTools();
    for (const id of TOOL_ORDER) expect(SYMMETRY_TOOLS.includes(id)).toBe(tools[id].usesSymmetry);
    expect(SELECTION_TOOLS).toEqual(['selectRect', 'selectEllipse', 'lasso', 'magicWand']);
    expect(SYMMETRY_TOOLS).toEqual(['brush', 'spray', 'pencil', 'eraser', 'stamp', 'smudge', 'blurSharpen', 'dodgeBurn']);
  });

  it('uses unique group ids', () => {
    expect(new Set(RAIL_GROUPS.map((g) => g.id)).size).toBe(RAIL_GROUPS.length);
  });
});

describe('colour picker maths', () => {
  it('maps the SV square', () => {
    expect(svFromPoint(0, 0, 200, 100)).toEqual({ s: 0, v: 1 });
    expect(svFromPoint(200, 100, 200, 100)).toEqual({ s: 1, v: 0 });
    expect(svFromPoint(-10, 150, 200, 100)).toEqual({ s: 0, v: 0 });
    expect(svFromPoint(50, 25, 0, 0)).toEqual({ s: 0, v: 0 });
  });

  it('keeps the hue for greys and black', () => {
    expect(toHsv({ r: 0, g: 0, b: 0, a: 1 }, { h: 200, s: 0.7 })).toEqual({ h: 200, s: 0.7, v: 0, a: 1 });
    expect(toHsv({ r: 128, g: 128, b: 128, a: 1 }, { h: 200, s: 0.7 }).h).toBe(200);
    expect(toHsv({ r: 255, g: 0, b: 0, a: 1 }, { h: 200, s: 0.7 }).h).toBe(0);
  });

  it('round-trips colours through HSV', () => {
    for (const c of [
      { r: 255, g: 0, b: 0, a: 1 },
      { r: 12, g: 200, b: 99, a: 0.5 },
      { r: 124, g: 92, b: 255, a: 1 },
    ]) {
      expect(fromHsv(toHsv(c))).toEqual(c);
    }
  });

  it('formats and parses hex input', () => {
    expect(hexOf({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000');
    expect(hexOf({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#ff000080');
    expect(parseColorInput('7c5cff')).toEqual({ r: 124, g: 92, b: 255, a: 1 });
    expect(parseColorInput('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColorInput('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColorInput('  ')).toBeNull();
    expect(parseColorInput('not a colour')).toBeNull();
    expect(hueCss(-30)).toBe('hsl(330 100% 50%)');
  });

  it('keeps recent colours unique, newest first, capped', () => {
    expect(pushRecent(['#000000', '#ffffff'], '#FFFFFF', 16)).toEqual(['#ffffff', '#000000']);
    expect(pushRecent(['#111111', '#222222', '#333333'], '#444444', 3)).toEqual(['#444444', '#111111', '#222222']);
  });
});

describe('filterFonts', () => {
  const fonts = ['Arial', 'Bahnschrift', 'Cascadia Code', 'Segoe UI', 'Segoe UI Variable Display', 'Times New Roman'];

  it('lists everything for an empty query, adding a missing current font', () => {
    expect(filterFonts(fonts, '')).toEqual(fonts);
    expect(filterFonts(fonts, '', 'Fancy Font')).toEqual(['Fancy Font', ...fonts]);
    expect(filterFonts(fonts, '', 'Arial')).toEqual(fonts);
  });

  it('ranks prefix, then word, then substring matches', () => {
    expect(filterFonts(fonts, 'seg')).toEqual(['Segoe UI', 'Segoe UI Variable Display']);
    expect(filterFonts(fonts, 'code')).toEqual(['Cascadia Code']);
    expect(filterFonts(fonts, 'ma')).toEqual(['Times New Roman']);
    expect(filterFonts(fonts, 'ROMAN')).toEqual(['Times New Roman']);
    expect(filterFonts(fonts, 'zzz')).toEqual([]);
  });
});

describe('gradientCss', () => {
  it('sorts stops and writes percentages', () => {
    expect(
      gradientCss([
        { offset: 1, color: { r: 0, g: 0, b: 255, a: 1 } },
        { offset: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
        { offset: 0.333, color: { r: 0, g: 255, b: 0, a: 0.5 } },
      ]),
    ).toBe('linear-gradient(to right, rgb(255, 0, 0) 0%, rgba(0, 255, 0, 0.5) 33.3%, rgb(0, 0, 255) 100%)');
  });

  it('handles one or no stops', () => {
    expect(gradientCss([{ offset: 2, color: { r: 1, g: 2, b: 3, a: 1 } }])).toBe(
      'linear-gradient(to right, rgb(1, 2, 3) 100%, rgb(1, 2, 3) 100%)',
    );
    expect(gradientCss([])).toContain('transparent');
  });
});

describe('apply modes', () => {
  const item = (patch: Partial<ItemInfo>): Pick<ItemInfo, 'name' | 'modes' | 'kind'> => ({
    name: 'Steam',
    kind: 'shortcut',
    modes: ['inPlace'],
    ...patch,
  });

  it('describes every mode', () => {
    expect(MODE_ORDER).toEqual(['inPlace', 'newShortcut', 'personalCopy']);
    for (const m of MODE_ORDER) expect(MODE_INFO[m].label.length).toBeGreaterThan(3);
    expect(MODE_INFO.inPlace.label).toBe('Change in place');
    expect(MODE_INFO.newShortcut.label).toBe('New desktop shortcut');
    expect(MODE_INFO.personalCopy.label).toBe('Personal copy');
  });

  it('explains why applying is blocked', () => {
    expect(applyBlockedReason(item({}), null)).toBeNull();
    expect(applyBlockedReason(null, null)).toBe('Drop a shortcut here to apply');
    expect(applyBlockedReason(item({}), { label: 'Applying' })).toBe('Applying…');
    expect(applyBlockedReason(item({ kind: 'image', modes: [], name: 'logo.png' }), null)).toBe(
      'logo.png is a design source — drop a shortcut here to apply',
    );
    expect(applyBlockedReason(item({ kind: 'file', modes: [] }), null)).toContain("can't");
  });

  it('prefers a classic shortcut for Store apps, whose own icon Explorer ignores', () => {
    const info = (patch: Partial<ItemInfo>): Pick<ItemInfo, 'modes' | 'storeApp'> => ({ modes: ['inPlace'], storeApp: false, ...patch });
    expect(preferredMode(info({}))).toBe('inPlace');
    expect(preferredMode(info({ modes: ['inPlace', 'personalCopy'] }))).toBe('inPlace');
    expect(preferredMode(info({ modes: [] }))).toBeNull();
    const store = info({ storeApp: true, modes: ['inPlace', 'newShortcut'] });
    expect(preferredMode(store)).toBe('newShortcut');
    expect(orderedModes(store)).toEqual(['newShortcut', 'inPlace']);
    // Without a classic shortcut to offer, a Store app keeps what it has.
    expect(preferredMode(info({ storeApp: true, modes: ['personalCopy'] }))).toBe('personalCopy');
    expect(orderedModes(info({ modes: ['inPlace', 'personalCopy'] }))).toEqual(['inPlace', 'personalCopy']);
    expect(orderedModes(info({ modes: [] }))).toEqual([]);
  });
});

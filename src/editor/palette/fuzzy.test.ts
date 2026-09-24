import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, highlightRuns } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('brsh', 'Brush tool')?.indices).toEqual([0, 1, 3, 4]);
    expect(fuzzyMatch('BRUSH', 'Brush tool')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Brush tool')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('prefers word starts', () => {
    // "sa" should hit the S of Save and the A of Apply, not "Sa" + "v".
    expect(fuzzyMatch('sa', 'Save & Apply')?.indices).toEqual([0, 1]);
    expect(fuzzyMatch('za', 'Zoom to fit / Actual')?.indices).toEqual([0, 14]);
    expect(fuzzyMatch('ei', 'Export as .ico…')?.indices).toEqual([0, 11]);
  });

  it('ignores spaces in the query', () => {
    expect(fuzzyMatch('zoom in', 'Zoom in')).not.toBeNull();
    expect(fuzzyMatch('zo om', 'Zoom out')).not.toBeNull();
  });

  it('scores prefixes and contiguous runs higher', () => {
    const prefix = fuzzyMatch('lib', 'Library')!.score;
    const middle = fuzzyMatch('lib', 'Go to Library')!.score;
    const scattered = fuzzyMatch('lib', 'Layer tint bias')!.score;
    expect(prefix).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(scattered);
  });
});

describe('fuzzyFilter', () => {
  const items = [
    { label: 'Undo', kw: [] },
    { label: 'Go to Library', kw: ['saved designs'] },
    { label: 'Brush tool', kw: ['paint'] },
    { label: 'Pencil tool', kw: ['pixel'] },
  ];
  const label = (i: (typeof items)[number]) => i.label;
  const kw = (i: (typeof items)[number]) => i.kw;

  it('keeps registry order for an empty query', () => {
    expect(fuzzyFilter(items, '  ', label, kw).map((r) => r.item.label)).toEqual(items.map((i) => i.label));
  });

  it('ranks and filters', () => {
    const r = fuzzyFilter(items, 'tool', label, kw);
    expect(r.map((x) => x.item.label)).toEqual(['Brush tool', 'Pencil tool']);
  });

  it('matches keywords without highlighting the label', () => {
    const r = fuzzyFilter(items, 'paint', label, kw);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ item: items[2], indices: [] });
  });

  it('prefers a label hit over a keyword hit', () => {
    const r = fuzzyFilter(
      [
        { label: 'Export as .png…', kw: ['image'] },
        { label: 'Open image or shortcut…', kw: [] },
      ],
      'image',
      label,
      kw,
    );
    expect(r[0]!.item.label).toBe('Open image or shortcut…');
  });
});

describe('highlightRuns', () => {
  it('groups consecutive hits', () => {
    expect(highlightRuns('Brush', [0, 1, 4])).toEqual([
      { text: 'Br', hit: true },
      { text: 'us', hit: false },
      { text: 'h', hit: true },
    ]);
    expect(highlightRuns('Undo', [])).toEqual([{ text: 'Undo', hit: false }]);
  });
});

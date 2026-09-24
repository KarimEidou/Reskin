import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, highlightRuns, rankOf } from './fuzzy';

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('brsh', 'Brush tool')?.indices).toEqual([0, 1, 3, 4]);
    expect(fuzzyMatch('BRUSH', 'Brush tool')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Brush tool')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ kind: 'scattered', score: 0, indices: [] });
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

  it('classifies the match', () => {
    expect(fuzzyMatch('undo', 'Undo')?.kind).toBe('exact');
    expect(fuzzyMatch('zoom in', 'Zoom in')?.kind).toBe('exact');
    expect(fuzzyMatch('save', 'Save & Apply')?.kind).toBe('prefix');
    expect(fuzzyMatch('goto', 'Go to Library')?.kind).toBe('prefix');
    expect(fuzzyMatch('save apply', 'Save & Apply')?.kind).toBe('words');
    expect(fuzzyMatch('lib', 'Go to Library')?.kind).toBe('words');
    expect(fuzzyMatch('ei', 'Export as .ico…')?.kind).toBe('words');
    expect(fuzzyMatch('rsh', 'Brush tool')?.kind).toBe('scattered');
    expect(fuzzyMatch('ormal', 'Normal')?.kind).toBe('scattered');
  });

  it('scores contiguous runs higher within a kind', () => {
    const run = fuzzyMatch('lib', 'Go to Library')!;
    const scattered = fuzzyMatch('lib', 'Layer tint bias')!;
    expect(run.score).toBeGreaterThan(scattered.score);
  });
});

describe('rankOf', () => {
  const rank = (q: string, text: string, source: 'label' | 'keyword' = 'label') => rankOf(fuzzyMatch(q, text)!, source);

  it('orders exact › prefix › word starts › synonyms › scattered, whatever the score', () => {
    const exact = rank('undo', 'Undo');
    const prefix = rank('undo', 'Undo all changes to this very long label');
    const words = rank('undo', 'Go to history (undo)');
    const keyword = rank('undo', 'undo', 'keyword');
    const scattered = rank('undo', 'Sun and moon');
    const keywordScattered = rank('undo', 'sun and moon', 'keyword');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(words);
    expect(words).toBeGreaterThan(keyword);
    expect(keyword).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(keywordScattered);
  });

  it('prefers the shorter label within a tier', () => {
    expect(rank('save', 'Save & Apply')).toBeGreaterThan(rank('save', 'Save to Library'));
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

  it('puts the command whose label starts with the query first', () => {
    // Registry order puts the synonym and scattered hits first; ranking must not.
    const commands = [
      { label: 'Export as .ico…', kw: ['save as', 'icon file'] },
      { label: 'Normal', kw: ['save as normal'] },
      { label: 'Show Layers panel', kw: ['stack', 'save'] },
      { label: 'Save to Library', kw: ['keep', 'design'] },
      { label: 'Save & Apply', kw: ['apply', 'change icon', 'save'] },
    ];
    expect(fuzzyFilter(commands, 'save', label, kw)[0]!.item.label).toBe('Save & Apply');
    expect(fuzzyFilter(commands, 'save apply', label, kw)[0]!.item.label).toBe('Save & Apply');
    expect(fuzzyFilter(commands, 'save to', label, kw)[0]!.item.label).toBe('Save to Library');
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

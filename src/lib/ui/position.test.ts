import { describe, expect, it } from 'vitest';
import { computePosition, parsePlacement } from './position';
import { rovingIndex, typeaheadIndex } from './focus';

const viewport = { width: 800, height: 600 };
const anchor = { x: 100, y: 100, width: 40, height: 20 };
const tip = { width: 120, height: 30 };

describe('computePosition', () => {
  it('places below, centred, with an offset', () => {
    expect(computePosition(anchor, tip, viewport, { placement: 'bottom', offset: 6 })).toMatchObject({
      x: 60,
      y: 126,
      side: 'bottom',
      placement: 'bottom',
    });
  });

  it('aligns start/end along the cross axis', () => {
    expect(computePosition(anchor, tip, viewport, { placement: 'bottom-start' }).x).toBe(100);
    expect(computePosition(anchor, tip, viewport, { placement: 'bottom-end' }).x).toBe(20);
    expect(computePosition(anchor, tip, viewport, { placement: 'right-start', offset: 4 })).toMatchObject({
      x: 144,
      y: 100,
    });
  });

  it('flips when the preferred side lacks room', () => {
    const nearTop = { x: 300, y: 10, width: 40, height: 20 };
    expect(computePosition(nearTop, tip, viewport, { placement: 'top' })).toMatchObject({
      side: 'bottom',
      placement: 'bottom',
    });
    expect(computePosition(nearTop, tip, viewport, { placement: 'top-start', flip: false }).side).toBe('top');
    const nearBottom = { x: 300, y: 580, width: 40, height: 16 };
    expect(computePosition(nearBottom, { width: 200, height: 300 }, viewport, { placement: 'bottom-start' })).toMatchObject({
      side: 'top',
      placement: 'top-start',
    });
  });

  it('shifts back into the viewport', () => {
    const edge = { x: 2, y: 200, width: 20, height: 20 };
    expect(computePosition(edge, tip, viewport, { placement: 'bottom', padding: 8 }).x).toBe(8);
    const right = { x: 790, y: 200, width: 10, height: 20 };
    expect(computePosition(right, tip, viewport, { placement: 'bottom', padding: 8 }).x).toBe(800 - 8 - 120);
  });

  it('reports the available space on the chosen side', () => {
    const r = computePosition(anchor, tip, viewport, { placement: 'bottom', offset: 6, padding: 8 });
    expect(r.available).toBe(600 - 120 - 6 - 8);
  });

  it('parses placements', () => {
    expect(parsePlacement('left-end')).toEqual({ side: 'left', align: 'end' });
    expect(parsePlacement('top')).toEqual({ side: 'top', align: 'center' });
  });
});

describe('rovingIndex', () => {
  const none = [false, false, false, false];
  it('moves with arrows in the widget orientation and wraps', () => {
    expect(rovingIndex('ArrowRight', 0, none)).toBe(1);
    expect(rovingIndex('ArrowLeft', 0, none)).toBe(3);
    expect(rovingIndex('ArrowDown', 0, none)).toBeNull();
    expect(rovingIndex('ArrowDown', 3, none, 'vertical')).toBe(0);
    expect(rovingIndex('ArrowUp', 1, none, 'both')).toBe(0);
    expect(rovingIndex('Home', 2, none)).toBe(0);
    expect(rovingIndex('End', 0, none)).toBe(3);
    expect(rovingIndex('a', 0, none)).toBeNull();
  });

  it('skips disabled entries', () => {
    const d = [false, true, true, false];
    expect(rovingIndex('ArrowRight', 0, d)).toBe(3);
    expect(rovingIndex('Home', 3, [true, false, false, false])).toBe(1);
    expect(rovingIndex('End', 0, [false, false, false, true])).toBe(2);
    expect(rovingIndex('ArrowRight', 0, [true, true])).toBeNull();
    expect(rovingIndex('ArrowRight', 0, [])).toBeNull();
  });
});

describe('typeaheadIndex', () => {
  const labels = ['Open', 'Library', 'Layers', 'Quit'];
  const none = labels.map(() => false);
  it('cycles through matches for repeated letters', () => {
    expect(typeaheadIndex('l', 0, labels, none)).toBe(1);
    expect(typeaheadIndex('l', 1, labels, none)).toBe(2);
    expect(typeaheadIndex('l', 2, labels, none)).toBe(1);
  });
  it('matches longer prefixes including the current item', () => {
    expect(typeaheadIndex('la', 2, labels, none)).toBe(2);
    expect(typeaheadIndex('lib', 2, labels, none)).toBe(1);
    expect(typeaheadIndex('x', 0, labels, none)).toBeNull();
    expect(typeaheadIndex('q', 0, labels, [false, false, false, true])).toBeNull();
  });
});

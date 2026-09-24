import { describe, expect, it } from 'vitest';
import { boxReducer, initialBoxState, progressFraction, type BoxEvent, type BoxState } from './box-state';

const run = (events: BoxEvent[], from: BoxState = initialBoxState) => events.reduce(boxReducer, from);

describe('boxReducer', () => {
  it('hovers and unhovers', () => {
    const s = run([{ type: 'pointerEnter' }]);
    expect(s).toMatchObject({ name: 'hover', hovering: true });
    expect(boxReducer(s, { type: 'pointerEnter' })).toBe(s);
    expect(run([{ type: 'pointerLeave' }], s)).toMatchObject({ name: 'idle', hovering: false });
  });

  it('arms on drag enter and disarms on leave, back to hover when the pointer is over it', () => {
    const armed = run([{ type: 'dragEnter', count: 2 }]);
    expect(armed).toMatchObject({ name: 'armed', count: 2 });
    expect(run([{ type: 'dragLeave' }], armed)).toMatchObject({ name: 'idle', count: 0 });
    const hovered = run([{ type: 'pointerEnter' }, { type: 'dragEnter', count: 1 }, { type: 'dragLeave' }]);
    expect(hovered.name).toBe('hover');
  });

  it('absorbs a drop, takes the inspected icon and hands over to the editor', () => {
    const s = run([
      { type: 'dragEnter', count: 3 },
      { type: 'drop', count: 3 },
    ]);
    expect(s).toMatchObject({ name: 'absorbing', icon: null, count: 3 });
    expect(s.epoch).toBe(1);
    const inspected = boxReducer(s, { type: 'inspectDone', icon: 'data:icon', count: 2 });
    expect(inspected).toMatchObject({ name: 'absorbing', icon: 'data:icon', count: 2 });
    const handoff = boxReducer(inspected, { type: 'openRequested' });
    expect(handoff).toMatchObject({ name: 'idle', handoff: true, icon: 'data:icon', count: 2 });
  });

  it('accepts a drop without a preceding enter', () => {
    expect(run([{ type: 'drop', count: 1 }]).name).toBe('absorbing');
  });

  it('shakes when inspection fails and settles afterwards', () => {
    const s = run([
      { type: 'dragEnter', count: 1 },
      { type: 'drop', count: 1 },
      { type: 'inspectFailed', message: 'nothing usable' },
    ]);
    expect(s).toMatchObject({ name: 'error', message: 'nothing usable', count: 0 });
    // A stale timer from an earlier one-shot state does nothing.
    expect(boxReducer(s, { type: 'settled', epoch: s.epoch - 1 })).toBe(s);
    expect(boxReducer(s, { type: 'settled', epoch: s.epoch })).toMatchObject({ name: 'idle', message: null });
  });

  it('freezes during the handoff until shown again', () => {
    const frozen = run([{ type: 'pointerEnter' }, { type: 'openRequested', icon: null, count: 0 }]);
    expect(frozen).toMatchObject({ name: 'idle', handoff: true });
    expect(run([{ type: 'pointerLeave' }, { type: 'pointerEnter' }], frozen).name).toBe('idle');
    expect(run([{ type: 'dragEnter', count: 1 }], frozen).name).toBe('idle');
    expect(run([{ type: 'drop', count: 1 }], frozen).name).toBe('idle');
    const shown = boxReducer(frozen, { type: 'shown' });
    expect(shown).toMatchObject({ name: 'idle', handoff: false, icon: null, hovering: false });
    expect(boxReducer(shown, { type: 'pointerEnter' }).name).toBe('hover');
  });

  it('reports a failed open as an error', () => {
    const s = run([{ type: 'openRequested' }, { type: 'openFailed', message: 'no editor' }]);
    expect(s).toMatchObject({ name: 'error', handoff: false, message: 'no editor' });
  });

  it('follows the fly-to-icon legs', () => {
    const depart = run([{ type: 'openRequested' }, { type: 'flight', phase: 'depart', icon: 'data:new' }]);
    expect(depart).toMatchObject({ name: 'flying', icon: 'data:new', handoff: false });
    const land = boxReducer(depart, { type: 'flight', phase: 'land' });
    expect(land).toMatchObject({ name: 'celebrate', icon: null });
    const back = boxReducer(land, { type: 'flight', phase: 'return' });
    expect(back.name).toBe('flying');
    expect(boxReducer(back, { type: 'flight', phase: 'home' })).toMatchObject({ name: 'idle', icon: null });
  });

  it('celebrates in place with the new icon, and errors on a failed flight', () => {
    const c = run([{ type: 'flight', phase: 'celebrate', icon: 'data:new' }]);
    expect(c).toMatchObject({ name: 'celebrate', icon: 'data:new' });
    expect(boxReducer(c, { type: 'settled', epoch: c.epoch })).toMatchObject({ name: 'idle', icon: null });
    const err = run([{ type: 'flight', phase: 'error', message: 'access denied' }]);
    expect(err).toMatchObject({ name: 'error', message: 'access denied' });
  });

  it('shows batch progress and returns to rest when done', () => {
    const busy = run([{ type: 'progress', done: 1, total: 4 }]);
    expect(busy).toMatchObject({ name: 'busy', progress: { done: 1, total: 4 } });
    expect(progressFraction(busy)).toBe(0.25);
    const done = boxReducer(busy, { type: 'progress', done: 4, total: 4 });
    expect(done).toMatchObject({ name: 'idle', progress: null });
    expect(progressFraction(done)).toBeNull();
    // A finished report while not busy does not change the state name.
    expect(boxReducer(initialBoxState, { type: 'progress', done: 2, total: 2 }).name).toBe('idle');
  });

  it('ignores drags while flying, absorbing or busy', () => {
    for (const from of [
      run([{ type: 'flight', phase: 'depart', icon: null }]),
      run([{ type: 'drop', count: 1 }]),
      run([{ type: 'progress', done: 0, total: 2 }]),
    ]) {
      expect(boxReducer(from, { type: 'dragEnter', count: 1 })).toBe(from);
    }
  });

  it('can re-arm right after an error or a celebration', () => {
    const err = run([{ type: 'error' }]);
    expect(boxReducer(err, { type: 'dragEnter', count: 1 }).name).toBe('armed');
  });

  it('resets everything on box:shown but keeps the epoch monotonic', () => {
    const s = run([{ type: 'drop', count: 2 }, { type: 'inspectDone', icon: 'x', count: 2 }, { type: 'shown' }]);
    expect(s).toEqual({ ...initialBoxState, epoch: 1 });
  });

  it('drops the handoff picture when the window gets hidden', () => {
    const s = run([{ type: 'drop', count: 1 }, { type: 'inspectDone', icon: 'x', count: 1 }, { type: 'openRequested' }]);
    expect(s.handoff).toBe(true);
    expect(boxReducer(s, { type: 'hidden' })).toEqual({ ...initialBoxState, epoch: s.epoch });
  });
});

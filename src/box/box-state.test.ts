import { describe, expect, it } from 'vitest';
import type { CollapseThen } from '$lib/ipc/types';
import { defaultSettings } from '$lib/settings/defaults';
import { collapseItems, handoffProps } from '$lib/ui/box-geometry';
import { boxReducer, initialBoxState, progressFraction, undoOutcome, type BoxEvent, type BoxState } from './box-state';

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

  it('an open from elsewhere (box:handoff) freezes on the picture the proxy draws', () => {
    // Tray / menu / Explorer: box:handoff arrives as openRequested with the
    // first item's icon and the count, whatever the box showed before.
    const hovering = run([{ type: 'pointerEnter' }]);
    const frozen = boxReducer(hovering, { type: 'openRequested', icon: 'data:sys', count: 3 });
    expect(frozen).toMatchObject({ name: 'idle', handoff: true, icon: 'data:sys', count: 3 });
    const proxy = handoffProps(defaultSettings(), [{ icon: 'data:sys' }, { icon: null }, { icon: null }], false);
    expect({ icon: frozen.icon, count: frozen.count, state: frozen.name }).toEqual({
      icon: proxy.icon,
      count: proxy.count,
      state: proxy.state,
    });
    // It interrupts an absorb in progress (that drop never opens).
    const absorbing = run([{ type: 'drop', count: 1 }]);
    expect(boxReducer(absorbing, { type: 'openRequested', icon: null, count: 0 })).toMatchObject({
      name: 'idle',
      handoff: true,
      icon: null,
      count: 0,
    });
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

  describe('the close handoff (box:collapse, box:shown, then box:released)', () => {
    /** The box handed over a dropped icon to the editor (frozen on it). */
    const handedOver = run([{ type: 'drop', count: 2 }, { type: 'inspectDone', icon: 'data:dropped', count: 2 }, { type: 'openRequested' }]);
    /** Nothing covers the box (the editor faded out): it paints at once. */
    const collapse = (then: CollapseThen, icon: string | null) =>
      boxReducer(handedOver, { type: 'collapse', then, icon, held: false });

    it("takes over the picture the editor's proxy collapsed onto", () => {
      for (const [then, icon] of [
        ['hide', 'data:new'],
        ['fly', 'data:new'],
        ['celebrate', 'data:new'],
        ['fly', null],
      ] as const) {
        const s = collapse(then, icon);
        // Exactly what App renders the proxy from (handoffProps of collapseItems).
        const proxy = handoffProps(defaultSettings(), collapseItems(then, icon), false);
        expect(s).toMatchObject({ name: proxy.state, icon: proxy.icon, count: proxy.count, handoff: true, veiled: false });
        expect(s.epoch).toBe(handedOver.epoch);
      }
      // A plain close never shows the dropped icon (nor the new one).
      expect(collapse('hide', 'data:new')).toMatchObject({ icon: null, count: 0 });
    });

    it('box:shown keeps the picture, frozen until the close releases it: a plain close then rests on it', () => {
      const shown = boxReducer(collapse('hide', null), { type: 'shown' });
      // The editor may still paint over it: nothing of the box's own yet.
      expect(shown).toMatchObject({ name: 'idle', icon: null, count: 0, handoff: true, collapsed: 'hide' });
      expect(run([{ type: 'pointerEnter' }, { type: 'dragEnter', count: 1 }], shown)).toMatchObject({ name: 'idle', handoff: true });
      const released = boxReducer(shown, { type: 'released' });
      expect(released).toMatchObject({ name: 'idle', icon: null, count: 0, handoff: false, collapsed: null, veiled: false });
      expect(boxReducer(released, { type: 'pointerEnter' }).name).toBe('hover');
      // Nothing to release outside a close.
      expect(boxReducer(released, { type: 'released' })).toBe(released);
      expect(boxReducer(initialBoxState, { type: 'released' })).toBe(initialBoxState);
    });

    it('a pointer that came onto the frozen box hovers it once the close released it', () => {
      const hovered = run([{ type: 'shown' }, { type: 'pointerEnter' }], collapse('hide', null));
      expect(hovered).toMatchObject({ name: 'idle', hovering: true, handoff: true });
      expect(boxReducer(hovered, { type: 'released' })).toMatchObject({ name: 'hover', handoff: false, collapsed: null });
    });

    it('box:shown keeps the new icon, frozen until the flight carries it on', () => {
      const shown = boxReducer(collapse('fly', 'data:new'), { type: 'shown' });
      expect(shown).toMatchObject({ name: 'idle', icon: 'data:new', handoff: true });
      // The close's end does not unfreeze it: the flight comes next.
      expect(boxReducer(shown, { type: 'released' })).toBe(shown);
      expect(run([{ type: 'pointerEnter' }, { type: 'dragEnter', count: 1 }], shown)).toMatchObject({ name: 'idle', icon: 'data:new' });
      const depart = boxReducer(shown, { type: 'flight', phase: 'depart', icon: 'data:new' });
      expect(depart).toMatchObject({ name: 'flying', icon: 'data:new', handoff: false });
      const land = boxReducer(depart, { type: 'flight', phase: 'land', icon: 'data:new' });
      expect(land).toMatchObject({ name: 'celebrate', handoff: false });
      expect(boxReducer(land, { type: 'flight', phase: 'return' }).name).toBe('flying');
      // A flight leg without an icon carries the one taken over.
      expect(boxReducer(shown, { type: 'flight', phase: 'celebrate', icon: null })).toMatchObject({
        name: 'celebrate',
        icon: 'data:new',
      });
    });

    it('a picture the flight never follows up on is dropped by the unfreeze', () => {
      const shown = boxReducer(collapse('celebrate', 'data:new'), { type: 'shown' });
      expect(boxReducer(shown, { type: 'unfreeze' })).toEqual({ ...initialBoxState, epoch: shown.epoch });
    });

    it('a flight without an icon does not bring back an icon that was not handed over', () => {
      expect(boxReducer(handedOver, { type: 'flight', phase: 'depart', icon: null }).icon).toBeNull();
    });
  });

  describe("the swaps with the editor's proxy (box:conceal, box:collapse held, box:reveal)", () => {
    const handedOver = run([{ type: 'drop', count: 1 }, { type: 'inspectDone', icon: 'data:dropped', count: 1 }, { type: 'openRequested' }]);
    /** Under the editor's proxy: the box holds the picture. */
    const held = (then: CollapseThen, icon: string | null) => boxReducer(handedOver, { type: 'collapse', then, icon, held: true });

    it('box:conceal stops painting the handoff picture, which the proxy now paints', () => {
      const concealed = boxReducer(handedOver, { type: 'conceal' });
      expect(concealed).toEqual({ ...handedOver, veiled: true });
      // Hidden next, it stays blank until it is told what to show: shown
      // again under the proxy (or not), it never flashes a picture first.
      const hidden = boxReducer(concealed, { type: 'hidden' });
      expect(hidden).toEqual({ ...initialBoxState, veiled: true, epoch: concealed.epoch });
      expect(boxReducer(hidden, { type: 'collapse', then: 'hide', icon: null, held: true }).veiled).toBe(true);
      expect(boxReducer(hidden, { type: 'collapse', then: 'hide', icon: null, held: false }).veiled).toBe(false);
      // Shown at rest (the editor closed while the box had to stay hidden).
      expect(boxReducer(hidden, { type: 'shown' })).toEqual({ ...initialBoxState, epoch: concealed.epoch });
    });

    it('a held picture is taken over without painting it until box:reveal', () => {
      const s = held('hide', null);
      expect(s).toMatchObject({ name: 'idle', icon: null, count: 0, handoff: true, veiled: true });
      // Shown under the proxy: it keeps holding it, frozen.
      const shown = boxReducer(s, { type: 'shown' });
      expect(shown).toBe(s);
      expect(run([{ type: 'pointerEnter' }, { type: 'dragEnter', count: 1 }], shown)).toMatchObject({ name: 'idle', veiled: true });
      // The swap: it paints the very picture the proxy showed — frozen on
      // it while the editor's proxy may still be there…
      const revealed = boxReducer(shown, { type: 'reveal' });
      expect(revealed).toMatchObject({ name: 'idle', icon: null, count: 0, handoff: true, collapsed: 'hide', veiled: false });
      expect(boxReducer(revealed, { type: 'pointerEnter' }).name).toBe('idle');
      // A second reveal changes nothing.
      expect(boxReducer(revealed, { type: 'reveal' })).toBe(revealed);
      // …and rests on it once the close released it.
      const released = boxReducer(revealed, { type: 'released' });
      expect(released).toMatchObject({ name: 'idle', icon: null, count: 0, handoff: false, collapsed: null, veiled: false });
      expect(boxReducer(released, { type: 'pointerEnter' }).name).toBe('hover');
    });

    it('a release before the swap landed leaves the picture unpainted until box:reveal', () => {
      const released = run([{ type: 'shown' }, { type: 'released' }], held('hide', null));
      expect(released).toMatchObject({ handoff: false, collapsed: null, veiled: true });
      expect(boxReducer(released, { type: 'reveal' })).toMatchObject({ name: 'idle', handoff: false, veiled: false });
    });

    it('after an apply the revealed icon stays frozen until the flight carries it on', () => {
      const revealed = run([{ type: 'shown' }, { type: 'reveal' }, { type: 'released' }], held('fly', 'data:new'));
      expect(revealed).toMatchObject({ name: 'idle', icon: 'data:new', handoff: true, collapsed: 'fly', veiled: false });
      expect(boxReducer(revealed, { type: 'flight', phase: 'depart', icon: null })).toMatchObject({
        name: 'flying',
        icon: 'data:new',
        handoff: false,
      });
    });

    it('whatever shows the box on its own again paints it', () => {
      const s = held('celebrate', 'data:new');
      expect(boxReducer(s, { type: 'flight', phase: 'celebrate', icon: null })).toMatchObject({ name: 'celebrate', veiled: false });
      expect(boxReducer(s, { type: 'error', message: 'no' }).veiled).toBe(false);
      expect(boxReducer(s, { type: 'openRequested', icon: null, count: 0 }).veiled).toBe(false);
      // A reveal Rust never sent: the unfreeze gives the box back its picture.
      expect(boxReducer(s, { type: 'unfreeze' })).toEqual({ ...initialBoxState, epoch: s.epoch });
    });
  });

  describe('the Undo chip', () => {
    it('celebrates when the icon is back', () => {
      expect(undoOutcome({ restored: 1, failed: [], needsElevation: 0 })).toEqual({ type: 'undone' });
      // Already restored elsewhere: the icon is back all the same.
      expect(undoOutcome({ restored: 0, failed: [], needsElevation: 0 })).toEqual({ type: 'undone' });
      const s = run([{ type: 'pointerEnter' }, { type: 'undone' }]);
      expect(s).toMatchObject({ name: 'celebrate', icon: null, count: 0, handoff: false });
      expect(s.epoch).toBe(1);
      expect(boxReducer(s, { type: 'settled', epoch: s.epoch })).toMatchObject({ name: 'hover' });
    });

    it('shakes with the reason when the icon is not back', () => {
      expect(undoOutcome({ restored: 0, failed: ['Firefox — access denied'], needsElevation: 0 })).toEqual({
        type: 'error',
        message: "Couldn't undo: Firefox — access denied",
      });
      // The administrator prompt was cancelled.
      expect(undoOutcome({ restored: 0, failed: [], needsElevation: 1 })).toEqual({
        type: 'error',
        message: 'Undo needs administrator approval',
      });
      const s = run([undoOutcome({ restored: 0, failed: [], needsElevation: 1 })]);
      expect(s).toMatchObject({ name: 'error', message: 'Undo needs administrator approval' });
    });

    it('never interrupts something in progress to celebrate', () => {
      const armed = run([{ type: 'dragEnter', count: 1 }]);
      expect(boxReducer(armed, { type: 'undone' })).toBe(armed);
      const frozen = run([{ type: 'openRequested', icon: null, count: 0 }]);
      expect(boxReducer(frozen, { type: 'undone' })).toBe(frozen);
      const busy = run([{ type: 'progress', done: 1, total: 3 }]);
      expect(boxReducer(busy, { type: 'undone' })).toBe(busy);
    });
  });

  it('drops the handoff picture when the window gets hidden', () => {
    const s = run([{ type: 'drop', count: 1 }, { type: 'inspectDone', icon: 'x', count: 1 }, { type: 'openRequested' }]);
    expect(s.handoff).toBe(true);
    expect(boxReducer(s, { type: 'hidden' })).toEqual({ ...initialBoxState, epoch: s.epoch });
  });
});

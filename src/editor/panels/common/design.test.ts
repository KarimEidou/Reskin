import { describe, expect, it } from 'vitest';
import type { EditorSession } from '../../state/session.svelte';
import { designRef, isCurrentDesign } from './design';

function fakeSession() {
  const queue = [{ name: 'a' }, { name: 'b' }];
  const s = {
    engine: { doc: { layers: [] } as object },
    currentIndex: 0,
    get current() {
      return queue[s.currentIndex] ?? null;
    },
  };
  return { s, queue };
}

const asSession = (s: unknown) => s as Pick<EditorSession, 'engine' | 'currentIndex' | 'current'>;

describe('design identity of async panel results', () => {
  it('holds while the same design stays open', () => {
    const { s } = fakeSession();
    const ref = designRef(asSession(s));
    expect(isCurrentDesign(asSession(s), ref)).toBe(true);
  });

  it('breaks as soon as another item is selected, before its document loads', () => {
    const { s } = fakeSession();
    const ref = designRef(asSession(s));
    // Session.select moves the slot first, the document comes after a load.
    s.currentIndex = 1;
    expect(isCurrentDesign(asSession(s), ref)).toBe(false);
    s.engine.doc = { layers: [] };
    expect(isCurrentDesign(asSession(s), ref)).toBe(false);
  });

  it('breaks when the document is replaced in place (a blank design, a project)', () => {
    const { s } = fakeSession();
    const ref = designRef(asSession(s));
    s.engine.doc = { layers: [] };
    expect(isCurrentDesign(asSession(s), ref)).toBe(false);
  });

  it('breaks when the queue entry at that slot changed (an item removed before it)', () => {
    const { s, queue } = fakeSession();
    s.currentIndex = 1;
    const ref = designRef(asSession(s));
    queue.splice(0, 1, { name: 'c' }, { name: 'd' });
    expect(isCurrentDesign(asSession(s), ref)).toBe(false);
  });
});

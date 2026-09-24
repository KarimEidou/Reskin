// Which design an asynchronous panel result (a style built in the worker,
// the design read back for styling) was asked for. The design can change
// while it is computed — another queue item is opened, a blank design is
// started — and switching items changes the queue slot first and the
// document only once the new item has loaded, so all three are compared.

import type { EditorSession } from '../../state/session.svelte';

type DesignSession = Pick<EditorSession, 'engine' | 'currentIndex' | 'current'>;

export interface DesignRef {
  readonly doc: object;
  readonly index: number;
  readonly entry: object | null;
}

/** The design open right now. */
export function designRef(session: DesignSession): DesignRef {
  return { doc: session.engine.doc, index: session.currentIndex, entry: session.current };
}

/** `ref` is still the open design (a result for it may land). */
export function isCurrentDesign(session: DesignSession, ref: DesignRef): boolean {
  return session.engine.doc === ref.doc && session.currentIndex === ref.index && session.current === ref.entry;
}

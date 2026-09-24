// An image pasted into an open design becomes a layer at once. It is not
// asked about (docs/UI.md's Import popover is for items dropped from
// Explorer), so it is announced with an Undo instead.

import type { Engine } from '$engine/index';
import { toast } from '$lib/ui/toasts.svelte';

/**
 * Announces the paste the engine just recorded (its latest change) with an
 * Undo, which takes back exactly that change: once anything came after it,
 * Undo says so instead of undoing something else.
 */
export function announcePaste(engine: Engine): void {
  const doc = engine.doc;
  const entry = engine.currentEntryId;
  toast({
    message: 'Pasted the image as a new layer.',
    kind: 'info',
    action: {
      label: 'Undo',
      run: () => {
        if (engine.doc !== doc || engine.currentEntryId !== entry) {
          throw new Error('Other changes came after the paste: undo them first (Ctrl+Z).');
        }
        engine.undo();
      },
    },
  });
}

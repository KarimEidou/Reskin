// An image pasted into an open design becomes a layer at once, announced
// with an Undo.

import type { Engine } from '$engine/index';
import { toast } from '$lib/ui/toasts.svelte';

/**
 * Announces the paste the engine just recorded (its latest change) with an
 * Undo, which takes back exactly that change: once anything came after it —
 * another step, or work still in progress that an undo would take back
 * first (a pending transform, an adjustment being tuned, a text edit) —
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
        const later = engine.hasPending || engine.preview !== null || engine.textEditLayerId !== null;
        if (engine.doc !== doc || engine.currentEntryId !== entry || later) {
          throw new Error('Other changes came after the paste: undo them first (Ctrl+Z).');
        }
        engine.undo();
      },
    },
  });
}

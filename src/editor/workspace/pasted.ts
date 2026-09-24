// Images pasted into the editor — on the canvas, or anywhere nothing else
// took the paste — and image files dropped on the canvas go through the
// import popover like any other import (`shell.askImport`): with nothing
// open they start a design; with a design open the user chooses what they
// become (a layer, or a design of their own in the queue).

import { decodeImage } from '$engine/dom';
import type { Surface } from '$engine/index';
import { toast } from '$lib/ui/toasts.svelte';
import type { Shell } from '../chrome/shell.svelte';
import { errorText } from '../state/session.svelte';

/** The parts of a DataTransfer an image is looked for in (a paste's clipboard data, a drop's). */
export interface ImageCarrier {
  readonly items: ArrayLike<{ readonly kind: string; readonly type: string; getAsFile(): File | null }>;
  readonly files: ArrayLike<File>;
}

/** The first image file `data` carries, if any. */
export function imageFile(data: ImageCarrier | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return Array.from(data.files).find((f) => f.type.startsWith('image/')) ?? null;
}

/**
 * What an imported image is called: its file name without the extension,
 * except the clipboard's generic "image" (a screenshot, a copied picture),
 * which gets `fallback`.
 */
export function importName(file: Pick<File, 'name'>, fallback: string): string {
  const stem = file.name.replace(/\.[^.]+$/, '').trim();
  return stem && !/^image$/i.test(stem) ? stem : fallback;
}

/**
 * Imports a pasted or dropped image file: decoded, then asked about at `at`
 * (client px; null: the middle of the window). An editor that closed
 * meanwhile (or closed and opened again) gets nothing.
 */
export async function importImageFile(
  shell: Shell,
  file: File,
  fallback: string,
  at: { x: number; y: number } | null = null,
): Promise<void> {
  const epoch = shell.openEpoch;
  let surface: Surface;
  try {
    surface = await decodeImage(file);
  } catch (e) {
    toast({ message: `Couldn't read that image: ${errorText(e)}`, kind: 'error' });
    return;
  }
  if (!shell.interactive || shell.openEpoch !== epoch) return;
  await shell.askImport([{ kind: 'image', name: importName(file, fallback), surface }], at);
}

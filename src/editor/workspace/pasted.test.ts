import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, Surface } from '$engine/index';
import type { ToastOptions } from '$lib/ui/toasts.svelte';

vi.mock('$lib/ui/toasts.svelte', () => ({ toast: vi.fn(() => 'toast') }));

const { toast } = await import('$lib/ui/toasts.svelte');
const { announcePaste } = await import('./pasted');

/** Pastes a small opaque image as a layer and announces it; returns its Undo. */
function paste(engine: Engine): () => unknown {
  const surface = new Surface(8, 8);
  surface.data.fill(255);
  expect(engine.importImage(surface, 'Pasted image')).not.toBeNull();
  announcePaste(engine);
  const opts = vi.mocked(toast).mock.lastCall![0] as ToastOptions;
  expect(opts).toMatchObject({ message: 'Pasted the image as a new layer.', kind: 'info', action: { label: 'Undo' } });
  return opts.action!.run;
}

describe('announcePaste', () => {
  let engine: Engine;

  beforeEach(() => {
    vi.mocked(toast).mockClear();
    engine = new Engine();
  });

  it('Undo takes back the paste', () => {
    const layers = engine.doc.layers.length;
    const undo = paste(engine);
    expect(engine.doc.layers).toHaveLength(layers + 1);
    undo();
    expect(engine.doc.layers).toHaveLength(layers);
  });

  it('never undoes a later step instead', () => {
    const undo = paste(engine);
    const layers = engine.doc.layers.length;
    engine.addLayer();
    expect(undo).toThrow(/Other changes came after the paste/);
    expect(engine.doc.layers).toHaveLength(layers + 1);
  });

  it('never takes back work in progress instead (an adjustment being tuned)', () => {
    const undo = paste(engine);
    const layers = engine.doc.layers.length;
    const preview = engine.beginPreview('Invert', { layerId: engine.doc.activeLayerId! })!;
    expect(preview).not.toBeNull();
    expect(undo).toThrow(/Other changes came after the paste/);
    expect(engine.preview).toBe(preview);
    expect(engine.doc.layers).toHaveLength(layers);
  });

  it('does nothing to another design', () => {
    const undo = paste(engine);
    engine.newDocument({ name: 'Untitled' });
    expect(undo).toThrow(/Other changes came after the paste/);
  });
});

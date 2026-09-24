import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Surface } from '$engine/index';
import type { Shell } from '../chrome/shell.svelte';
import type { ImageCarrier } from './pasted';

vi.mock('$engine/dom', () => ({ decodeImage: vi.fn() }));
vi.mock('$lib/ui/toasts.svelte', () => ({ toast: vi.fn() }));

const { decodeImage } = await import('$engine/dom');
const { toast } = await import('$lib/ui/toasts.svelte');
const { imageFile, importImageFile, importName } = await import('./pasted');

const file = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });

/** A paste's or drop's data carrying `items` (as items) and `files`. */
function carrier(items: File[], files: File[] = []): ImageCarrier {
  return {
    items: items.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    files,
  };
}

/** The shell parts an import uses: an open, interactive editor. */
function fakeShell() {
  const askImport = vi.fn(async () => {});
  const shell = { openEpoch: 1, interactive: true, askImport };
  return { shell, asShell: shell as unknown as Shell, askImport };
}

describe('pasted and dropped images', () => {
  beforeEach(() => {
    vi.mocked(decodeImage).mockReset();
    vi.mocked(toast).mockClear();
  });

  it('finds the first image the data carries', () => {
    const png = file('shot.png', 'image/png');
    expect(imageFile(carrier([file('notes.txt', 'text/plain'), png]))).toBe(png);
    // Some drops list their files only in `files`.
    const jpg = file('photo.jpg', 'image/jpeg');
    expect(imageFile(carrier([], [file('a.txt', 'text/plain'), jpg]))).toBe(jpg);
    expect(imageFile(carrier([file('notes.txt', 'text/plain')]))).toBeNull();
    expect(imageFile(null)).toBeNull();
  });

  it('skips text on the clipboard and items that give no file', () => {
    const png = file('logo.png', 'image/png');
    const data: ImageCarrier = {
      items: [
        { kind: 'string', type: 'text/html', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => png },
      ],
      files: [],
    };
    expect(imageFile(data)).toBe(png);
  });

  it("names the import after its file, but not after the clipboard's generic image", () => {
    expect(importName({ name: 'logo.png' }, 'Pasted image')).toBe('logo');
    expect(importName({ name: 'my.icon.webp' }, 'Pasted image')).toBe('my.icon');
    expect(importName({ name: 'image.png' }, 'Pasted image')).toBe('Pasted image');
    expect(importName({ name: 'Image.PNG' }, 'Dropped image')).toBe('Dropped image');
    expect(importName({ name: '' }, 'Pasted image')).toBe('Pasted image');
  });

  it('asks about the decoded image — nothing goes in unasked — where it was pasted', async () => {
    const surface = new Surface(4, 4);
    vi.mocked(decodeImage).mockResolvedValue(surface);
    const { asShell, askImport } = fakeShell();
    await importImageFile(asShell, file('image.png', 'image/png'), 'Pasted image', { x: 10, y: 20 });
    expect(askImport).toHaveBeenCalledWith([{ kind: 'image', name: 'Pasted image', surface }], { x: 10, y: 20 });
    await importImageFile(asShell, file('logo.png', 'image/png'), 'Pasted image');
    expect(askImport).toHaveBeenLastCalledWith([{ kind: 'image', name: 'logo', surface }], null);
  });

  it('an editor that closed while the image was decoded gets nothing, nor one that opened again', async () => {
    let decoded!: (s: Surface) => void;
    vi.mocked(decodeImage).mockImplementation(() => new Promise<Surface>((r) => (decoded = r)));
    const closed = fakeShell();
    const pending = importImageFile(closed.asShell, file('image.png', 'image/png'), 'Pasted image');
    closed.shell.interactive = false;
    decoded(new Surface(4, 4));
    await pending;
    const reopened = fakeShell();
    const again = importImageFile(reopened.asShell, file('image.png', 'image/png'), 'Pasted image');
    reopened.shell.openEpoch += 1;
    decoded(new Surface(4, 4));
    await again;
    expect(closed.askImport).not.toHaveBeenCalled();
    expect(reopened.askImport).not.toHaveBeenCalled();
  });

  it('an image that cannot be read says so', async () => {
    vi.mocked(decodeImage).mockRejectedValue(new Error('not a PNG'));
    const { asShell, askImport } = fakeShell();
    await importImageFile(asShell, file('broken.png', 'image/png'), 'Pasted image');
    expect(askImport).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ message: "Couldn't read that image: not a PNG", kind: 'error' });
  });
});

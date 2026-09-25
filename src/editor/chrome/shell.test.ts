import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemInfo } from '$lib/ipc/types';
import type { EditorSession } from '../state/session.svelte';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    pickFiles: vi.fn(),
    restore: vi.fn(),
    refreshIcons: vi.fn(),
    openExternal: vi.fn(),
  },
}));
vi.mock('$lib/sound/synth', () => ({ play: vi.fn() }));
vi.mock('$lib/ui/toasts.svelte', () => ({ toast: vi.fn() }));

const { commands } = await import('$lib/ipc/commands');
const { toast } = await import('$lib/ui/toasts.svelte');
const { Shell } = await import('./shell.svelte');
const { answerConfirm, pendingConfirm } = await import('../dialogs/confirm.svelte');

/** A promise with its resolve function, for driving async order by hand. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const item = (id: string, modes: string[] = []) => ({ id, name: id, modes }) as unknown as ItemInfo;
const asSource = (info: ItemInfo) => ({ kind: 'item' as const, info });

interface FakeSession {
  view: string;
  queue: Array<{ info: ItemInfo; unsaved: boolean }>;
  currentIndex: number;
  hasDesign: boolean;
  unsaved: boolean;
  libraryId: string | null;
  interactive: boolean;
  item: ItemInfo | null;
  newBlank: ReturnType<typeof vi.fn>;
  openItems: ReturnType<typeof vi.fn>;
  importSources: ReturnType<typeof vi.fn>;
  openLibraryDesign: ReturnType<typeof vi.fn>;
  saveToLibrary: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  recoverable: ReturnType<typeof vi.fn>;
  restoreAutosave: ReturnType<typeof vi.fn>;
  discardAutosave: ReturnType<typeof vi.fn>;
  requestClose: ReturnType<typeof vi.fn>;
}

let session: FakeSession;
let shell: InstanceType<typeof Shell>;

beforeEach(() => {
  vi.clearAllMocks();
  session = {
    view: 'start',
    queue: [],
    currentIndex: -1,
    hasDesign: false,
    unsaved: false,
    libraryId: null,
    interactive: false,
    item: null,
    newBlank: vi.fn(() => {
      session.hasDesign = true;
    }),
    openItems: vi.fn(async () => {}),
    importSources: vi.fn(async () => 0),
    openLibraryDesign: vi.fn(async () => true),
    saveToLibrary: vi.fn(async () => ({ id: 'lib1', name: 'Neon', thumb: '', updatedAt: 0, bytes: 1 })),
    navigate: vi.fn((v: string) => {
      session.view = v;
    }),
    recoverable: vi.fn(async () => null),
    restoreAutosave: vi.fn(async () => {}),
    discardAutosave: vi.fn(async () => {}),
    requestClose: vi.fn(async () => {}),
  };
  shell = new Shell(session as unknown as EditorSession);
});

describe('openItems', () => {
  it('runs loads one after another and tracks them in `loading`', async () => {
    const first = deferred();
    const order: string[] = [];
    session.openItems.mockImplementation(async (items: ItemInfo[]) => {
      order.push(`start ${items[0]!.id}`);
      if (items[0]!.id === 'a') await first.promise;
      order.push(`end ${items[0]!.id}`);
    });
    const a = shell.openItems([item('a')]);
    const b = shell.openItems([item('b')]);
    expect(shell.loading).toBe(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start a']);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(shell.loading).toBe(0);
  });

  it('skips loads still queued when the editor reopened', async () => {
    const first = deferred();
    session.openItems.mockImplementationOnce(() => first.promise);
    const a = shell.openItems([item('a')]);
    const stale = shell.openItems([item('b')]);
    await vi.waitFor(() => expect(session.openItems).toHaveBeenCalledTimes(1));
    // Close + reopen while "a" is still loading ("b" is still queued).
    shell.openEpoch += 1;
    const fresh = shell.openItems([item('c')], { replace: true });
    first.resolve();
    await Promise.all([a, stale, fresh]);
    expect(session.openItems.mock.calls.map((c) => (c[0] as ItemInfo[])[0]!.id)).toEqual(['a', 'c']);
    expect(shell.loading).toBe(0);
  });

  it('turns a failed load into a toast and keeps the queue going', async () => {
    session.openItems.mockRejectedValueOnce(new Error('unreadable'));
    await shell.openItems([item('a')]);
    await shell.openItems([item('b')]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', message: expect.stringContaining('unreadable') }));
    expect(session.openItems).toHaveBeenCalledTimes(2);
  });
});

describe('openImage', () => {
  it('opens one file picker at a time', async () => {
    const picked = deferred<ItemInfo[]>();
    vi.mocked(commands.pickFiles).mockReturnValue(picked.promise);
    const first = shell.openImage();
    const second = shell.openImage();
    await second;
    expect(commands.pickFiles).toHaveBeenCalledTimes(1);
    picked.resolve([item('logo')]);
    await first;
    expect(session.importSources).toHaveBeenCalledWith([asSource(item('logo'))], 'queue');
    // Once the picker closed, the next one may open.
    vi.mocked(commands.pickFiles).mockResolvedValue([]);
    await shell.openImage();
    expect(commands.pickFiles).toHaveBeenCalledTimes(2);
  });

  it('with a design open, asks what the picked files become', async () => {
    session.hasDesign = true;
    vi.mocked(commands.pickFiles).mockResolvedValue([item('logo')]);
    await shell.openImage();
    expect(shell.importQuestion).toEqual({ sources: [asSource(item('logo'))], at: null });
    expect(session.importSources).not.toHaveBeenCalled();
  });
});

describe('askImport', () => {
  it('opens right away when nothing is open', async () => {
    await shell.askImport([asSource(item('a', ['inPlace']))], { x: 10, y: 20 });
    expect(session.importSources).toHaveBeenCalledWith([asSource(item('a', ['inPlace']))], 'queue');
    expect(shell.importQuestion).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('with a design open asks the import popover; its answer imports, and says what joined the queue', async () => {
    session.hasDesign = true;
    const sources = [asSource(item('a', ['inPlace'])), asSource(item('b', ['inPlace']))];
    await shell.askImport(sources, { x: 10, y: 20 });
    expect(shell.importQuestion).toEqual({ sources, at: { x: 10, y: 20 } });
    expect(session.importSources).not.toHaveBeenCalled();
    session.importSources.mockResolvedValueOnce(2);
    await shell.importAs(sources, 'queue');
    expect(session.importSources).toHaveBeenCalledWith(sources, 'queue');
    expect(shell.importQuestion).toBeNull();
    expect(toast).toHaveBeenCalledWith({ message: 'Added 2 items to the queue.', kind: 'info' });
    vi.mocked(toast).mockClear();
    await shell.importAs(sources.slice(0, 1), 'layer');
    expect(toast).not.toHaveBeenCalled();
  });

  it('turns a failed import into a toast', async () => {
    session.hasDesign = true;
    session.importSources.mockRejectedValueOnce(new Error('unreadable'));
    await shell.importAs([asSource(item('logo'))], 'layer');
    expect(toast).toHaveBeenCalledWith({ message: 'Could not open logo: unreadable', kind: 'error' });
  });

  it('ignores nothing to import', async () => {
    session.hasDesign = true;
    await shell.askImport([]);
    expect(shell.importQuestion).toBeNull();
  });
});

describe('Library designs', () => {
  const neon = { id: 'lib1', name: 'Neon', thumb: '', updatedAt: 0, bytes: 1 };

  it('opens one right away when nothing unsaved would be replaced', async () => {
    expect(await shell.openLibraryDesign(neon)).toBe(true);
    expect(session.openLibraryDesign).toHaveBeenCalledWith('lib1', 'Neon');
    expect(pendingConfirm()).toBeNull();
  });

  it('asks before it replaces unsaved changes', async () => {
    session.hasDesign = true;
    session.unsaved = true;
    session.item = item('Steam', ['inPlace']);
    const declined = shell.openLibraryDesign(neon);
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    expect(pendingConfirm()!.options).toMatchObject({ title: 'Open "Neon"?', danger: true });
    expect(pendingConfirm()!.options.message).toContain("Steam's design");
    answerConfirm(false);
    expect(await declined).toBe(false);
    expect(session.openLibraryDesign).not.toHaveBeenCalled();

    const accepted = shell.openLibraryDesign(neon);
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    answerConfirm(true);
    expect(await accepted).toBe(true);
    expect(session.openLibraryDesign).toHaveBeenCalledTimes(1);
  });

  it('is not open when the session dropped it (the editor closed and opened again while it loaded)', async () => {
    session.openLibraryDesign.mockResolvedValueOnce(false);
    expect(await shell.openLibraryDesign(neon)).toBe(false);
    expect(session.openLibraryDesign).toHaveBeenCalledWith('lib1', 'Neon');
  });

  it('saves over the open design’s Library design, or as a new one', async () => {
    await shell.saveToLibrary();
    await shell.saveToLibrary('Neon copy', { asNew: true });
    expect(session.saveToLibrary.mock.calls).toEqual([
      [undefined, {}],
      ['Neon copy', { asNew: true }],
    ]);
    expect(shell.libraryEpoch).toBe(2);
  });
});

describe('Ctrl+S / the palette', () => {
  it('saves a design not linked to the Library as a new one at once', async () => {
    session.view = 'library';
    await shell.requestSaveToLibrary();
    expect(session.saveToLibrary).toHaveBeenCalledWith(undefined, {});
    expect(shell.libraryEpoch).toBe(1);
    expect(shell.saveFormOpen).toBe(false);
    expect(session.view).toBe('library');
  });

  it('pressed again while that save runs, adds the design once', async () => {
    const saved = deferred<{ id: string; name: string }>();
    session.saveToLibrary.mockImplementationOnce(async () => {
      const entry = await saved.promise;
      session.libraryId = entry.id;
      return entry;
    });
    const first = shell.requestSaveToLibrary();
    const second = shell.requestSaveToLibrary();
    saved.resolve({ id: 'lib1', name: 'Steam' });
    expect(await first).toEqual({ id: 'lib1', name: 'Steam' });
    expect(await second).toEqual({ id: 'lib1', name: 'Steam' });
    expect(session.saveToLibrary).toHaveBeenCalledTimes(1);
    expect(shell.saveFormOpen).toBe(false);
    // Saved (and linked) now: the next press asks with the form.
    await shell.requestSaveToLibrary();
    expect(session.saveToLibrary).toHaveBeenCalledTimes(1);
    expect(shell.saveFormOpen).toBe(true);
  });

  it('opens the form that names a linked design, in the Edit view, instead of saving over it', async () => {
    session.libraryId = 'lib1';
    session.view = 'history';
    expect(await shell.requestSaveToLibrary()).toBeNull();
    expect(session.saveToLibrary).not.toHaveBeenCalled();
    expect(shell.saveFormOpen).toBe(true);
    expect(session.view).toBe('edit');
  });
});

describe('requestClose', () => {
  const steam = item('Steam', ['inPlace']);
  const notes = item('Notes', ['inPlace']);

  it('closes at once when nothing unsaved would be lost', async () => {
    session.hasDesign = true;
    session.queue = [{ info: steam, unsaved: false }];
    session.currentIndex = 0;
    await shell.requestClose();
    expect(pendingConfirm()).toBeNull();
    expect(session.requestClose).toHaveBeenCalledTimes(1);
    expect(shell.hasUnsavedWork).toBe(false);
    expect(shell.discardOnReopen).toBe(false);
  });

  it('asks over unsaved work; kept open on Cancel, dropped at the next open on "Close anyway"', async () => {
    session.hasDesign = true;
    session.unsaved = true;
    session.item = steam;
    session.queue = [{ info: steam, unsaved: false }];
    session.currentIndex = 0;
    expect(shell.hasUnsavedWork).toBe(true);
    const declined = shell.requestClose();
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    expect(pendingConfirm()!.options).toMatchObject({ title: 'Close the editor?', confirmLabel: 'Close anyway', danger: true });
    expect(pendingConfirm()!.options.message).toContain("Your changes to Steam's design will be lost.");
    answerConfirm(false);
    await declined;
    expect(session.requestClose).not.toHaveBeenCalled();
    expect(shell.discardOnReopen).toBe(false);

    const accepted = shell.requestClose();
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    answerConfirm(true);
    await accepted;
    expect(session.requestClose).toHaveBeenCalledTimes(1);
    expect(shell.discardOnReopen).toBe(true);
  });

  it('counts the other queued designs with unsaved changes too', async () => {
    session.hasDesign = true;
    session.item = notes;
    session.queue = [
      { info: steam, unsaved: true },
      // The open one's own flag is stale: the session's `unsaved` counts.
      { info: notes, unsaved: true },
    ];
    session.currentIndex = 1;
    const one = shell.requestClose();
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    expect(pendingConfirm()!.options.message).toContain("Your changes to Steam's design will be lost.");
    answerConfirm(false);
    await one;

    session.unsaved = true;
    const both = shell.requestClose();
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    expect(pendingConfirm()!.options.message).toContain('Your changes to 2 designs will be lost.');
    answerConfirm(false);
    await both;
    expect(session.requestClose).not.toHaveBeenCalled();
  });

  it('drops nothing when the close itself fails', async () => {
    session.hasDesign = true;
    session.unsaved = true;
    session.requestClose.mockRejectedValueOnce(new Error('no editor'));
    const closing = shell.requestClose();
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    expect(pendingConfirm()!.options.message).toContain('Your changes to the current design will be lost.');
    answerConfirm(true);
    await expect(closing).rejects.toThrow('no editor');
    expect(shell.discardOnReopen).toBe(false);
  });
});

describe('interactive', () => {
  it('is the session’s, so it knows whether the editor is open', () => {
    shell.interactive = true;
    expect(session.interactive).toBe(true);
    session.interactive = false;
    expect(shell.interactive).toBe(false);
  });
});

describe('recovery', () => {
  it('shares one offer between the Start banner and the dialog', async () => {
    session.recoverable.mockResolvedValue('{"draft":1}');
    await shell.refreshRecovery();
    expect(shell.recovery).toBe('{"draft":1}');
    await shell.restoreRecovery('{"draft":1}');
    expect(session.restoreAutosave).toHaveBeenCalledWith('{"draft":1}');
    expect(shell.recovery).toBeNull();
  });

  it('a Discard made while the autosave is being read wins', async () => {
    const read = deferred<string | null>();
    session.recoverable.mockReturnValueOnce(read.promise);
    shell.recovery = '{"draft":1}';
    const refreshing = shell.refreshRecovery();
    await shell.discardRecovery();
    read.resolve('{"draft":1}');
    await refreshing;
    expect(shell.recovery).toBeNull();
    expect(session.discardAutosave).toHaveBeenCalledTimes(1);
  });

  it('keeps the offer when the restore fails', async () => {
    shell.recovery = '{"draft":1}';
    session.restoreAutosave.mockRejectedValueOnce(new Error('damaged'));
    await expect(shell.restoreRecovery('{"draft":1}')).rejects.toThrow('damaged');
    expect(shell.recovery).toBe('{"draft":1}');
  });
});

describe('newBlank', () => {
  it('starts right away when nothing would be lost', async () => {
    await shell.newBlank();
    expect(session.newBlank).toHaveBeenCalledTimes(1);
    expect(session.view).toBe('edit');
    // An open design without unsaved changes is replaced without asking too.
    await shell.newBlank();
    expect(session.newBlank).toHaveBeenCalledTimes(2);
    expect(pendingConfirm()).toBeNull();
  });

  it('asks before dropping unsaved changes', async () => {
    session.hasDesign = true;
    session.unsaved = true;
    const declined = shell.newBlank();
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    expect(pendingConfirm()!.options).toMatchObject({ danger: true });
    answerConfirm(false);
    await declined;
    expect(session.newBlank).not.toHaveBeenCalled();
    expect(session.view).toBe('start');

    const accepted = shell.newBlank();
    await vi.waitFor(() => expect(pendingConfirm()).not.toBeNull());
    answerConfirm(true);
    await accepted;
    expect(session.newBlank).toHaveBeenCalledTimes(1);
    expect(session.view).toBe('edit');
  });
});

describe('navigate', () => {
  it('opens About as the About section of Settings', () => {
    shell.navigate('about');
    expect(session.view).toBe('settings');
    expect(shell.settingsSection).toBe('about');
    shell.navigate('settings');
    expect(shell.settingsSection).toBeNull();
  });
});

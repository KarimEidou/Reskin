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

const item = (id: string) => ({ id, name: id, modes: [] }) as unknown as ItemInfo;

interface FakeSession {
  view: string;
  queue: unknown[];
  hasDesign: boolean;
  engine: { canUndo: boolean };
  newBlank: ReturnType<typeof vi.fn>;
  openItems: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  recoverable: ReturnType<typeof vi.fn>;
  restoreAutosave: ReturnType<typeof vi.fn>;
  discardAutosave: ReturnType<typeof vi.fn>;
}

let session: FakeSession;
let shell: InstanceType<typeof Shell>;

beforeEach(() => {
  vi.clearAllMocks();
  session = {
    view: 'start',
    queue: [],
    hasDesign: false,
    engine: { canUndo: false },
    newBlank: vi.fn(() => {
      session.hasDesign = true;
    }),
    openItems: vi.fn(async () => {}),
    navigate: vi.fn((v: string) => {
      session.view = v;
    }),
    recoverable: vi.fn(async () => null),
    restoreAutosave: vi.fn(async () => {}),
    discardAutosave: vi.fn(async () => {}),
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
    expect(session.openItems).toHaveBeenCalledTimes(1);
    // Once the picker closed, the next one may open.
    vi.mocked(commands.pickFiles).mockResolvedValue([]);
    await shell.openImage();
    expect(commands.pickFiles).toHaveBeenCalledTimes(2);
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
    // An open design without edits is replaced without asking too.
    session.engine.canUndo = false;
    await shell.newBlank();
    expect(session.newBlank).toHaveBeenCalledTimes(2);
    expect(pendingConfirm()).toBeNull();
  });

  it('asks before dropping unsaved edits', async () => {
    session.hasDesign = true;
    session.engine.canUndo = true;
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

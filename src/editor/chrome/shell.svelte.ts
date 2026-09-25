// Shell-level UI state and actions shared by the chrome, the views, the
// dialogs and the command palette (App.svelte creates one and provides it
// with setShell()). The editor *document* state lives in the session.

import { getContext, setContext } from 'svelte';
import { commands } from '$lib/ipc/commands';
import type { EditorView, ItemInfo, LibraryEntry, RefreshLevel, RestoreReport } from '$lib/ipc/types';
import { toast } from '$lib/ui/toasts.svelte';
import { play } from '$lib/sound/synth';
import { errorText, type EditorSession, type ImportChoice, type ImportSource } from '../state/session.svelte';
import { confirm } from '../dialogs/confirm.svelte';

const KEY = Symbol('reskin.editor.shell');

/** Where Settings should scroll to when it opens (e.g. "about"). */
export type SettingsSection = 'appearance' | 'motion' | 'behaviour' | 'advanced' | 'about';

/** The import popover's question: what should these become? */
export interface ImportQuestion {
  sources: ImportSource[];
  /** Where to ask (CSS px), or null for the middle of the window. */
  at: { x: number; y: number } | null;
}

/** Names what is being imported, for messages. */
function describe(sources: readonly ImportSource[]): string {
  if (sources.length !== 1) return 'the items';
  const [s] = sources;
  return s!.kind === 'item' ? s!.info.name : s!.name;
}

export class Shell {
  readonly session: EditorSession;

  /** Bumped on every open (Prepare): views reload their data. */
  openEpoch = $state(0);
  paletteOpen = $state(false);
  shortcutsOpen = $state(false);
  /** Item loads in flight (Prepare / AddItems / drops / pickers). */
  loading = $state(0);
  /** Files are being dragged over the window. */
  dragging = $state(false);
  /** Section Settings scrolls to when it (re)opens. */
  settingsSection = $state<SettingsSection | null>(null);
  /** Bumped when the History list must reload (after applies/restores). */
  historyEpoch = $state(0);
  /** Bumped when the Library changed outside the Library view. */
  libraryEpoch = $state(0);
  /** Asked by the import popover, or null (see askImport). */
  importQuestion = $state.raw<ImportQuestion | null>(null);
  /**
   * The Save to Library form is open: from its button, or from Ctrl+S / the
   * palette on a design linked to a Library design (see requestSaveToLibrary).
   */
  saveFormOpen = $state(false);
  /** The save as new Ctrl+S / the palette started, while it runs (see requestSaveToLibrary). */
  private quickSave: Promise<LibraryEntry | null> | null = null;
  /**
   * The user closed the editor over unsaved work ("Close anyway", see
   * requestClose): the next open starts over instead of coming back to it.
   * App's Prepare reads and clears it.
   */
  discardOnReopen = false;

  /**
   * An autosaved design offered for recovery (the Start banner and the
   * crash-recovery dialog share it; null once restored or discarded).
   */
  recovery = $state<string | null>(null);

  private chain: Promise<void> = Promise.resolve();
  private picking = false;
  private recoveryVersion = 0;

  constructor(session: EditorSession) {
    this.session = session;
  }

  /** The panel is open and interactive (not hidden / animating); the session follows it. */
  get interactive(): boolean {
    return this.session.interactive;
  }

  set interactive(on: boolean) {
    this.session.interactive = on;
  }

  /** Switches view; `about` is the About section of Settings. */
  navigate(view: EditorView): void {
    if (view === 'about') {
      this.settingsSection = 'about';
      this.session.navigate('settings');
      return;
    }
    if (view === 'settings') this.settingsSection = null;
    this.session.navigate(view);
  }

  /**
   * Runs loads in order (each waits for the previous one), without
   * blocking the caller. Errors become a toast.
   */
  private load(what: string, task: () => Promise<void>): Promise<void> {
    this.loading += 1;
    // A load still queued when the editor closed and reopened belongs to
    // the old open: skip it rather than leak its items into the new one.
    const epoch = this.openEpoch;
    const next = this.chain
      .then(() => (epoch === this.openEpoch ? task() : undefined))
      .catch((e: unknown) => {
        toast({ message: `Could not open ${what}: ${errorText(e)}`, kind: 'error' });
        play('error');
      })
      .finally(() => {
        this.loading -= 1;
      });
    this.chain = next;
    return next;
  }

  /** Opens items (Prepare, AddItems) in order, without blocking the caller. */
  openItems(items: ItemInfo[], opts: { replace?: boolean } = {}): Promise<void> {
    if (items.length === 0 && !opts.replace) return Promise.resolve();
    return this.load(items.length === 1 ? items[0]!.name : 'the items', () => this.session.openItems(items, opts));
  }

  /** Resolves once every queued load has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  /**
   * Brings in dropped, picked or pasted things. With nothing open they
   * open right away; with a design open the import popover asks what they
   * become (see ImportChoice) — nothing open is replaced.
   */
  askImport(sources: ImportSource[], at: { x: number; y: number } | null = null): Promise<void> {
    if (sources.length === 0) return Promise.resolve();
    if (!this.session.hasDesign) {
      return this.load(describe(sources), async () => {
        await this.session.importSources(sources, 'queue');
      });
    }
    this.importQuestion = { sources, at };
    return Promise.resolve();
  }

  /** The import popover's answer. */
  importAs(sources: ImportSource[], how: ImportChoice): Promise<void> {
    this.importQuestion = null;
    return this.load(describe(sources), async () => {
      const queued = await this.session.importSources(sources, how);
      if (queued > 0) toast({ message: `Added ${queued} item${queued === 1 ? '' : 's'} to the queue.`, kind: 'info' });
    });
  }

  /** "Open image…": native picker, then imports what was picked. */
  async openImage(): Promise<void> {
    // One picker at a time (double clicks, Ctrl+O while it is open).
    if (this.picking) return;
    this.picking = true;
    let picked: ItemInfo[];
    try {
      picked = await commands.pickFiles('import');
    } catch (e) {
      toast({ message: `Could not open the file picker: ${errorText(e)}`, kind: 'error' });
      return;
    } finally {
      this.picking = false;
    }
    await this.askImport(picked.map((info) => ({ kind: 'item', info })));
  }

  /** Asks before the open design's unsaved changes are replaced; true to go ahead. */
  private confirmReplace(title: string, confirmLabel: string): Promise<boolean> {
    const { session } = this;
    if (!session.unsaved) return Promise.resolve(true);
    const item = session.item;
    return confirm({
      title,
      message: `Your changes to ${item ? `${item.name}'s design` : 'the current design'} will be lost. Save it to the Library first to keep them.`,
      confirmLabel,
      danger: true,
    });
  }

  /**
   * Starts a blank design in the Edit view. It replaces the open design
   * (and its undo history), so unsaved changes are confirmed first.
   */
  async newBlank(): Promise<void> {
    if (!(await this.confirmReplace('Start a blank icon?', 'Start blank'))) return;
    this.session.newBlank();
    this.session.navigate('edit');
  }

  /**
   * Opens a Library design in place of the open one, asking first when
   * that has unsaved changes. False when the user kept the open design.
   */
  async openLibraryDesign(entry: LibraryEntry): Promise<boolean> {
    if (!(await this.confirmReplace(`Open "${entry.name}"?`, 'Open'))) return false;
    await this.session.openLibraryDesign(entry.id, entry.name);
    return true;
  }

  /** Re-reads the autosave offered for recovery. */
  async refreshRecovery(): Promise<void> {
    const asked = this.recoveryVersion;
    const draft = await this.session.recoverable();
    // A Restore / Discard made while reading wins over the stale answer.
    if (asked === this.recoveryVersion) this.recovery = draft;
  }

  /** Opens the autosaved design (rejects when it can't be loaded). */
  async restoreRecovery(json: string): Promise<void> {
    await this.session.restoreAutosave(json);
    this.recoveryVersion += 1;
    this.recovery = null;
  }

  /** Forgets the autosaved design (rejects when the file can't be cleared). */
  async discardRecovery(): Promise<void> {
    this.recoveryVersion += 1;
    this.recovery = null;
    await this.session.discardAutosave();
  }

  /** Asks, then puts back every original icon Reskin changed. */
  async restoreAll(): Promise<RestoreReport | null> {
    const ok = await confirm({
      title: 'Restore all icons?',
      message:
        'Every shortcut, folder and system icon Reskin changed gets its original icon back. Your Library designs are kept.',
      confirmLabel: 'Restore all',
      danger: true,
    });
    if (!ok) return null;
    try {
      const report = await commands.restore({ type: 'all' });
      this.historyEpoch += 1;
      reportRestore(report, 'all');
      return report;
    } catch (e) {
      toast({ message: `Could not restore: ${errorText(e)}`, kind: 'error' });
      play('error');
      return null;
    }
  }

  async refreshIcons(level: RefreshLevel = 'notify'): Promise<void> {
    try {
      await commands.refreshIcons(level);
      toast({
        message: level === 'rebuild' ? 'Rebuilt the Windows icon cache.' : 'Asked Windows to redraw desktop icons.',
        kind: 'success',
      });
    } catch (e) {
      toast({ message: `Could not refresh icons: ${errorText(e)}`, kind: 'error' });
    }
  }

  /** Saves the open design to the Library (over its Library design unless `asNew`). */
  async saveToLibrary(name?: string, opts: { asNew?: boolean } = {}): Promise<LibraryEntry | null> {
    const entry = await this.session.saveToLibrary(name, opts);
    if (entry) this.libraryEpoch += 1;
    return entry;
  }

  /**
   * Ctrl+S and the palette's "Save to Library". A design linked to a
   * Library design is only ever saved over from the form that names it, so
   * the form opens (in the Edit view, where it lives); any other design is
   * saved as a new one at once.
   */
  async requestSaveToLibrary(): Promise<LibraryEntry | null> {
    // Pressed again while that save runs: the same save, not a second design.
    if (this.quickSave) return this.quickSave;
    if (this.session.libraryId === null) {
      this.quickSave = this.saveToLibrary().finally(() => {
        this.quickSave = null;
      });
      return this.quickSave;
    }
    this.navigate('edit');
    this.saveFormOpen = true;
    return null;
  }

  /**
   * The designs whose changes a close would drop: the open design and
   * every other queued one changed since it was last applied, saved or
   * exported.
   */
  private unsavedDesigns(): string[] {
    const { session } = this;
    const queued = session.queue
      .filter((q, i) => i !== session.currentIndex && q.unsaved)
      .map((q) => `${q.info.name}'s design`);
    if (!session.unsaved) return queued;
    return [session.item ? `${session.item.name}'s design` : 'the current design', ...queued];
  }

  /** Some design has changes a close would drop (see unsavedDesigns). */
  get hasUnsavedWork(): boolean {
    return this.unsavedDesigns().length > 0;
  }

  /**
   * Close (✕, Esc, the palette). Over unsaved work it asks first; closed
   * anyway, that work is dropped at the next open (discardOnReopen). The
   * session's close keeps the open design in the autosave as it goes.
   */
  async requestClose(): Promise<void> {
    const unsaved = this.unsavedDesigns();
    if (unsaved.length > 0) {
      const what = unsaved.length === 1 ? unsaved[0]! : `${unsaved.length} designs`;
      const ok = await confirm({
        title: 'Close the editor?',
        message: `Your changes to ${what} will be lost. Apply them or save them to the Library first to keep them.`,
        confirmLabel: 'Close anyway',
        danger: true,
      });
      if (!ok) return;
    }
    this.discardOnReopen = unsaved.length > 0;
    try {
      await this.session.requestClose();
    } catch (e) {
      // Still open: nothing is dropped.
      this.discardOnReopen = false;
      throw e;
    }
  }

  async openReleases(): Promise<void> {
    try {
      await commands.openExternal('releases');
    } catch (e) {
      toast({ message: `Could not open the browser: ${errorText(e)}`, kind: 'error' });
    }
  }
}

/** Toast for a RestoreReport. */
export function reportRestore(report: RestoreReport, what: 'all' | 'one'): void {
  const failed = report.failed.length;
  if (report.restored === 0 && failed === 0 && report.needsElevation === 0) {
    toast({ message: what === 'all' ? 'Nothing to restore — every icon is original.' : 'Already restored.', kind: 'info' });
    return;
  }
  if (failed > 0 || report.needsElevation > 0) {
    const parts = [`Restored ${report.restored}`];
    if (failed > 0) parts.push(`${failed} failed (${report.failed.slice(0, 2).join('; ')})`);
    if (report.needsElevation > 0) parts.push(`${report.needsElevation} need administrator rights`);
    toast({ message: `${parts.join(', ')}.`, kind: 'warning' });
    return;
  }
  toast({
    message:
      what === 'all'
        ? `Restored ${report.restored} original icon${report.restored === 1 ? '' : 's'}.`
        : 'Original icon restored.',
    kind: 'success',
  });
  play('success');
}

export function setShell(shell: Shell): Shell {
  return setContext(KEY, shell);
}

export function getShell(): Shell {
  const s = getContext<Shell | undefined>(KEY);
  if (!s) throw new Error('getShell() used outside the editor');
  return s;
}

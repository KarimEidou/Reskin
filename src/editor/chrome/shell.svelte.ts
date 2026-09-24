// Shell-level UI state and actions shared by the chrome, the views, the
// dialogs and the command palette (App.svelte creates one and provides it
// with setShell()). The editor *document* state lives in the session.

import { getContext, setContext } from 'svelte';
import { commands } from '$lib/ipc/commands';
import type { EditorView, ItemInfo, RefreshLevel, RestoreReport } from '$lib/ipc/types';
import { toast } from '$lib/ui/toasts.svelte';
import { play } from '$lib/sound/synth';
import { errorText, isTarget, type EditorSession } from '../state/session.svelte';
import { confirm } from '../dialogs/confirm.svelte';

const KEY = Symbol('reskin.editor.shell');

/** Where Settings should scroll to when it opens (e.g. "about"). */
export type SettingsSection = 'appearance' | 'motion' | 'behaviour' | 'advanced' | 'about';

export class Shell {
  readonly session: EditorSession;

  /** Bumped on every open (Prepare): views reload their data. */
  openEpoch = $state(0);
  /** The panel is open and interactive (not hidden / animating). */
  interactive = $state(false);
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
   * Opens items in order (each load waits for the previous one), without
   * blocking the caller. Errors become a toast.
   */
  openItems(items: ItemInfo[], opts: { replace?: boolean } = {}): Promise<void> {
    if (items.length === 0 && !opts.replace) return Promise.resolve();
    this.loading += 1;
    // A load still queued when the editor closed and reopened belongs to
    // the old open: skip it rather than leak its items into the new one.
    const epoch = this.openEpoch;
    const next = this.chain
      .then(() => (epoch === this.openEpoch ? this.session.openItems(items, opts) : undefined))
      .catch((e: unknown) => {
        toast({ message: `Could not open ${items.length === 1 ? items[0]!.name : 'the items'}: ${errorText(e)}`, kind: 'error' });
        play('error');
      })
      .finally(() => {
        this.loading -= 1;
      });
    this.chain = next;
    return next;
  }

  /** Resolves once every queued load has finished. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** "Open image…": native picker, then open/add what was picked. */
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
    if (picked.length === 0) return;
    await this.openItems(picked);
    const targets = picked.filter(isTarget).length;
    if (targets > 0 && this.session.queue.length > 1) {
      toast({ message: `Added ${targets} item${targets === 1 ? '' : 's'} to the queue.`, kind: 'info' });
    }
  }

  /**
   * Starts a blank design in the Edit view. It replaces the open design
   * (and its undo history), so unsaved edits are confirmed first.
   */
  async newBlank(): Promise<void> {
    const { session } = this;
    if (session.hasDesign && session.engine.canUndo) {
      const ok = await confirm({
        title: 'Start a blank icon?',
        message: 'Your changes to the current design will be lost. Save it to the Library first to keep it.',
        confirmLabel: 'Start blank',
        danger: true,
      });
      if (!ok) return;
    }
    session.newBlank();
    session.navigate('edit');
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

  async saveToLibrary(): Promise<unknown> {
    const entry = await this.session.saveToLibrary();
    if (entry) this.libraryEpoch += 1;
    return entry;
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

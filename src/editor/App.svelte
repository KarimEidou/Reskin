<!--
  The editor page. Boots, creates the session, follows Rust's mailbox and
  routes every EditorCmd: the handoff commands go through MorphController
  (which drives MorphFrame: the box proxy ⇄ the panel), the rest to the
  session / shell. Mounts the chrome, the views, the dialogs, the command
  palette and the global keyboard handling.
-->
<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import { boot } from '$lib/boot';
  import { commands } from '$lib/ipc/commands';
  import { startMailbox } from '$lib/ipc/mailbox';
  import type { EditorCmd, ItemId, Settings } from '$lib/ipc/types';
  import { doubleRaf } from '$lib/motion/raf';
  import { motion } from '$lib/motion/speed.svelte';
  import { applySettingsFromMailbox, settings, updateSettings } from '$lib/settings/store.svelte';
  import { currentTheme } from '$lib/theme/theme';
  import { handoffProps } from '$lib/ui/box-geometry';
  import ToastHost from '$lib/ui/ToastHost.svelte';
  import { clearToasts, toast } from '$lib/ui/toasts.svelte';
  import { Shell, setShell } from './chrome/shell.svelte';
  import TitleBar from './chrome/TitleBar.svelte';
  import { answerConfirm } from './dialogs/confirm.svelte';
  import ConfirmDialog from './dialogs/ConfirmDialog.svelte';
  import ElevationDialog from './dialogs/ElevationDialog.svelte';
  import ImportPopover from './dialogs/ImportPopover.svelte';
  import RecoveryDialog from './dialogs/RecoveryDialog.svelte';
  import MorphFrame, { type FrameMode } from './morph/MorphFrame.svelte';
  import {
    isHandoffCmd,
    MorphController,
    type CollapseCmd,
    type MorphPhase,
    type PrepareCmd,
  } from './morph/MorphController';
  import { createCommands, type CommandContext } from './palette/commands';
  import { installKeyboard } from './palette/dispatcher';
  import { createSession, setSession } from './state/context';
  import { errorText } from './state/session.svelte';
  import { preloadViews } from './views/lazy.svelte';
  import ViewHost from './views/ViewHost.svelte';

  const session = setSession(createSession());
  const shell = setShell(new Shell(session));
  const registry = createCommands(session.engine.tools);

  let frame: ReturnType<typeof MorphFrame> | undefined = $state();
  let mode = $state<FrameMode>('hidden');
  let recoveryDraft = $state<string | null>(null);
  /** Recovery is offered once per page lifetime, on the first Start view. */
  let recoveryChecked = false;
  let recoveryPending: Promise<string | null> | null = null;

  const s = $derived(settings());

  // ---- lazily loaded overlays --------------------------------------------------
  let Palette = $state<Component<{ open?: boolean; commands: typeof registry; ctx: CommandContext }> | null>(null);
  let Shortcuts = $state<Component<{ open?: boolean; commands: typeof registry }> | null>(null);

  function loadPalette(): void {
    if (!Palette) void import('./palette/CommandPalette.svelte').then((m) => (Palette = m.default));
  }
  function loadShortcuts(): void {
    if (!Shortcuts) void import('./palette/ShortcutsOverlay.svelte').then((m) => (Shortcuts = m.default));
  }
  $effect(() => {
    if (shell.paletteOpen) loadPalette();
  });
  $effect(() => {
    if (shell.shortcutsOpen) loadShortcuts();
  });

  // ---- command context ----------------------------------------------------------
  const ctx: CommandContext = {
    session,
    settings: () => settings(),
    updateSettings: (patch: Partial<Settings>) =>
      updateSettings(patch).catch((e: unknown) => {
        toast({ message: `Couldn't save the setting: ${errorText(e)}`, kind: 'error' });
      }),
    theme: () => currentTheme(),
    openPalette: () => {
      shell.shortcutsOpen = false;
      shell.paletteOpen = true;
    },
    openShortcuts: () => {
      shell.paletteOpen = false;
      shell.shortcutsOpen = true;
    },
    openImage: () => shell.openImage(),
    restoreAll: async () => {
      await shell.restoreAll();
    },
    refreshIcons: () => shell.refreshIcons('notify'),
    openReleases: () => shell.openReleases(),
    saveToLibrary: () => shell.saveToLibrary(),
  };

  // ---- the handoff surface --------------------------------------------------------

  /** Closes everything transient (palette, dialogs, menus, popovers). */
  function closeTransient(): void {
    shell.paletteOpen = false;
    shell.shortcutsOpen = false;
    shell.dragging = false;
    recoveryDraft = null;
    answerConfirm(false);
    session.dismissElevation();
    // Menus and popovers close on an outside press.
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  }

  async function prepare(cmd: PrepareCmd): Promise<void> {
    closeTransient();
    applySettingsFromMailbox(cmd.settings);
    session.reset();
    shell.openEpoch += 1;
    const view = cmd.items.length > 0 ? 'edit' : cmd.view;
    shell.navigate(view);
    // The items load in the background; only the proxy must be ready.
    if (cmd.items.length > 0) void shell.openItems(cmd.items, { replace: true });
    if (view === 'start' && !recoveryChecked) {
      recoveryChecked = true;
      recoveryPending = session.recoverable();
    }
    await frame?.showProxy(cmd.boxRect, handoffProps(cmd.settings, cmd.items, motion.reduced));
  }

  async function collapse(cmd: CollapseCmd): Promise<void> {
    closeTransient();
    // Plain close: the box comes back empty; after an apply it carries the new icon.
    const items = cmd.then === 'hide' ? [] : [{ icon: cmd.icon }];
    const props = cmd.morph ? handoffProps(settings(), items, motion.reduced) : null;
    await frame?.collapse(cmd.boxRect, props, cmd.morph && !motion.reduced);
  }

  function clear(): void {
    closeTransient();
    frame?.clear();
    clearToasts();
  }

  /** Fetches the lazily loaded parts while nothing else is going on. */
  function preloadAll(): void {
    preloadViews();
    loadPalette();
    loadShortcuts();
  }

  async function onOpened(): Promise<void> {
    setTimeout(preloadAll, 300);
    const pending = recoveryPending;
    recoveryPending = null;
    if (!pending) return;
    const draft = await pending;
    if (draft && morph.phase === 'open' && session.view === 'start') recoveryDraft = draft;
  }

  const morph = new MorphController({
    surface: {
      prepare,
      expand: async (m) => {
        await frame?.expand(m && !motion.reduced);
      },
      collapse,
      clear,
      frames: (ms) => doubleRaf({ timeoutMs: ms }),
    },
    ack: (sid, stage) => commands.editorAck(sid, stage),
    onPhase: (phase: MorphPhase) => {
      document.documentElement.dataset.phase = phase;
      if (phase === 'open') void onOpened();
    },
    onIssue: (issue) => console.warn(`[morph] ${issue.step} ${issue.kind} (session ${issue.session})`, issue.error ?? ''),
  });

  // ---- smoke test -----------------------------------------------------------------

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Waits until `item` is in the queue with its design loaded. */
  async function waitForItem(item: ItemId, timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    let missingSince: number | null = null;
    while (performance.now() < deadline) {
      await shell.idle();
      const index = session.queue.findIndex((q) => q.info.id === item);
      if (index >= 0) {
        missingSince = null;
        if (index !== session.currentIndex) await session.select(index);
        if (session.currentIndex === index && session.hasDesign) return;
      } else if (shell.loading === 0) {
        // Nothing is loading and the item isn't there: it was never opened.
        missingSince ??= performance.now();
        if (performance.now() - missingSince > 1000) throw new Error('the item is not open in the editor');
      }
      await sleep(50);
    }
    throw new Error('the item never finished loading');
  }

  async function smokeCycle(item: ItemId): Promise<void> {
    let detail = 'cycle:ok';
    try {
      await waitForItem(item, 20_000);
      const outcome = await session.apply({ mode: 'inPlace', flourish: false });
      if (!outcome) throw new Error('apply failed');
      if (outcome.type !== 'applied') {
        const why =
          outcome.type === 'failed'
            ? outcome.message
            : outcome.type === 'needsElevation' || outcome.type === 'unsupported'
              ? `${outcome.type}: ${outcome.reason}`
              : outcome.type;
        throw new Error(`apply: ${why}`);
      }
      const report = await commands.restore({ type: 'item', item });
      if (report.failed.length > 0) throw new Error(`restore: ${report.failed.join('; ')}`);
      if (report.restored < 1) throw new Error('restore: nothing was restored');
    } catch (e) {
      detail = `cycle:fail:${errorText(e)}`;
    }
    await commands.smokeReady({ window: 'editor', detail }).catch((e: unknown) => console.error('[smoke] report failed', e));
  }

  // ---- mailbox routing --------------------------------------------------------------

  async function onCommand(cmd: EditorCmd): Promise<void> {
    if (isHandoffCmd(cmd)) {
      await morph.handle(cmd);
      return;
    }
    switch (cmd.type) {
      case 'addItems':
        void shell.openItems(cmd.items);
        break;
      case 'navigate':
        shell.navigate(cmd.view);
        break;
      case 'settings':
        applySettingsFromMailbox(cmd.settings);
        break;
      case 'smokeCycle':
        await smokeCycle(cmd.item);
        break;
      case 'heartbeat':
        break;
    }
  }

  onMount(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    const uninstallKeys = installKeyboard({
      commands: registry,
      ctx: () => ctx,
      active: () => shell.interactive,
      engine: () => session.engine,
      onEscape: () => void session.requestClose().catch((e: unknown) => console.error('[editor] close failed', e)),
      onError: (cmd, e) => toast({ message: `${cmd.label} failed: ${errorText(e)}`, kind: 'error' }),
    });

    (async () => {
      const info = await boot();
      if (info.smoke) {
        // The window is hidden (no rAF): report as soon as the page runs.
        const detail = `editor ok v${info.version} dpr=${window.devicePixelRatio} t=${Math.round(performance.now())}ms`;
        void commands.smokeReady({ window: 'editor', detail }).catch((e: unknown) => console.error('[smoke]', e));
      }
      if (disposed) return;
      // The pre-warmed editor has time to fetch the lazy parts before it opens.
      setTimeout(preloadAll, info.smoke ? 0 : 1500);
      const mailbox = startMailbox(onCommand, {
        onPollError: (e, retry) => console.warn(`[mailbox] poll failed, retrying in ${retry} ms`, e),
      });
      stop = () => mailbox.stop();
    })().catch((e: unknown) => console.error('[editor] boot failed', e));

    return () => {
      disposed = true;
      uninstallKeys();
      stop?.();
      session.dispose();
    };
  });

  // Mirror the frame's rest mode for the chrome and global CSS.
  $effect(() => {
    shell.interactive = mode === 'open';
    document.documentElement.dataset.stage = mode;
  });
</script>

<MorphFrame bind:this={frame} compat={s.compatibilityMode} onmode={(m) => (mode = m)}>
  <TitleBar />
  <ViewHost />
</MorphFrame>

<div class="toasts" class:shown={mode === 'open'}>
  <ToastHost inset={session.view === 'edit' && session.hasDesign ? '80px' : '28px'} />
</div>

<ElevationDialog />
<RecoveryDialog draft={recoveryDraft} onclose={() => (recoveryDraft = null)} />
<ConfirmDialog />
<ImportPopover />
{#if Palette}
  <Palette bind:open={shell.paletteOpen} commands={registry} {ctx} />
{/if}
{#if Shortcuts}
  <Shortcuts bind:open={shell.shortcutsOpen} commands={registry} />
{/if}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
  }
  :global(body) {
    font-family: var(--font-ui);
    font-size: var(--text-md);
    color: var(--text);
    -webkit-user-select: none;
    user-select: none;
    cursor: default;
  }
  /* A soft recessed surface for wells and tiles on the glass panel. */
  :global(:root) {
    --shell-well: rgb(0 0 0 / 0.2);
  }
  :global(:root[data-theme='light']) {
    --shell-well: rgb(24 32 64 / 0.045);
  }
  :global(input),
  :global(textarea),
  :global([contenteditable='true']) {
    -webkit-user-select: text;
    user-select: text;
  }
  /* Compatibility mode: the window is opaque, paint it while visible. */
  :global(html[data-compat='true']:not([data-stage='hidden'])) {
    background: var(--bg);
  }
  /* Portalled menus / popovers / tooltips only show over the open panel. */
  :global(html:not([data-stage='open']) body > :not(#app)) {
    visibility: hidden;
  }
  .toasts {
    visibility: hidden;
  }
  .toasts.shown {
    visibility: visible;
  }
</style>

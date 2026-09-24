<!--
  The editor page. Boots, creates the session, follows Rust's mailbox and
  routes every EditorCmd: the handoff commands go through MorphController
  (which drives MorphFrame: the box proxy ⇄ the panel), the rest to the
  session / shell. Mounts the chrome, the views, the dialogs, the command
  palette and the global keyboard handling (Escape closes the editor, an
  image pasted outside the canvas becomes part of the design).
-->
<script lang="ts">
  import { onMount, tick, type Component } from 'svelte';
  import { decodeImage } from '$engine/dom';
  import type { Surface } from '$engine/index';
  import { boot } from '$lib/boot';
  import { commands } from '$lib/ipc/commands';
  import { startMailbox } from '$lib/ipc/mailbox';
  import type { EditorCmd, ItemId, Rect, Settings } from '$lib/ipc/types';
  import { doubleRaf, nextFrame } from '$lib/motion/raf';
  import { motion } from '$lib/motion/speed.svelte';
  import { applySettingsFromMailbox, settings, updateSettings } from '$lib/settings/store.svelte';
  import { currentTheme } from '$lib/theme/theme';
  import { collapseItems, handoffProps } from '$lib/ui/box-geometry';
  import ToastHost from '$lib/ui/ToastHost.svelte';
  import { clearToasts, toast } from '$lib/ui/toasts.svelte';
  import { afterAllListeners } from './chrome/last-listener';
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
  import { isTypingTarget } from './palette/keys';
  import { createSession, setSession } from './state/context';
  import { errorText } from './state/session.svelte';
  import { preloadViews } from './views/lazy.svelte';
  import ViewHost from './views/ViewHost.svelte';
  import { stage } from './workspace/stage.svelte';

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

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    newBlank: () => shell.newBlank(),
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
    // Items open in Edit; "edit" without anything to edit is the Start page.
    const view = cmd.items.length > 0 ? 'edit' : cmd.view === 'edit' ? 'start' : cmd.view;
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
    // Plain close: the box comes back empty; after an apply it carries the
    // new icon. The box takes this very picture over (box:collapse).
    const items = collapseItems(cmd.then, cmd.icon);
    const props = cmd.morph ? handoffProps(settings(), items, motion.reduced) : null;
    await frame?.collapse(cmd.boxRect, props, cmd.morph && !motion.reduced);
  }

  function clear(): void {
    closeTransient();
    frame?.clear();
    clearToasts();
  }

  /** How long Expand waits for the opened item to reach the canvas. */
  const LANDING_WAIT_MS = 250;

  /**
   * Where the box's icon settles at the end of the open morph: the document
   * on the canvas. The item loads while the proxy is prepared and revealed;
   * when it is not on the canvas yet, this waits a little for it (the
   * workspace mounts with the design and sizes its canvas on the next
   * frame). Null outside the Edit view, or when the item takes longer.
   */
  async function landing(): Promise<Rect | null> {
    if (session.view !== 'edit') return null;
    const deadline = performance.now() + LANDING_WAIT_MS;
    await Promise.race([shell.idle(), sleep(LANDING_WAIT_MS)]);
    await tick();
    for (;;) {
      const r = stage.docRect();
      if (r) return { x: r.x, y: r.y, w: r.width, h: r.height };
      const left = deadline - performance.now();
      if (left <= 0 || !session.hasDesign) return null;
      await nextFrame({ timeoutMs: left });
    }
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
        const morph = m && !motion.reduced;
        await frame?.expand(morph, morph ? await landing() : null);
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

  // ---- Escape and paste ----------------------------------------------------------
  // Both are decided after every other listener (./chrome/last-listener.ts):
  // whatever uses the key or the paste calls preventDefault (or stops it) —
  // dialogs, popovers and menus, the canvas (a drag, a pending transform, a
  // text edit, a lasso polygon, an image pasted as a layer) and the
  // sidebar's panel editors — and many of them listen on the window, where
  // they come after the App's own listeners.

  /**
   * The Escape keydown on its way. The keyboard dispatcher leaves it alone
   * (it would decide before the listeners added after it): closeOnEscape
   * decides instead.
   */
  let escapeKey: KeyboardEvent | null = null;
  /**
   * The engine had a gesture, a pending transform or a text edit when that
   * Escape went down: the key is for it, even if what settles it on the
   * way does not say so (or nothing on the way handles it, e.g. focus in a
   * non-modal overlay).
   */
  let escapeForEngine = false;

  /** Window capture, before any other keydown listener. */
  function trackEscape(e: KeyboardEvent): void {
    escapeKey = e.key === 'Escape' ? e : null;
    if (!escapeKey) return;
    const engine = session.engine;
    escapeForEngine = engine.hasPending || engine.isInteracting || engine.textEditLayerId !== null;
  }

  const modalOpen = () => document.querySelector('dialog:modal') !== null;

  /** The event's target keeps the key / the paste (text entry, the hotkey recorder). */
  function keptByTarget(e: Event): boolean {
    const target = e.target instanceof Element ? e.target : null;
    return !!target && (isTypingTarget(target) || target.closest('[data-capture-keys]') !== null);
  }

  /** Escape nothing else used closes the editor (the collapse handoff). */
  function closeOnEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented || e.repeat || e.isComposing) return;
    if (!shell.interactive || escapeForEngine || modalOpen() || keptByTarget(e)) return;
    e.preventDefault();
    // An adjustment still previewing on the canvas: Escape cancels it first
    // (its panel closes its settings when the preview ends).
    const preview = session.engine.preview;
    if (preview?.active) {
      preview.cancel();
      return;
    }
    void session.requestClose().catch((err: unknown) => console.error('[editor] close failed', err));
  }

  function pastedImage(data: DataTransfer | null): File | null {
    if (!data) return null;
    for (const item of data.items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
    }
    return null;
  }

  /**
   * An image pasted where nothing took it (the canvas adds pasted images
   * itself): it joins the open design as a layer, or starts a design.
   */
  function pasteImage(e: ClipboardEvent): void {
    if (e.defaultPrevented || !shell.interactive || modalOpen() || keptByTarget(e)) return;
    const file = pastedImage(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    void importPasted(file);
  }

  /** The design an image joins (null: it starts one). */
  const openDesign = () => (session.hasDesign ? session.engine.doc : null);

  async function importPasted(file: File): Promise<void> {
    const design = openDesign();
    let surface: Surface;
    try {
      surface = await decodeImage(file);
    } catch (e) {
      toast({ message: `Couldn't read the pasted image: ${errorText(e)}`, kind: 'error' });
      return;
    }
    // The editor closed, or another design opened, while decoding.
    if (!shell.interactive || openDesign() !== design) return;
    const fresh = design === null;
    if (fresh) session.newBlank();
    const starter = fresh ? session.engine.doc.layers[0] : undefined;
    session.importSurface(surface);
    if (fresh) {
      // Like an opened image: the design is the picture, with nothing to undo.
      if (starter && session.engine.doc.layers.length > 1) session.engine.deleteLayer(starter.id);
      session.engine.clearHistory();
    }
    shell.navigate('edit');
  }

  // ---- smoke test -----------------------------------------------------------------

  /** The SmokeCycle running (see onCommand); a second one waits for it. */
  let smokeRun: Promise<void> = Promise.resolve();

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
        // Long work (an item load, an apply and a restore) must never hold
        // the mailbox: Rust takes a page whose mailbox is silent for 2 s for
        // dead. The cycle reports through smoke_ready.
        smokeRun = smokeRun.then(() => smokeCycle(cmd.item));
        break;
      case 'heartbeat':
        break;
    }
  }

  onMount(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    // Added before the dispatcher's listeners, so it sees every keydown first.
    window.addEventListener('keydown', trackEscape, true);
    const uninstallEscape = afterAllListeners(window, 'keydown', closeOnEscape, (e) => e.key === 'Escape');
    const uninstallPaste = afterAllListeners(window, 'paste', pasteImage);
    const uninstallKeys = installKeyboard({
      commands: registry,
      ctx: () => ctx,
      active: () => shell.interactive && escapeKey === null,
      engine: () => session.engine,
      // Never called: Escape is not active for the dispatcher (closeOnEscape).
      onEscape: () => {},
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
      window.removeEventListener('keydown', trackEscape, true);
      uninstallEscape();
      uninstallPaste();
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
  /* Modal scrims cover the panel only: the window's 12 px shadow margin is
     transparent desktop, and a scrim there would outline the window's
     square bounds. (Compatibility mode: the panel fills the window.) */
  :global(html:not([data-compat='true']) dialog::backdrop) {
    inset: 12px;
    border-radius: 16px;
  }
  .toasts {
    visibility: hidden;
  }
  .toasts.shown {
    visibility: visible;
  }
</style>

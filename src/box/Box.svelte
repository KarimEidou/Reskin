<!--
  The floating box page. Renders BoxVisual from the box state machine
  (./box-state.ts) and wires it to the pointer, OS drag-and-drop and the
  Rust events. A saved hotkey Windows won't register is said once at
  start-up (the hint bubble) and in the box's tooltip and description for
  as long as it doesn't work. The root exposes `data-state` (logical state)
  and `data-ready` (booted and listening) for tests.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { boot } from '$lib/boot';
  import { commands } from '$lib/ipc/commands';
  import { on } from '$lib/ipc/events';
  import type { BootInfo, ItemInfo } from '$lib/ipc/types';
  import { doubleRaf, frames } from '$lib/motion/raf';
  import { dur, motion } from '$lib/motion/speed.svelte';
  import { settings } from '$lib/settings/store.svelte';
  import { system } from '$lib/settings/system.svelte';
  import { play } from '$lib/sound/synth';
  import BoxVisual from '$lib/ui/BoxVisual.svelte';
  import {
    ABSORB_IMPACT_AT,
    ABSORB_MS,
    CELEBRATE_MS,
    ERROR_HOLD_MS,
    errorLifetime,
    FIRST_RUN_HINT,
    iconRect,
    metricsFor,
    physicalToCss,
    type BoxVisualState,
  } from '$lib/ui/box-geometry';
  import { flyIconIn } from './absorb';
  import { boxReducer, initialBoxState, progressFraction, undoOutcome, type BoxEvent } from './box-state';
  import { hotkeyHint, hotkeyProblem } from './hotkey-hint';

  /**
   * How long a hint stays once the box is on screen (UI.md: "for a few
   * seconds"): the first-run hint after the welcome (until then — the
   * welcome is still open over the hidden box — it waits), then the hotkey
   * note from start-up (for as long as it is in the bubble).
   */
  const HINT_MS = 6000;
  /** Undo chip lifetime after a successful apply. */
  const UNDO_MS = 6000;
  /** Unfreeze a handoff that Rust never followed up on. */
  const HANDOFF_TIMEOUT_MS = 8000;
  /**
   * A picture taken on for a handoff is confirmed once its icon is decoded
   * and two frames passed with the box on screen (a hidden window paints
   * nothing); should that take longer, it is confirmed anyway.
   */
  const PAINT_TIMEOUT_MS = 250;

  let info = $state.raw<BootInfo | null>(null);
  let box = $state.raw(initialBoxState);
  let ready = $state(false);
  /** Epoch of the absorb whose gulp is running (its icon is flying in). */
  let gulpEpoch = $state<number | null>(null);
  let showHint = $state(false);
  /** Bumped by `box:shown` while the hint is up: starts its lifetime. */
  let hintClock = $state(0);
  /** The saved hotkey did not work at start-up: said once, in the hint bubble. */
  let hotkeyNote = $state<string | null>(null);
  /** The hotkey note has been on screen: its lifetime runs. */
  let hotkeyNoteShown = $state(false);
  let undoId = $state<string | null>(null);
  let flyLayer: HTMLDivElement | undefined = $state();
  let hitEl: HTMLDivElement | undefined = $state();
  /**
   * The picture taken over with `box:collapse` while hidden, to confirm once
   * the box is back on screen: its handoff session and its icon's decoding
   * (an image not decoded yet paints as nothing).
   */
  let collapsePicture: { session: number; decoded: Promise<void> } | null = null;

  const s = $derived(settings());
  const metrics = $derived(
    info && s.boxSize === info.settings.boxSize ? info.boxMetrics : metricsFor(s.boxSize),
  );
  // While a drop waits for its inspection the box keeps "holding" (armed
  // look); the gulp starts together with the icon's flight.
  const visualState: BoxVisualState = $derived(
    box.name === 'absorbing' && gulpEpoch !== box.epoch ? 'armed' : box.name,
  );
  // The hotkey note waits for the first-run hint, and goes once the hotkey works.
  const note = $derived(showHint ? FIRST_RUN_HINT : system.hotkeyError ? hotkeyNote : null);
  const hint = $derived((box.name === 'idle' || box.name === 'hover') && !box.handoff ? note : null);
  /** The tooltip and accessible description while the saved hotkey doesn't work (Windows is asked again on focus). */
  const problem = $derived(system.hotkeyError ? hotkeyProblem(system.hotkeyError) : null);
  const label = $derived(
    box.name === 'armed'
      ? box.count > 1
        ? `Drop ${box.count} items to edit their icons`
        : 'Drop to edit this icon'
      : 'Reskin box. Drop a shortcut here, or press Enter to open the editor',
  );

  function send(e: BoxEvent): void {
    box = boxReducer(box, e);
  }

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // ---- inspection (starts as soon as a drag enters) ----------------------
  let pending: { key: string; result: Promise<ItemInfo[]> } | null = null;

  function inspect(paths: string[]): Promise<ItemInfo[]> {
    const key = JSON.stringify(paths);
    if (pending?.key !== key) {
      const result = commands.inspectPaths(paths);
      // Consumers await it later; keep an early rejection from being "unhandled".
      result.catch(() => {});
      pending = { key, result };
    }
    return pending.result;
  }

  /**
   * Epoch of the absorb that an open from elsewhere cut short (`box:handoff`
   * while it ran): its items still go to that editor.
   */
  let joinEpoch: number | null = null;

  async function absorb(paths: string[], position: { x: number; y: number }): Promise<void> {
    send({ type: 'drop', count: paths.length });
    if (box.name !== 'absorbing') return;
    const epoch = box.epoch;
    // Anything else (an error, a flight, the window being hidden or shown)
    // cancels this absorb; `epoch` alone misses the resets, which keep it.
    const current = () => box.epoch === epoch && box.name === 'absorbing';
    const dropAt = physicalToCss(position, window.devicePixelRatio);
    // The user is past the hints now.
    showHint = false;
    hotkeyNote = null;

    let items: ItemInfo[] = [];
    let failure = 'None of these items can be reskinned';
    try {
      items = await inspect(paths);
    } catch (e) {
      failure = errorText(e);
    }
    pending = null;
    if (!current()) return joinOpening(epoch, items);
    if (items.length === 0) {
      send({ type: 'inspectFailed', message: failure });
      play('error');
      return;
    }

    const icon = items[0]!.icon;
    const impact = dur(ABSORB_MS * ABSORB_IMPACT_AT);
    gulpEpoch = epoch;
    try {
      if (icon && flyLayer) await flyIconIn(flyLayer, icon, dropAt, iconRect(metrics), impact);
      else await sleep(impact);
      if (!current()) return joinOpening(epoch, items);
      send({ type: 'inspectDone', icon, count: items.length });
      play('drop');
      await sleep(dur(ABSORB_MS) - impact);
    } finally {
      // Never leave a later drop showing the gulp instead of the hold.
      if (gulpEpoch === epoch) gulpEpoch = null;
    }
    if (!current()) return joinOpening(epoch, items);
    await requestOpen(
      items.map((i) => i.id),
      'edit',
    );
  }

  /**
   * The absorb of `epoch` was cut short: when an open from elsewhere did
   * it, the dropped items join that editor (Rust hands them over once it is
   * open) instead of being lost.
   */
  function joinOpening(epoch: number, items: ItemInfo[]): void {
    if (joinEpoch !== epoch) return;
    joinEpoch = null;
    if (items.length === 0) return;
    commands
      .openEditor(
        items.map((i) => i.id),
        'edit',
      )
      .catch((e: unknown) => console.error('[box] the dropped items could not join the editor', e));
  }

  /** Freezes on the handoff picture and asks Rust to open the editor. */
  async function requestOpen(ids: string[], view: 'edit' | 'start'): Promise<void> {
    send({ type: 'openRequested' });
    try {
      await commands.openEditor(ids, view);
    } catch (e) {
      send({ type: 'openFailed', message: errorText(e) });
      play('error');
    }
  }

  function openStart(): void {
    if (box.handoff || box.name === 'absorbing' || box.name === 'flying') return;
    showHint = false;
    hotkeyNote = null;
    send({ type: 'openRequested', icon: null, count: 0 });
    void requestOpen([], 'start');
  }

  // ---- pointer & keyboard -------------------------------------------------
  async function onPointerDown(e: PointerEvent): Promise<void> {
    if (e.button !== 0 || !ready) return;
    e.preventDefault();
    try {
      const result = await commands.boxDrag();
      if (result === 'click') openStart();
    } catch (err) {
      console.error('[box] box_drag failed', err);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault();
      openStart();
    }
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    commands.boxMenu(e.clientX, e.clientY).catch((err: unknown) => console.error('[box] box_menu failed', err));
  }

  async function undo(): Promise<void> {
    const id = undoId;
    if (!id) return;
    undoId = null;
    play('click');
    let outcome: BoxEvent;
    try {
      outcome = undoOutcome(await commands.restore({ type: 'entry', id }));
    } catch (e) {
      outcome = { type: 'error', message: `Couldn't undo: ${errorText(e)}` };
    }
    send(outcome);
    play(outcome.type === 'error' ? 'error' : 'success');
  }

  // ---- timers ---------------------------------------------------------------
  $effect(() => {
    const { name, epoch, message } = box;
    if (name !== 'celebrate' && name !== 'error') return;
    const t = setTimeout(
      () => send({ type: 'settled', epoch }),
      name === 'celebrate' ? dur(CELEBRATE_MS, 'hold') : errorLifetime(message, dur(ERROR_HOLD_MS, 'hold')),
    );
    return () => clearTimeout(t);
  });

  $effect(() => {
    if (!box.handoff) return;
    const t = setTimeout(() => send({ type: 'unfreeze' }), HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(t);
  });

  /** Decodes the icon of the state just sent (once it is in the DOM). */
  async function iconDecoded(): Promise<void> {
    await tick();
    try {
      await hitEl?.querySelector('img')?.decode();
    } catch {
      // A broken image paints as nothing either way; don't hold the handoff.
    }
  }

  /**
   * Tells Rust the picture taken on for a handoff is on screen: the editor
   * may show its proxy over it (open) or let its proxy go (close).
   */
  async function confirmPainted({ session, decoded }: { session: number; decoded: Promise<void> }): Promise<void> {
    const deadline = performance.now() + PAINT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      decoded.then(() => true),
      new Promise<false>((r) => (timer = setTimeout(() => r(false), PAINT_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    const { timedOut } = await frames(2, { timeoutMs: Math.max(0, deadline - performance.now()) });
    if (!ready || timedOut) console.warn(`[box] the picture was not on screen within ${PAINT_TIMEOUT_MS} ms; confirming it anyway`);
    await commands.boxPainted(session).catch((e: unknown) => console.error('[box] box_painted failed', e));
  }

  $effect(() => {
    if (hint === null || hintClock === 0) return;
    const t = setTimeout(() => (showHint = false), dur(HINT_MS, 'hold'));
    return () => clearTimeout(t);
  });

  /** The box is on screen: the hotkey note may start its lifetime. */
  function hotkeyNoteOnScreen(): void {
    if (hotkeyNote !== null) hotkeyNoteShown = true;
  }

  // Its few seconds run while it is on screen in the hint bubble: not
  // behind the first-run hint, a handoff or a drag (it waits for them).
  $effect(() => {
    if (hotkeyNote === null || !hotkeyNoteShown || hint !== hotkeyNote) return;
    const t = setTimeout(() => (hotkeyNote = null), dur(HINT_MS, 'hold'));
    return () => clearTimeout(t);
  });

  $effect(() => {
    if (!undoId) return;
    const t = setTimeout(() => (undoId = null), UNDO_MS);
    return () => clearTimeout(t);
  });

  // ---- boot & listeners -------------------------------------------------------
  onMount(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') send({ type: 'hidden' });
      else hotkeyNoteOnScreen();
    };
    document.addEventListener('visibilitychange', onVisibility);

    (async () => {
      const b = await boot();
      info = b;
      showHint = b.firstRun;
      if (system.hotkeyError) hotkeyNote = hotkeyHint(system.hotkeyError);
      if (document.visibilityState === 'visible') hotkeyNoteOnScreen();
      const subscriptions = await Promise.all([
        on('box:flight', (f) => {
          send({ type: 'flight', phase: f.phase, icon: f.icon, message: f.message });
          if (f.phase === 'depart') play('whoosh');
          else if (f.phase === 'land') play('sparkle');
          else if (f.phase === 'celebrate') play('success');
          else if (f.phase === 'error') play('error');
        }),
        on('box:progress', (p) => send({ type: 'progress', done: p.done, total: p.total })),
        on('box:handoff', (h) => {
          // The editor opens over the (visible) box: freeze on the picture
          // its proxy draws — the one a drop or click already froze on, or
          // a new one when the open came from elsewhere (a drop still being
          // absorbed then joins that editor).
          if (box.name === 'absorbing') joinEpoch = box.epoch;
          send({ type: 'openRequested', icon: h.icon, count: h.count });
          void confirmPainted({ session: h.session, decoded: iconDecoded() });
        }),
        on('box:collapse', (c) => {
          send({ type: 'collapse', then: c.then, icon: c.icon });
          collapsePicture = { session: c.session, decoded: iconDecoded() };
        }),
        on('box:shown', () => {
          send({ type: 'shown' });
          if (showHint) hintClock += 1;
          hotkeyNoteOnScreen();
          const picture = collapsePicture;
          collapsePicture = null;
          if (picture) void confirmPainted(picture);
        }),
        on('box:undo', (id) => (undoId = id)),
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          switch (payload.type) {
            case 'enter':
              send({ type: 'dragEnter', count: payload.paths.length });
              if (box.name === 'armed') {
                play('pop', { volume: 0.6 });
                void inspect(payload.paths);
              }
              break;
            case 'over':
              break;
            case 'leave':
              send({ type: 'dragLeave' });
              pending = null;
              break;
            case 'drop':
              void absorb(payload.paths, payload.position);
              break;
          }
        }),
      ]);
      if (disposed) {
        subscriptions.forEach((u) => u());
        return;
      }
      unlisteners.push(...subscriptions);
      ready = true;

      if (b.smoke) {
        await doubleRaf({ timeoutMs: 2000 });
        const detail = `box ok skin=${s.boxSkin} dpr=${window.devicePixelRatio} t=${Math.round(performance.now())}ms`;
        await commands.smokeReady({ window: 'box', detail });
      }
    })().catch((e: unknown) => console.error('[box] boot failed', e));

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      unlisteners.forEach((u) => u());
    };
  });
</script>

<main
  class="box-page"
  class:handoff={box.handoff}
  data-state={box.name}
  data-ready={ready ? 'true' : 'false'}
  data-skin={s.boxSkin}
  style:width="{metrics.window}px"
  style:height="{metrics.window}px"
  style:--box-m="{metrics.margin}px"
  style:--box-r="{metrics.radius}px"
>
  <div
    class="hit"
    bind:this={hitEl}
    role="button"
    tabindex="0"
    aria-label={label}
    aria-describedby={problem ? 'box-problem' : undefined}
    title={problem ?? undefined}
    aria-busy={box.name === 'busy' || box.name === 'absorbing'}
    onpointerdown={onPointerDown}
    onpointerenter={() => send({ type: 'pointerEnter' })}
    onpointerleave={() => send({ type: 'pointerLeave' })}
    onkeydown={onKeyDown}
    oncontextmenu={onContextMenu}
  >
    <!-- The window is visible from the start: paint nothing until boot has
         applied the real skin, theme and motion (no flash of defaults). -->
    {#if info}
      <BoxVisual
        {metrics}
        skin={s.boxSkin}
        state={visualState}
        icon={box.icon}
        count={box.count}
        progress={progressFraction(box)}
        opacity={s.idleOpacity}
        compat={s.compatibilityMode}
        reducedMotion={motion.reduced}
        {hint}
        message={box.name === 'error' ? box.message : null}
      />
    {/if}
  </div>
  <div class="flyers" bind:this={flyLayer}></div>
  {#if undoId}
    <button class="undo" type="button" onclick={undo}>Undo</button>
  {/if}
  {#if problem}
    <p class="sr-only" id="box-problem">{problem}</p>
  {/if}
  <p class="sr-only" role="status">
    {#if box.name === 'error' && box.message}{box.message}{:else if box.name === 'busy' && box.progress}Applying
      {box.progress.done} of {box.progress.total}{/if}
  </p>
</main>

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

  .box-page {
    position: relative;
    overflow: hidden;
  }

  /* The handoff picture must be on screen at once: the editor's proxy
     (handoffProps) renders its final state and is revealed over the box
     within a few frames, so a still-running hover → idle transition would
     show two different boxes. */
  .handoff :global(*) {
    transition: none !important;
  }

  .hit {
    position: absolute;
    inset: 0;
    outline: none;
    cursor: default;
    touch-action: none;
  }
  /* Keyboard focus: a ring hugging the visual box, inside the margin. */
  .hit:focus-visible::after {
    content: '';
    position: absolute;
    inset: calc(var(--box-m) - 5px);
    border-radius: calc(var(--box-r) + 5px);
    box-shadow: 0 0 0 2px var(--focus-color);
    pointer-events: none;
  }

  .flyers {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .undo {
    position: absolute;
    left: 50%;
    bottom: 4px;
    transform: translateX(-50%);
    height: 24px;
    padding: 0 12px;
    border: 0;
    border-radius: 12px;
    background: rgb(var(--bg-rgb) / 0.86);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    box-shadow:
      0 0 0 1px var(--border-strong),
      0 3px 8px rgb(0 0 0 / 0.3);
    animation: undo-in var(--dur-spring) var(--ease-spring) both;
  }
  .undo:hover {
    background: rgb(var(--bg-rgb) / 0.96);
  }
  .undo:focus-visible {
    outline: 2px solid var(--focus-color);
    outline-offset: 2px;
  }

  @keyframes undo-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(6px) scale(0.9);
    }
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>

<!--
  The canvas stage: the engine's CanvasView on a DPR-correct canvas with
  zoom/pan (wheel at cursor, Space / middle-drag, Ctrl+0 / Ctrl+1 / Ctrl ±),
  coalesced pointer input with capture, the tool overlay, marching ants,
  keyline guides (K), before/after (hold \ or the split view), the inline
  text editor, image paste and a drop highlight. Redraws are coalesced to
  one per animation frame; the view state is shared through `stage`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import ImagePlus from '@lucide/svelte/icons/image-plus';
  import SquareDashed from '@lucide/svelte/icons/square-dashed';
  import {
    MASTER_SIZE,
    Viewport,
    fitAndCenter,
    modifiersOf,
    toPointerInput,
    toPointerInputs,
    type Surface,
  } from '$engine/index';
  import { CanvasView, decodeImage, type CanvasViewTheme } from '$engine/dom';
  import { ease } from '$lib/motion/easing';
  import { dur, motion } from '$lib/motion/speed.svelte';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../state/context';
  import { stage } from './stage.svelte';
  import {
    backingSize,
    clamp01,
    isFitted,
    mixView,
    physicalPointIn,
    splitFromStageX,
    textEditorBox,
    wheelZoom,
  } from './geometry';
  import { FocusOrigin, isInOverlay, isSpaceControl, isTypingTarget, stageKeyAction, type ElementLike } from './keys';

  const session = getSession();
  const engine = session.engine;

  let host: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let shadowEl: HTMLDivElement | undefined = $state();
  let overlayEl: HTMLDivElement | undefined = $state();

  const viewport = new Viewport({ viewWidth: 1, viewHeight: 1 });
  let view: CanvasView | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let themeKey = '';

  // Render loop state (plain fields: never reactive, never reallocated).
  let frame = 0;
  let cssH = 0;
  let dpr = 1;
  let originX = 0;
  let originY = 0;
  let cursor = '';
  let antsOffset = 0;
  const placed = { x: NaN, y: NaN, w: NaN, h: NaN };
  let sized = false;

  // Input state.
  let gestureButton = -1;
  let gesturePointer = -1;
  let middlePan = false;
  let handHeld = false;
  let compareHeld = false;
  let compareBefore: 'off' | 'split' = 'off';
  let pointerOver = false;
  let viewAnim = 0;
  /** How the focused element got focus (Space belongs to keyboard-focused buttons). */
  const focusOrigin = new FocusOrigin();

  /** Bumped on viewport changes, for the (rare) reactive overlays. */
  let viewTick = $state(0);
  let dropActive = $state(false);
  let dragging = $state(false);
  let textLayerId = $state<string | null>(null);

  // ---- rendering --------------------------------------------------------------

  function requestRender(): void {
    if (!frame) frame = requestAnimationFrame(render);
  }

  let fittedSource: Surface | null = null;
  let fittedOriginal: Surface | null = null;

  /** The original icon fitted like the design (the import fits it to the master). */
  function compareImage(): Surface | null {
    const original = session.original;
    if (!original) return null;
    if (fittedSource !== original) {
      fittedOriginal = fitAndCenter(original, { size: MASTER_SIZE, padding: 0 });
      fittedSource = original;
    }
    return fittedOriginal;
  }

  // Reused every frame: rendering allocates nothing of its own.
  const compareOpts: { image: Surface; split: number | null } = { image: null as unknown as Surface, split: null };
  const renderOpts: {
    dpr: number;
    showGrid: boolean;
    showKeylines: boolean;
    compare: typeof compareOpts | null;
    antsOffset: number;
  } = { dpr: 1, showGrid: true, showKeylines: false, compare: null, antsOffset: 0 };

  function render(): void {
    frame = 0;
    if (!ctx || !view || !canvas || !sized) return;
    const mode = session.compare;
    const image = mode === 'off' ? null : compareImage();
    if (image) {
      compareOpts.image = image;
      compareOpts.split = mode === 'hold' ? null : stage.split;
    }
    renderOpts.dpr = dpr;
    renderOpts.showGrid = stage.grid;
    renderOpts.showKeylines = stage.keylines;
    renderOpts.compare = image ? compareOpts : null;
    renderOpts.antsOffset = antsOffset;
    view.render(ctx, viewport, renderOpts);
    const css = engine.cursor.css;
    if (css !== cursor) {
      canvas.style.cursor = css;
      cursor = css;
    }
    placeFrames();
  }

  /** Keeps the document frames (shadow behind, overlays in front) on the document. */
  function placeFrames(): void {
    const s = viewport.scale;
    const x = viewport.panX;
    const y = viewport.panY;
    const w = engine.doc.width * s;
    const h = engine.doc.height * s;
    if (x === placed.x && y === placed.y && w === placed.w && h === placed.h) return;
    placed.x = x;
    placed.y = y;
    placed.w = w;
    placed.h = h;
    if (shadowEl) placeFrame(shadowEl);
    if (overlayEl) placeFrame(overlayEl);
  }

  function placeFrame(el: HTMLElement): void {
    el.style.transform = `translate(${placed.x}px, ${placed.y}px)`;
    el.style.width = `${placed.w}px`;
    el.style.height = `${placed.h}px`;
  }

  /** Canvas view colours from the theme tokens. */
  function readTheme(): Partial<CanvasViewTheme> {
    const cs = getComputedStyle(host ?? document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    const light = document.documentElement.dataset.theme === 'light';
    return {
      checkerLight: v('--checker-a', light ? '#ffffff' : '#2a2d35'),
      checkerDark: v('--checker-b', light ? '#e6e8ec' : '#1f2128'),
      checkerSize: 8,
      grid: light ? 'rgba(20, 22, 30, 0.16)' : 'rgba(255, 255, 255, 0.12)',
      keyline: 'rgba(31, 200, 227, 0.85)',
      divider: v('--accent', '#9a82ff'),
      handleFill: '#ffffff',
    };
  }

  function ensureView(): void {
    const theme = readTheme();
    const key = JSON.stringify(theme);
    if (view && key === themeKey) return;
    view?.dispose();
    themeKey = key;
    view = new CanvasView(engine, { theme, onInvalidate: requestRender });
    requestRender();
  }

  // ---- sizing -------------------------------------------------------------------

  function resize(w: number, h: number, device: { inlineSize: number; blockSize: number } | null): void {
    if (!canvas || w <= 0 || h <= 0) return;
    const wasFitted = !sized || stage.fitted;
    cssH = h;
    const b = backingSize(w, h, window.devicePixelRatio || 1, device);
    dpr = b.width / w;
    if (canvas.width !== b.width) canvas.width = b.width;
    if (canvas.height !== b.height) canvas.height = b.height;
    viewport.setViewSize(w, h);
    sized = true;
    if (wasFitted) viewport.fit();
    updateOrigin();
    // Resizing cleared the backing store: draw now, before this frame paints.
    cancelAnimationFrame(frame);
    render();
  }

  function updateOrigin(): void {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    originX = r.left;
    originY = r.top;
  }

  // ---- view actions (also exposed through `stage`) ---------------------------------

  function animateView(change: () => void, animate: boolean): void {
    cancelAnimationFrame(viewAnim);
    viewAnim = 0;
    const from = viewport.state;
    change();
    const to = viewport.state;
    const ms = animate ? dur(220) : 0;
    const same = from.zoom === to.zoom && from.panX === to.panX && from.panY === to.panY;
    if (ms <= 0 || same) return;
    viewport.restore(from);
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      viewport.restore(p >= 1 ? to : mixView(from, to, ease.standard(p)));
      viewAnim = p >= 1 ? 0 : requestAnimationFrame(step);
    };
    viewAnim = requestAnimationFrame(step);
  }

  const controller = {
    fit: (animate = true) => animateView(() => viewport.fit(), animate),
    actualSize: (animate = true) => animateView(() => viewport.actualSize(), animate),
    zoomStep: (direction: 1 | -1, animate = true) => animateView(() => viewport.zoomStep(direction), animate),
    setZoom: (zoom: number) => animateView(() => viewport.setZoom(zoom), false),
    docRect: (): DOMRect | null => {
      if (!canvas || !sized) return null;
      const r = canvas.getBoundingClientRect();
      const s = viewport.scale;
      return new DOMRect(r.left + viewport.panX, r.top + viewport.panY, engine.doc.width * s, engine.doc.height * s);
    },
    focus: () => canvas?.focus({ preventScroll: true }),
  };

  // ---- pointer input ----------------------------------------------------------------

  /**
   * Focuses an element for a pointer press whose default we cancelled. The
   * browser then treats it as script focus and, before any other click on
   * the page (the editor opens from a drop on the box), shows the keyboard
   * focus ring; `data-pointer-focus` hides it until the element blurs.
   */
  function focusForPointer(el: HTMLElement): void {
    if (el.dataset.pointerFocus === undefined) {
      el.dataset.pointerFocus = '';
      el.addEventListener('blur', () => delete el.dataset.pointerFocus, { once: true });
    }
    if (document.activeElement !== el) el.focus({ preventScroll: true });
  }

  /** Client px → document + stage coordinates (inline maths: one object per sample). */
  function mapPoint(clientX: number, clientY: number) {
    const sx = clientX - originX;
    const sy = clientY - originY;
    const s = viewport.scale;
    return { x: (sx - viewport.panX) / s, y: (sy - viewport.panY) / s, screenX: sx, screenY: sy };
  }

  function onPointerDown(e: PointerEvent): void {
    if (!canvas || !session.hasDesign || gestureButton !== -1) return;
    updateOrigin();
    if (engine.textEditLayerId) {
      // Click-away commits the text being edited (and does nothing else).
      engine.endTextEdit();
      e.preventDefault();
      return;
    }
    if (e.button === 1) {
      middlePan = true;
      engine.setToolOverride('hand');
      e.preventDefault();
    } else if (e.button !== 0 && e.button !== 2) {
      return;
    }
    // We focus the canvas ourselves; cancelling the default keeps the
    // browser from moving focus back to it after a tool opened an editor.
    e.preventDefault();
    focusForPointer(canvas);
    cancelAnimationFrame(viewAnim);
    gestureButton = e.button;
    gesturePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    engine.pointerDown(toPointerInput(e, mapPoint, e.button));
  }

  /** `PointerEvent.buttons` bit of a `PointerEvent.button` (left, middle, right, back, forward). */
  const BUTTON_BITS = [1, 4, 2, 8, 16];

  function gestureButtonHeld(e: PointerEvent): boolean {
    return (e.buttons & (BUTTON_BITS[gestureButton] ?? 0)) !== 0;
  }

  function onPointerMove(e: PointerEvent): void {
    if (gestureButton === -1) {
      if (!session.hasDesign) return;
      // The stage can move without resizing (the open morph, panels
      // appearing): hover maps against its current position. Layout is
      // clean at this point of the frame, so the read is cheap.
      updateOrigin();
      engine.pointerHover(toPointerInput(e, mapPoint, 0));
      return;
    }
    if (e.pointerId !== gesturePointer) return;
    if (e.pointerType === 'mouse' && !gestureButtonHeld(e)) {
      // The gesture's button was let go while another one stays down
      // (a chorded release reports a move, not a pointerup).
      onPointerUp(e);
      return;
    }
    engine.pointerMove(toPointerInputs(e, mapPoint, gestureButton));
  }

  function onPointerUp(e: PointerEvent): void {
    if (gestureButton === -1 || e.pointerId !== gesturePointer) return;
    // Another mouse button let go while the gesture's own is still held.
    if (e.pointerType === 'mouse' && gestureButtonHeld(e)) return;
    engine.pointerUp(toPointerInput(e, mapPoint, gestureButton));
    endGesture();
  }

  function onPointerCancel(e: PointerEvent): void {
    if (gestureButton === -1 || e.pointerId !== gesturePointer) return;
    engine.pointerCancel();
    endGesture();
  }

  function endGesture(): void {
    const id = gesturePointer;
    gestureButton = -1;
    gesturePointer = -1;
    if (canvas?.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (middlePan) {
      middlePan = false;
      engine.setToolOverride(handHeld ? 'hand' : null);
    }
  }

  function onPointerEnter(): void {
    pointerOver = true;
    updateOrigin();
  }

  function onPointerLeave(): void {
    pointerOver = false;
    if (gestureButton === -1) engine.pointerHover(null);
  }

  function onWheel(e: WheelEvent): void {
    if (!session.hasDesign || e.defaultPrevented) return;
    e.preventDefault();
    cancelAnimationFrame(viewAnim);
    updateOrigin();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cssH : 1;
    const horizontal = !e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY));
    if (horizontal) {
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      viewport.panBy(-dx * unit, e.shiftKey ? 0 : -e.deltaY * unit);
      return;
    }
    const z = wheelZoom(e.deltaY, e.deltaMode);
    if (!z) return;
    const ax = e.clientX - originX;
    const ay = e.clientY - originY;
    if (z.kind === 'step') viewport.zoomStep(z.direction, ax, ay);
    else viewport.zoomBy(z.factor, ax, ay);
  }

  // ---- keyboard -------------------------------------------------------------------

  function setHand(on: boolean): void {
    if (on === handHeld) return;
    handHeld = on;
    if (!middlePan) engine.setToolOverride(on ? 'hand' : null);
  }

  function setCompareHold(on: boolean): void {
    if (on === compareHeld) return;
    compareHeld = on;
    if (on) {
      compareBefore = session.compare === 'split' ? 'split' : 'off';
      session.compare = 'hold';
    } else if (session.compare === 'hold') {
      session.compare = compareBefore;
    }
  }

  function onKey(e: KeyboardEvent): void {
    const releasing = e.type === 'keyup';
    // Releases always go through, so a hold can never get stuck.
    if (!releasing && (e.defaultPrevented || !session.hasDesign)) return;
    const target = e.target as ElementLike | null;
    const active = document.activeElement;
    const canvasFocus = active === canvas || active === document.body || active === null;
    const action = stageKeyAction(
      {
        type: releasing ? 'keyup' : 'keydown',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
      },
      {
        typing: isTypingTarget(target),
        inOverlay: isInOverlay(target),
        canvasFocus,
        pointerOverStage: pointerOver,
        controlFocused: !canvasFocus && focusOrigin.keyboard && isSpaceControl(active),
        interacting: engine.isInteracting,
        toolBusy: engine.hasPending,
        handHeld,
        compareHeld,
        canCompare: session.original !== null,
      },
    );
    if (!action) return;
    switch (action.type) {
      case 'hand':
        setHand(action.on);
        break;
      case 'compare':
        setCompareHold(action.on);
        break;
      case 'fit':
        controller.fit();
        break;
      case 'actualSize':
        controller.actualSize();
        break;
      case 'zoom':
        controller.zoomStep(action.direction);
        break;
      case 'keylines':
        stage.toggleKeylines();
        break;
      case 'swapColors':
        engine.swapColors();
        break;
      case 'resetColors':
        engine.resetColors();
        break;
      case 'modifiers':
        engine.updateModifiers(modifiersOf(e));
        return; // never swallow modifier keys
      case 'tool':
        if (!engine.keyDown(action.key, modifiersOf(e))) return;
        break;
    }
    e.preventDefault();
  }

  /** Releases every hold when the window loses focus (no stuck Space / \). */
  function onBlur(): void {
    setHand(false);
    setCompareHold(false);
    focusOrigin.pointerup();
    if (gestureButton !== -1) {
      engine.pointerCancel();
      endGesture();
    }
  }

  // ---- inline text editing ------------------------------------------------------------

  const textBox = $derived.by(() => {
    void session.rev.layers;
    void session.rev.pixels;
    void viewTick;
    const id = textLayerId;
    if (!id) return null;
    const layer = engine.getLayer(id);
    if (!layer || layer.kind !== 'text') return null;
    const box = textEditorBox(layer, engine.textLayout(layer), {
      scale: viewport.scale,
      panX: viewport.panX,
      panY: viewport.panY,
    });
    return {
      ...box,
      family: `"${layer.fontFamily.replace(/["\\]/g, '')}", sans-serif`,
      weight: layer.weight,
      italic: layer.italic,
      align: layer.align,
    };
  });

  function textEditor(node: HTMLTextAreaElement) {
    const id = textLayerId;
    const layer = id ? engine.getLayer(id) : null;
    node.value = layer?.kind === 'text' ? layer.text : '';
    queueMicrotask(() => {
      node.focus({ preventScroll: true });
      node.setSelectionRange(node.value.length, node.value.length);
    });
  }

  function onTextInput(e: Event & { currentTarget: HTMLTextAreaElement }): void {
    const id = textLayerId;
    if (id) engine.updateText(id, { text: e.currentTarget.value });
  }

  function onTextKey(e: KeyboardEvent): void {
    // Enter / Escape during IME composition belong to the input method.
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
      // Shift+Enter makes a new line; Enter / Escape finish (the text is live already).
      e.preventDefault();
      e.stopPropagation();
      engine.endTextEdit();
      canvas?.focus({ preventScroll: true });
    }
  }

  /** Where a press does not end the text being edited: the editor itself,
   *  the type options (font, size, colour…) and their popovers / lists. */
  const TEXT_EDIT_KEEPERS = '.text-editor, [data-keeps-text-edit], [role="dialog"], [role="listbox"], [role="menu"]';

  // Click-away: a press anywhere else in the editor finishes the text. The
  // canvas handles its own presses (finish, and do nothing else).
  $effect(() => {
    if (!textLayerId) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!engine.textEditLayerId || !target || target === canvas) return;
      if (target.closest?.(TEXT_EDIT_KEEPERS)) return;
      engine.endTextEdit();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });

  // ---- before / after split -------------------------------------------------------------

  let splitDrag = -1;

  function splitFromClient(clientX: number): number {
    return splitFromStageX(clientX - originX, viewport, engine.doc.width);
  }

  function onSplitDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    updateOrigin();
    splitDrag = e.pointerId;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    focusForPointer(e.currentTarget as HTMLElement);
  }

  function onSplitMove(e: PointerEvent): void {
    if (e.pointerId !== splitDrag) return;
    stage.split = splitFromClient(e.clientX);
  }

  function onSplitUp(e: PointerEvent): void {
    if (e.pointerId !== splitDrag) return;
    splitDrag = -1;
  }

  function onSplitKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 0.1 : 0.02;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = stage.split - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = stage.split + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else if (e.key === 'PageUp') next = stage.split + 0.1;
    else if (e.key === 'PageDown') next = stage.split - 0.1;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    stage.split = clamp01(next);
  }

  // ---- paste & drop -----------------------------------------------------------------------

  function imageFile(list: DataTransfer | null): File | null {
    if (!list) return null;
    for (const item of list.items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) return f;
      }
    }
    for (const f of list.files) if (f.type.startsWith('image/')) return f;
    return null;
  }

  function importName(file: File, fallback: string): string {
    const stem = file.name.replace(/\.[^.]+$/, '').trim();
    return stem && !/^image$/i.test(stem) ? stem : fallback;
  }

  async function importFile(file: File, fallback: string): Promise<void> {
    const doc = engine.doc;
    try {
      const surface = await decodeImage(file);
      // The design changed while decoding (another queue item, closed): drop it.
      if (!session.hasDesign || engine.doc !== doc) return;
      if (session.importSurface(surface, importName(file, fallback))) stage.focusCanvas();
    } catch (error) {
      console.warn('image import failed', error);
      toast({ message: "Couldn't read that image.", kind: 'error' });
    }
  }

  function onPaste(e: ClipboardEvent): void {
    if (e.defaultPrevented || !session.hasDesign) return;
    const target = e.target as ElementLike | null;
    if (isTypingTarget(target) || isInOverlay(target)) return;
    const file = imageFile(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    void importFile(file, 'Pasted image');
  }

  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  function onDragOver(e: DragEvent): void {
    if (!hasFiles(e) || !session.hasDesign) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropActive = true;
  }

  function onDragLeave(e: DragEvent): void {
    if (!host?.contains(e.relatedTarget as Node | null)) dropActive = false;
  }

  function onDrop(e: DragEvent): void {
    dropActive = false;
    if (!hasFiles(e) || !session.hasDesign) return;
    e.preventDefault();
    const file = imageFile(e.dataTransfer);
    if (file) void importFile(file, 'Dropped image');
  }

  // ---- lifecycle ------------------------------------------------------------------------

  $effect(() => {
    // Reactive view options: redraw when any of them changes.
    void stage.grid;
    void stage.keylines;
    void stage.split;
    void session.compare;
    void session.original;
    void session.hasDesign;
    requestRender();
  });

  $effect(() => {
    void session.rev.textEdit;
    void session.rev.document;
    textLayerId = engine.textEditLayerId;
  });

  $effect(() => {
    // Marching ants move only while a selection exists (static when reduced).
    void session.rev.selection;
    void session.rev.document;
    const active = engine.doc.selection !== null && !motion.reduced;
    if (!active) {
      antsOffset = 0;
      requestRender();
      return;
    }
    const timer = setInterval(() => {
      if (document.hidden) return;
      antsOffset = (antsOffset + 1) % 8;
      requestRender();
    }, 70);
    return () => clearInterval(timer);
  });

  onMount(() => {
    const el = canvas!;
    const stageHost = host!;
    ctx = el.getContext('2d', { alpha: true });
    engine.attachViewport(viewport);
    ensureView();

    const unsubscribeView = viewport.subscribe((s) => {
      stage.zoom = s.zoom;
      stage.fitted = isFitted(viewport);
      viewTick++;
      requestRender();
    });
    stage.zoom = viewport.zoom;
    const detach = stage.attach(controller);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.contentBoxSize?.[0];
        const device = entry.devicePixelContentBoxSize?.[0] ?? null;
        resize(box?.inlineSize ?? entry.contentRect.width, box?.blockSize ?? entry.contentRect.height, device);
      }
    });
    try {
      ro.observe(el, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(el);
    }

    // Theme / accent / compat changes re-colour the checkerboard and guides.
    const themeObserver = new MutationObserver(() => ensureView());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-compat', 'style'],
    });

    const opts = { passive: false } as const;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerCancel);
    el.addEventListener('lostpointercapture', onPointerCancel);
    el.addEventListener('pointerenter', onPointerEnter);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('contextmenu', preventDefault);
    stageHost.addEventListener('wheel', onWheel, opts);
    stageHost.addEventListener('dragover', onDragOver);
    stageHost.addEventListener('dragleave', onDragLeave);
    stageHost.addEventListener('drop', onDrop);
    window.addEventListener('keydown', trackKey, true);
    window.addEventListener('pointerdown', trackPress, true);
    window.addEventListener('pointerup', trackRelease, true);
    window.addEventListener('pointercancel', trackRelease, true);
    window.addEventListener('focusin', trackFocus, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    window.addEventListener('paste', onPaste);
    window.addEventListener('scroll', updateOrigin);

    // Files dragged over the window from Explorer arrive as Tauri events;
    // the App decides what a drop does, the stage only lights up.
    let unlistenDrop: (() => void) | null = null;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === 'leave' || payload.type === 'drop') {
          dragging = false;
          dropActive = false;
          return;
        }
        dragging = true;
        const r = stageHost.getBoundingClientRect();
        dropActive = session.hasDesign && physicalPointIn(payload.position, window.devicePixelRatio || 1, r);
      })
      .then((u) => (disposed ? u() : (unlistenDrop = u)))
      .catch((error: unknown) => console.warn('drag-drop events unavailable', error));

    return () => {
      disposed = true;
      unlistenDrop?.();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(viewAnim);
      frame = 0;
      ro.disconnect();
      themeObserver.disconnect();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('lostpointercapture', onPointerCancel);
      el.removeEventListener('pointerenter', onPointerEnter);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('contextmenu', preventDefault);
      stageHost.removeEventListener('wheel', onWheel);
      stageHost.removeEventListener('dragover', onDragOver);
      stageHost.removeEventListener('dragleave', onDragLeave);
      stageHost.removeEventListener('drop', onDrop);
      window.removeEventListener('keydown', trackKey, true);
      window.removeEventListener('pointerdown', trackPress, true);
      window.removeEventListener('pointerup', trackRelease, true);
      window.removeEventListener('pointercancel', trackRelease, true);
      window.removeEventListener('focusin', trackFocus, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('scroll', updateOrigin);
      if (handHeld || middlePan) engine.setToolOverride(null);
      if (compareHeld && session.compare === 'hold') session.compare = compareBefore;
      if (gestureButton !== -1) engine.pointerCancel();
      unsubscribeView();
      detach();
      if (engine.viewport === viewport) engine.attachViewport(null);
      view?.dispose();
      view = null;
      ctx = null;
    };
  });

  function preventDefault(e: Event): void {
    e.preventDefault();
  }

  const trackKey = (e: KeyboardEvent) => focusOrigin.keydown(e.key, e.timeStamp);
  const trackPress = () => focusOrigin.pointerdown();
  const trackRelease = () => focusOrigin.pointerup();
  const trackFocus = (e: FocusEvent) => focusOrigin.focusin(e.timeStamp);

  const splitPct = $derived(Math.round(stage.split * 100));
</script>

<div
  class="stage"
  class:drop={dropActive}
  class:dragging
  class:empty={!session.hasDesign}
  bind:this={host}
  data-testid="canvas-stage"
>
  <div class="doc-shadow" bind:this={shadowEl} aria-hidden="true"></div>
  <canvas
    bind:this={canvas}
    class="canvas"
    tabindex={session.hasDesign ? 0 : -1}
    aria-label="Icon canvas. Draw with the active tool; hold Space to pan, scroll to zoom."
    data-testid="canvas"
  ></canvas>

  <div class="doc-overlay" bind:this={overlayEl}>
    {#if session.compare === 'split' && session.original}
      <span class="tag before" aria-hidden="true">Before</span>
      <span class="tag after" aria-hidden="true">After</span>
      <div
        class="split"
        style:left="{stage.split * 100}%"
        role="slider"
        tabindex="0"
        aria-label="Before and after divider"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={splitPct}
        aria-valuetext="{splitPct}% before"
        data-testid="compare-split"
        onpointerdown={onSplitDown}
        onpointermove={onSplitMove}
        onpointerup={onSplitUp}
        onpointercancel={onSplitUp}
        onkeydown={onSplitKey}
      >
        <span class="grip" aria-hidden="true"></span>
      </div>
    {:else if session.compare === 'hold'}
      <span class="tag before solo" aria-hidden="true">Before</span>
    {/if}
  </div>

  {#if textBox}
    {#key textLayerId}
      <textarea
        class="text-editor"
        aria-label="Text"
        spellcheck="false"
        autocomplete="off"
        wrap="off"
        data-testid="text-editor"
        style:left="{textBox.left}px"
        style:top="{textBox.top}px"
        style:width="{textBox.width}px"
        style:height="{textBox.height}px"
        style:font-family={textBox.family}
        style:font-size="{textBox.fontSize}px"
        style:line-height="{textBox.lineHeight}px"
        style:font-weight={textBox.weight}
        style:font-style={textBox.italic ? 'italic' : 'normal'}
        style:text-align={textBox.align}
        style:transform="rotate({textBox.rotation}deg)"
        style:transform-origin="{textBox.originX}px 0"
        oninput={onTextInput}
        onkeydown={onTextKey}
        {@attach textEditor}
      ></textarea>
    {/key}
  {/if}

  {#if dropActive}
    <div class="drop-hint" aria-hidden="true">
      <ImagePlus size={16} strokeWidth={1.75} />
      <span>Drop to import</span>
    </div>
  {/if}

  {#if !session.hasDesign}
    <div class="empty-state">
      <EmptyState
        icon={SquareDashed}
        title="Nothing to edit"
        description="Drop a shortcut on the box to restyle its icon, or start from a blank canvas."
      >
        <Button variant="secondary" onclick={() => session.newBlank()}>New blank icon</Button>
      </EmptyState>
    </div>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    /* clip, not hidden: a hidden box can still be scrolled (the text editor's
       caret near an edge would shift the whole canvas out of place). */
    overflow: clip;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background:
      radial-gradient(120% 90% at 50% 40%, rgb(var(--text-rgb) / 0.025), transparent 70%),
      var(--surface-sunken);
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 0.18);
    contain: strict;
    isolation: isolate;
  }

  .canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    outline: none;
    user-select: none;
  }
  .canvas:focus-visible:not([data-pointer-focus]) {
    box-shadow: var(--focus-ring-inset);
  }
  .empty .canvas {
    visibility: hidden;
  }

  .doc-shadow,
  .doc-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    transform-origin: 0 0;
    pointer-events: none;
  }
  .doc-shadow {
    border-radius: 2px;
    box-shadow:
      0 0 0 1px rgb(var(--text-rgb) / 0.06),
      0 12px 36px rgb(0 0 0 / 0.34),
      0 2px 8px rgb(0 0 0 / 0.22);
  }
  :global([data-theme='light']) .doc-shadow {
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.06),
      0 12px 32px rgb(16 18 24 / 0.14),
      0 2px 6px rgb(16 18 24 / 0.08);
  }
  .empty .doc-shadow,
  .empty .doc-overlay {
    display: none;
  }

  .tag {
    position: absolute;
    top: 10px;
    padding: 3px 8px;
    border-radius: var(--radius-full);
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.02em;
    backdrop-filter: blur(6px);
  }
  .tag.before {
    left: 10px;
  }
  .tag.after {
    right: 10px;
  }

  .split {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 24px;
    margin-left: -12px;
    display: grid;
    place-items: center;
    cursor: ew-resize;
    pointer-events: auto;
    touch-action: none;
    outline: none;
  }
  .grip {
    width: 18px;
    height: 34px;
    border: 2px solid #fff;
    border-radius: var(--radius-full);
    background: var(--accent);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.4);
    transition: transform var(--dur-1) var(--ease-standard);
  }
  .split:hover .grip,
  .split:active .grip {
    transform: scale(1.08);
  }
  .split:focus-visible:not([data-pointer-focus]) .grip {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }

  .text-editor {
    position: absolute;
    z-index: 2;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: transparent;
    caret-color: var(--accent);
    outline: none;
    overflow: hidden;
    resize: none;
    white-space: pre;
    font-kerning: normal;
  }
  .text-editor::selection {
    background: rgb(var(--accent-rgb) / 0.32);
  }

  .stage.dragging {
    border-color: rgb(var(--accent-rgb) / 0.35);
  }
  .stage.drop {
    border-color: var(--accent-border);
    box-shadow:
      inset 0 0 0 2px rgb(var(--accent-rgb) / 0.55),
      inset 0 0 48px rgb(var(--accent-rgb) / 0.14);
  }
  .stage {
    transition:
      border-color var(--fade-2) linear,
      box-shadow var(--fade-2) linear;
  }
  .drop-hint {
    position: absolute;
    left: 50%;
    bottom: 16px;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    padding: 6px 12px;
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-full);
    background: var(--surface-overlay);
    color: var(--accent-text);
    box-shadow: var(--shadow-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    translate: -50% 0;
    pointer-events: none;
    transition:
      opacity var(--fade-2) linear,
      translate var(--dur-2) var(--ease-decelerate);
  }
  @starting-style {
    .drop-hint {
      opacity: 0;
      translate: -50% 6px;
    }
  }

  .empty-state {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }
</style>

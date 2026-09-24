<!--
  Panels harness: a minimal editor frame (canvas stage + Sidebar) around
  the real EditorSession and engine, for developing and e2e-testing the
  sidebar without the rest of the editor shell. Opens the item named by
  `?item=` (a fake-backend path; default a shortcut) or `?blank`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { boot } from '$lib/boot';
  import { commands } from '$lib/ipc/commands';
  import ToastHost from '$lib/ui/ToastHost.svelte';
  import { CanvasView } from '$engine/dom';
  import { Viewport, toPointerInputs } from '$engine/index';
  import { createSession, setSession } from '../../state/context';
  import Sidebar from '../Sidebar.svelte';

  const session = setSession(createSession());
  const engine = session.engine;

  let ready = $state(false);
  let stage: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();

  onMount(() => {
    let disposed = false;
    const viewport = new Viewport({ viewWidth: 400, viewHeight: 400 });
    engine.attachViewport(viewport);
    let frame = 0;
    const render = () => {
      frame = 0;
      const ctx = canvas?.getContext('2d');
      if (!ctx || !canvas) return;
      view.render(ctx, viewport, { dpr: devicePixelRatio || 1, showKeylines: false });
      canvas.style.cursor = engine.cursor.css;
    };
    const requestRender = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    const view = new CanvasView(engine, { onInvalidate: requestRender });
    const unsubscribe = viewport.subscribe(requestRender);
    const resize = () => {
      if (!stage || !canvas) return;
      const r = stage.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      viewport.setViewSize(r.width, r.height);
      viewport.fit();
      requestRender();
    };
    const ro = new ResizeObserver(resize);
    if (stage) ro.observe(stage);

    void (async () => {
      await boot();
      const params = new URLSearchParams(location.search);
      if (params.has('blank')) {
        session.newBlank();
      } else {
        const path = params.get('item') ?? 'C:\\Users\\e2e\\Desktop\\Steam.lnk';
        const items = await commands.inspectPaths([path]);
        await session.openItems(items);
      }
      if (disposed) return;
      session.view = 'edit';
      resize();
      ready = true;
    })();

    return () => {
      disposed = true;
      ro.disconnect();
      unsubscribe();
      view.dispose();
      cancelAnimationFrame(frame);
    };
  });

  // The editor shell's undo/redo shortcuts (the harness stands in for it).
  function onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      engine.undo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      engine.redo();
    }
  }

  // Pointer input → engine (document coordinates).
  let button = 0;
  function toDoc(cx: number, cy: number) {
    const r = canvas!.getBoundingClientRect();
    const sx = cx - r.left;
    const sy = cy - r.top;
    const d = engine.viewport!.screenToDoc(sx, sy);
    return { x: d.x, y: d.y, screenX: sx, screenY: sy };
  }
</script>

<svelte:window onkeydown={onKey} />

<main class="harness" data-ready={ready}>
  <div class="frame">
    <div class="stage" bind:this={stage}>
      <canvas
        bind:this={canvas}
        data-testid="stage"
        onpointerdown={(e) => {
          canvas?.setPointerCapture(e.pointerId);
          button = e.button;
          engine.pointerDown(toPointerInputs(e, toDoc, button).at(-1)!);
        }}
        onpointermove={(e) => engine.pointerMove(toPointerInputs(e, toDoc, button))}
        onpointerup={(e) => engine.pointerUp(toPointerInputs(e, toDoc, button).at(-1)!)}
        onpointercancel={() => engine.pointerCancel()}
      ></canvas>
    </div>
    <Sidebar />
  </div>
  <ToastHost />
</main>

<style>
  :global(html, body) {
    height: 100%;
    margin: 0;
    background: var(--bg);
  }
  :global(#app) {
    height: 100%;
  }
  .harness {
    display: grid;
    height: 100%;
    padding: 12px;
    box-sizing: border-box;
  }
  .frame {
    display: flex;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    box-shadow: var(--glass-shadow);
  }
  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
    background: var(--surface-sunken);
  }
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    touch-action: none;
  }
</style>

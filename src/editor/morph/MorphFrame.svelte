<!--
  MorphFrame — the editor window's picture: the box proxy (the same
  BoxVisual the box renders, with the same props, at the box's place) and the
  panel (inset 12 px for its own shadow) that the proxy morphs into.

  App drives it through the exported functions (MorphController's surface):
    showProxy(rect, props)  draw the proxy, wait for its icon to decode
    expand(morph, landing)  proxy → panel (FLIP morph or crossfade); the
                            icon flies onto `landing` (the document on the
                            canvas, window CSS px) when there is one
    collapse(rect, props, morph)  panel → proxy (or fade out)
    clear()                 paint nothing
  Between animations the frame rests in one of the modes: hidden, proxy,
  open. `data-mode` / `data-transition` on `[data-testid="morph-frame"]`
  expose them to tests.
-->
<script module lang="ts">
  export type FrameMode = 'hidden' | 'proxy' | 'animating' | 'open';
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import type { Rect } from '$lib/ipc/types';
  import BoxVisual from '$lib/ui/BoxVisual.svelte';
  import { iconRect, visualRect, visualRadius, type BoxVisualProps } from '$lib/ui/box-geometry';
  import {
    cancelOn,
    iconTarget,
    playCollapse,
    playExpand,
    settled,
    staggerTargets,
    type MorphGeometry,
  } from './choreography';

  interface Props {
    /** Compatibility (opaque) mode: the panel fills the window. */
    compat?: boolean;
    /** Panel content (title bar + views). */
    children: Snippet;
    /**
     * Every mode change, including 'animating' when a morph or fade starts
     * (the shell stops being interactive right away, e.g. as a close begins).
     */
    onmode?: (mode: FrameMode) => void;
  }

  let { compat = false, children, onmode }: Props = $props();

  /** Panel radius (UI.md) and its margin for the shadow. */
  const PANEL_RADIUS = 16;
  const PANEL_INSET = 12;

  let mode = $state<FrameMode>('hidden');
  let transition = $state<'morph' | 'crossfade' | null>(null);
  let proxy = $state.raw<{ rect: Rect; props: BoxVisualProps } | null>(null);
  let flyer = $state.raw<{ src: string; rect: Rect } | null>(null);

  let proxyEl: HTMLDivElement | undefined = $state();
  let panelEl: HTMLDivElement | undefined = $state();
  let shellEl: HTMLDivElement | undefined = $state();
  let contentEl: HTMLDivElement | undefined = $state();
  let flyerEl: HTMLImageElement | undefined = $state();

  /** Bumped by every call so a superseded animation doesn't settle the frame. */
  let run = 0;

  const inset = $derived(compat ? 0 : PANEL_INSET);
  const radius = $derived(compat ? 8 : PANEL_RADIUS);

  /** Top-left of the BoxVisual root inside the proxy rect (centred). */
  function origin(p: { rect: Rect; props: BoxVisualProps }) {
    const m = p.props.metrics;
    return { x: p.rect.x + (p.rect.w - m.window) / 2, y: p.rect.y + (p.rect.h - m.window) / 2 };
  }

  function setMode(next: FrameMode): void {
    if (mode === next) return;
    mode = next;
    onmode?.(next);
  }

  function geometry(): MorphGeometry | null {
    if (!proxy || !panelEl) return null;
    const r = panelEl.getBoundingClientRect();
    const m = proxy.props.metrics;
    return {
      box: visualRect(m, origin(proxy), proxy.props.state),
      boxRadius: visualRadius(m, proxy.props.state),
      panel: { x: r.left, y: r.top, w: r.width, h: r.height },
      panelRadius: radius,
    };
  }

  function viewEl(): HTMLElement | null {
    return contentEl?.querySelector<HTMLElement>('[data-view-host]') ?? null;
  }

  async function decoded(): Promise<void> {
    const img = proxyEl?.querySelector('img');
    if (!img) return;
    try {
      await img.decode();
    } catch {
      // A broken image still paints (as nothing); don't hold the handoff.
    }
  }

  function stopAll(): void {
    cancelOn([proxyEl, shellEl, contentEl, flyerEl, ...(contentEl ? staggerTargets(contentEl, viewEl()) : [])]);
  }

  /** Draws the box proxy (panel hidden) and waits until its icon is decoded. */
  export async function showProxy(rect: Rect, props: BoxVisualProps): Promise<void> {
    run++;
    stopAll();
    flyer = null;
    transition = null;
    proxy = { rect, props };
    setMode('proxy');
    await tick();
    await decoded();
  }

  /** Proxy → panel; the box's icon settles onto `landing` (see iconTarget). */
  export async function expand(morph: boolean, landing: Rect | null = null): Promise<void> {
    const my = ++run;
    stopAll();
    const g = geometry();
    const useMorph = morph && g !== null;
    transition = useMorph ? 'morph' : 'crossfade';
    // Icon that settles onto the canvas (only when the box carried one).
    if (useMorph && proxy?.props.icon && contentEl) {
      flyer = { src: proxy.props.icon, rect: iconTarget(landing, viewEl() ?? contentEl, 48) };
    }
    setMode('animating');
    await tick();
    if (my !== run || !shellEl || !contentEl) return;
    const from = proxy ? iconRect(proxy.props.metrics, origin(proxy), proxy.props.state) : null;
    const animations = playExpand(
      {
        proxy: proxy ? (proxyEl ?? null) : null,
        shell: shellEl,
        content: contentEl,
        regions: useMorph ? staggerTargets(contentEl, viewEl()) : [],
        flyer: flyer && flyerEl && from ? { el: flyerEl, from, to: flyer.rect } : null,
      },
      g ?? fallbackGeometry(),
      useMorph,
    );
    await settled(animations);
    if (my !== run) return;
    proxy = null;
    flyer = null;
    transition = null;
    setMode('open');
    await tick();
    stopAll();
    // Keyboard focus lands in the panel (Rust focuses the window next).
    if (document.activeElement === document.body || !contentEl?.contains(document.activeElement)) {
      contentEl?.focus({ preventScroll: true });
    }
  }

  /**
   * Panel → proxy at `rect` showing `props` (null: fade out with no proxy,
   * e.g. when the box stays hidden).
   */
  export async function collapse(rect: Rect, props: BoxVisualProps | null, morph: boolean): Promise<void> {
    const my = ++run;
    stopAll();
    flyer = null;
    proxy = props ? { rect, props } : null;
    const wasOpen = mode === 'open' || mode === 'animating';
    const g = geometry();
    const useMorph = morph && wasOpen && g !== null;
    transition = useMorph ? 'morph' : 'crossfade';
    setMode('animating');
    await tick();
    if (my !== run || !shellEl || !contentEl) return;
    if (wasOpen) {
      const animations = playCollapse(
        { proxy: proxy ? (proxyEl ?? null) : null, shell: shellEl, content: contentEl, regions: [] },
        g ?? fallbackGeometry(),
        useMorph,
      );
      await settled(animations);
      if (my !== run) return;
    }
    transition = null;
    setMode(proxy ? 'proxy' : 'hidden');
    await tick();
    stopAll();
  }

  /** Paints nothing (the window may hide now). */
  export function clear(): void {
    run++;
    stopAll();
    proxy = null;
    flyer = null;
    transition = null;
    setMode('hidden');
  }

  function fallbackGeometry(): MorphGeometry {
    const r = panelEl?.getBoundingClientRect();
    const panel = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 1, h: 1 };
    return { box: panel, boxRadius: radius, panel, panelRadius: radius };
  }
</script>

<div
  class="frame"
  class:compat
  data-testid="morph-frame"
  data-mode={mode}
  data-transition={transition}
  style:--inset="{inset}px"
  style:--panel-radius="{radius}px"
>
  <div class="panel" data-testid="editor-panel" bind:this={panelEl} inert={mode !== 'open'} aria-hidden={mode === 'hidden' || mode === 'proxy'}>
    <div class="shell" bind:this={shellEl}></div>
    <div class="content" bind:this={contentEl} tabindex="-1">
      {@render children()}
    </div>
  </div>

  {#if proxy}
    {@const o = origin(proxy)}
    <div
      class="proxy"
      class:handed-over={flyer !== null}
      bind:this={proxyEl}
      data-testid="box-proxy"
      style:left="{o.x}px"
      style:top="{o.y}px"
      style:width="{proxy.props.metrics.window}px"
      style:height="{proxy.props.metrics.window}px"
    >
      <BoxVisual {...proxy.props} />
    </div>
  {/if}

  {#if flyer}
    <img
      class="flyer"
      bind:this={flyerEl}
      src={flyer.src}
      alt=""
      draggable="false"
      style:left="{flyer.rect.x}px"
      style:top="{flyer.rect.y}px"
      style:width="{flyer.rect.w}px"
      style:height="{flyer.rect.h}px"
    />
  {/if}
</div>

<style>
  .frame {
    position: fixed;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .frame[data-mode='hidden'] {
    visibility: hidden;
  }

  .panel {
    position: absolute;
    inset: var(--inset);
    border-radius: var(--panel-radius);
    pointer-events: auto;
  }
  .frame[data-mode='hidden'] .panel,
  .frame[data-mode='proxy'] .panel {
    visibility: hidden;
  }

  /* The panel's material: layered translucency (no backdrop blur — the
     window is transparent, there is nothing to blur), hairline border,
     a tight shadow that fits the 12 px margin. */
  .shell {
    position: absolute;
    inset: 0;
    border-radius: var(--panel-radius);
    background: var(--glass-tint), var(--glass-fill-strong);
    box-shadow:
      0 0 0 1px var(--glass-border),
      var(--glass-highlight),
      0 6px 12px -4px rgb(0 0 0 / 0.38),
      0 2px 5px -1px rgb(0 0 0 / 0.24);
    transform-origin: 0 0;
    will-change: transform;
  }
  :global([data-theme='light']) .shell {
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.08),
      var(--glass-highlight),
      0 6px 12px -4px rgb(20 24 40 / 0.2),
      0 2px 5px -1px rgb(20 24 40 / 0.12);
  }
  .compat .shell {
    box-shadow: none;
    background: var(--glass-fill-strong);
  }

  .content {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: var(--panel-radius);
    outline: none;
  }

  .proxy {
    position: absolute;
    display: grid;
    place-items: center;
    transform-origin: 50% 50%;
  }

  /* The flying clone carries the icon from here on. */
  .handed-over :global(img.icon) {
    visibility: hidden;
  }

  .flyer {
    position: absolute;
    object-fit: contain;
    transform-origin: 0 0;
    filter: drop-shadow(0 6px 10px rgb(0 0 0 / 0.3));
    -webkit-user-drag: none;
  }
</style>

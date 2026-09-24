<!--
  Previews (always visible at the bottom of the sidebar, collapsible):
  every export size rendered through the real export path (the engine's
  renderSizes, in the panels worker) ~250 ms after the design changes,
  drawn 1:1 in device pixels; the icon on the user's desktop; and on light
  and dark taskbars.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { Pixels } from '$engine/filters/types';
  import { settings } from '$lib/settings/store.svelte';
  import { getSession } from '../../state/context';
  import { putPixels, snapToDevicePixels, watchDpr } from '../common/canvas';
  import { debounce } from '../common/schedule';
  import { isCancelled } from '../worker/client';
  import { snapshotDoc, snapshotTransfer } from '../worker/snapshot';
  import DesktopPreview from './DesktopPreview.svelte';
  import TaskbarPreview from './TaskbarPreview.svelte';

  const session = getSession();
  const engine = session.engine;
  const STORE_KEY = 'reskin.previews.open';

  function initialOpen(): boolean {
    try {
      return localStorage.getItem(STORE_KEY) !== 'false';
    } catch {
      return true;
    }
  }

  let open = $state(initialOpen());
  let rendered = $state.raw<Map<number, Pixels>>(new Map());
  let rendering = $state(false);
  let failed = $state<string | null>(null);
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);

  const sizes = $derived(settings().icoSizes);
  const label = $derived(session.item?.name ?? (engine.doc.meta.name || 'Untitled'));

  function toggle(): void {
    open = !open;
    try {
      localStorage.setItem(STORE_KEY, String(open));
    } catch {
      // Storage unavailable: the choice lasts for this session.
    }
  }

  async function render(): Promise<void> {
    if (!open) return;
    const snap = snapshotDoc(engine.doc);
    const list = [...sizes];
    rendering = true;
    try {
      const out = await session.panels.request({ op: 'renderSizes', doc: snap, sizes: list }, { channel: 'previews', transfer: snapshotTransfer(snap), priority: 'low' });
      rendered = new Map(out.map((r) => [r.size, r.pixels]));
      failed = null;
      rendering = false;
    } catch (e) {
      if (isCancelled(e)) return;
      failed = e instanceof Error ? e.message : String(e);
      rendering = false;
    }
  }

  const schedule = debounce(() => void render(), 250);

  // Edits re-render ~250 ms after they settle; a different design (another
  // item, a loaded project) renders at once instead of showing the old one.
  let renderedDoc = -1;
  $effect(() => {
    void session.rev.pixels;
    void session.rev.layers;
    const doc = session.rev.document;
    void sizes;
    if (!open) return;
    untrack(() => {
      if (rendered.size === 0 || doc !== renderedDoc) {
        renderedDoc = doc;
        schedule.cancel();
        void render();
      } else {
        schedule();
      }
    });
  });

  onMount(() => {
    const stop = watchDpr((d) => (dpr = d));
    return () => {
      stop();
      schedule.cancel();
      session.panels.cancel('previews');
    };
  });

  /** Draws one size 1:1: backing store = size device px, CSS size = size / dpr. */
  function sizeCanvas(size: number) {
    return (node: HTMLCanvasElement) => {
      const px = rendered.get(size);
      node.style.width = `${size / dpr}px`;
      node.style.height = `${size / dpr}px`;
      if (px) putPixels(node, px);
    };
  }
</script>

<section class="previews" class:open data-testid="previews" aria-busy={rendering}>
  <header>
    <button type="button" class="toggle" aria-expanded={open} aria-controls="previews-body" onclick={toggle}>
      <span class="chev" aria-hidden="true"><ChevronRight size={14} /></span>
      <h3>Previews</h3>
    </button>
    {#if open}<span class="status" aria-live="polite">{failed ? 'Preview failed' : rendering ? 'Updating…' : `${sizes.length} sizes`}</span>{/if}
  </header>
  {#if open}
    <div class="body" id="previews-body">
      <ul class="sizes" aria-label="Icon sizes, actual pixels">
        {#each sizes as size (size)}
          <li class="size" data-size={size} class:ready={rendered.has(size)}>
            <span class="slot" role="img" aria-label="{size} × {size} px" style:width="{Math.max(16, size / dpr)}px" style:height="{size / dpr}px">
              <canvas
                width={size}
                height={size}
                aria-hidden="true"
                data-testid="preview-size"
                data-size={size}
                {@attach sizeCanvas(size)}
                {@attach snapToDevicePixels()}
              ></canvas>
            </span>
            <span class="px">{size}</span>
          </li>
        {/each}
      </ul>
      {#if failed}<p class="note" role="alert">Could not render the previews: {failed}</p>{/if}
      <h4>On your desktop</h4>
      <DesktopPreview {rendered} {label} />
      <h4>Taskbar</h4>
      <div class="taskbars">
        <TaskbarPreview {rendered} theme="light" {label} />
        <TaskbarPreview {rendered} theme="dark" {label} />
      </div>
    </div>
  {/if}
</section>

<style>
  .previews {
    display: flex;
    flex: none;
    flex-direction: column;
    max-height: 36%;
    min-height: 0;
    border-top: 1px solid var(--divider);
    background: var(--surface-1);
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
  }
  .toggle {
    display: inline-flex;
    flex: 1;
    align-items: center;
    gap: var(--space-1);
    margin-left: calc(-1 * var(--space-1));
    padding: 2px var(--space-1);
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-2);
    text-align: left;
    cursor: default;
  }
  .toggle:hover {
    color: var(--text);
  }
  .toggle:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 0;
  }
  .chev {
    display: inline-flex;
    transition: transform var(--dur-2) var(--ease-standard);
  }
  .open .chev {
    transform: rotate(90deg);
  }
  h3 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .status {
    color: var(--text-3);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-height: 0;
    padding: 0 var(--space-3) var(--space-3);
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .sizes {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--space-2) var(--space-3);
    margin: 0;
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 10px 10px;
    list-style: none;
  }
  .size {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
  .slot {
    display: grid;
    place-items: end center;
  }
  canvas {
    display: block;
    image-rendering: pixelated;
    opacity: 0;
    transition: opacity var(--fade-2) linear;
  }
  .ready canvas {
    opacity: 1;
  }
  .px {
    padding: 0 4px;
    border-radius: var(--radius-full);
    background: var(--surface-1);
    color: var(--text-2);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
  }
  h4 {
    margin: var(--space-2) 0 0;
    color: var(--text-3);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .taskbars {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .note {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-xs);
  }
</style>

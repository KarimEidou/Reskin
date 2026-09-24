<!--
  "On your desktop": a crop of the user's real wallpaper (laid out with its
  Windows fit mode) with the icon at the desktop icon size and its label in
  Windows style (white text with a shadow), between two neutral placeholder
  icons. Pixel-exact: the canvas backing store is in device pixels. The
  wallpaper is read once the editor is open and decoded off the main
  thread, and the canvas (a composited layer) exists from then on
  (docs/ARCHITECTURE.md, "Performance").
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import type { WallpaperInfo } from '$lib/ipc/types';
  import { getSession } from '../../state/context';
  import { snapToDevicePixels, watchDpr } from '../common/canvas';
  import { desktopLabel, vignetteOrigin, wallpaperLayout } from './desktop';
  import { drawIcon, type Rendered } from './draw';

  interface Props {
    rendered: Rendered;
    /** The label under the icon. */
    label: string;
  }

  let { rendered, label }: Props = $props();

  const session = getSession();
  const HEIGHT = 124; // CSS px
  let info = $state.raw<WallpaperInfo | null>(null);
  let image = $state.raw<ImageBitmap | null>(null);
  let problem = $state<string | null>(null);
  let width = $state(260);
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  let canvas: HTMLCanvasElement | undefined = $state();
  let host: HTMLDivElement | undefined = $state();
  /** The wallpaper was read (or could not be): the preview is drawn from then on. */
  let ready = $state(false);

  /** Reads the wallpaper's settings and image (`alive`: the preview is still mounted). */
  async function readWallpaper(alive: () => boolean): Promise<void> {
    try {
      info = await commands.wallpaperInfo();
    } catch (e) {
      problem = `Wallpaper settings unavailable (${e instanceof Error ? e.message : String(e)}).`;
    }
    if (!alive() || (info && !info.hasImage)) return;
    try {
      const bytes = await commands.wallpaper();
      if (!alive()) return;
      // Decoded once, off the main thread; drawing it never decodes again.
      const bitmap = await createImageBitmap(new Blob([bytes]));
      if (!alive()) {
        bitmap.close();
        return;
      }
      image = bitmap;
    } catch {
      // No readable wallpaper: the desktop colour stands in.
      if (alive() && !problem) problem = 'Your wallpaper could not be read, so the desktop colour is shown.';
    }
  }

  onMount(() => {
    let alive = true;
    void (async () => {
      // Nothing of this may land on the page while it morphs open.
      await session.whenInteractive();
      if (!alive) return;
      await readWallpaper(() => alive);
      if (alive) ready = true;
    })();
    const stop = watchDpr((d) => (dpr = d));
    const ro = new ResizeObserver(([e]) => {
      if (e) width = Math.max(120, Math.floor(e.contentRect.width));
    });
    if (host) ro.observe(host);
    return () => {
      alive = false;
      stop();
      ro.disconnect();
      image?.close();
    };
  });

  const iconSize = $derived(info?.iconSize ?? Math.round(48 * dpr));

  $effect(() => {
    const c = canvas;
    if (!c) return;
    const W = Math.round(width * dpr);
    const H = Math.round(HEIGHT * dpr);
    c.width = W;
    c.height = H;
    c.style.width = `${W / dpr}px`;
    c.style.height = `${H / dpr}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // Wallpaper: the screen region around where desktop icons sit.
    const monW = info?.monitorWidth ?? 1920;
    const monH = info?.monitorHeight ?? 1080;
    ctx.fillStyle = info?.background ?? '#0a3a6b';
    ctx.fillRect(0, 0, W, H);
    if (image) {
      const o = vignetteOrigin(monW, monH, W, H);
      const lay = wallpaperLayout(info?.fit ?? 'fill', image.width, image.height, monW, monH);
      ctx.save();
      ctx.translate(-o.x, -o.y);
      ctx.imageSmoothingQuality = 'high';
      if (lay.kind === 'image') {
        ctx.drawImage(image, lay.x, lay.y, lay.w, lay.h);
      } else {
        const pattern = ctx.createPattern(image, 'repeat');
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(o.x, o.y, W, H);
        }
      }
      ctx.restore();
    }
    // Desktop grid: our icon in the middle cell, neutral neighbours either side.
    const cell = Math.round(Math.max(iconSize * 1.55, 76 * dpr));
    const top = Math.round(10 * dpr);
    const cx = Math.round(W / 2);
    const fontPx = Math.round(12 * dpr);
    ctx.font = `${fontPx}px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const drawLabel = (text: string, x: number) => {
      const lines = desktopLabel(text, cell - 6 * dpr, (s) => ctx.measureText(s).width);
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 2 * dpr;
      ctx.shadowOffsetY = 1 * dpr;
      lines.forEach((l, i) => ctx.fillText(l, x, top + iconSize + 3 * dpr + i * Math.round(fontPx * 1.3)));
      ctx.restore();
    };
    for (const dx of [-cell, cell]) {
      const x = cx + dx - iconSize / 2;
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = Math.max(1, dpr);
      const inset = iconSize * 0.12;
      const r = iconSize * 0.18;
      ctx.beginPath();
      ctx.roundRect(x + inset, top + inset, iconSize - inset * 2, iconSize - inset * 2, r);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.beginPath();
      ctx.roundRect(cx + dx - cell * 0.28, top + iconSize + 6 * dpr, cell * 0.56, 6 * dpr, 3 * dpr);
      ctx.fill();
      ctx.restore();
    }
    drawIcon(ctx, rendered, iconSize, cx - iconSize / 2, top);
    drawLabel(label, cx);
  });
</script>

<div class="desktop" bind:this={host}>
  <span class="img" role="img" aria-label="{label} on your desktop at {iconSize} px" style:height="{HEIGHT}px">
    {#if ready}
      <canvas bind:this={canvas} aria-hidden="true" data-testid="desktop-preview" {@attach snapToDevicePixels()}></canvas>
    {/if}
  </span>
  {#if problem}<p class="note">{problem}</p>{/if}
</div>

<style>
  .desktop {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .img {
    display: block;
  }
  canvas {
    display: block;
    border-radius: var(--radius-md);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .note {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-xs);
  }
</style>

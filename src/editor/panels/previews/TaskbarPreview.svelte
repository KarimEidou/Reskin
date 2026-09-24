<!--
  A Windows 11 taskbar strip (light or dark) with the icon at 24 px as a
  running app among neutral placeholder icons.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { snapToDevicePixels, watchDpr } from '../common/canvas';
  import { drawIcon, type Rendered } from './draw';

  interface Props {
    rendered: Rendered;
    theme: 'light' | 'dark';
    label: string;
  }

  let { rendered, theme, label }: Props = $props();
  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  let canvas: HTMLCanvasElement | undefined = $state();

  onMount(() => watchDpr((d) => (dpr = d)));

  const ICON = 24;

  $effect(() => {
    const c = canvas;
    if (!c) return;
    const size = Math.round(ICON * dpr);
    c.width = size;
    c.height = size;
    c.style.width = `${size / dpr}px`;
    c.style.height = `${size / dpr}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    drawIcon(ctx, rendered, size, 0, 0);
  });
</script>

<div class="taskbar {theme}" role="img" aria-label="{label} on the {theme} taskbar" data-testid="taskbar-{theme}">
  <span class="slot start" aria-hidden="true">
    <span class="win"><i></i><i></i><i></i><i></i></span>
  </span>
  <span class="slot" aria-hidden="true"><span class="ph round"></span></span>
  <span class="slot" aria-hidden="true"><span class="ph a"></span></span>
  <span class="slot running" aria-hidden="true">
    <canvas bind:this={canvas} {@attach snapToDevicePixels()}></canvas>
    <span class="pip"></span>
  </span>
  <span class="slot" aria-hidden="true"><span class="ph b"></span></span>
  <span class="slot" aria-hidden="true"><span class="ph c"></span></span>
</div>

<style>
  .taskbar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 48px;
    border-radius: var(--radius-md);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .light {
    border-top: 1px solid rgb(0 0 0 / 0.06);
    background: #eef1f6;
  }
  .dark {
    border-top: 1px solid rgb(255 255 255 / 0.08);
    background: #1c1f26;
  }
  .slot {
    position: relative;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 4px;
  }
  .running {
    background: rgb(255 255 255 / 0.7);
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.04);
  }
  .dark .running {
    background: rgb(255 255 255 / 0.07);
    box-shadow: none;
  }
  .pip {
    position: absolute;
    bottom: 2px;
    left: 50%;
    width: 16px;
    height: 3px;
    border-radius: 2px;
    background: var(--accent-base, #0078d4);
    transform: translateX(-50%);
  }
  canvas {
    display: block;
  }
  .win {
    display: grid;
    grid-template-columns: 9px 9px;
    gap: 1.5px;
  }
  .win i {
    width: 9px;
    height: 9px;
    border-radius: 1px;
    background: linear-gradient(135deg, #3aa0ff, #1466e0);
  }
  .ph {
    width: 22px;
    height: 22px;
    border-radius: 5px;
  }
  .light .ph {
    background: #c9ced8;
  }
  .dark .ph {
    background: #4a505c;
  }
  .ph.round {
    border-radius: 50%;
  }
  .light .ph.a {
    background: #b8c3d6;
  }
  .light .ph.b {
    background: #d0c8bb;
  }
  .light .ph.c {
    background: #bccfc5;
  }
  .dark .ph.a {
    background: #4d586c;
  }
  .dark .ph.b {
    background: #5e5649;
  }
  .dark .ph.c {
    background: #495e53;
  }
</style>

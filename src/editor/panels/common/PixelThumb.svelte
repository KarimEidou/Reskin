<!--
  A small image of straight-RGBA pixels drawn into a canvas at `size` CSS
  px (device-pixel sharp), over a checkerboard for transparency.
-->
<script lang="ts">
  import type { PixelImage } from './canvas';
  import { drawFitted } from './canvas';

  interface Props {
    pixels: PixelImage | null;
    /** CSS size (square). */
    size: number;
    /** Accessible description; omit for decorative thumbnails. */
    label?: string;
    radius?: string;
    checker?: boolean;
    /** Hairline frame around the thumbnail. */
    framed?: boolean;
  }

  let { pixels, size, label, radius = 'var(--radius-xs)', checker = true, framed = true }: Props = $props();
  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    if (canvas && pixels) drawFitted(canvas, pixels, size);
  });
</script>

<span
  class="thumb"
  class:checker
  class:framed
  style:width="{size}px"
  style:height="{size}px"
  style:border-radius={radius}
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
>
  {#if pixels}
    <canvas bind:this={canvas} style:width="{size}px" style:height="{size}px"></canvas>
  {/if}
</span>

<style>
  .thumb {
    position: relative;
    display: inline-block;
    flex: none;
    overflow: hidden;
  }
  .framed {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .checker {
    background: repeating-conic-gradient(var(--checker-a) 0 25%, var(--checker-b) 0 50%) 0 0 / 8px 8px;
  }
  canvas {
    display: block;
  }
</style>

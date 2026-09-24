<!--
  HSV colour picker: a saturation/brightness square plus hue and alpha
  sliders. Pointer drag and keyboard (arrows ±1 %, Shift ±10 %) on the
  square; the sliders are native ranges. `oninput` fires while adjusting,
  `onchange` once a change is committed (pointer released, key released).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { hsvToRgb, rgbToHsv, roundRgba, type Hsva, type Rgba } from '$engine/index';
  import { hexOf } from '../common/color';

  interface Props {
    value: Rgba;
    /** Offer the alpha slider. */
    alpha?: boolean;
    /** Accessible name prefix, e.g. "Primary colour". */
    label?: string;
    oninput?: (c: Rgba) => void;
    onchange?: (c: Rgba) => void;
  }

  let { value, alpha = true, label = 'Colour', oninput, onchange }: Props = $props();

  // Kept separately so hue survives greys and black (where RGB loses it).
  let hsv = $state<Hsva>({ h: 0, s: 0, v: 0, a: 1 });
  let lastEmitted = '';

  $effect.pre(() => {
    const hex = hexOf(value);
    if (hex === lastEmitted) return;
    const next = rgbToHsv(value);
    // Keep the current hue (and saturation for black) when the colour carries none.
    const prev = untrack(() => hsv);
    if (next.s === 0 || next.v === 0) next.h = prev.h;
    if (next.v === 0) next.s = prev.s;
    hsv = next;
    lastEmitted = hex;
  });

  const rgb = $derived(roundRgba(hsvToRgb(hsv)));
  const hueCss = $derived(hexOf(hsvToRgb({ h: hsv.h, s: 1, v: 1, a: 1 })));
  const solidCss = $derived(hexOf({ ...rgb, a: 1 }));

  function emit(commit: boolean): void {
    const c = roundRgba(hsvToRgb(hsv));
    lastEmitted = hexOf(c);
    oninput?.(c);
    if (commit) onchange?.(c);
  }

  function set(patch: Partial<Hsva>, commit = false): void {
    hsv = { ...hsv, ...patch };
    emit(commit);
  }

  // ---- saturation / value square ---------------------------------------------
  let square: HTMLDivElement | undefined = $state();
  let dragging = false;

  function fromPointer(e: PointerEvent): void {
    if (!square) return;
    const r = square.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    set({ s, v });
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    dragging = true;
    square?.setPointerCapture(e.pointerId);
    square?.focus({ preventScroll: true });
    fromPointer(e);
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragging) fromPointer(e);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    square?.releasePointerCapture(e.pointerId);
    emit(true);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const step = e.shiftKey ? 0.1 : 0.01;
    let { s, v } = hsv;
    switch (e.key) {
      case 'ArrowLeft':
        s -= step;
        break;
      case 'ArrowRight':
        s += step;
        break;
      case 'ArrowUp':
        v += step;
        break;
      case 'ArrowDown':
        v -= step;
        break;
      case 'Home':
        s = 0;
        break;
      case 'End':
        s = 1;
        break;
      case 'PageUp':
        v = 1;
        break;
      case 'PageDown':
        v = 0;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    set({ s: Math.min(1, Math.max(0, s)), v: Math.min(1, Math.max(0, v)) });
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) emit(true);
  }

  const svText = $derived(`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
</script>

<div class="picker" style:--hue={hueCss} style:--solid={solidCss}>
  <div
    bind:this={square}
    class="square"
    role="slider"
    tabindex="0"
    aria-label="{label}: saturation and brightness"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(hsv.s * 100)}
    aria-valuetext={svText}
    data-testid="sv-square"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onkeydown={onKeyDown}
    onkeyup={onKeyUp}
  >
    <span class="thumb" style:left="{hsv.s * 100}%" style:top="{(1 - hsv.v) * 100}%" aria-hidden="true"></span>
  </div>

  <label class="range hue">
    <span class="sr-only">{label}: hue</span>
    <input
      type="range"
      min="0"
      max="360"
      step="1"
      value={Math.round(hsv.h)}
      aria-valuetext="Hue {Math.round(hsv.h)}°"
      data-testid="hue-slider"
      oninput={(e) => set({ h: Number(e.currentTarget.value) })}
      onchange={() => emit(true)}
    />
  </label>

  {#if alpha}
    <label class="range alpha">
      <span class="sr-only">{label}: opacity</span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={Math.round(hsv.a * 100)}
        aria-valuetext="Opacity {Math.round(hsv.a * 100)}%"
        data-testid="alpha-slider"
        oninput={(e) => set({ a: Number(e.currentTarget.value) / 100 })}
        onchange={() => emit(true)}
      />
    </label>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .square {
    position: relative;
    height: 132px;
    border-radius: var(--radius-md);
    background:
      linear-gradient(to top, #000, transparent),
      linear-gradient(to right, #fff, transparent),
      var(--hue);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
    cursor: crosshair;
    touch-action: none;
  }
  .square:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  .thumb {
    position: absolute;
    width: 16px;
    height: 16px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--solid);
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 1px 4px rgb(0 0 0 / 0.4);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .range {
    position: relative;
    display: block;
    height: 14px;
    border-radius: var(--radius-full);
  }
  .hue {
    background: linear-gradient(to right, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%);
  }
  .alpha {
    background:
      linear-gradient(to right, transparent, var(--solid)),
      repeating-conic-gradient(#c8cbd2 0 25%, #fff 0 50%) 0 0 / 8px 8px;
  }
  .range::after {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.14);
    content: '';
    pointer-events: none;
  }
  input[type='range'] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    background: transparent;
    appearance: none;
    cursor: default;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: 100%;
    background: transparent;
  }
  input[type='range']::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
    margin-top: -1px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: transparent;
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 1px 3px rgb(0 0 0 / 0.35);
    appearance: none;
  }
  input[type='range']:focus-visible {
    outline: none;
  }
  input[type='range']:focus-visible::-webkit-slider-thumb {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>

<!--
  Compact HSV colour picker: saturation/brightness square, hue and opacity
  sliders, a hex field and the recent colours. Used by the rail's colour
  chips, the text colour and the gradient stops (the full Color panel lives
  in the sidebar).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Hsva, Rgba } from '$engine/index';
  import { settings } from '$lib/settings/store.svelte';
  import ColorSwatch from '$lib/ui/ColorSwatch.svelte';
  import { fromHsv, hexOf, hueCss, parseColorInput, svFromPoint, toHsv } from './color-picker';

  interface Props {
    color: Rgba;
    /** Names the controls, e.g. "Primary colour". */
    label: string;
    /** Every change (dragging included). */
    onchange: (color: Rgba) => void;
  }

  let { color, label, onchange }: Props = $props();

  // Initialised from the prop, then kept in sync by the effect below.
  let hsv = $state<Hsva>({ h: 0, s: 0, v: 0, a: 1 });
  let lastHex = '';
  let hexDraft = $state<string | null>(null);
  let sv: HTMLDivElement | undefined = $state();
  let dragId = -1;

  const current = $derived(fromHsv(hsv));
  const hex = $derived(hexOf(current));
  const opaque = $derived(hexOf({ ...current, a: 1 }));
  const recents = $derived(settings().recentColors.slice(0, 16));

  // External changes (another control, undo…) update the picker, keeping
  // the hue when the new colour has none.
  $effect(() => {
    const incoming = hexOf(color);
    if (incoming === lastHex) return;
    lastHex = incoming;
    hsv = toHsv(color, untrack(() => ({ h: hsv.h, s: hsv.s })));
  });

  function emit(next: Hsva): void {
    hsv = next;
    const c = fromHsv(next);
    lastHex = hexOf(c);
    onchange(c);
  }

  function pickAt(e: PointerEvent): void {
    if (!sv) return;
    const r = sv.getBoundingClientRect();
    const p = svFromPoint(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    emit({ ...hsv, s: p.s, v: p.v });
  }

  function onSvDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    dragId = e.pointerId;
    sv?.setPointerCapture(e.pointerId);
    sv?.focus({ preventScroll: true });
    pickAt(e);
  }

  function onSvMove(e: PointerEvent): void {
    if (e.pointerId === dragId) pickAt(e);
  }

  function onSvUp(e: PointerEvent): void {
    if (e.pointerId === dragId) dragId = -1;
  }

  function onSvKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 0.1 : 0.01;
    let { s, v } = hsv;
    if (e.key === 'ArrowLeft') s -= step;
    else if (e.key === 'ArrowRight') s += step;
    else if (e.key === 'ArrowUp') v += step;
    else if (e.key === 'ArrowDown') v -= step;
    else return;
    e.preventDefault();
    emit({ ...hsv, s: Math.min(1, Math.max(0, s)), v: Math.min(1, Math.max(0, v)) });
  }

  function commitHex(): void {
    if (hexDraft === null) return;
    const parsed = parseColorInput(hexDraft);
    hexDraft = null;
    if (parsed) emit(toHsv(parsed, { h: hsv.h, s: hsv.s }));
  }

  function pickRecent(c: string): void {
    const parsed = parseColorInput(c);
    if (parsed) emit(toHsv(parsed, { h: hsv.h, s: hsv.s }));
  }
</script>

<div class="picker" style:--hue={hueCss(hsv.h)} style:--c={opaque}>
  <div
    bind:this={sv}
    class="sv"
    role="slider"
    tabindex="0"
    aria-label="{label}: saturation and brightness"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(hsv.s * 100)}
    aria-valuetext="Saturation {Math.round(hsv.s * 100)}%, brightness {Math.round(hsv.v * 100)}%"
    onpointerdown={onSvDown}
    onpointermove={onSvMove}
    onpointerup={onSvUp}
    onpointercancel={onSvUp}
    onkeydown={onSvKey}
  >
    <span class="thumb" style:left="{hsv.s * 100}%" style:top="{(1 - hsv.v) * 100}%"></span>
  </div>

  <input
    class="bar hue"
    type="range"
    min="0"
    max="360"
    step="1"
    aria-label="{label}: hue"
    value={Math.round(hsv.h)}
    oninput={(e) => emit({ ...hsv, h: Number(e.currentTarget.value) })}
  />
  <input
    class="bar alpha"
    type="range"
    min="0"
    max="100"
    step="1"
    aria-label="{label}: opacity"
    aria-valuetext="{Math.round(hsv.a * 100)}%"
    value={Math.round(hsv.a * 100)}
    oninput={(e) => emit({ ...hsv, a: Number(e.currentTarget.value) / 100 })}
  />

  <div class="row">
    <span class="preview" aria-hidden="true"><span style:background={hex}></span></span>
    <label class="hex">
      <span class="sr-only">{label}: hex</span>
      <input
        type="text"
        spellcheck="false"
        autocomplete="off"
        value={hexDraft ?? hex}
        oninput={(e) => (hexDraft = e.currentTarget.value)}
        onblur={commitHex}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitHex();
          } else if (e.key === 'Escape' && hexDraft !== null) {
            e.preventDefault();
            e.stopPropagation();
            hexDraft = null;
          }
        }}
      />
    </label>
    <span class="alpha-readout" aria-hidden="true">{Math.round(hsv.a * 100)}%</span>
  </div>

  {#if recents.length > 0}
    <div class="recents" role="group" aria-label="Recent colours">
      {#each recents as c (c)}
        <ColorSwatch color={c} size="sm" label="Recent colour {c}" selected={c === hex} onclick={pickRecent} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 216px;
  }

  .sv {
    position: relative;
    height: 144px;
    border-radius: var(--radius-md);
    background:
      linear-gradient(to top, #000, rgb(0 0 0 / 0)),
      linear-gradient(to right, #fff, var(--hue));
    box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.1);
    cursor: crosshair;
    touch-action: none;
    outline: none;
  }
  .sv:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  .thumb {
    position: absolute;
    width: 14px;
    height: 14px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: var(--c);
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 1px 4px rgb(0 0 0 / 0.4);
    translate: -50% -50%;
    pointer-events: none;
  }

  .bar {
    --track: 12px;
    width: 100%;
    height: 16px;
    margin: 0;
    background: transparent;
    appearance: none;
    cursor: default;
  }
  .bar::-webkit-slider-runnable-track {
    height: var(--track);
    border-radius: var(--radius-full);
    box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.1);
  }
  .hue::-webkit-slider-runnable-track {
    background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  }
  .alpha::-webkit-slider-runnable-track {
    background:
      linear-gradient(to right, rgb(0 0 0 / 0), var(--c)),
      repeating-conic-gradient(#d9dce2 0 25%, #ffffff 0 50%) 0 0 / 8px 8px;
  }
  .bar::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
    margin-top: -2px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: transparent;
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 1px 3px rgb(0 0 0 / 0.35);
    appearance: none;
  }
  .bar:focus-visible {
    outline: none;
  }
  .bar:focus-visible::-webkit-slider-thumb {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .preview {
    display: grid;
    flex: none;
    width: 26px;
    height: 26px;
    overflow: hidden;
    border-radius: var(--radius-sm);
    background: var(--checker);
    box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.12);
  }
  .hex {
    flex: 1;
    min-width: 0;
  }
  .hex input {
    width: 100%;
    height: var(--control-sm);
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    outline: none;
  }
  .hex input:focus {
    border-color: var(--accent);
    box-shadow: inset 0 -1px 0 var(--accent);
  }
  .alpha-readout {
    min-width: 36px;
    color: var(--text-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .recents {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: var(--space-1);
    border-top: 1px solid var(--divider);
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

<!--
  Reusable gradient editor: a preview bar with draggable colour stops
  (click the bar to add a stop, drag a stop to move it, Delete to remove,
  arrows to nudge), the selected stop's colour and position, an optional
  type select and an angle for linear gradients.
    <GradientEditor stops={…} types={…} type="linear" angle={90} onchange={(v) => …} />
-->
<script module lang="ts">
  import type { EditorStop } from './gradient-model';

  export interface GradientValue {
    stops: EditorStop[];
    type?: string;
    angle?: number;
  }
</script>

<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
  import IconButton from '$lib/ui/IconButton.svelte';
  import NumberField from '$lib/ui/NumberField.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import ColorField from './ColorField.svelte';
  import { colorAt, cssGradient, reverseStops, sortStops } from './gradient-model';

  interface Props {
    stops: readonly EditorStop[];
    label?: string;
    type?: string;
    /** Offer a type select with these choices. */
    types?: readonly { value: string; label: string }[];
    /** Angle in degrees (shown for linear gradients). */
    angle?: number;
    minStops?: number;
    maxStops?: number;
    oninput?: (v: GradientValue) => void;
    onchange: (v: GradientValue) => void;
  }

  let { stops, label = 'Gradient', type, types, angle, minStops = 2, maxStops = 16, oninput, onchange }: Props = $props();

  const uid = $props.id();
  let local = $state<EditorStop[]>([]);
  let selected = $state(0);
  let dragging = $state(-1);
  let synced = '';

  $effect.pre(() => {
    const key = JSON.stringify(stops);
    if (key === synced || dragging >= 0) return;
    synced = key;
    local = stops.map((s) => ({ ...s }));
    if (selected >= local.length) selected = Math.max(0, local.length - 1);
  });

  const preview = $derived(cssGradient(local));
  const current = $derived(local[selected]);
  const showAngle = $derived(angle !== undefined && (type === undefined || type === 'linear'));

  function value(list: EditorStop[] = local): GradientValue {
    const v: GradientValue = { stops: sortStops(list) };
    if (type !== undefined) v.type = type;
    if (angle !== undefined) v.angle = angle;
    return v;
  }

  function emitInput(): void {
    oninput?.(value());
  }

  function commit(): void {
    // Keep the same stop selected across re-sorting.
    const sel = local[selected];
    const sorted = sortStops(local);
    local = sorted;
    if (sel) selected = Math.max(0, sorted.findIndex((s) => s.offset === clamp(sel.offset) && s.color === sel.color));
    synced = JSON.stringify(sorted);
    onchange(value(sorted));
  }

  function clamp(v: number): number {
    return Math.min(1, Math.max(0, v));
  }

  // ---- bar: add stops ------------------------------------------------------------
  let bar: HTMLDivElement | undefined = $state();

  function offsetAt(clientX: number): number {
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width);
  }

  function addAt(t: number): void {
    if (local.length >= maxStops) return;
    const color = colorAt(local, t);
    local = [...local, { offset: Math.round(t * 1000) / 1000, color }];
    selected = local.length - 1;
    commit();
  }

  // ---- stops: drag / keyboard ----------------------------------------------------
  const handles: HTMLButtonElement[] = $state([]);

  function onStopDown(e: PointerEvent, i: number): void {
    if (e.button !== 0) return;
    selected = i;
    dragging = i;
    handles[i]?.setPointerCapture(e.pointerId);
  }

  function onStopMove(e: PointerEvent, i: number): void {
    if (dragging !== i) return;
    local[i] = { ...local[i]!, offset: Math.round(offsetAt(e.clientX) * 1000) / 1000 };
    emitInput();
  }

  function onStopUp(e: PointerEvent, i: number): void {
    if (dragging !== i) return;
    dragging = -1;
    handles[i]?.releasePointerCapture(e.pointerId);
    commit();
  }

  function remove(i: number): void {
    if (local.length <= minStops) return;
    local = local.filter((_, k) => k !== i);
    selected = Math.min(selected, local.length - 1);
    commit();
    handles[selected]?.focus();
  }

  function onStopKey(e: KeyboardEvent, i: number): void {
    const step = e.shiftKey ? 0.1 : 0.01;
    let o = local[i]!.offset;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') o -= step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') o += step;
    else if (e.key === 'Home') o = 0;
    else if (e.key === 'End') o = 1;
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      remove(i);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    local[i] = { ...local[i]!, offset: Math.round(clamp(o) * 1000) / 1000 };
    selected = i;
    commit();
    // The stop may have moved in the order; keep focus on it.
    queueMicrotask(() => handles[selected]?.focus());
  }

  function setColor(hex: string, done: boolean): void {
    if (!current) return;
    local[selected] = { ...current, color: hex };
    if (done) commit();
    else emitInput();
  }

  function setOffset(pct: number): void {
    if (!current) return;
    local[selected] = { ...current, offset: clamp(pct / 100) };
    commit();
  }
</script>

<div class="gradient" role="group" aria-label={label}>
  {#if types || showAngle}
    <div class="head">
      {#if types}
        <div class="type">
          <Select
            label="Type"
            size="sm"
            options={types}
            value={type}
            onchange={(t) => onchange({ ...value(), type: t })}
          />
        </div>
      {/if}
      <IconButton label="Reverse" icon={ArrowLeftRight} size="sm" onclick={() => {
        local = reverseStops(local);
        commit();
      }} />
    </div>
  {/if}

  <div class="track">
    <div
      bind:this={bar}
      class="bar"
      style:--g={preview}
      role="presentation"
      title="Click to add a stop"
      onclick={(e) => addAt(offsetAt(e.clientX))}
    ></div>
    <div class="stops">
      {#each local as stop, i (i)}
        <button
          bind:this={handles[i]}
          type="button"
          class="stop"
          class:selected={i === selected}
          style:left="{stop.offset * 100}%"
          style:--c={stop.color}
          role="slider"
          aria-label="{label} stop {i + 1}"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(stop.offset * 100)}
          aria-valuetext="{Math.round(stop.offset * 100)}%, {stop.color}"
          aria-describedby="{uid}-hint"
          onpointerdown={(e) => onStopDown(e, i)}
          onpointermove={(e) => onStopMove(e, i)}
          onpointerup={(e) => onStopUp(e, i)}
          onpointercancel={(e) => onStopUp(e, i)}
          onkeydown={(e) => onStopKey(e, i)}
          onfocus={() => (selected = i)}
        ></button>
      {/each}
    </div>
  </div>

  {#if current}
    <div class="stop-row">
      <div class="color">
        <ColorField
          label="Stop colour"
          showLabel={false}
          value={current.color}
          oninput={(h) => setColor(h, false)}
          onchange={(h) => setColor(h, true)}
        />
      </div>
      <NumberField
        label="Stop position"
        hideLabel
        value={Math.round(current.offset * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        width="64px"
        onchange={setOffset}
      />
      <IconButton
        label="Add stop"
        icon={Plus}
        size="sm"
        focusableWhenDisabled
        disabled={local.length >= maxStops}
        onclick={() => {
          const s = sortStops(local);
          // Midway into the widest gap.
          let best = 0.5;
          let gap = -1;
          for (let k = 0; k + 1 < s.length; k++) {
            const g = s[k + 1]!.offset - s[k]!.offset;
            if (g > gap) {
              gap = g;
              best = s[k]!.offset + g / 2;
            }
          }
          addAt(best);
        }}
      />
      <IconButton label="Remove stop" icon={Trash2} size="sm" focusableWhenDisabled disabled={local.length <= minStops} onclick={() => remove(selected)} />
    </div>
  {/if}

  {#if showAngle}
    <Slider label="Angle" value={angle ?? 0} min={0} max={360} step={1} unit="°" onchange={(a) => onchange({ ...value(), angle: a })} oninput={(a) => oninput?.({ ...value(), angle: a })} />
  {/if}
  <span class="sr-only" id="{uid}-hint">Click the bar to add a stop. Select a stop and use the arrow keys to move it, Delete to remove it.</span>
</div>

<style>
  .gradient {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }
  .type {
    flex: 1;
    min-width: 0;
  }
  .track {
    position: relative;
    padding: 0 7px;
  }
  .bar {
    height: 22px;
    border-radius: var(--radius-sm);
    background:
      var(--g),
      repeating-conic-gradient(#c8cbd2 0 25%, #fff 0 50%) 0 0 / 8px 8px;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.14);
    cursor: copy;
  }
  .stops {
    position: relative;
    height: 18px;
  }
  .stop {
    position: absolute;
    top: 3px;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    padding: 0;
    border: 2px solid #fff;
    border-radius: 3px 3px 7px 7px;
    background: var(--c);
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 1px 3px rgb(0 0 0 / 0.3);
    cursor: ew-resize;
    touch-action: none;
  }
  .stop::before {
    position: absolute;
    top: -7px;
    left: 50%;
    width: 0;
    height: 0;
    border: 4px solid transparent;
    border-bottom-color: #fff;
    content: '';
    transform: translateX(-50%);
  }
  .stop.selected {
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 0 0 3px var(--accent),
      0 1px 3px rgb(0 0 0 / 0.3);
  }
  .stop:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 3px;
  }
  .stop-row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .color {
    flex: 1;
    min-width: 0;
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

<!--
  Inline gradient stops editor for the gradient tool: a preview bar with a
  handle per stop. Click the bar to add a stop, drag a handle to move it,
  click a handle to recolour or remove it. Keyboard: ←/→ move the focused
  stop (Shift ×10), Enter opens its colour, Delete removes it, Insert or +
  adds a stop halfway to the next one.
-->
<script lang="ts">
  import Trash from '@lucide/svelte/icons/trash';
  import { normalizeStops, sampleStops, toHex, type GradientStop, type Rgba } from '$engine/index';
  import Button from '$lib/ui/Button.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import MiniColorPicker from './MiniColorPicker.svelte';
  import { gradientCss } from './gradient-css';

  interface Props {
    stops: readonly GradientStop[];
    onchange: (stops: GradientStop[]) => void;
  }

  let { stops, onchange }: Props = $props();

  const MIN_STOPS = 2;
  const MAX_STOPS = 12;
  const DRAG_THRESHOLD = 3;

  let bar: HTMLDivElement | undefined = $state();
  let handles: HTMLDivElement[] = $state([]);
  let editing = $state<number | null>(null);
  let focused = $state(0);
  let drag: { index: number; pointer: number; x0: number; moved: boolean } | null = null;

  const preview = $derived(gradientCss(stops));

  const copy = (list: readonly GradientStop[]) => list.map((s) => ({ offset: s.offset, color: { ...s.color } }));

  function offsetAt(clientX: number): number {
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
  }

  function update(index: number, patch: Partial<GradientStop>): void {
    const next = copy(stops);
    const s = next[index];
    if (!s) return;
    if (patch.offset !== undefined) s.offset = Math.round(Math.min(1, Math.max(0, patch.offset)) * 1000) / 1000;
    if (patch.color) s.color = { ...patch.color };
    onchange(next);
  }

  function add(clientX: number): void {
    addAt(offsetAt(clientX));
  }

  /** Keyboard: a new stop halfway between `index` and the next stop (or the previous one at the end). */
  function addAfter(index: number): void {
    const here = stops[index];
    if (!here) return;
    const after = stops.filter((s) => s.offset > here.offset).sort((a, b) => a.offset - b.offset)[0];
    const before = stops.filter((s) => s.offset < here.offset).sort((a, b) => b.offset - a.offset)[0];
    const other = after ?? before;
    addAt(other ? (here.offset + other.offset) / 2 : Math.min(1, here.offset + 0.1));
  }

  function addAt(at: number): void {
    if (stops.length >= MAX_STOPS) return;
    const offset = Math.round(Math.min(1, Math.max(0, at)) * 1000) / 1000;
    const color: Rgba = sampleStops(normalizeStops(stops), offset);
    const next = [...copy(stops), { offset, color }];
    onchange(next);
    const index = next.length - 1;
    focused = index;
    queueMicrotask(() => handles[index]?.focus());
  }

  function remove(index: number): void {
    if (stops.length <= MIN_STOPS) return;
    const next = copy(stops);
    next.splice(index, 1);
    editing = null;
    focused = Math.min(index, next.length - 1);
    onchange(next);
    queueMicrotask(() => handles[focused]?.focus());
  }

  function onBarDown(e: PointerEvent): void {
    if (e.button !== 0 || e.target !== bar) return;
    add(e.clientX);
  }

  function onHandleDown(e: PointerEvent, index: number): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    focused = index;
    drag = { index, pointer: e.pointerId, x0: e.clientX, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onHandleMove(e: PointerEvent): void {
    const d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < DRAG_THRESHOLD) return;
    d.moved = true;
    update(d.index, { offset: offsetAt(e.clientX) });
  }

  function onHandleUp(e: PointerEvent, index: number): void {
    const d = drag;
    if (!d || e.pointerId !== d.pointer) return;
    drag = null;
    if (!d.moved) editing = editing === index ? null : index;
  }

  function onHandleKey(e: KeyboardEvent, index: number): void {
    const s = stops[index];
    if (!s) return;
    const step = e.shiftKey ? 0.1 : 0.01;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        update(index, { offset: s.offset - step });
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        update(index, { offset: s.offset + step });
        break;
      case 'Home':
        update(index, { offset: 0 });
        break;
      case 'End':
        update(index, { offset: 1 });
        break;
      case 'Enter':
      case ' ':
        editing = editing === index ? null : index;
        break;
      case 'Delete':
      case 'Backspace':
        remove(index);
        break;
      case 'Insert':
      case '+':
        addAfter(index);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div class="stops" role="group" aria-label="Gradient stops" data-testid="gradient-stops">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={bar}
    class="bar"
    title="Click to add a stop"
    style:--g={preview}
    onpointerdown={onBarDown}
  >
    {#each stops as stop, i (i)}
      <div
        bind:this={handles[i]}
        class="handle"
        class:open={editing === i}
        role="slider"
        aria-label="Stop {i + 1}, {toHex(stop.color, 'auto')}"
        aria-keyshortcuts="Enter Delete Insert"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(stop.offset * 100)}
        aria-valuetext="{Math.round(stop.offset * 100)}%"
        aria-haspopup="dialog"
        tabindex="0"
        style:left="{stop.offset * 100}%"
        style:--c={toHex(stop.color, 'auto')}
        onpointerdown={(e) => onHandleDown(e, i)}
        onpointermove={onHandleMove}
        onpointerup={(e) => onHandleUp(e, i)}
        onpointercancel={() => (drag = null)}
        onkeydown={(e) => onHandleKey(e, i)}
        onfocus={() => (focused = i)}
      ></div>
    {/each}
  </div>
</div>

{#if editing !== null && stops[editing]}
  {@const index = editing}
  <Popover
    open
    anchor={handles[index]}
    label="Stop {index + 1} colour"
    placement="bottom"
    offset={8}
    initialFocus="first"
    onclose={() => (editing = null)}
  >
    <div class="editor">
      <MiniColorPicker color={stops[index]!.color} label="Stop {index + 1}" onchange={(color) => update(index, { color })} />
      <Button
        size="sm"
        variant="ghost"
        icon={Trash}
        disabled={stops.length <= MIN_STOPS}
        onclick={() => remove(index)}
      >
        Remove stop
      </Button>
    </div>
  </Popover>
{/if}

<style>
  .stops {
    display: inline-flex;
    flex: none;
    align-items: center;
    height: var(--control-sm);
    padding: 0 7px;
  }
  .bar {
    position: relative;
    width: 132px;
    height: 16px;
    border-radius: var(--radius-full);
    background: var(--g), var(--checker);
    background-size: 100% 100%, auto;
    box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.14);
    cursor: copy;
  }
  .handle {
    position: absolute;
    top: 50%;
    box-sizing: border-box;
    width: 14px;
    height: 22px;
    padding: 0;
    border: 2px solid #fff;
    border-radius: 5px;
    background:
      linear-gradient(var(--c), var(--c)),
      repeating-conic-gradient(#d9dce2 0 25%, #fff 0 50%) 0 0 / 6px 6px;
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 1px 4px rgb(0 0 0 / 0.35);
    translate: -50% -50%;
    cursor: ew-resize;
    touch-action: none;
    transition: scale var(--dur-1) var(--ease-standard);
  }
  .handle:hover,
  .handle.open {
    scale: 1.12;
  }
  .handle:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  .editor {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }
</style>

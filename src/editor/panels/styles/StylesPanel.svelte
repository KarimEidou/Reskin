<!--
  Styles panel: twelve presets rendered live from the item's own icon
  (thumbnails built in the panels worker and cached per icon). Clicking one
  replaces the design with that look as ONE undo step and records it as the
  recipe "Apply style to all" replays. Accent, intensity and shape re-style
  the grid, and the applied look while it is still the latest change.
-->
<script module lang="ts">
  import type { Pixels } from '$engine/filters/types';

  /** Thumbnails by icon + preset + size + options (kept across tab switches). */
  const thumbCache = new Map<string, Pixels>();
  const MAX_CACHE = 240;

  function remember(key: string, px: Pixels): void {
    thumbCache.set(key, px);
    while (thumbCache.size > MAX_CACHE) thumbCache.delete(thumbCache.keys().next().value!);
  }
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
  import { BACKDROP_SHAPES, type BackdropShape } from '$engine/backdrop/shapes';
  import { applyPresetResult, DEFAULT_PRESET_OPTIONS, PRESETS, getPreset, type PresetId, type PresetOptions } from '$engine/presets';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../../state/context';
  import { discardRedo } from '../adjust/live-edit';
  import { watchDpr } from '../common/canvas';
  import PixelThumb from '../common/PixelThumb.svelte';
  import Section from '../common/Section.svelte';
  import { debounce } from '../common/schedule';
  import { isCancelled, panelsWorker } from '../worker/client';
  import { snapshotDoc, snapshotTransfer } from '../worker/snapshot';
  import { presetRecipe, type PresetBuilder } from './recipe';

  const session = getSession();
  const engine = session.engine;
  const TILE = 76;

  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  const thumbSize = $derived(Math.min(192, Math.round(TILE * dpr)));

  // ---- the source icon -----------------------------------------------------------------
  function hashPixels(p: { width: number; height: number; data: Uint8ClampedArray }): string {
    let h = 2166136261;
    const d = p.data;
    const step = Math.max(1, Math.floor(d.length / 65536)) * 4 + 1;
    for (let i = 0; i < d.length; i += step) h = Math.imul(h ^ d[i]!, 16777619);
    return `${p.width}x${p.height}:${(h >>> 0).toString(36)}`;
  }

  let designSource = $state.raw<Pixels | null>(null);
  const icon = $derived<Pixels | null>(session.original ? { width: session.original.width, height: session.original.height, data: session.original.data } : designSource);
  const iconKey = $derived(icon ? hashPixels(icon) : '');

  onMount(() => {
    if (!session.original) {
      // No original icon (a blank design or an image): style the current
      // design, composited in the worker through the export path.
      const snap = snapshotDoc(engine.doc);
      panelsWorker()
        .request({ op: 'renderSizes', doc: snap, sizes: [256] }, { transfer: snapshotTransfer(snap) })
        .then(([r]) => {
          const px = r?.pixels;
          const empty = !px || !px.data.some((v, i) => i % 4 === 3 && v > 0);
          designSource = empty ? null : px;
        })
        .catch((e: unknown) => console.warn('could not read the design for presets', e));
    }
    return watchDpr((d) => (dpr = d));
  });

  // ---- options -----------------------------------------------------------------------------
  let matchIcon = $state(true);
  let hue = $state(DEFAULT_PRESET_OPTIONS.hue ?? 220);
  let intensity = $state(50);
  let shape = $state<'auto' | BackdropShape>('auto');

  const options = $derived<Partial<PresetOptions>>({
    hue: matchIcon ? null : hue,
    intensity: intensity / 100,
    shape: shape === 'auto' ? null : shape,
  });
  const optionsKey = $derived(JSON.stringify(options));

  // ---- thumbnails ----------------------------------------------------------------------------
  let thumbs = $state.raw<Partial<Record<PresetId, Pixels>>>({});

  function requestThumbs(): void {
    const src = icon;
    if (!src) return;
    const size = thumbSize;
    const opts = $state.snapshot(options) as Partial<PresetOptions>;
    const key = iconKey;
    const next: Partial<Record<PresetId, Pixels>> = {};
    for (const p of PRESETS) {
      const cacheKey = `${key}:${p.id}:${size}:${JSON.stringify(opts)}`;
      const cached = thumbCache.get(cacheKey);
      if (cached) {
        next[p.id] = cached;
        continue;
      }
      next[p.id] = thumbs[p.id];
      const copy = { width: src.width, height: src.height, data: src.data.slice() };
      panelsWorker()
        .request({ op: 'presetThumb', iconKey: key, icon: copy, id: p.id, size, options: opts }, { channel: `preset-thumb-${p.id}`, transfer: [copy.data.buffer] })
        .then((px) => {
          remember(cacheKey, px);
          if (key === iconKey) thumbs = { ...thumbs, [p.id]: px };
        })
        .catch((e: unknown) => {
          if (!isCancelled(e)) console.warn(`preset thumbnail ${p.id} failed`, e);
        });
    }
    thumbs = next;
  }

  const refreshThumbs = debounce(requestThumbs, 180);

  $effect(() => {
    void iconKey;
    void thumbSize;
    void optionsKey;
    untrack(() => (Object.keys(thumbs).length === 0 ? requestThumbs() : refreshThumbs()));
  });

  // ---- applying ----------------------------------------------------------------------------
  let applying = $state<PresetId | null>(null);
  let applied = $state<PresetId | null>(null);
  /** History command of our last apply (to re-style it in place). */
  let appliedCmd: unknown = null;

  const builder: PresetBuilder = (id, src, size, opts) => {
    const copy = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
    return panelsWorker().request({ op: 'presetBuild', iconKey: hashPixels(copy), icon: copy, id, size, options: opts }, { transfer: [copy.data.buffer] });
  };

  async function apply(id: PresetId, restyle = false): Promise<void> {
    const src = icon;
    if (!src || applying) return;
    applying = id;
    const opts = $state.snapshot(options) as Partial<PresetOptions>;
    const label = getPreset(id).label;
    try {
      const copy = { width: src.width, height: src.height, data: src.data.slice() };
      const result = await panelsWorker().request(
        { op: 'presetBuild', iconKey, icon: copy, id, size: engine.doc.width, options: opts },
        { channel: 'preset-apply', transfer: [copy.data.buffer] },
      );
      if (restyle && appliedCmd && engine.history.peek() === appliedCmd) {
        // Replace the previous look instead of stacking another undo step.
        engine.undo();
        discardRedo(engine);
      }
      applyPresetResult(engine, result, `Style: ${label}`);
      appliedCmd = engine.history.peek();
      applied = id;
      session.recipe = presetRecipe(id, label, opts, builder);
    } catch (e) {
      if (!isCancelled(e)) toast({ message: `Could not apply ${label}: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' });
    } finally {
      applying = null;
    }
  }

  // Re-style the applied look when the options change (only while it is the latest change).
  const restyle = debounce(() => {
    if (applied && appliedCmd && engine.history.peek() === appliedCmd) void apply(applied, true);
  }, 280);

  $effect(() => {
    void optionsKey;
    untrack(() => restyle());
  });

  // The applied marker follows undo / other edits.
  const stillApplied = $derived.by(() => {
    void session.rev.history;
    return applied !== null && engine.history.peek() === appliedCmd;
  });

  const shapeOptions = [{ value: 'auto', label: 'Preset’s own' }, ...BACKDROP_SHAPES.map((s) => ({ value: s.id, label: s.label }))];
  const current = $derived(applied ? getPreset(applied) : null);
</script>

<div class="styles" data-testid="styles-panel">
  {#if !icon}
    <EmptyState icon={WandSparkles} title="Nothing to style yet" description="Open an icon or draw something first — presets are built from your icon." compact />
  {:else}
    <p class="lead">Designer looks rebuilt from your icon. Click to apply — one undo step.</p>
    <div class="grid" role="list" aria-label="Style presets">
      {#each PRESETS as p (p.id)}
        {@const px = thumbs[p.id] ?? null}
        <div role="listitem">
          <button
            type="button"
            class="tile"
            class:on={stillApplied && applied === p.id}
            aria-pressed={stillApplied && applied === p.id}
            aria-busy={applying === p.id}
            title={p.description}
            disabled={applying !== null}
            data-testid="preset-tile"
            data-preset={p.id}
            data-ready={px !== null}
            onclick={() => void apply(p.id)}
          >
            <span class="thumb">
              <PixelThumb pixels={px} size={TILE} radius="var(--radius-md)" checker={false} framed={false} />
              {#if applying === p.id}<span class="busy"><Spinner size={18} label="Applying {p.label}" /></span>{/if}
              {#if stillApplied && applied === p.id}<span class="badge" aria-hidden="true"><Check size={12} strokeWidth={3} /></span>{/if}
            </span>
            <span class="label">{p.label}</span>
          </button>
        </div>
      {/each}
    </div>

    <Section title="Tune">
      <Toggle label="Match the icon’s colour" size="sm" bind:checked={matchIcon} />
      {#if !matchIcon}
        <label class="hue">
          <span class="hue-head"><span>Accent hue</span><output>{hue}°</output></span>
          <input type="range" min="0" max="359" step="1" bind:value={hue} aria-valuetext="{hue} degrees" data-testid="preset-hue" />
        </label>
      {/if}
      <Slider label={current?.intensityLabel ?? 'Intensity'} bind:value={intensity} min={0} max={100} unit="%" />
      <Select label="Backdrop shape" size="sm" options={shapeOptions} bind:value={shape} />
      {#if session.recipe}
        <p class="recipe">“Apply style to all” will use: <strong>{session.recipe.label}</strong></p>
      {/if}
    </Section>
  {/if}
</div>

<style>
  .styles {
    display: flex;
    flex-direction: column;
  }
  .lead {
    margin: 0;
    padding: var(--space-3) var(--space-3) var(--space-2);
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-1);
    padding: 0 var(--space-2) var(--space-3);
  }
  .tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-1-5) 0 var(--space-1);
    border: 1px solid transparent;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--text-2);
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      border-color var(--fade-1) linear;
  }
  .tile:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .tile:disabled {
    cursor: progress;
  }
  .tile.on {
    border-color: var(--accent-border);
    background: var(--surface-selected);
    color: var(--text);
  }
  .tile:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
  .thumb {
    position: relative;
    display: grid;
    transition: transform var(--dur-2) var(--ease-overshoot);
  }
  .tile:hover:not(:disabled) .thumb {
    transform: scale(1.04);
  }
  .tile:active:not(:disabled) .thumb {
    transform: scale(0.97);
  }
  .busy {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: var(--radius-md);
    background: rgb(0 0 0 / 0.35);
    color: #fff;
  }
  .badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 2px solid var(--surface-1);
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
  }
  .label {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
  }
  .hue {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .hue-head {
    display: flex;
    justify-content: space-between;
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .hue-head output {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .hue input {
    width: 100%;
    height: 14px;
    margin: 0;
    border-radius: var(--radius-full);
    background: linear-gradient(to right, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.14);
    appearance: none;
    cursor: default;
  }
  .hue input::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
    border: 2px solid #fff;
    border-radius: 50%;
    background: transparent;
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.35),
      0 1px 3px rgb(0 0 0 / 0.35);
    appearance: none;
  }
  .hue input:focus-visible {
    outline: none;
  }
  .hue input:focus-visible::-webkit-slider-thumb {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }
  .recipe {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-xs);
  }
  .recipe strong {
    color: var(--text-2);
    font-weight: var(--weight-medium);
  }
</style>

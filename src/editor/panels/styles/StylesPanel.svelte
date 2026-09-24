<!--
  Styles panel: twelve presets rendered live from the item's own icon
  (thumbnails built in the panels worker and cached per icon). Clicking one
  replaces the design with that look as ONE undo step and records it as the
  recipe "Apply style to all" replays. Accent, intensity and shape re-style
  the grid, and the applied look while it is still the latest change (the
  engine merges the new stack into that same step). A look (or the design
  read back for styling) lands only on the design it was asked for
  (`session.isOpenDesign`): one that comes back after another design
  opened, or while one is on its way in, is dropped. The command palette
  applies a preset through `panelRequests.style`.
-->
<script module lang="ts">
  import type { Pixels } from '$engine/filters/types';
  import type { PresetId } from '$engine/presets';
  import type { BackdropShape } from '$engine/backdrop/shapes';

  /** Thumbnails by icon + preset + size + options (kept across tab switches). */
  const thumbCache = new Map<string, Pixels>();
  /** A few option sets' worth of grids (12 each), a few MB at most. */
  const MAX_CACHE = 96;

  function remember(key: string, px: Pixels): void {
    thumbCache.set(key, px);
    while (thumbCache.size > MAX_CACHE) thumbCache.delete(thumbCache.keys().next().value!);
  }

  /**
   * Designs without an original icon are styled from their composite. Once
   * a look is applied, that composite is the styled one, so the unstyled
   * source is kept per document together with the history entry of the look
   * built from it: while that look is still the latest change, reopening the
   * panel styles the same source again (not a style of a style).
   */
  const designSources = new WeakMap<object, { source: Pixels; entry: number | null }>();

  /** The look last applied to each document (its preset and history entry), so the panel shows it again after a tab switch. */
  const appliedLooks = new WeakMap<object, { id: PresetId; entry: number | null }>();

  interface Tuning {
    matchIcon: boolean;
    hue: number;
    intensity: number;
    shape: 'auto' | BackdropShape;
  }

  /** The Tune settings per document: re-styling after a tab switch keeps the earlier choices. */
  const tunings = new WeakMap<object, Tuning>();
</script>

<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import WandSparkles from '@lucide/svelte/icons/wand-sparkles';
  import { BACKDROP_SHAPES } from '$engine/backdrop/shapes';
  import { applyPresetResult, DEFAULT_PRESET_OPTIONS, PRESETS, getPreset, type PresetOptions } from '$engine/presets';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../../state/context';
  import { watchDpr } from '../common/canvas';
  import PixelThumb from '../common/PixelThumb.svelte';
  import Section from '../common/Section.svelte';
  import { debounce } from '../common/schedule';
  import { panelRequests } from '../requests.svelte';
  import { isCancelled } from '../worker/client';
  import { snapshotDoc, snapshotTransfer } from '../worker/snapshot';
  import { presetRecipe, type PresetBuilder } from './recipe';

  const session = getSession();
  const engine = session.engine;
  const TILE = 76;

  let dpr = $state(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  const thumbSize = $derived(Math.min(192, Math.round(TILE * dpr)));

  // ---- the source icon -----------------------------------------------------------------
  /**
   * Content key of an icon: every pixel counts, since the worker caches the
   * icon analysis under it (a sampled hash could hand one icon another's
   * analysis). Two FNV-style lanes over 32-bit words: ~1 ms for 256².
   */
  function hashPixels(p: { width: number; height: number; data: Uint8ClampedArray }): string {
    const d = p.data;
    const words = d.byteOffset % 4 === 0 ? new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2) : new Uint32Array(d.slice().buffer);
    let h1 = 2166136261;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      h1 = Math.imul(h1 ^ w, 16777619);
      h2 = Math.imul(h2 ^ w, 0x85ebca6b) ^ (h2 >>> 13);
    }
    return `${p.width}x${p.height}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  }

  let designSource = $state.raw<Pixels | null>(null);
  /** Whether there is an icon to style is known (reading the design back takes a moment). */
  let sourceKnown = $state(false);
  const icon = $derived<Pixels | null>(session.original ? { width: session.original.width, height: session.original.height, data: session.original.data } : designSource);
  const iconKey = $derived(icon ? hashPixels(icon) : '');

  onMount(() => {
    const kept = designSources.get(engine.doc);
    if (!session.original && kept && kept.entry === engine.currentEntryId) {
      designSource = kept.source;
      sourceKnown = true;
    } else if (!session.original) {
      // No original icon (a blank design or an image): style the current
      // design, composited in the worker through the export path.
      const token = session.designToken;
      const snap = snapshotDoc(engine.doc);
      session.panels
        .request({ op: 'renderSizes', doc: snap, sizes: [256] }, { transfer: snapshotTransfer(snap) })
        .then(([r]) => {
          if (!session.isOpenDesign(token)) return;
          const px = r?.pixels;
          const empty = !px || !px.data.some((v, i) => i % 4 === 3 && v > 0);
          designSource = empty ? null : px;
        })
        .catch((e: unknown) => console.warn('could not read the design for presets', e))
        .finally(() => (sourceKnown = true));
    } else {
      sourceKnown = true;
    }
    return watchDpr((d) => (dpr = d));
  });

  // ---- options -----------------------------------------------------------------------------
  const tuned = tunings.get(engine.doc);
  let matchIcon = $state(tuned?.matchIcon ?? true);
  let hue = $state(tuned?.hue ?? DEFAULT_PRESET_OPTIONS.hue ?? 220);
  let intensity = $state(tuned?.intensity ?? 50);
  let shape = $state<'auto' | BackdropShape>(tuned?.shape ?? 'auto');

  $effect(() => {
    tunings.set(engine.doc, { matchIcon, hue, intensity, shape });
  });

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
      session.panels
        .request({ op: 'presetThumb', iconKey: key, icon: copy, id: p.id, size, options: opts }, { channel: `preset-thumb-${p.id}`, transfer: [copy.data.buffer], priority: 'low' })
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
  const lastLook = appliedLooks.get(engine.doc);
  const lookIsLatest = lastLook !== undefined && lastLook.entry !== null && lastLook.entry === engine.currentEntryId;
  let applying = $state<PresetId | null>(null);
  let applied = $state<PresetId | null>(lookIsLatest ? lastLook.id : null);
  /** History entry of our last apply (re-styled in place while it is the latest). */
  let appliedEntry: number | null = lookIsLatest ? lastLook.entry : null;

  /** The applied look is still the latest change. */
  function lookIsCurrent(): boolean {
    return appliedEntry !== null && engine.currentEntryId === appliedEntry;
  }

  const builder: PresetBuilder = (id, src, size, opts) => {
    const copy = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
    return session.panels.request({ op: 'presetBuild', iconKey: hashPixels(copy), icon: copy, id, size, options: opts }, { transfer: [copy.data.buffer] });
  };

  /** Options changed while a look was being applied: re-style once it lands. */
  let restyleAgain = false;

  async function apply(id: PresetId, inPlace = false): Promise<void> {
    const src = icon;
    if (!src) return;
    if (applying) {
      if (inPlace) restyleAgain = true;
      return;
    }
    applying = id;
    const opts = $state.snapshot(options) as Partial<PresetOptions>;
    const label = getPreset(id).label;
    const token = session.designToken;
    const doc = engine.doc;
    try {
      const copy = { width: src.width, height: src.height, data: src.data.slice() };
      const result = await session.panels.request(
        { op: 'presetBuild', iconKey, icon: copy, id, size: doc.width, options: opts },
        { channel: 'preset-apply', transfer: [copy.data.buffer] },
      );
      // Another design was opened meanwhile (or is being opened, or this one
      // changed size — pixel-art mode): this look was not meant for it.
      if (!session.isOpenDesign(token) || engine.doc.width !== result.size) return;
      // Re-styling only while the look is still the latest change (the user
      // may have edited meanwhile); the same merge key then replaces it in
      // place instead of stacking another step.
      if (inPlace && !lookIsCurrent()) return;
      applyPresetResult(engine, result, { label: `Style: ${label}`, mergeKey: `style:${id}` });
      appliedEntry = engine.currentEntryId;
      applied = id;
      appliedLooks.set(doc, { id, entry: appliedEntry });
      if (!session.original) designSources.set(doc, { source: src, entry: appliedEntry });
      session.recipe = presetRecipe(id, label, opts, builder);
    } catch (e) {
      if (!isCancelled(e)) toast({ message: `Could not apply ${label}: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' });
    } finally {
      applying = null;
      if (restyleAgain && !destroyed) {
        restyleAgain = false;
        restyle();
      }
    }
  }

  // Re-style the applied look when the options change (only while it is the latest change).
  const restyle = debounce(() => {
    if (applied && lookIsCurrent()) void apply(applied, true);
  }, 280);

  // The command palette asked for a preset (it may have loaded this panel
  // for it): apply it once the icon to style is known.
  $effect(() => {
    const asked = panelRequests.style;
    if (!asked || !sourceKnown) return;
    untrack(() => {
      panelRequests.style = null;
      if (icon) void apply(asked);
    });
  });

  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    refreshThumbs.cancel();
    restyle.cancel();
  });

  // Only real option changes re-style (not the panel opening).
  let seenOptions = untrack(() => optionsKey);
  $effect(() => {
    const key = optionsKey;
    if (key === seenOptions) return;
    seenOptions = key;
    untrack(() => restyle());
  });

  // The applied marker follows undo / other edits.
  const stillApplied = $derived.by(() => {
    void session.rev.history;
    return applied !== null && lookIsCurrent();
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
            aria-disabled={applying !== null && applying !== p.id}
            title={p.description}
            class:waiting={applying !== null}
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
  .tile:hover:not(.waiting) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .tile.waiting {
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
  .tile:hover:not(.waiting) .thumb {
    transform: scale(1.04);
  }
  .tile:active:not(.waiting) .thumb {
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

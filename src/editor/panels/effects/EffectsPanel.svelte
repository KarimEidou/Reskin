<!--
  Effects panel: the active layer's non-destructive effects (drop shadow,
  outer glow, outline, colour overlay, inner shadow). Add from the menu or
  the quick chips; each card has an enable switch, remove, and its
  parameters. A slider or colour drag is one undo step (its updates merge;
  a new drag seals the previous step so two drags never merge). The
  layer's effects are a step of the design's recipe ("Apply style to all").
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Plus from '@lucide/svelte/icons/plus';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { cloneEffects, createEffect, parseColor, scaleEffect, type EffectType, type LayerEffect } from '$engine/index';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import { getSession } from '../../state/context';
  import ColorField from '../color/ColorField.svelte';
  import { hexOf } from '../common/color';
  import { throttle } from '../common/schedule';
  import { onSliderPress } from '../common/seal';
  import { chainRecipes, effectsRecipe } from '../styles/recipe';
  import { EFFECTS, effectInfo, pxRange, type EffectField } from './fields';

  const session = getSession();
  const engine = session.engine;

  const layer = $derived.by(() => {
    void session.rev.layers;
    void session.rev.document;
    void session.rev.history;
    const l = engine.activeLayer;
    return l ? { id: l.id, name: l.name, effects: cloneEffects(l.effects), size: engine.doc.width } : null;
  });

  let collapsed = $state<Record<string, boolean>>({});

  function commit(effects: LayerEffect[], merge?: string): void {
    const l = layer;
    if (!l) return;
    if (!engine.setLayerProps(l.id, { effects }, merge ? { merge } : {})) return;
    session.recipe = chainRecipes(session.recipe, effectsRecipe(l.name, effects, l.size));
  }

  function add(type: EffectType): void {
    const l = layer;
    if (!l) return;
    // Defaults are designed for 512 px documents.
    commit([...l.effects, scaleEffect(createEffect(type), l.size / 512)]);
  }

  let root: HTMLDivElement | undefined = $state();

  function remove(i: number): void {
    const l = layer;
    if (!l) return;
    // The card (and its focused button) goes away: keep focus in the panel.
    if (root?.contains(document.activeElement)) root.focus();
    commit(l.effects.filter((_, k) => k !== i));
  }

  /**
   * Changes one effect. `key` names a continuous control (slider, colour
   * drag) whose updates merge into one undo step; discrete changes (switch,
   * choice) pass null and are always their own step.
   */
  function patch(i: number, change: Partial<Record<string, unknown>>, key: string | null): void {
    const l = layer;
    if (!l || !l.effects[i]) return;
    const next = cloneEffects(l.effects);
    next[i] = { ...next[i], ...change } as LayerEffect;
    commit(next, key === null ? undefined : `fx:${i}:${key}`);
  }

  // Slider drags: effects re-render the whole layer, so update the engine at
  // most every 90 ms while dragging (the final value is always applied).
  const live = throttle((i: number, change: Partial<Record<string, unknown>>, key: string) => patch(i, change, key), 90);
  // Leaving the panel mid-drag applies the latest value now, not after the component is gone.
  onDestroy(() => live.flush());

  function valueOf(e: LayerEffect, key: string): unknown {
    return (e as unknown as Record<string, unknown>)[key];
  }

  const addItems = EFFECTS.map((e) => ({ id: e.type, label: e.label }));
  const numeric = (v: unknown) => (typeof v === 'number' ? v : 0);
</script>

{#snippet field(e: LayerEffect, i: number, f: EffectField)}
  {#if f.kind === 'color'}
    <ColorField
      label={f.label}
      value={hexOf(e.color)}
      onstart={() => engine.sealHistory()}
      oninput={(h) => live(i, { color: parseColor(h) ?? e.color }, 'color')}
      onchange={(h) => {
        live.cancel();
        patch(i, { color: parseColor(h) ?? e.color }, 'color');
      }}
    />
  {:else if f.kind === 'percent'}
    <Slider
      label={f.label}
      value={Math.round(e.opacity * 100)}
      min={0}
      max={100}
      unit="%"
      oninput={(v) => live(i, { opacity: v / 100 }, 'opacity')}
      onchange={(v) => {
        live.cancel();
        patch(i, { opacity: v / 100 }, 'opacity');
      }}
    />
  {:else if f.kind === 'angle'}
    <Slider
      label={f.label}
      value={Math.round(numeric(valueOf(e, 'angle')))}
      min={0}
      max={360}
      unit="°"
      oninput={(v) => live(i, { angle: v }, 'angle')}
      onchange={(v) => {
        live.cancel();
        patch(i, { angle: v }, 'angle');
      }}
    />
  {:else if f.kind === 'px'}
    {@const r = pxRange(f, layer?.size ?? 512)}
    <Slider
      label={f.label}
      value={numeric(valueOf(e, f.key))}
      min={r.min}
      max={r.max}
      step={r.step}
      format={(v) => `${Number(v.toFixed(2))} px`}
      oninput={(v) => live(i, { [f.key]: v }, f.key)}
      onchange={(v) => {
        live.cancel();
        patch(i, { [f.key]: v }, f.key);
      }}
    />
  {:else if f.kind === 'segment'}
    <SegmentedControl label={f.label} size="sm" fullWidth options={f.options} value={String(valueOf(e, f.key))} onchange={(v) => patch(i, { [f.key]: v }, null)} />
  {:else if f.kind === 'select'}
    <Select label={f.label} size="sm" options={f.options} value={String(valueOf(e, f.key))} onchange={(v) => patch(i, { [f.key]: v }, null)} />
  {/if}
{/snippet}

<div class="effects" data-testid="effects-panel" tabindex="-1" bind:this={root} {@attach onSliderPress(() => engine.sealHistory())}>
  {#if !layer}
    <EmptyState icon={Sparkles} title="No layer selected" description="Select a layer to give it shadows, glows and outlines." compact />
  {:else}
    <div class="head">
      <div class="title">
        <span class="kicker">Effects on</span>
        <span class="name">{layer.name}</span>
      </div>
      <Menu label="Add effect" icon={Plus} size="sm" variant="secondary" items={addItems} placement="bottom-end" onselect={(id) => add(id as EffectType)} />
    </div>

    {#if layer.effects.length === 0}
      <div class="empty">
        <EmptyState icon={Sparkles} title="No effects yet" description="Effects are non-destructive: tweak or remove them any time." compact>
          <div class="quick">
            <Button size="sm" onclick={() => add('dropShadow')}>Drop shadow</Button>
            <Button size="sm" onclick={() => add('outerGlow')}>Glow</Button>
            <Button size="sm" onclick={() => add('outline')}>Outline</Button>
          </div>
        </EmptyState>
      </div>
    {:else}
      <ol class="list">
        {#each layer.effects as e, i (i)}
          {@const info = effectInfo(e.type)}
          {@const key = `${layer.id}:${i}`}
          <li class="card" class:off={!e.enabled} data-testid="effect-card" data-effect={e.type}>
            <div class="card-head">
              <button
                type="button"
                class="expand"
                aria-expanded={!collapsed[key]}
                aria-controls="fx-{i}"
                onclick={() => (collapsed[key] = !collapsed[key])}
              >
                <span class="chev" class:open={!collapsed[key]} aria-hidden="true"><ChevronRight size={14} /></span>
                <span class="fx-name">{info.label}</span>
              </button>
              <Toggle label="{info.label} enabled" hideLabel size="sm" checked={e.enabled} onchange={(on) => patch(i, { enabled: on }, null)} />
              <IconButton label="Remove {info.label.toLowerCase()}" icon={Trash2} size="sm" onclick={() => remove(i)} data-testid="remove-effect" />
            </div>
            {#if !collapsed[key]}
              <div class="fields" id="fx-{i}">
                {#each info.fields as f (f.key)}
                  {@render field(e, i, f)}
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</div>

<style>
  .effects {
    display: flex;
    flex-direction: column;
    padding-bottom: var(--space-3);
  }
  .effects:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
  }
  .title {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .kicker {
    color: var(--text-3);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .name {
    overflow: hidden;
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    padding: var(--space-4) var(--space-3);
  }
  .quick {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-1);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0 var(--space-3);
    list-style: none;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  .card.off .fields,
  .card.off .fx-name {
    opacity: 0.55;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-2);
  }
  .expand {
    display: inline-flex;
    flex: 1;
    align-items: center;
    gap: var(--space-1);
    min-width: 0;
    height: 28px;
    padding: 0 var(--space-1);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-weight: var(--weight-medium);
    text-align: left;
    cursor: default;
  }
  .expand:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 0;
  }
  .chev {
    display: inline-flex;
    color: var(--text-3);
    transition: transform var(--dur-2) var(--ease-standard);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-1) var(--space-3) var(--space-3);
  }
</style>

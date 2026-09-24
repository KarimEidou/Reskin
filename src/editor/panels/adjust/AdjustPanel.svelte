<!--
  Adjust panel: filters grouped by category and the icon helpers. Picking
  one opens its settings with a LIVE preview on the active image layer
  (limited to the selection when there is one), computed off the main
  thread and shown through an engine layer preview: the canvas follows
  every change, the history does not. Apply records the adjustment as one
  undo step, Cancel restores the layer byte for byte, Reset returns to the
  defaults. Anything else that changes the design ends the preview (the
  engine restores the layer) and closes the settings.
-->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ImageOff from '@lucide/svelte/icons/image-off';
  import Lock from '@lucide/svelte/icons/lock';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import SquareDashedMousePointer from '@lucide/svelte/icons/square-dashed-mouse-pointer';
  import { FILTER_CATEGORIES, FILTER_LIST, defaultParams, getFilter, type FilterId } from '$engine/filters';
  import { isFilterCancelled } from '$engine/filters/client';
  import type { LayerPreview } from '$engine/index';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../../state/context';
  import Section from '../common/Section.svelte';
  import { chainRecipes, filterRecipe, helperRecipe } from '../styles/recipe';
  import { isCancelled } from '../worker/client';
  import { HELPERS, defaultValues, getHelper, type ControlSpec, type ControlValue, type ControlValues, type HelperId } from './helper-defs';
  import ParamControls from './ParamControls.svelte';

  const session = getSession();
  const engine = session.engine;

  type Target = { kind: 'filter'; id: FilterId } | { kind: 'helper'; id: HelperId };

  interface Editing {
    target: Target;
    label: string;
    description: string;
    params: readonly ControlSpec[];
    usesSelection: boolean;
    /** Name of the layer being adjusted (the active layer may change meanwhile). */
    layerName: string;
  }

  const layer = $derived.by(() => {
    void session.rev.layers;
    void session.rev.document;
    void session.rev.history;
    const l = engine.activeLayer;
    return l ? { id: l.id, name: l.name, kind: l.kind, locked: l.locked, visible: l.visible } : null;
  });
  const hasSelection = $derived.by(() => {
    void session.rev.selection;
    return engine.doc.selection !== null;
  });

  let editing = $state<Editing | null>(null);
  let values = $state<ControlValues>({});
  let busy = $state(false);
  let live: LayerPreview | null = null;
  let seq = 0;
  let latest: Promise<void> = Promise.resolve();

  function describe(t: Target, layerName: string): Editing {
    if (t.kind === 'filter') {
      const f = getFilter(t.id);
      return { target: t, label: f.label, description: f.description, params: f.params, usesSelection: true, layerName };
    }
    const h = getHelper(t.id);
    return { target: t, label: h.label, description: h.description, params: h.params, usesSelection: h.usesSelection, layerName };
  }

  function initial(t: Target): ControlValues {
    return t.kind === 'filter' ? (structuredClone(defaultParams(t.id)) as unknown as ControlValues) : defaultValues(getHelper(t.id).params);
  }

  let editorEl: HTMLDivElement | undefined = $state();
  let root: HTMLDivElement | undefined = $state();

  /** The editor is about to close: move focus out of it first. */
  function park(): void {
    if (editorEl?.contains(document.activeElement)) root?.focus();
  }

  function open(t: Target): void {
    const l = engine.activeLayer;
    if (!l || l.kind !== 'raster' || l.locked) return;
    finish(true);
    const info = describe(t, l.name);
    // Commits a pending transform (the user's finished move) first.
    const preview = engine.beginPreview(info.label, { layerId: l.id });
    if (!preview) return;
    live = preview;
    values = initial(t);
    editing = info;
    compute();
    void tick().then(() => editorEl?.querySelector<HTMLElement>('input, button:not(.back), select')?.focus());
  }

  /** Recomputes the preview from the untouched pixels (latest request wins). */
  function compute(): void {
    const e = editing;
    const edit = live;
    if (!e || !edit) return;
    if (!edit.active) {
      staleEnd();
      return;
    }
    const token = ++seq;
    const { width, height, data } = edit.original;
    const src = { width, height, data: data.slice() };
    const sel = e.usesSelection ? engine.doc.selection : null;
    const mask = sel && sel.width === src.width && sel.height === src.height ? sel.data.slice() : null;
    const params = $state.snapshot(values) as Record<string, unknown>;
    busy = true;
    const job =
      e.target.kind === 'filter'
        ? session.filters.run(e.target.id, src, params, { channel: 'adjust', mask, transfer: true })
        : session.panels.request({ op: 'helper', id: e.target.id, pixels: src, values: params, mask }, { channel: 'adjust-helper', transfer: [src.data.buffer] });
    latest = job.then(
      (px) => {
        if (token !== seq || live !== edit) return;
        busy = false;
        if (!edit.update(px)) staleEnd();
      },
      (err: unknown) => {
        if (isFilterCancelled(err) || isCancelled(err)) return;
        if (token === seq) busy = false;
        toast({ message: `Preview failed: ${err instanceof Error ? err.message : String(err)}`, kind: 'error' });
      },
    );
  }

  /** The preview ended without us (Ctrl+Z, painting, the layer locked or deleted…): close the settings. */
  function staleEnd(): void {
    park();
    session.filters.cancel('adjust');
    session.panels.cancel('adjust-helper');
    seq++;
    live = null;
    editing = null;
    busy = false;
  }

  // The engine ends the preview as soon as something else changes the
  // design; close the settings right then, not on the next slider change.
  $effect(() => {
    void session.rev.preview;
    untrack(() => {
      if (editing && live && !live.active) staleEnd();
    });
  });

  function setValue(key: string, v: ControlValue): void {
    values[key] = v;
    compute();
  }

  function reset(): void {
    const e = editing;
    if (!e) return;
    values = initial(e.target);
    compute();
  }

  async function apply(): Promise<void> {
    const e = editing;
    const edit = live;
    if (!e || !edit) return;
    await latest;
    if (live !== edit) return;
    park();
    const kept = edit.commit();
    const params = $state.snapshot(values) as Record<string, unknown>;
    if (kept) {
      const step = e.target.kind === 'filter' ? filterRecipe(e.target.id, e.label, params) : helperRecipe(e.target.id, e.label, params);
      session.recipe = chainRecipes(session.recipe, step);
    }
    live = null;
    editing = null;
    busy = false;
  }

  function cancel(): void {
    park();
    session.filters.cancel('adjust');
    session.panels.cancel('adjust-helper');
    seq++;
    live?.cancel();
    live = null;
    editing = null;
    busy = false;
  }

  /** Leaving the panel keeps what is on the canvas. */
  function finish(keep: boolean): void {
    if (!live) return;
    session.filters.cancel('adjust');
    session.panels.cancel('adjust-helper');
    seq++;
    if (keep) live.commit();
    else live.cancel();
    live = null;
    editing = null;
    busy = false;
  }

  onDestroy(() => finish(true));

  function onEditorKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void apply();
    }
  }

  /** Shorter names where the full one does not fit a half-width button. */
  const SHORT: Partial<Record<FilterId, string>> = {
    brightnessContrast: 'Brightness',
    chromaticAberration: 'Chromatic',
    gradientMap: 'Gradient map',
  };

  const byCategory = FILTER_CATEGORIES.map((c) => ({ ...c, filters: FILTER_LIST.filter((f) => f.category === c.id) }));
  const blocked = $derived(!layer ? 'none' : layer.kind === 'text' ? 'text' : layer.locked ? 'locked' : null);
</script>

<div class="adjust" data-testid="adjust-panel" tabindex="-1" bind:this={root}>
  {#if editing}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="editor" bind:this={editorEl} onkeydown={onEditorKey} data-testid="adjust-editor">
      <div class="editor-head">
        <IconButton label="Back to adjustments (cancel)" icon={ChevronLeft} size="sm" class="back" onclick={cancel} />
        <div class="title">
          <h3>{editing.label}</h3>
          <p>{editing.description}</p>
        </div>
        {#if busy}<Spinner size={14} label="Updating preview" />{/if}
      </div>
      <div class="scope">
        {#if hasSelection && editing.usesSelection}
          <span class="chip"><SquareDashedMousePointer size={13} aria-hidden="true" /> Only the selection changes</span>
        {:else}
          <span class="chip">On “{editing.layerName}”</span>
        {/if}
      </div>
      {#if editing.params.length > 0}
        <div class="params">
          <ParamControls params={editing.params} {values} oninput={setValue} onchange={setValue} />
        </div>
      {:else}
        <p class="noparams">No settings — the preview shows the result.</p>
      {/if}
      <div class="actions">
        <Button size="sm" variant="ghost" icon={RotateCcw} onclick={reset} disabled={editing.params.length === 0}>Reset</Button>
        <span class="grow"></span>
        <Button size="sm" onclick={cancel} data-testid="adjust-cancel">Cancel</Button>
        <Button size="sm" variant="primary" onclick={() => void apply()} data-testid="adjust-apply">Apply</Button>
      </div>
    </div>
  {:else if blocked === 'none'}
    <EmptyState icon={ImageOff} title="No layer selected" description="Select an image layer to adjust it." compact />
  {:else}
    {#if blocked === 'text'}
      <div class="notice">
        <p>“{layer?.name}” is a text layer. Rasterize it to adjust its pixels.</p>
        <Button size="sm" onclick={() => layer && engine.rasterizeLayer(layer.id)}>Rasterize text</Button>
      </div>
    {:else if blocked === 'locked'}
      <div class="notice">
        <p><Lock size={13} aria-hidden="true" /> “{layer?.name}” is locked.</p>
        <Button size="sm" onclick={() => layer && engine.setLayerProps(layer.id, { locked: false })}>Unlock</Button>
      </div>
    {:else}
      <p class="target">
        Adjusting <strong>{layer?.name}</strong>{#if hasSelection}<span class="sel"> · selection only</span>{/if}
      </p>
    {/if}

    {#each byCategory as cat (cat.id)}
      <Section title={cat.label}>
        <div class="grid">
          {#each cat.filters as f (f.id)}
            <button type="button" class="item" title={f.description} disabled={blocked !== null} onclick={() => open({ kind: 'filter', id: f.id })} data-filter={f.id} aria-label={f.label}>
              {SHORT[f.id] ?? f.label}
            </button>
          {/each}
        </div>
      </Section>
    {/each}

    <Section title="Icon helpers">
      <div class="helpers">
        {#each HELPERS as h (h.id)}
          <button type="button" class="helper" disabled={blocked !== null} onclick={() => open({ kind: 'helper', id: h.id })} data-helper={h.id}>
            <span class="h-label">{h.label}</span>
            <span class="h-desc">{h.description}</span>
          </button>
        {/each}
      </div>
    </Section>
  {/if}
</div>

<style>
  .adjust {
    display: flex;
    flex-direction: column;
  }
  .adjust:focus {
    outline: none;
  }
  .target {
    margin: 0;
    padding: var(--space-3) var(--space-3) 0;
    overflow: hidden;
    color: var(--text-2);
    font-size: var(--text-sm);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .target strong {
    color: var(--text);
    font-weight: var(--weight-medium);
  }
  .sel {
    color: var(--accent-text);
  }
  .notice {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    margin: var(--space-3) var(--space-3) 0;
    padding: var(--space-3);
    border: 1px solid rgb(var(--warning-rgb) / 0.35);
    border-radius: var(--radius-lg);
    background: rgb(var(--warning-rgb) / 0.08);
  }
  .notice p {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
    font-size: var(--text-sm);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-1);
  }
  .item {
    height: 30px;
    padding: 0 var(--space-2);
    overflow: hidden;
    border: 1px solid var(--control-border);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text);
    font-size: var(--text-sm);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      border-color var(--fade-1) linear;
  }
  .item:hover:not(:disabled),
  .helper:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--control-fill-hover);
  }
  .item:disabled,
  .helper:disabled {
    opacity: 0.45;
  }
  .item:focus-visible,
  .helper:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .helpers {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .helper {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-2) var(--space-2-5, 10px);
    border: 1px solid var(--control-border);
    border-radius: var(--radius-md);
    background: var(--control-fill);
    color: var(--text);
    text-align: left;
    cursor: default;
  }
  .h-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .h-desc {
    color: var(--text-3);
    font-size: var(--text-xs);
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3) var(--space-3);
  }
  .editor-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }
  .title {
    flex: 1;
    min-width: 0;
    padding-top: 3px;
  }
  h3 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-semibold);
  }
  .title p {
    margin: 2px 0 0;
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .scope {
    display: flex;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    max-width: 100%;
    padding: 2px var(--space-2);
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--surface-3);
    color: var(--text-2);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .params {
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  .noparams {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .grow {
    flex: 1;
  }
</style>

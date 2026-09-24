<!--
  Tool options bar (top of the canvas): context options of the active tool
  through engine.getToolOptions / setToolOptions, symmetry for the painting
  tools, selection commands for the selection tools, transform apply /
  cancel for Move. Controls the bar has no room for are in "More options".
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Maximize from '@lucide/svelte/icons/maximize';
  import X from '@lucide/svelte/icons/x';
  import type { GradientStop, ShapeKind, TextProps, ToolId } from '$engine/index';
  import { toHex } from '$engine/index';
  import Button from '$lib/ui/Button.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { getSession } from '../state/context';
  import { gradientCss } from './gradient-css';
  import { colorPicker, fontPicker, gradientStops as stopsEditor } from './lazy.svelte';
  import MoreOptions from './MoreOptions.svelte';
  import OptionControl from './OptionControl.svelte';
  import { SHAPE_CHOICES, TOOL_OPTION_SPECS, visibleSpecs, type OptionSpec, type SliderSpec } from './options-schema';
  import PillSlider from './PillSlider.svelte';
  import SymmetryControl from './SymmetryControl.svelte';
  import { stage } from './stage.svelte';
  import { SELECTION_TOOLS, SYMMETRY_TOOLS } from './tool-groups';
  import { CHOICE_ICONS, TOOL_ICONS } from './tool-icons';

  const session = getSession();
  const engine = session.engine;

  /** Gap between controls (matches `.controls` gap). */
  const GAP = 8;
  /** Width assumed for a control that has never been measured. */
  const DEFAULT_SLOT_WIDTH = 140;
  const TEXT_KEYS = new Set(['fontFamily', 'fontSize', 'weight', 'italic', 'align']);
  const FEATHER: SliderSpec = { kind: 'slider', key: 'radius', label: 'Radius', min: 1, max: 64, step: 1, unit: 'px', priority: 1 };

  const toolId = $derived.by((): ToolId => {
    void session.rev.tool;
    return engine.selectedToolId;
  });
  const options = $derived.by(() => {
    void session.rev.tool;
    return engine.getToolOptions(toolId) as unknown as Record<string, unknown>;
  });
  const label = $derived(engine.tools[toolId].label);
  const Icon = $derived(TOOL_ICONS[toolId]);
  const allSpecs = $derived(TOOL_OPTION_SPECS[toolId] as readonly OptionSpec[]);
  const specs = $derived(visibleSpecs(allSpecs, options));
  const inline = $derived(specs.filter((s) => s.priority === 1));
  const hasMore = $derived(specs.some((s) => s.priority === 2));

  // ---- fitting the bar: trailing inline controls that do not fit move to "More" ----
  let controlsEl: HTMLDivElement | undefined = $state();
  let slotEls: HTMLDivElement[] = $state([]);
  let visibleCount = $state(Number.POSITIVE_INFINITY);
  const slotWidths = new Map<string, number>();
  const slotKey = (spec: OptionSpec) => `${toolId}:${spec.key}:${spec.label}`;
  const overflowing = $derived(visibleCount < inline.length);

  function fit(): void {
    const el = controlsEl;
    if (!el) return;
    inline.forEach((spec, i) => {
      const w = slotEls[i]?.offsetWidth ?? 0;
      if (w > 0) slotWidths.set(slotKey(spec), w);
    });
    // Width of the controls that always stay (layout-less wrappers such as
    // tooltips are looked through).
    let fixed = 0;
    const measureFixed = (parent: Element) => {
      for (const child of parent.children) {
        const c = child as HTMLElement;
        if (c.dataset.slot !== undefined || c.classList.contains('hint')) continue;
        if (getComputedStyle(c).display === 'contents') measureFixed(c);
        else if (c.offsetWidth > 0) fixed += c.offsetWidth + GAP;
      }
    };
    measureFixed(el);
    const style = getComputedStyle(el);
    let room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - fixed;
    let count = 0;
    for (const spec of inline) {
      const w = (slotWidths.get(slotKey(spec)) ?? DEFAULT_SLOT_WIDTH) + GAP;
      if (w > room + GAP) break;
      room -= w;
      count++;
    }
    visibleCount = count;
  }

  // Re-fit when the tool or its visible options change (show everything,
  // measure, then hide what does not fit — all before the frame paints).
  const inlineKey = $derived(inline.map(slotKey).join('|'));
  $effect(() => {
    void inlineKey;
    visibleCount = Number.POSITIVE_INFINITY;
    queueMicrotask(fit);
  });

  $effect(() => {
    const el = controlsEl;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      visibleCount = Number.POSITIVE_INFINITY;
      queueMicrotask(fit);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  const pending = $derived.by(() => {
    void session.rev.tool;
    void session.rev.history;
    void session.rev.interaction;
    return engine.hasPending;
  });
  const hasSelection = $derived.by(() => {
    void session.rev.selection;
    void session.rev.document;
    return engine.doc.selection !== null;
  });
  const activeText = $derived.by(() => {
    void session.rev.layers;
    void session.rev.textEdit;
    const l = engine.activeLayer;
    return l?.kind === 'text' ? l : null;
  });
  const textColor = $derived.by(() => {
    void session.rev.color;
    void session.rev.layers;
    return activeText ? { ...activeText.color } : engine.primary;
  });
  const colors = $derived.by(() => {
    void session.rev.color;
    return { primary: engine.primary, secondary: engine.secondary };
  });

  function set(key: string, value: unknown): void {
    engine.setToolOptions(toolId, { [key]: value } as never);
    // With the text tool, the text being edited (or the selected text layer) follows.
    if (toolId === 'text' && activeText && TEXT_KEYS.has(key)) {
      engine.updateText(activeText.id, { [key]: value } as Partial<TextProps>);
    }
  }

  // Tool-specific editors load on first use.
  $effect(() => {
    if (toolId === 'text') {
      fontPicker.preload();
      colorPicker.preload();
    } else if (toolId === 'gradient') {
      stopsEditor.preload();
    }
  });

  // Selecting a text layer with the text tool shows its type settings.
  $effect(() => {
    const l = activeText;
    if (toolId !== 'text' || !l) return;
    const o = engine.getToolOptions('text');
    if (
      o.fontFamily !== l.fontFamily ||
      o.fontSize !== l.fontSize ||
      o.weight !== l.weight ||
      o.italic !== l.italic ||
      o.align !== l.align
    ) {
      engine.setToolOptions('text', {
        fontFamily: l.fontFamily,
        fontSize: l.fontSize,
        weight: l.weight,
        italic: l.italic,
        align: l.align,
      });
    }
  });

  function setTextColor(color: TextProps['color']): void {
    if (activeText) engine.updateText(activeText.id, { color });
    else engine.setColor('primary', color);
  }

  // ---- shape kind menu ----
  const shape = $derived(SHAPE_CHOICES.find((c) => c.value === options.kind) ?? SHAPE_CHOICES[0]!);
  const ShapeIcon = $derived(CHOICE_ICONS[shape.icon ?? 'shapeRect']!);
  const shapeItems = $derived(
    SHAPE_CHOICES.map((c) => ({
      id: c.value,
      label: c.label,
      icon: c.icon ? CHOICE_ICONS[c.icon] : undefined,
      checked: c.value === options.kind,
    })),
  );

  // ---- gradient ----
  const gradientStops = $derived.by((): GradientStop[] => {
    const own = options.stops as GradientStop[] | undefined;
    if (options.source === 'custom' && own) return own;
    return [
      { offset: 0, color: colors.primary },
      { offset: 1, color: colors.secondary },
    ];
  });

  function editStops(stops: GradientStop[]): void {
    engine.setToolOptions('gradient', { source: 'custom', stops });
  }

  // ---- popovers (text colour, feather) ----
  let colorOpen = $state(false);
  let colorAnchor: HTMLButtonElement | undefined = $state();
  let featherOpen = $state(false);
  let featherAnchor: HTMLElement | undefined = $state();
  let featherRadius = $state(4);
</script>

<div
  class="options"
  role="group"
  aria-label="{label} options"
  data-testid="tool-options"
  data-tool={toolId}
  data-keeps-text-edit
>
  <div class="tool-name" aria-hidden="true">
    <Icon size={16} strokeWidth={1.75} />
    <span>{label}</span>
  </div>
  <span class="divider" aria-hidden="true"></span>

  <div class="controls" bind:this={controlsEl}>
    {#if toolId === 'text'}
      {#if fontPicker.current}
        {@const Fonts = fontPicker.current}
        <Fonts value={String(options.fontFamily ?? 'Segoe UI')} onchange={(f: string) => set('fontFamily', f)} />
      {:else}
        <span class="placeholder font" aria-hidden="true">{String(options.fontFamily ?? '')}</span>
      {/if}
    {:else if toolId === 'shape'}
      <Menu label="Shape" items={shapeItems} onselect={(id) => set('kind', id as ShapeKind)}>
        {#snippet trigger(props)}
          <button {...props} type="button" class="menu-button" aria-label="Shape: {shape.label}">
            <ShapeIcon size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{shape.label}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        {/snippet}
      </Menu>
    {:else if toolId === 'gradient'}
      <div class="slot">
        <SegmentedControl
        size="sm"
        label="Gradient colours"
        options={[
          { value: 'colors', label: 'Colours' },
          { value: 'custom', label: 'Custom' },
        ]}
        value={String(options.source)}
        onchange={(v) => engine.setToolOptions('gradient', { source: v as 'colors' | 'custom' })}
        />
      </div>
      {#if stopsEditor.current}
        {@const Stops = stopsEditor.current}
        <Stops stops={gradientStops} onchange={editStops} />
      {:else}
        <span class="placeholder stops" aria-hidden="true" style:background={gradientCss(gradientStops)}></span>
      {/if}
    {/if}

    {#each inline as spec, i (spec.key + spec.label)}
      <div class="slot" class:folded={i >= visibleCount} data-slot={i} bind:this={slotEls[i]}>
        <OptionControl {spec} value={options[spec.key]} onchange={(v) => set(spec.key, v)} />
      </div>
    {/each}

    {#if toolId === 'text'}
      <Tooltip text={activeText ? 'Text colour' : 'Text colour (primary colour)'} placement="bottom">
        <button
          bind:this={colorAnchor}
          type="button"
          class="color-button"
          aria-label="Text colour {toHex(textColor, 'auto')}"
          aria-haspopup="dialog"
          aria-expanded={colorOpen}
          onclick={() => (colorOpen = !colorOpen)}
        >
          <span style:background={toHex(textColor, 'auto')}></span>
        </button>
      </Tooltip>
      <Popover bind:open={colorOpen} anchor={colorAnchor} label="Text colour" placement="bottom-start" initialFocus="first">
        {#if colorPicker.current}
          {@const Picker = colorPicker.current}
          <Picker color={textColor} label="Text colour" onchange={setTextColor} />
        {:else}
          <Spinner size={18} label="Loading the colour picker" />
        {/if}
      </Popover>
    {/if}

    {#if SYMMETRY_TOOLS.includes(toolId)}
      <span class="divider" aria-hidden="true"></span>
      <SymmetryControl />
    {/if}

    {#if SELECTION_TOOLS.includes(toolId)}
      <span class="divider" aria-hidden="true"></span>
      <div class="group" role="group" aria-label="Selection">
        <Button size="sm" variant="ghost" onclick={() => engine.selectAll()}>Select all</Button>
        <Button size="sm" variant="ghost" disabled={!hasSelection} onclick={() => engine.deselect()}>Deselect</Button>
        <Button size="sm" variant="ghost" disabled={!hasSelection} onclick={() => engine.invertSelection()}>Invert</Button>
        <span bind:this={featherAnchor} class="anchor">
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasSelection}
            aria-haspopup="dialog"
            aria-expanded={featherOpen}
            onclick={() => (featherOpen = !featherOpen)}
          >
            Feather…
          </Button>
        </span>
      </div>
      <Popover
        bind:open={featherOpen}
        anchor={featherAnchor?.querySelector('button')}
        label="Feather selection"
        placement="bottom-start"
        initialFocus="first"
      >
        <div class="feather">
          <PillSlider spec={FEATHER} value={featherRadius} width="180px" onchange={(v) => (featherRadius = v)} />
          <Button
            size="sm"
            variant="primary"
            onclick={() => {
              engine.featherSelection(featherRadius);
              featherOpen = false;
              featherAnchor?.querySelector('button')?.focus({ preventScroll: true });
            }}
          >
            Feather
          </Button>
        </div>
      </Popover>
    {/if}

    {#if toolId === 'move'}
      {#if pending}
        <span class="hint">Drag handles to scale · outside a corner to rotate</span>
        <Button size="sm" variant="primary" icon={Check} onclick={() => engine.commitPending()}>Apply</Button>
        <Button size="sm" variant="ghost" icon={X} onclick={() => engine.cancelPending()}>Cancel</Button>
      {:else}
        <span class="hint">{hasSelection ? 'Drag to move the selection' : 'Drag to move the layer'} · arrows nudge</span>
      {/if}
    {:else if toolId === 'hand' || toolId === 'zoom'}
      {#if toolId === 'hand'}<span class="hint">Drag to pan · hold Space with any tool</span>{/if}
      <Button size="sm" variant="ghost" icon={Maximize} onclick={() => stage.fit()}>Fit</Button>
      <Button size="sm" variant="ghost" onclick={() => stage.actualSize()}>100%</Button>
    {:else if toolId === 'eyedropper'}
      <span class="hint">Right-click or Alt picks the secondary colour</span>
    {/if}
  </div>

  {#if specs.length > 0}
    <MoreOptions toolLabel={label} {specs} {options} onchange={set} hideTrigger={!hasMore && !overflowing} />
  {/if}
</div>

<style>
  .options {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 100%;
    min-width: 0;
    padding: 0 var(--space-2) 0 var(--space-1);
  }

  .tool-name {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1-5);
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    white-space: nowrap;
  }
  .tool-name :global(svg) {
    color: var(--accent-text);
  }

  .divider {
    flex: none;
    width: 1px;
    height: 18px;
    background: var(--divider);
  }

  .controls {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    /* Clipped, never scrolled sideways by focusing a control. */
    overflow: clip;
    /* Room for focus rings inside the clipped strip. */
    padding: 4px 3px;
  }
  .slot,
  .group,
  .anchor {
    display: inline-flex;
    flex: none;
    align-items: center;
  }
  .group {
    gap: 2px;
  }

  .hint {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-sm);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .menu-button {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1-5);
    height: var(--control-sm);
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    box-shadow: var(--inset-highlight);
    cursor: default;
  }
  .menu-button:hover {
    background: var(--control-fill-hover);
  }
  .menu-button:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .menu-button :global(svg:last-child) {
    color: var(--text-3);
  }

  .color-button {
    display: grid;
    flex: none;
    width: 26px;
    height: 26px;
    padding: 3px;
    border: 1px solid var(--control-border);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    cursor: default;
  }
  .color-button > span {
    border-radius: 3px;
    box-shadow: inset 0 0 0 1px rgb(var(--text-rgb) / 0.16);
  }
  .color-button:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }

  .placeholder {
    flex: none;
    height: var(--control-sm);
    border-radius: var(--radius-sm);
  }
  .placeholder.font {
    width: 168px;
    padding: 0 10px;
    border: 1px solid var(--control-border);
    background: var(--control-fill);
    color: var(--text-2);
    font-size: var(--text-md);
    line-height: calc(var(--control-sm) - 2px);
  }
  .placeholder.stops {
    width: 132px;
    height: 16px;
    margin: 0 7px;
    border-radius: var(--radius-full);
  }

  .feather {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* Controls that do not fit live in "More options" only. */
  .slot.folded {
    display: none;
  }
  @container (max-width: 560px) {
    .hint {
      display: none;
    }
  }
  @container (max-width: 580px) {
    .tool-name span {
      display: none;
    }
  }
</style>

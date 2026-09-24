<!--
  Color panel: primary / secondary colours (swap, reset), an HSV picker with
  hex and RGBA entry, a screen eyedropper (EyeDropper API; otherwise the
  canvas eyedropper tool), recent colours, palettes, the icon's own
  dominant colours, and the gradient used by the gradient tool.
-->
<script lang="ts">
  import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
  import Pipette from '@lucide/svelte/icons/pipette';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import { dominantColors, parseColor, roundRgba, type GradientKind, type Rgba } from '$engine/index';
  import { PALETTES, type PaletteId } from '$engine/color/palettes';
  import { settings } from '$lib/settings/store.svelte';
  import Button from '$lib/ui/Button.svelte';
  import ColorSwatch from '$lib/ui/ColorSwatch.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import NumField from '../common/NumField.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../../state/context';
  import { hexOf, rememberColor } from '../common/color';
  import Section from '../common/Section.svelte';
  import GradientEditor, { type GradientValue } from './GradientEditor.svelte';
  import HexInput from './HexInput.svelte';
  import HsvPicker from './HsvPicker.svelte';

  const session = getSession();
  const engine = session.engine;

  let target = $state<'primary' | 'secondary'>('primary');

  const colors = $derived.by(() => {
    void session.rev.color;
    return { primary: engine.primary, secondary: engine.secondary };
  });
  const current = $derived(colors[target]);

  function set(c: Rgba, commit: boolean): void {
    engine.setColor(target, c);
    if (commit) rememberColor(c);
  }

  function setChannel(key: 'r' | 'g' | 'b' | 'a', v: number): void {
    const c = { ...current, [key]: key === 'a' ? v / 100 : v };
    set(c, true);
  }

  function useSwatch(hex: string): void {
    const c = parseColor(hex);
    if (c) set(c, true);
  }

  // ---- screen eyedropper -----------------------------------------------------------
  interface EyeDropperLike {
    open(options?: { signal?: AbortSignal }): Promise<{ sRGBHex: string }>;
  }
  type EyeDropperCtor = new () => EyeDropperLike;
  const ScreenDropper = (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper;

  async function pickFromScreen(): Promise<void> {
    if (!ScreenDropper) {
      engine.setTool('eyedropper');
      toast({ message: 'Click the canvas to pick a colour (Alt or right-click for the secondary colour).', kind: 'info' });
      return;
    }
    try {
      const res = await new ScreenDropper().open();
      const c = parseColor(res.sRGBHex);
      if (c) set(c, true);
    } catch {
      // Escape / cancelled: nothing to do.
    }
  }

  // ---- palettes & icon colours --------------------------------------------------------
  let paletteId = $state<PaletteId>('fluent');
  const palette = $derived(PALETTES.find((p) => p.id === paletteId) ?? PALETTES[0]!);
  const recent = $derived(settings().recentColors);

  const iconColors = $derived.by(() => {
    const icon = session.original;
    if (!icon) return [];
    return dominantColors(icon.data, icon.width, icon.height, { count: 8 }).map((d) => ({
      hex: hexOf(roundRgba({ ...d.color, a: 1 })),
      share: d.share,
    }));
  });

  // ---- gradient tool gradient ---------------------------------------------------------------
  const gradient = $derived.by(() => {
    void session.rev.tool;
    return engine.getToolOptions('gradient');
  });
  const gradientStops = $derived(gradient.stops.map((s) => ({ offset: s.offset, color: hexOf(s.color) })));
  const KINDS = [
    { value: 'linear', label: 'Linear' },
    { value: 'radial', label: 'Radial' },
    { value: 'conic', label: 'Conic' },
  ];

  function setGradient(v: GradientValue): void {
    engine.setToolOptions('gradient', {
      stops: v.stops.map((s) => ({ offset: s.offset, color: parseColor(s.color) ?? { r: 0, g: 0, b: 0, a: 1 } })),
      kind: (v.type as GradientKind | undefined) ?? gradient.kind,
      source: 'custom',
    });
  }

  const nice = (c: Rgba) => hexOf(c).toUpperCase();
</script>

<div class="color" data-testid="color-panel">
  <Section title="Colour" collapsible={false}>
    {#snippet actions()}
      <IconButton label={ScreenDropper ? 'Pick a colour from the screen' : 'Pick a colour from the canvas'} icon={Pipette} size="sm" shortcut="I" onclick={pickFromScreen} data-testid="eyedropper" />
    {/snippet}
    <div class="wells">
      <div class="pair" role="radiogroup" aria-label="Colour being edited">
        <button
          type="button"
          role="radio"
          class="well secondary"
          aria-checked={target === 'secondary'}
          aria-label="Secondary colour {nice(colors.secondary)}"
          style:--c={hexOf(colors.secondary)}
          onclick={() => (target = 'secondary')}
          data-testid="secondary-well"
        ></button>
        <button
          type="button"
          role="radio"
          class="well primary"
          aria-checked={target === 'primary'}
          aria-label="Primary colour {nice(colors.primary)}"
          style:--c={hexOf(colors.primary)}
          onclick={() => (target = 'primary')}
          data-testid="primary-well"
        ></button>
      </div>
      <div class="well-actions">
        <IconButton label="Swap colours" shortcut="X" icon={ArrowLeftRight} size="sm" onclick={() => engine.swapColors()} data-testid="swap-colors" />
        <IconButton label="Reset to black and white" shortcut="D" icon={RotateCcw} size="sm" onclick={() => engine.resetColors()} />
      </div>
      <div class="which">
        <span class="which-label">{target === 'primary' ? 'Primary' : 'Secondary'}</span>
        <span class="which-value">{nice(current)}</span>
      </div>
    </div>

    <HsvPicker value={current} label={target === 'primary' ? 'Primary colour' : 'Secondary colour'} oninput={(c) => set(c, false)} onchange={(c) => set(c, true)} />

    <div class="entry">
      <div class="hex"><HexInput value={current} label="Hex" onchange={(c) => set(c, true)} /></div>
      <NumField label="R" value={Math.round(current.r)} min={0} max={255} width="44px" onchange={(v) => setChannel('r', v)} />
      <NumField label="G" value={Math.round(current.g)} min={0} max={255} width="44px" onchange={(v) => setChannel('g', v)} />
      <NumField label="B" value={Math.round(current.b)} min={0} max={255} width="44px" onchange={(v) => setChannel('b', v)} />
      <NumField label="A" value={Math.round(current.a * 100)} min={0} max={100} width="44px" onchange={(v) => setChannel('a', v)} />
    </div>
  </Section>

  <Section title="Recent">
    {#if recent.length === 0}
      <p class="hint">Colours you use show up here.</p>
    {:else}
      <div class="swatches" data-testid="recent-colors">
        {#each recent as c (c)}
          <ColorSwatch color={c} label="Use {c.toUpperCase()}" selected={c === hexOf(current)} onclick={useSwatch} />
        {/each}
      </div>
    {/if}
  </Section>

  <Section title="Palettes">
    <Select
      label="Palette"
      hideLabel
      size="sm"
      options={PALETTES.map((p) => ({ value: p.id, label: p.name }))}
      bind:value={paletteId}
    />
    <div class="swatches" data-testid="palette">
      {#each palette.colors as c (c)}
        <ColorSwatch color={c} label="Use {c.toUpperCase()}" selected={c === hexOf(current)} onclick={useSwatch} />
      {/each}
    </div>
  </Section>

  {#if iconColors.length > 0}
    <Section title="From your icon">
      <div class="swatches icon-colors">
        {#each iconColors as c (c.hex)}
          <ColorSwatch color={c.hex} size="lg" label="Use {c.hex.toUpperCase()} ({Math.round(c.share * 100)}% of the icon)" onclick={useSwatch} />
        {/each}
      </div>
    </Section>
  {/if}

  <Section title="Gradient" open={false}>
    <GradientEditor stops={gradientStops} types={KINDS} type={gradient.kind} label="Gradient tool colours" onchange={setGradient} />
    <Toggle
      label="Gradient tool uses these colours"
      description="Off: primary to secondary colour."
      size="sm"
      checked={gradient.source === 'custom'}
      onchange={(on) => engine.setToolOptions('gradient', { source: on ? 'custom' : 'colors' })}
    />
    <Button size="sm" onclick={() => engine.setTool('gradient')}>Use the gradient tool</Button>
  </Section>
</div>

<style>
  .color {
    display: flex;
    flex-direction: column;
  }
  .wells {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .pair {
    position: relative;
    width: 56px;
    height: 48px;
    flex: none;
  }
  .well {
    position: absolute;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 2px solid var(--surface-1);
    border-radius: var(--radius-md);
    background:
      linear-gradient(var(--c), var(--c)),
      repeating-conic-gradient(#c8cbd2 0 25%, #fff 0 50%) 0 0 / 8px 8px;
    box-shadow: 0 0 0 1px var(--border-strong);
    cursor: default;
    transition: box-shadow var(--fade-1) linear;
  }
  .primary {
    top: 0;
    left: 0;
    z-index: 1;
  }
  .secondary {
    right: 0;
    bottom: 0;
  }
  .well[aria-checked='true'] {
    z-index: 2;
    box-shadow:
      0 0 0 1px var(--border-strong),
      0 0 0 3px var(--accent);
  }
  .well:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 3px;
  }
  .well-actions {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .which {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-end;
    min-width: 0;
  }
  .which-label {
    color: var(--text-3);
    font-size: var(--text-xs);
  }
  .which-value {
    font-family: var(--font-mono);
    font-size: var(--text-md);
    font-variant-numeric: tabular-nums;
  }
  .entry {
    display: flex;
    align-items: flex-end;
    gap: var(--space-1);
  }
  .hex {
    flex: 1;
    min-width: 0;
  }
  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(24px, 1fr));
    gap: 5px;
    justify-items: center;
  }
  .icon-colors {
    grid-template-columns: repeat(auto-fill, minmax(32px, 1fr));
    gap: var(--space-2);
  }
  .hint {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-sm);
  }
</style>

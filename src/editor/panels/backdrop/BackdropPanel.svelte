<!--
  Backdrop panel: design a plate for the icon (shape, fill, gloss, border,
  shadow) with a live preview, start from a style chip, and add it as the
  bottom "Backdrop" layer (or update that layer) — rendered at document
  size off the main thread.
-->
<script module lang="ts">
  import type { BackdropSpec } from '$engine/backdrop';

  /** The spec being designed, per document (survives tab switches). */
  const specs = new WeakMap<object, BackdropSpec>();
  /** Starter-style previews by style id and pixel size. */
  const chipCache = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>();
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import Circle from '@lucide/svelte/icons/circle';
  import Dices from '@lucide/svelte/icons/dices';
  import Egg from '@lucide/svelte/icons/egg';
  import Hexagon from '@lucide/svelte/icons/hexagon';
  import Shield from '@lucide/svelte/icons/shield';
  import SquareRoundCorner from '@lucide/svelte/icons/square-round-corner';
  import Squircle from '@lucide/svelte/icons/squircle';
  import { BACKDROP_STYLES, DEFAULT_BORDER, DEFAULT_GLOSS, DEFAULT_SHADOW, backdropStyle, resolveBackdropSpec, type BackdropFill, type BackdropShape } from '$engine/backdrop';
  import { dominantColors, hslToRgb, rgbToHsl, toHex } from '$engine/index';
  import { isFilterCancelled } from '$engine/filters/client';
  import Button from '$lib/ui/Button.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../../state/context';
  import ColorField from '../color/ColorField.svelte';
  import GradientEditor from '../color/GradientEditor.svelte';
  import NumField from '../common/NumField.svelte';
  import PixelThumb from '../common/PixelThumb.svelte';
  import Section from '../common/Section.svelte';
  import { debounce } from '../common/schedule';
  import { BACKDROP_LAYER_NAME, backdropRecipe, chainRecipes, placeBackdrop } from '../styles/recipe';

  const session = getSession();
  const engine = session.engine;

  const PREVIEW = 104;
  const CHIP = 40;

  /** A first spec in the icon's own colour. */
  function initialSpec(): BackdropSpec {
    const base = backdropStyle('ocean')!;
    const icon = session.original;
    if (!icon) return base;
    const colors = dominantColors(icon.data, icon.width, icon.height, { count: 5 });
    const vivid = colors
      .map((c) => ({ c: c.color, s: rgbToHsl(c.color).s * Math.sqrt(c.share) }))
      .sort((a, b) => b.s - a.s)[0];
    if (!vivid || rgbToHsl(vivid.c).s < 0.2) return base;
    const hsl = rgbToHsl(vivid.c);
    const light = toHex(hslToRgb({ h: hsl.h - 8, s: Math.min(1, hsl.s * 1.05), l: 0.66, a: 1 }));
    const deep = toHex(hslToRgb({ h: hsl.h + 14, s: Math.min(1, hsl.s * 1.1), l: 0.42, a: 1 }));
    return resolveBackdropSpec({ ...base, fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: light }, { offset: 1, color: deep }] } });
  }

  let spec = $state<BackdropSpec>(specs.get(engine.doc) ?? initialSpec());
  $effect(() => {
    specs.set(engine.doc, $state.snapshot(spec) as BackdropSpec);
  });

  const hasBackdrop = $derived.by(() => {
    void session.rev.layers;
    void session.rev.document;
    return engine.doc.layers.some((l) => l.kind === 'raster' && l.name === BACKDROP_LAYER_NAME);
  });

  // ---- previews ----------------------------------------------------------------------------
  let preview = $state.raw<{ width: number; height: number; data: Uint8ClampedArray } | null>(null);
  let chips = $state.raw<Record<string, { width: number; height: number; data: Uint8ClampedArray }>>({});

  const renderPreview = debounce((s: BackdropSpec) => {
    const size = Math.round(PREVIEW * (devicePixelRatio || 1));
    session.filters
      .backdrop(s, size, { channel: 'backdrop-preview' })
      .then((px) => (preview = px))
      .catch((e: unknown) => {
        if (!isFilterCancelled(e)) console.warn('backdrop preview failed', e);
      });
  }, 30);

  $effect(() => {
    renderPreview($state.snapshot(spec) as BackdropSpec);
  });

  onMount(() => {
    const size = Math.round(CHIP * (devicePixelRatio || 1));
    for (const style of BACKDROP_STYLES) {
      const key = `${style.id}:${size}`;
      const cached = chipCache.get(key);
      if (cached) {
        chips = { ...chips, [style.id]: cached };
        continue;
      }
      session.filters
        .backdrop(style.spec, size)
        .then((px) => {
          chipCache.set(key, px);
          chips = { ...chips, [style.id]: px };
        })
        .catch(() => {});
    }
    return () => {
      renderPreview.cancel();
      session.filters.cancel('backdrop-preview');
    };
  });

  // ---- editing -------------------------------------------------------------------------------
  function update(patch: Partial<BackdropSpec>): void {
    spec = resolveBackdropSpec({ ...$state.snapshot(spec), ...patch } as BackdropSpec);
  }

  const SHAPES = [
    { value: 'circle', label: 'Circle', icon: Circle },
    { value: 'rounded', label: 'Rounded square', icon: SquareRoundCorner },
    { value: 'squircle', label: 'Squircle', icon: Squircle },
    { value: 'hexagon', label: 'Hexagon', icon: Hexagon },
    { value: 'shield', label: 'Shield', icon: Shield },
    { value: 'blob', label: 'Blob', icon: Egg },
  ];
  const FILLS = [
    { value: 'solid', label: 'Solid' },
    { value: 'linear', label: 'Linear' },
    { value: 'radial', label: 'Radial' },
  ];
  const BORDER_POS = [
    { value: 'inside', label: 'Inside' },
    { value: 'center', label: 'Centre' },
    { value: 'outside', label: 'Outside' },
  ];

  function stopsOf(f: BackdropFill): { offset: number; color: string }[] {
    if (f.type === 'solid') return [{ offset: 0, color: f.color }, { offset: 1, color: f.color }];
    return f.stops.map((s) => ({ ...s }));
  }

  function setFillType(type: string): void {
    const f = spec.fill;
    const stops = stopsOf(f);
    if (type === 'solid') update({ fill: { type: 'solid', color: stops[0]!.color } });
    else if (type === 'linear') update({ fill: { type: 'linear', angle: f.type === 'linear' ? f.angle : 180, stops } });
    else update({ fill: { type: 'radial', cx: 0.5, cy: 0.35, radius: 0.8, stops } });
  }

  // ---- apply -----------------------------------------------------------------------------------
  let applying = $state(false);

  async function apply(): Promise<void> {
    if (applying) return;
    applying = true;
    const s = $state.snapshot(spec) as BackdropSpec;
    try {
      const px = await session.filters.backdrop(s, engine.doc.width, { channel: 'backdrop-apply' });
      const id = placeBackdrop(engine, px);
      if (id) session.recipe = chainRecipes(session.recipe, backdropRecipe(s));
    } catch (e) {
      if (!isFilterCancelled(e)) toast({ message: `Could not render the backdrop: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' });
    } finally {
      applying = false;
    }
  }

  function useStyle(id: string): void {
    const s = backdropStyle(id);
    if (!s) return;
    spec = s;
    void apply();
  }
</script>

<div class="backdrop" data-testid="backdrop-panel">
  <div class="top">
    <PixelThumb pixels={preview} size={PREVIEW} label="Backdrop preview" radius="var(--radius-lg)" />
    <div class="apply">
      <p class="lead">A plate behind your icon, as the bottom layer.</p>
      <Button variant="primary" loading={applying} onclick={apply} fullWidth data-testid="apply-backdrop">
        {hasBackdrop ? 'Update backdrop' : 'Add backdrop'}
      </Button>
    </div>
  </div>

  <Section title="Styles">
    <div class="chips" role="list">
      {#each BACKDROP_STYLES as style (style.id)}
        <div role="listitem">
          <button type="button" class="chip" title="{style.label} — click to apply" onclick={() => useStyle(style.id)} data-testid="backdrop-style">
            <PixelThumb pixels={chips[style.id] ?? null} size={CHIP} checker={false} framed={false} />
            <span>{style.label}</span>
          </button>
        </div>
      {/each}
    </div>
  </Section>

  <Section title="Shape">
    <SegmentedControl label="Shape" iconOnly fullWidth options={SHAPES} value={spec.shape} onchange={(v) => update({ shape: v as BackdropShape })} />
    {#if spec.shape === 'blob'}
      <div class="row">
        <NumField label="Seed" value={spec.blob.seed} min={0} max={99999} width="80px" onchange={(v) => update({ blob: { ...spec.blob, seed: v } })} />
        <IconButton label="New random shape" icon={Dices} onclick={() => update({ blob: { ...spec.blob, seed: Math.floor(Math.random() * 99999) } })} />
        <div class="grow">
          <Slider label="Wobble" value={Math.round(spec.blob.variance * 100)} min={0} max={100} unit="%" onchange={(v) => update({ blob: { ...spec.blob, variance: v / 100 } })} />
        </div>
      </div>
    {/if}
    {#if spec.shape === 'rounded' || spec.shape === 'hexagon' || spec.shape === 'shield'}
      <Slider label="Corner radius" value={Math.round(spec.cornerRadius * 100)} min={0} max={50} unit="%" onchange={(v) => update({ cornerRadius: v / 100 })} />
    {/if}
    {#if spec.shape === 'squircle'}
      <Slider label="Squareness" value={spec.squircleExponent} min={2} max={12} step={0.5} onchange={(v) => update({ squircleExponent: v })} />
    {/if}
    <Slider label="Margin" value={Math.round(spec.inset * 100)} min={0} max={30} unit="%" onchange={(v) => update({ inset: v / 100 })} />
  </Section>

  <Section title="Fill">
    <SegmentedControl label="Fill type" size="sm" fullWidth options={FILLS} value={spec.fill.type} onchange={setFillType} />
    {#if spec.fill.type === 'solid'}
      <ColorField label="Colour" value={spec.fill.color} onchange={(c) => update({ fill: { type: 'solid', color: c } })} />
    {:else}
      {@const fill = spec.fill}
      <GradientEditor
        stops={fill.stops}
        angle={fill.type === 'linear' ? fill.angle : undefined}
        label="Fill gradient"
        onchange={(v) => {
          if (fill.type === 'linear') update({ fill: { type: 'linear', angle: v.angle ?? fill.angle, stops: v.stops } });
          else update({ fill: { ...fill, stops: v.stops } });
        }}
      />
      {#if fill.type === 'radial'}
        <Slider label="Radius" value={Math.round(fill.radius * 100)} min={20} max={200} unit="%" onchange={(v) => update({ fill: { ...fill, radius: v / 100 } })} />
      {/if}
    {/if}
  </Section>

  <Section title="Gloss" open={spec.gloss !== null}>
    <Toggle label="Top highlight" size="sm" checked={spec.gloss !== null} onchange={(on) => update({ gloss: on ? { ...DEFAULT_GLOSS } : null })} />
    {#if spec.gloss}
      {@const gloss = spec.gloss}
      <Slider label="Strength" value={Math.round(gloss.opacity * 100)} min={0} max={100} unit="%" onchange={(v) => update({ gloss: { ...gloss, opacity: v / 100 } })} />
      <Slider label="Size" value={Math.round(gloss.size * 100)} min={20} max={100} unit="%" onchange={(v) => update({ gloss: { ...gloss, size: v / 100 } })} />
    {/if}
  </Section>

  <Section title="Border" open={spec.border !== null}>
    <Toggle label="Border" size="sm" checked={spec.border !== null} onchange={(on) => update({ border: on ? { ...DEFAULT_BORDER } : null })} />
    {#if spec.border}
      {@const border = spec.border}
      <Slider label="Width" value={Math.round(border.width * 1000) / 10} min={0.5} max={10} step={0.5} unit="%" onchange={(v) => update({ border: { ...border, width: v / 100 } })} />
      <ColorField label="Colour" value={border.color} onchange={(c) => update({ border: { ...border, color: c } })} />
      <SegmentedControl label="Border position" size="sm" fullWidth options={BORDER_POS} value={border.position} onchange={(v) => update({ border: { ...border, position: v as typeof border.position } })} />
    {/if}
  </Section>

  <Section title="Shadow" open={spec.shadow !== null}>
    <Toggle label="Drop shadow" size="sm" checked={spec.shadow !== null} onchange={(on) => update({ shadow: on ? { ...DEFAULT_SHADOW } : null })} />
    {#if spec.shadow}
      {@const shadow = spec.shadow}
      <Slider label="Blur" value={Math.round(shadow.blur * 1000) / 10} min={0} max={10} step={0.5} unit="%" onchange={(v) => update({ shadow: { ...shadow, blur: v / 100 } })} />
      <Slider label="Offset" value={Math.round(shadow.offsetY * 1000) / 10} min={-10} max={10} step={0.5} unit="%" onchange={(v) => update({ shadow: { ...shadow, offsetY: v / 100 } })} />
      <Slider label="Opacity" value={Math.round(shadow.opacity * 100)} min={0} max={100} unit="%" onchange={(v) => update({ shadow: { ...shadow, opacity: v / 100 } })} />
      <ColorField label="Colour" value={shadow.color} alpha={false} onchange={(c) => update({ shadow: { ...shadow, color: c } })} />
    {/if}
  </Section>
</div>

<style>
  .backdrop {
    display: flex;
    flex-direction: column;
  }
  .top {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border-bottom: 1px solid var(--divider);
  }
  .apply {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .lead {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .chips {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-1);
  }
  .chip {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    width: 100%;
    padding: var(--space-1) 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-2xs);
    cursor: default;
    transition: background-color var(--fade-1) linear;
  }
  .chip:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .chip:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
</style>

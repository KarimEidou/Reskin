<!--
  Controls generated from parameter descriptors (filter ParamSpecs and the
  icon helpers' specs): sliders, colours, switches, choices, gradients and
  short text. `oninput` fires while dragging, `onchange` on commit.
-->
<script lang="ts">
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import ColorField from '../color/ColorField.svelte';
  import GradientEditor from '../color/GradientEditor.svelte';
  import type { ControlSpec, ControlValue, ControlValues } from './helper-defs';

  interface Props {
    params: readonly ControlSpec[];
    values: ControlValues;
    oninput: (key: string, value: ControlValue) => void;
    onchange: (key: string, value: ControlValue) => void;
  }

  let { params, values, oninput, onchange }: Props = $props();
  const uid = $props.id();

  function fmt(v: number, step: number, unit?: string): string {
    const decimals = Math.max(0, (String(step).split('.')[1] ?? '').length);
    const n = v.toFixed(decimals);
    return `${n}${unit ?? ''}`;
  }
</script>

<div class="controls">
  {#each params as p (p.key)}
    {#if p.kind === 'slider'}
      <Slider
        label={p.label}
        value={Number(values[p.key] ?? p.default)}
        min={p.min}
        max={p.max}
        step={p.step}
        format={(v) => fmt(v, p.step, p.unit)}
        oninput={(v) => oninput(p.key, v)}
        onchange={(v) => onchange(p.key, v)}
      />
    {:else if p.kind === 'color'}
      <ColorField label={p.label} value={String(values[p.key] ?? p.default)} alpha={p.alpha} oninput={(c) => oninput(p.key, c)} onchange={(c) => onchange(p.key, c)} />
    {:else if p.kind === 'toggle'}
      <Toggle label={p.label} size="sm" checked={Boolean(values[p.key] ?? p.default)} onchange={(on) => onchange(p.key, on)} />
    {:else if p.kind === 'select'}
      {#if p.options.length <= 3}
        <SegmentedControl label={p.label} size="sm" fullWidth options={p.options} value={String(values[p.key] ?? p.default)} onchange={(v) => onchange(p.key, v)} />
      {:else}
        <Select label={p.label} size="sm" options={p.options} value={String(values[p.key] ?? p.default)} onchange={(v) => onchange(p.key, v)} />
      {/if}
    {:else if p.kind === 'gradient'}
      <GradientEditor
        label={p.label}
        stops={(values[p.key] as { offset: number; color: string }[] | undefined) ?? p.default.map((s) => ({ ...s }))}
        minStops={p.minStops}
        maxStops={p.maxStops}
        oninput={(v) => oninput(p.key, v.stops)}
        onchange={(v) => onchange(p.key, v.stops)}
      />
    {:else if p.kind === 'text'}
      <div class="text">
        <label for="{uid}-{p.key}">{p.label}</label>
        <input
          id="{uid}-{p.key}"
          type="text"
          maxlength={p.maxLength}
          value={String(values[p.key] ?? p.default)}
          oninput={(e) => onchange(p.key, e.currentTarget.value)}
        />
      </div>
    {/if}
  {/each}
</div>

<style>
  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  label {
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  input {
    width: 100%;
    height: var(--control-sm);
    padding: 0 var(--space-2);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    font-size: var(--text-md);
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
    box-shadow: inset 0 -1px 0 var(--accent);
  }
</style>

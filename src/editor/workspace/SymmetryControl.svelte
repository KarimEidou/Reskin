<!--
  Symmetry for the painting tools: off / mirror X / mirror Y / both /
  radial with N rays (and optional mirrored rays), via engine.setSymmetry.
-->
<script lang="ts">
  import Asterisk from '@lucide/svelte/icons/asterisk';
  import CircleOff from '@lucide/svelte/icons/circle-off';
  import Grid2x2 from '@lucide/svelte/icons/grid-2x2';
  import SquareCenterlineDashedHorizontal from '@lucide/svelte/icons/square-centerline-dashed-horizontal';
  import SquareCenterlineDashedVertical from '@lucide/svelte/icons/square-centerline-dashed-vertical';
  import type { SymmetryMode } from '$engine/index';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import type { Option } from '$lib/ui/types';
  import { getSession } from '../state/context';
  import type { SliderSpec } from './options-schema';
  import PillSlider from './PillSlider.svelte';

  const session = getSession();
  const engine = session.engine;

  const MODES: Option<SymmetryMode>[] = [
    { value: 'off', label: 'Symmetry off', icon: CircleOff },
    // Lucide names these by the axis they split: "horizontal" draws the vertical centre line.
    { value: 'x', label: 'Mirror left and right', icon: SquareCenterlineDashedHorizontal },
    { value: 'y', label: 'Mirror top and bottom', icon: SquareCenterlineDashedVertical },
    { value: 'xy', label: 'Mirror both ways', icon: Grid2x2 },
    { value: 'radial', label: 'Radial', icon: Asterisk },
  ];

  const RAYS: SliderSpec = { kind: 'slider', key: 'rays', label: 'Rays', min: 2, max: 32, step: 1, priority: 1 };

  const symmetry = $derived.by(() => {
    void session.rev.symmetry;
    return engine.symmetry;
  });
</script>

<div class="symmetry" role="group" aria-label="Symmetry">
  <span class="caption" aria-hidden="true">Symmetry</span>
  <SegmentedControl
    size="sm"
    iconOnly
    label="Symmetry"
    options={MODES}
    value={symmetry.mode}
    onchange={(mode) => engine.setSymmetry({ mode })}
  />
  {#if symmetry.mode === 'radial'}
    <PillSlider spec={RAYS} value={symmetry.rays} width="96px" onchange={(rays) => engine.setSymmetry({ rays })} />
    <button
      type="button"
      class="chip"
      aria-pressed={symmetry.mirror}
      onclick={() => engine.setSymmetry({ mirror: !symmetry.mirror })}
    >
      Mirror rays
    </button>
  {/if}
</div>

<style>
  .symmetry {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }
  .caption {
    color: var(--text-3);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  @container (max-width: 840px) {
    .caption {
      display: none;
    }
  }
  .chip {
    height: var(--control-sm);
    padding: 0 10px;
    border: 1px solid var(--control-border);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .chip:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .chip:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .chip[aria-pressed='true'] {
    border-color: var(--accent-border);
    background: var(--accent-soft);
    color: var(--text);
  }
</style>

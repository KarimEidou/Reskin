<!--
  The primary Save & Apply split button. The main part applies with the
  item's preferred mode; the menu lists every mode (unavailable ones
  disabled) and the "also update pins" setting. Disabled with the reason
  as a tooltip when nothing can be applied; while working it morphs into a
  progress ring with the current step.
-->
<script lang="ts">
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import CopyPlus from '@lucide/svelte/icons/copy-plus';
  import Link2 from '@lucide/svelte/icons/link-2';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import type { ApplyMode } from '$lib/ipc/types';
  import { settings, updateSettings } from '$lib/settings/store.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import ProgressRing from '$lib/ui/ProgressRing.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import type { IconComponent } from '$lib/ui/types';
  import { getSession } from '../state/context';
  import { applyBlockedReason, MODE_INFO, MODE_ORDER } from './apply-modes';

  const session = getSession();

  const ICONS: Record<ApplyMode, IconComponent> = {
    inPlace: Sparkles,
    newShortcut: Link2,
    personalCopy: CopyPlus,
  };

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  const busy = $derived(session.busy);
  const mode = $derived(session.modes[0] ?? null);
  const blocked = $derived(applyBlockedReason(session.item, session.busy));
  const canApply = $derived(session.canApply && blocked === null);
  const tip = $derived(blocked ?? (mode ? MODE_INFO[mode].description : ''));
  const pct = $derived(busy?.progress === null || busy?.progress === undefined ? null : Math.round(busy.progress * 100));

  async function apply(m: ApplyMode | null = mode): Promise<void> {
    open = false;
    if (!m || !session.canApply || !session.modes.includes(m)) return;
    await session.apply({ mode: m });
  }
</script>

<div class="split" class:busy={busy !== null} class:blocked={!canApply && !busy} bind:this={root} data-testid="apply-button">
  <Tooltip text={tip} placement="top" disabled={busy !== null}>
    <button
      type="button"
      class="main"
      aria-disabled={!canApply}
      aria-busy={busy !== null}
      aria-label={busy ? `${busy.label}${pct !== null ? ` ${pct}%` : ''}` : 'Save & Apply'}
      onclick={() => apply()}
    >
      <span class="face idle" aria-hidden={busy !== null}>
        <Sparkles size={16} strokeWidth={2} aria-hidden="true" />
        <span class="label">Save &amp; Apply</span>
      </span>
      <span class="face working" aria-hidden={busy === null}>
        <ProgressRing value={busy?.progress ?? null} size={18} stroke={2.5} label={busy?.label ?? 'Working'} />
        <span class="label">{busy?.label ?? 'Applying'}{pct !== null ? ` · ${pct}%` : '…'}</span>
      </span>
    </button>
  </Tooltip>
  <button
    type="button"
    class="caret"
    aria-label="Apply options"
    aria-haspopup="dialog"
    aria-expanded={open}
    disabled={busy !== null}
    data-testid="apply-options"
    onclick={() => (open = !open)}
  >
    <ChevronUp size={15} strokeWidth={2} aria-hidden="true" />
  </button>
</div>

<Popover bind:open anchor={root} label="Apply options" placement="top-end" offset={8} width="300px" initialFocus="first">
  <div class="menu">
    <p class="heading" id="apply-mode-heading">Apply as</p>
    <div class="modes" role="group" aria-labelledby="apply-mode-heading">
      {#each MODE_ORDER as m (m)}
        {@const Icon = ICONS[m]}
        {@const available = session.modes.includes(m)}
        <button
          type="button"
          class="mode"
          class:preferred={m === mode}
          disabled={!available || !session.canApply}
          data-mode={m}
          onclick={() => apply(m)}
        >
          <span class="icon" aria-hidden="true"><Icon size={16} strokeWidth={1.75} /></span>
          <span class="text">
            <span class="title">{MODE_INFO[m].label}</span>
            <span class="desc">{available ? MODE_INFO[m].description : MODE_INFO[m].unavailable}</span>
          </span>
          {#if m === mode}<span class="default">Default</span>{/if}
        </button>
      {/each}
    </div>
    <div class="pins">
      <Toggle
        size="sm"
        label="Also update Start menu and taskbar pins"
        description="Shortcuts to the same app get the new icon too."
        checked={settings().updatePins}
        onchange={(v) => {
          updateSettings({ updatePins: v }).catch((e: unknown) => console.warn('could not save the setting', e));
        }}
      />
    </div>
  </div>
</Popover>

<style>
  .split {
    --h: 36px;
    --brand: linear-gradient(135deg, var(--accent-base) 0%, #4f7dff 58%, #1fb3d6 100%);
    position: relative;
    display: inline-flex;
    flex: none;
    height: var(--h);
    border-radius: var(--radius-md);
    background: var(--brand);
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.22),
      0 1px 2px rgb(var(--accent-dark-rgb) / 0.4),
      0 6px 18px -6px rgb(var(--accent-vivid-rgb) / 0.65);
    isolation: isolate;
    transition:
      filter var(--fade-2) linear,
      box-shadow var(--fade-2) linear;
  }
  .split.blocked {
    filter: saturate(0.25) brightness(0.8);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.12);
    opacity: 0.7;
  }
  :global([data-theme='light']) .split.blocked {
    filter: saturate(0.2) brightness(1.1);
  }

  button {
    border: 0;
    background: transparent;
    color: #fff;
    font: inherit;
    cursor: default;
  }
  .main {
    position: relative;
    display: grid;
    min-width: 148px;
    height: 100%;
    padding: 0 16px 0 14px;
    border-radius: var(--radius-md) 0 0 var(--radius-md);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    text-shadow: 0 1px 1px rgb(0 0 0 / 0.18);
    transition: background-color var(--fade-1) linear;
  }
  .main:hover:not([aria-disabled='true']) {
    background: rgb(255 255 255 / 0.1);
  }
  .main:active:not([aria-disabled='true']) {
    background: rgb(0 0 0 / 0.08);
  }
  .main:focus-visible,
  .caret:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }

  .face {
    grid-area: 1 / 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    white-space: nowrap;
    transition:
      opacity var(--fade-2) linear,
      transform var(--dur-3) var(--ease-standard);
  }
  .face.working {
    opacity: 0;
    transform: translateY(6px) scale(0.96);
  }
  .busy .face.idle {
    opacity: 0;
    transform: translateY(-6px) scale(0.96);
  }
  .busy .face.working {
    opacity: 1;
    transform: none;
  }
  .face.working :global(.track) {
    stroke: rgb(255 255 255 / 0.3);
  }
  .face.working :global(.bar) {
    stroke: #fff;
  }
  .label {
    font-variant-numeric: tabular-nums;
  }

  .caret {
    display: grid;
    place-items: center;
    width: 32px;
    height: 100%;
    border-left: 1px solid rgb(255 255 255 / 0.24);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    transition: background-color var(--fade-1) linear;
  }
  .caret:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.12);
  }
  .caret:disabled {
    opacity: 0.6;
  }
  .caret[aria-expanded='true'] {
    background: rgb(0 0 0 / 0.12);
  }

  .menu {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .heading {
    margin: 0 0 2px;
    color: var(--text-3);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .modes {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mode {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2);
    border-radius: var(--radius-md);
    color: var(--text);
    text-align: left;
    transition: background-color var(--fade-1) linear;
  }
  .mode:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .mode:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring-inset);
  }
  .mode:disabled {
    opacity: 0.45;
  }
  .icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: var(--radius-md);
    background: var(--surface-3);
    color: var(--text-2);
  }
  .preferred .icon {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .title {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }
  .desc {
    color: var(--text-3);
    font-size: var(--text-sm);
    line-height: var(--leading-tight);
  }
  .default {
    flex: none;
    padding: 2px 6px;
    border-radius: var(--radius-full);
    background: var(--surface-3);
    color: var(--text-3);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.02em;
  }
  .pins {
    padding-top: var(--space-2);
    border-top: 1px solid var(--divider);
  }
</style>

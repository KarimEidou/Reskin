<!--
  The amount prompt of Feather… / Grow… / Shrink… / Border… (refinePrompt:
  opened from the Selection menu or the command palette), a px slider and
  the apply button, anchored in the options bar. It closes by itself when
  the selection goes away.
-->
<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import { getSession } from '../state/context';
  import type { SliderSpec } from './options-schema';
  import PillSlider from './PillSlider.svelte';
  import { REFINE, REFINE_MAX, REFINE_MIN, refinePrompt } from './refine.svelte';
  import { stage } from './stage.svelte';

  interface Props {
    anchor: HTMLElement | null | undefined;
  }

  let { anchor }: Props = $props();

  const session = getSession();
  const engine = session.engine;

  const kind = $derived(refinePrompt.kind);
  const info = $derived(kind ? REFINE[kind] : null);
  const spec = $derived<SliderSpec>({
    kind: 'slider',
    key: 'amount',
    label: info?.amount ?? '',
    min: REFINE_MIN,
    max: REFINE_MAX,
    step: 1,
    unit: 'px',
    priority: 1,
  });

  $effect(() => {
    void session.rev.selection;
    void session.rev.document;
    if (refinePrompt.kind && !engine.doc.selection) refinePrompt.close();
  });

  // Leaving the Edit view drops the question (it must not pop up on return).
  $effect(() => () => refinePrompt.close());

  /** Back to the Selection menu button, or to the canvas (the prompt came from the palette). */
  function apply(): void {
    refinePrompt.apply(engine);
    if (anchor instanceof HTMLButtonElement && anchor.isConnected) anchor.focus({ preventScroll: true });
    else stage.focusCanvas();
  }
</script>

<Popover
  bind:open={
    () => kind !== null,
    (open) => {
      if (!open) refinePrompt.close();
    }
  }
  {anchor}
  label={info?.title ?? ''}
  placement="bottom-start"
  initialFocus="first"
>
  {#if kind && info}
    <div class="refine" data-testid="refine-prompt">
      <PillSlider {spec} value={refinePrompt.amounts[kind]} width="180px" onchange={(v) => (refinePrompt.amounts[kind] = v)} />
      <Button size="sm" variant="primary" onclick={apply}>{info.verb}</Button>
    </div>
  {/if}
</Popover>

<style>
  .refine {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>

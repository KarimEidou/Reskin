<!--
  An IconButton that stays focusable while unavailable (aria-disabled): a
  panel action such as Undo or Delete often becomes unavailable *because*
  it was just pressed, and a natively disabled button would drop keyboard
  focus to the page (and, with the shared Tooltip, set state while the
  view updates). Clicks while unavailable do nothing.
-->
<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import IconButton from '$lib/ui/IconButton.svelte';

  type Props = Omit<ComponentProps<typeof IconButton>, 'disabled'> & { disabled?: boolean };

  let { disabled = false, onclick, class: className, ...rest }: Props = $props();
</script>

<IconButton
  {...rest}
  class={['tool-btn', { unavailable: disabled }, className]}
  aria-disabled={disabled || undefined}
  onclick={(e) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    onclick?.(e);
  }}
/>

<style>
  :global(.tool-btn.unavailable) {
    opacity: 0.4;
    pointer-events: auto;
  }
  :global(.tool-btn.unavailable:hover) {
    background: transparent !important;
    color: var(--text-2) !important;
  }
</style>

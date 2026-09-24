<!--
  Non-modal popover anchored to an element. Closes on an outside press or
  Escape (focus then returns to the anchor). Rendered in <body>, so no
  container can clip it.
    <button bind:this={btn} onclick={() => (open = !open)} aria-expanded={open}>…</button>
    <Popover bind:open anchor={btn} label="Brush options">…</Popover>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { dismissable, floating, portal } from './floating';
  import { focusableIn } from './focus';
  import type { Placement } from './position';

  interface Props {
    open?: boolean;
    anchor: HTMLElement | null | undefined;
    /** Accessible name of the popover. */
    label: string;
    placement?: Placement;
    offset?: number;
    /** Focus on open: the first focusable child, the popover itself, or nothing. */
    initialFocus?: 'first' | 'container' | 'none';
    /** Fixed width (CSS), otherwise it sizes to content. */
    width?: string;
    onclose?: () => void;
    children: Snippet;
  }

  let {
    open = $bindable(false),
    anchor,
    label,
    placement = 'bottom-start',
    offset = 6,
    initialFocus = 'container',
    width,
    onclose,
    children,
  }: Props = $props();

  function close(reason: 'outside' | 'escape'): void {
    open = false;
    onclose?.();
    if (reason === 'escape') anchor?.focus();
  }

  function focusOnOpen(node: HTMLElement) {
    if (initialFocus === 'none') return;
    const target = initialFocus === 'first' ? (focusableIn(node)[0] ?? node) : node;
    queueMicrotask(() => target.focus({ preventScroll: true }));
  }
</script>

{#if open && anchor}
  <div
    class="popover"
    role="dialog"
    aria-label={label}
    tabindex="-1"
    style:width
    {@attach portal(() => anchor)}
    {@attach floating({ anchor: () => anchor, placement, offset })}
    {@attach dismissable(close, () => [anchor])}
    {@attach focusOnOpen}
  >
    {@render children()}
  </div>
{/if}

<style>
  .popover {
    z-index: var(--z-popover);
    max-height: max(120px, var(--available, 100vh));
    overflow: auto;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-popover);
    transition:
      opacity var(--fade-2) linear,
      translate var(--dur-2) var(--ease-decelerate);
  }
  .popover:focus {
    outline: none;
  }
  .popover:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
  }

  @starting-style {
    .popover {
      opacity: 0;
      translate: 0 -4px;
    }
  }
</style>

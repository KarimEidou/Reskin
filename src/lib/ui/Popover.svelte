<!--
  Non-modal popover anchored to an element. Closes on an outside press, on
  Escape, and on a Tab or Shift+Tab that would leave it. Escape and
  Shift+Tab give focus back to what had it when the popover opened (else
  the anchor); Tab goes on from there to what follows it. Rendered in
  <body>, so no container can clip it (and a Tab out of it would land at
  the other end of the page).
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

  /** What had focus when the popover opened (never the page itself). */
  let opener: HTMLElement | null = null;

  /**
   * The popover's Tab stops, in DOM order: not the other options of a
   * roving-tabindex group (a segmented control's unselected segments).
   */
  const tabStops = (node: HTMLElement) => focusableIn(node).filter((el) => el.tabIndex >= 0);

  function close(reason: 'outside' | 'escape' | 'tab'): void {
    open = false;
    onclose?.();
    // After an outside press, focus is where that press put it.
    if (reason !== 'outside') (opener?.isConnected ? opener : anchor)?.focus({ preventScroll: true });
  }

  /**
   * Remembers the opener, moves focus in (`initialFocus`) and closes the
   * popover on a Tab past its last control or a Shift+Tab past its first
   * (or from the popover itself). Focus is back on the opener before the
   * key's default runs: Tab carries on from there; Shift+Tab stops there.
   */
  function focusBehaviour(node: HTMLElement) {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body && !node.contains(active) ? active : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      const from = document.activeElement;
      if (!from || !node.contains(from)) return;
      const onward = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
      if (tabStops(node).some((el) => from.compareDocumentPosition(el) & onward)) return;
      if (e.shiftKey) e.preventDefault();
      close('tab');
    };
    node.addEventListener('keydown', onKey);
    if (initialFocus !== 'none') {
      const target = initialFocus === 'first' ? (focusableIn(node)[0] ?? node) : node;
      queueMicrotask(() => target.focus({ preventScroll: true }));
    }
    return () => node.removeEventListener('keydown', onKey);
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
    {@attach focusBehaviour}
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

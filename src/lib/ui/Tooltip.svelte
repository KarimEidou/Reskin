<!--
  Tooltip around any trigger:
    <Tooltip text="Undo" shortcut="Ctrl+Z"><button …>…</button></Tooltip>
  Shows after a short hover delay or immediately on keyboard focus; hides
  on leave, blur, press or Escape. The wrapper is `display: contents`, so it
  does not affect layout. While shown, the trigger is described by the
  tooltip (aria-describedby) unless `describe` is false — turn that off
  when the text merely repeats the trigger's accessible name.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { FOCUSABLE_SELECTOR } from './focus';
  import { floating, portal } from './floating';
  import Kbd from './Kbd.svelte';
  import type { Placement } from './position';

  interface Props {
    text: string;
    /** Keyboard shortcut shown next to the text. */
    shortcut?: string;
    placement?: Placement;
    /** Hover delay in ms. */
    delay?: number;
    describe?: boolean;
    disabled?: boolean;
    children: Snippet;
  }

  let {
    text,
    shortcut,
    placement = 'top',
    delay = 450,
    describe = true,
    disabled = false,
    children,
  }: Props = $props();

  const id = $props.id();
  let anchor: HTMLSpanElement | undefined = $state();
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** The element to position against: the trigger itself. */
  const target = () => (anchor?.firstElementChild as HTMLElement | null) ?? null;

  function show(immediate: boolean): void {
    if (disabled || !text) return;
    clearTimeout(timer);
    timer = setTimeout(() => (open = true), immediate ? 0 : delay);
  }

  function hide(): void {
    clearTimeout(timer);
    open = false;
  }

  // Listeners are attached here rather than in the markup: the wrapper is a
  // layout-less span, not an interactive element.
  function wire(node: HTMLSpanElement) {
    const enter = () => show(false);
    const focusIn = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.matches(':focus-visible')) show(true);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        hide();
      }
    };
    node.addEventListener('pointerenter', enter);
    node.addEventListener('pointerleave', hide);
    node.addEventListener('pointerdown', hide);
    node.addEventListener('focusin', focusIn);
    node.addEventListener('focusout', hide);
    node.addEventListener('keydown', key);
    return () => {
      clearTimeout(timer);
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', hide);
      node.removeEventListener('pointerdown', hide);
      node.removeEventListener('focusin', focusIn);
      node.removeEventListener('focusout', hide);
      node.removeEventListener('keydown', key);
    };
  }

  $effect(() => {
    if (!open || !describe) return;
    const trigger = anchor?.matches(FOCUSABLE_SELECTOR) ? anchor : anchor?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!trigger) return;
    const previous = trigger.getAttribute('aria-describedby');
    trigger.setAttribute('aria-describedby', previous ? `${previous} ${id}` : id);
    return () => {
      if (previous) trigger.setAttribute('aria-describedby', previous);
      else trigger.removeAttribute('aria-describedby');
    };
  });

  $effect(() => {
    if (disabled) hide();
  });
</script>

<span class="anchor" bind:this={anchor} {@attach wire}>{@render children()}</span>

{#if open}
  <div class="tooltip" role="tooltip" {id} {@attach portal(target)} {@attach floating({ anchor: target, placement, offset: 8 })}>
    <span>{text}</span>
    {#if shortcut}<Kbd keys={shortcut} size="sm" />{/if}
  </div>
{/if}

<style>
  .anchor {
    display: contents;
  }

  .tooltip {
    z-index: var(--z-tooltip);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 280px;
    padding: 5px var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-2);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    line-height: var(--leading-tight);
    pointer-events: none;
    transition: opacity var(--fade-2) linear;
  }

  @starting-style {
    .tooltip {
      opacity: 0;
    }
  }
</style>

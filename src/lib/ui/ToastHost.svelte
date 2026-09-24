<!--
  Renders the toast stack (bottom centre). Mount once per page. Hovering or
  focusing the stack pauses auto-dismissal. Screen readers hear each toast
  exactly once: the stack is two persistent live regions (a live region
  inserted together with its text is often not announced, and one inside
  another is read twice) — warnings and errors in an alert region on top,
  info/success toasts in the polite "Notifications" status region below.
  A toast is announced as it is added to its region; the others are not
  read again (aria-atomic="false").
-->
<script lang="ts">
  import { flip } from 'svelte/animate';
  import { fade, fly } from 'svelte/transition';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Info from '@lucide/svelte/icons/info';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import X from '@lucide/svelte/icons/x';
  import { dur } from '$lib/motion/speed.svelte';
  import IconButton from './IconButton.svelte';
  import { dismissToast, pauseToasts, resumeToasts, runToastAction, toasts, type Toast, type ToastKind } from './toasts.svelte';
  import { ICON_STROKE, type IconComponent } from './types';

  interface Props {
    /** Distance from the bottom of the window (CSS length). */
    inset?: string;
  }

  let { inset = '24px' }: Props = $props();

  const urgent = (kind: ToastKind) => kind === 'error' || kind === 'warning';
  const polite = $derived(toasts().filter((t) => !urgent(t.kind)));
  const alerts = $derived(toasts().filter((t) => urgent(t.kind)));

  const ICONS: Record<ToastKind, IconComponent> = {
    info: Info,
    success: CircleCheck,
    warning: TriangleAlert,
    error: CircleAlert,
  };

  function pauseWhileEngaged(node: HTMLElement) {
    const leave = (e: FocusEvent) => {
      if (!node.contains(e.relatedTarget as Node | null)) resumeToasts();
    };
    node.addEventListener('pointerenter', pauseToasts);
    node.addEventListener('pointerleave', resumeToasts);
    node.addEventListener('focusin', pauseToasts);
    node.addEventListener('focusout', leave);
    return () => {
      node.removeEventListener('pointerenter', pauseToasts);
      node.removeEventListener('pointerleave', resumeToasts);
      node.removeEventListener('focusin', pauseToasts);
      node.removeEventListener('focusout', leave);
    };
  }
</script>

{#snippet body(t: Toast)}
  {@const Icon = ICONS[t.kind]}
  <span class="icon" aria-hidden="true"><Icon size={18} strokeWidth={ICON_STROKE} /></span>
  <p class="message">{t.message}</p>
  {#if t.action}
    <button type="button" class="action" onclick={() => runToastAction(t.id)}>{t.action.label}</button>
  {/if}
  <IconButton label="Dismiss notification" icon={X} size="sm" tooltip={false} onclick={() => dismissToast(t.id)} />
{/snippet}

<div class="host" style:bottom={inset} {@attach pauseWhileEngaged}>
  <div class="stack alerts" role="alert" aria-atomic="false">
    {#each alerts as t (t.id)}
      <div
        class="toast kind-{t.kind}"
        animate:flip={{ duration: dur(220) }}
        in:fly={{ y: 14, duration: dur(260), opacity: 0 }}
        out:fade={{ duration: dur(160, 'fade') }}
      >
        {@render body(t)}
      </div>
    {/each}
  </div>
  <section class="stack" aria-label="Notifications" role="status" aria-atomic="false">
    {#each polite as t (t.id)}
      <div
        class="toast kind-{t.kind}"
        animate:flip={{ duration: dur(220) }}
        in:fly={{ y: 14, duration: dur(260), opacity: 0 }}
        out:fade={{ duration: dur(160, 'fade') }}
      >
        {@render body(t)}
      </div>
    {/each}
  </section>
</div>

<style>
  .host {
    position: fixed;
    left: 50%;
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column;
    align-items: center;
    width: max-content;
    max-width: calc(100vw - 32px);
    transform: translateX(-50%);
    pointer-events: none;
  }
  .stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
  /* The gap between the regions only when both show toasts. */
  .alerts:has(> .toast) + .stack:has(> .toast) {
    margin-top: var(--space-2);
  }
  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 280px;
    max-width: 520px;
    padding: var(--space-1-5) var(--space-1-5) var(--space-1-5) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-3);
    pointer-events: auto;
  }
  .icon {
    display: grid;
    flex: none;
    color: var(--accent-text);
  }
  .kind-success .icon {
    color: var(--success);
  }
  .kind-warning .icon {
    color: var(--warning);
  }
  .kind-error .icon {
    color: var(--danger);
  }
  .kind-error {
    border-color: rgb(var(--danger-rgb) / 0.35);
  }
  .message {
    flex: 1;
    margin: 0;
    padding: var(--space-1) 0;
    font-size: var(--text-md);
    line-height: var(--leading-normal);
  }
  .action {
    flex: none;
    height: var(--control-sm);
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--accent-text);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    cursor: default;
  }
  .action:hover {
    background: var(--surface-hover);
  }
  .action:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
</style>

<!--
  Modal dialog on the native <dialog> (inert background, top layer) with an
  explicit Tab focus trap, Escape / backdrop dismissal (when `dismissible`)
  and focus restored to the previously focused element on close.
    <Dialog bind:open title="Restore all icons?" description="…">
      …body…
      {#snippet footer()}<Button onclick={…}>Cancel</Button>…{/snippet}
    </Dialog>
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import { focusableIn, trapTab } from './focus';
  import IconButton from './IconButton.svelte';

  interface Props {
    open?: boolean;
    title: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg';
    /** Escape, the close button and backdrop clicks close it. */
    dismissible?: boolean;
    onclose?: () => void;
    children?: Snippet;
    footer?: Snippet;
  }

  let {
    open = $bindable(false),
    title,
    description,
    size = 'md',
    dismissible = true,
    onclose,
    children,
    footer,
  }: Props = $props();

  const id = $props.id();
  let dialog: HTMLDialogElement | undefined = $state();
  let restoreFocus: HTMLElement | null = null;

  function close(): void {
    if (!open) return;
    open = false;
    onclose?.();
  }

  $effect(() => {
    const el = dialog;
    if (!el) return;
    if (open && !el.open) {
      restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.showModal();
      const first = focusableIn(el.querySelector('.body') ?? el)[0] ?? focusableIn(el)[0];
      first?.focus();
    } else if (!open && el.open) {
      el.close();
      restoreFocus?.focus();
      restoreFocus = null;
    }
  });

  // Keyboard and backdrop handling (attached to the <dialog> itself).
  function behaviour(node: HTMLDialogElement) {
    const onCancel = (e: Event) => {
      // Escape: native dialogs close themselves; route it through `open`.
      e.preventDefault();
      if (dismissible) close();
    };
    const onKey = (e: KeyboardEvent) => trapTab(e, node);
    const onClick = (e: MouseEvent) => {
      // The panel fills the dialog box, so a click whose target is the
      // <dialog> element itself landed on the ::backdrop.
      if (dismissible && e.target === node) close();
    };
    node.addEventListener('cancel', onCancel);
    node.addEventListener('keydown', onKey);
    node.addEventListener('click', onClick);
    return () => {
      node.removeEventListener('cancel', onCancel);
      node.removeEventListener('keydown', onKey);
      node.removeEventListener('click', onClick);
      if (!node.open) return;
      // Removed while open (e.g. its question was answered): a close too,
      // but focus went with the removed content. Give it back once the
      // teardown is over (focus handlers may write state), unless something
      // else took it meanwhile.
      node.close();
      const back = restoreFocus;
      restoreFocus = null;
      if (back) {
        queueMicrotask(() => {
          if (back.isConnected && (document.activeElement === document.body || document.activeElement === null)) {
            back.focus();
          }
        });
      }
    };
  }
</script>

<dialog
  bind:this={dialog}
  class="dialog size-{size}"
  aria-labelledby="{id}-title"
  aria-describedby={description ? `${id}-desc` : undefined}
  {@attach behaviour}
>
  <div class="panel">
    <header>
      <h2 id="{id}-title">{title}</h2>
      {#if dismissible}
        <IconButton label="Close" icon={X} size="sm" tooltip={false} onclick={close} />
      {/if}
    </header>
    {#if description}<p class="desc" id="{id}-desc">{description}</p>{/if}
    {#if children}<div class="body">{@render children()}</div>{/if}
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
</dialog>

<style>
  .dialog {
    width: min(var(--w), calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-dialog);
    opacity: 1;
    transform: none;
    transition:
      opacity var(--fade-2) linear,
      transform var(--dur-3) var(--ease-spring),
      overlay var(--fade-2) allow-discrete,
      display var(--fade-2) allow-discrete;
  }
  .dialog:not(:modal) {
    opacity: 0;
    transform: scale(0.97);
  }
  .size-sm {
    --w: 360px;
  }
  .size-md {
    --w: 480px;
  }
  .size-lg {
    --w: 640px;
  }
  .dialog::backdrop {
    background: var(--scrim);
    opacity: 1;
    transition:
      opacity var(--fade-2) linear,
      overlay var(--fade-2) allow-discrete,
      display var(--fade-2) allow-discrete;
  }
  .dialog:not(:modal)::backdrop {
    opacity: 0;
  }

  @starting-style {
    .dialog:modal {
      opacity: 0;
      transform: scale(0.97);
    }
    .dialog:modal::backdrop {
      opacity: 0;
    }
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5) var(--space-6) var(--space-5);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    line-height: var(--leading-tight);
  }
  .desc {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-md);
    line-height: var(--leading-relaxed);
  }
  .body {
    min-height: 0;
    overflow: auto;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
</style>

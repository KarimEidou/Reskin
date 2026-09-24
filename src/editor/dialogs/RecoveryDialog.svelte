<!--
  Crash recovery: a design autosaved in an earlier session was never applied
  or saved. Restore opens it; Discard deletes the autosave; closing the
  dialog keeps it (the Start view's banner still offers it). Both share
  shell.recovery, so a choice here updates the banner too.
-->
<script lang="ts">
  import LifeBuoy from '@lucide/svelte/icons/life-buoy';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getShell } from '../chrome/shell.svelte';
  import { errorText } from '../state/session.svelte';
  import { autofocus } from './autofocus';

  interface Props {
    /** The autosaved project JSON, or null when there is nothing to offer. */
    draft: string | null;
    onclose: () => void;
  }

  let { draft, onclose }: Props = $props();
  const shell = getShell();
  let open = $state(false);
  let busy = $state(false);

  $effect(() => {
    open = draft !== null;
  });

  async function restore(): Promise<void> {
    if (!draft) return;
    busy = true;
    try {
      await shell.restoreRecovery(draft);
      onclose();
    } catch (e) {
      toast({ message: `Could not restore the design: ${errorText(e)}`, kind: 'error' });
    } finally {
      busy = false;
    }
  }

  async function discard(): Promise<void> {
    busy = true;
    try {
      await shell.discardRecovery();
    } catch (e) {
      toast({ message: `Could not discard it: ${errorText(e)}`, kind: 'error' });
    } finally {
      busy = false;
      onclose();
    }
  }
</script>

{#if draft !== null}
  <Dialog bind:open title="Restore your unsaved design?" size="sm" {onclose}>
    <div class="body" data-testid="recovery-dialog">
      <span class="badge" aria-hidden="true"><LifeBuoy size={20} /></span>
      <p>Reskin closed before your last design was applied or saved. You can pick up right where you left off.</p>
    </div>
    {#snippet footer()}
      <Button variant="ghost" disabled={busy} onclick={discard}>Discard</Button>
      <Button variant="primary" loading={busy} onclick={restore} {@attach autofocus}>Restore</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .body {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  p {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-md);
    line-height: var(--leading-relaxed);
  }
</style>

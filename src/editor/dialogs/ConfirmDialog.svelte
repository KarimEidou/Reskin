<!-- Renders the pending `confirm()` question (see ./confirm.svelte.ts). -->
<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import { answerConfirm, pendingConfirm } from './confirm.svelte';

  const pending = $derived(pendingConfirm());
  let open = $state(false);

  // Mirror the store into the dialog's bindable `open`.
  $effect(() => {
    open = pending !== null;
  });
</script>

{#if pending}
  {#key pending.id}
    <Dialog
      bind:open
      title={pending.options.title}
      description={pending.options.message}
      size="sm"
      onclose={() => answerConfirm(false)}
    >
      {#snippet footer()}
        <Button variant="ghost" onclick={() => answerConfirm(false)}>{pending.options.cancelLabel ?? 'Cancel'}</Button>
        <Button
          variant={pending.options.danger ? 'danger' : 'primary'}
          data-testid="confirm-ok"
          onclick={() => answerConfirm(true)}
        >
          {pending.options.confirmLabel ?? 'OK'}
        </Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}

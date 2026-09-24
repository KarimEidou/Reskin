<!--
  Renders the pending `confirm()` question (see ./confirm.svelte.ts). Focus
  starts on Cancel for destructive questions and on the confirm button
  otherwise, so Enter never destroys anything by accident.
-->
<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import { autofocus } from './autofocus';
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
        <Button variant="ghost" onclick={() => answerConfirm(false)} {@attach pending.options.danger && autofocus}>
          {pending.options.cancelLabel ?? 'Cancel'}
        </Button>
        <Button
          variant={pending.options.danger ? 'danger' : 'primary'}
          data-testid="confirm-ok"
          onclick={() => answerConfirm(true)}
          {@attach !pending.options.danger && autofocus}
        >
          {pending.options.confirmLabel ?? 'OK'}
        </Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}

<!--
  Shown when an apply returned `needsElevation` (session.elevation): the
  item is on the Public Desktop, which only administrators can change.
  Allow → the elevated helper (UAC prompt); or make a personal copy on the
  user's own desktop; or cancel.
-->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Users from '@lucide/svelte/icons/users';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import { getSession } from '../state/context';

  const session = getSession();

  const pending = $derived(session.elevation);
  const name = $derived(session.item?.name ?? 'This shortcut');
  const canCopy = $derived(session.modes.includes('personalCopy'));
  let open = $state(false);

  $effect(() => {
    open = pending !== null;
  });
</script>

{#if pending}
  <Dialog
    bind:open
    title="Administrator permission needed"
    size="md"
    onclose={() => session.dismissElevation()}
  >
    <div class="body" data-testid="elevation-dialog">
      <div class="where">
        <span class="badge" aria-hidden="true"><Users size={20} /></span>
        <p>
          <strong>{name}</strong> is on the <strong>Public Desktop</strong>, which every account on this PC shares.
          Windows only lets administrators change it.
        </p>
      </div>
      {#if pending.reason}<p class="reason">{pending.reason}</p>{/if}
      <ul class="options">
        <li>
          <ShieldCheck size={16} aria-hidden="true" />
          <span><strong>Allow</strong> changes it for everyone. Windows asks for permission once.</span>
        </li>
        {#if canCopy}
          <li>
            <Copy size={16} aria-hidden="true" />
            <span><strong>Personal copy</strong> puts a copy on your own desktop with the new icon — no admin needed.</span>
          </li>
        {/if}
      </ul>
    </div>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => session.dismissElevation()}>Cancel</Button>
      {#if canCopy}
        <Button icon={Copy} onclick={() => void session.personalCopy()}>Make a personal copy</Button>
      {/if}
      <Button variant="primary" icon={ShieldCheck} onclick={() => void session.approveElevation()}>
        Allow (administrator)
      </Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: var(--text-md);
    line-height: var(--leading-relaxed);
  }
  .where {
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
    background: rgb(var(--warning-rgb) / 0.14);
    color: var(--warning);
  }
  p {
    margin: 0;
    color: var(--text-2);
  }
  strong {
    color: var(--text);
    font-weight: var(--weight-semibold);
  }
  .reason {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--shell-well);
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .options li {
    display: flex;
    gap: var(--space-2);
    align-items: flex-start;
    color: var(--text-2);
  }
  .options :global(svg) {
    flex: none;
    margin-top: 3px;
    color: var(--accent-text);
  }
</style>

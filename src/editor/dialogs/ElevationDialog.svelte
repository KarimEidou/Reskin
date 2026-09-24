<!--
  Shown when applies returned `needsElevation` (session.elevation): the
  items are on the Public Desktop, which only administrators can change —
  one item after Save & Apply, or every such item of an "Apply style to
  all" at once. Allow → the elevated helper (a UAC prompt per item); or
  personal copies on the user's own desktop; or cancel.
-->
<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Users from '@lucide/svelte/icons/users';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import { getSession } from '../state/context';
  import { autofocus } from './autofocus';

  const session = getSession();

  const pending = $derived(session.elevation);
  const names = $derived(pending?.requests.map((r) => r.entry.info.name) ?? []);
  const many = $derived(names.length > 1);
  /** Items that can be copied instead (shortcuts shared by all users). */
  const copyable = $derived(pending?.requests.filter((r) => r.entry.info.modes.includes('personalCopy')).length ?? 0);
  const reasons = $derived([...new Set(pending?.requests.map((r) => r.reason).filter((r) => r !== '') ?? [])]);
  let open = $state(false);

  $effect(() => {
    open = pending !== null;
  });
</script>

{#if pending}
  <Dialog
    bind:open
    title="Administrator permission needed"
    size="lg"
    onclose={() => session.dismissElevation()}
  >
    <div class="body" data-testid="elevation-dialog">
      <div class="where">
        <span class="badge" aria-hidden="true"><Users size={20} /></span>
        {#if many}
          <p>
            <strong>{names.length} shortcuts</strong> are on the <strong>Public Desktop</strong>, which every account on this
            PC shares. Windows only lets administrators change them.
          </p>
        {:else}
          <p>
            <strong>{names[0]}</strong> is on the <strong>Public Desktop</strong>, which every account on this PC shares.
            Windows only lets administrators change it.
          </p>
        {/if}
      </div>
      {#if many}
        <ul class="names" aria-label="Waiting for approval">
          {#each names as name, i (i)}<li>{name}</li>{/each}
        </ul>
      {/if}
      {#each reasons as reason (reason)}<p class="reason">{reason}</p>{/each}
      <ul class="options">
        <li>
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            <strong>Allow</strong> changes {many ? 'them' : 'it'} for everyone. Windows asks for permission {many
              ? 'for each one'
              : 'once'}.
          </span>
        </li>
        {#if copyable > 0}
          <li>
            <Copy size={16} aria-hidden="true" />
            <span>
              <strong>Personal {copyable > 1 ? 'copies' : 'copy'}</strong> put{copyable > 1 ? '' : 's'} a copy on your own
              desktop with the new icon — no admin needed.
            </span>
          </li>
        {/if}
      </ul>
    </div>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => session.dismissElevation()}>Cancel</Button>
      {#if copyable > 0}
        <Button icon={Copy} onclick={() => void session.personalCopy()}>
          {copyable > 1 ? 'Make personal copies' : 'Make a personal copy'}
        </Button>
      {/if}
      <Button variant="primary" icon={ShieldCheck} onclick={() => void session.approveElevation()} {@attach autofocus}>
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
  .names {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .names li {
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    background: var(--shell-well);
    color: var(--text);
    font-size: var(--text-sm);
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

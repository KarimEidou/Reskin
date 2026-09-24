<!--
  Settings › About › Open-source licenses: the third-party notices of this
  build. scripts/third-party-notices.mjs writes THIRD_PARTY_NOTICES.txt next
  to the pages when the app is built for release (the same file is attached
  to every GitHub release); it is fetched the first time the dialog opens.
  Development and test builds have none and say so.
-->
<script module lang="ts">
  /** Served next to editor.html. */
  const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
  /** The notices once fetched (they don't change while the app runs). */
  let cached: string | null = null;
</script>

<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { onMount } from 'svelte';
  import Button from '$lib/ui/Button.svelte';
  import Dialog from '$lib/ui/Dialog.svelte';
  import Spinner from '$lib/ui/Spinner.svelte';
  import { errorText } from '../../state/session.svelte';

  interface Props {
    onclose: () => void;
    onreleases: () => void;
  }

  let { onclose, onreleases }: Props = $props();

  type Notices =
    | { kind: 'loading' }
    | { kind: 'ready'; text: string }
    | { kind: 'missing' }
    | { kind: 'failed'; message: string };

  let open = $state(true);
  let notices = $state<Notices>(cached === null ? { kind: 'loading' } : { kind: 'ready', text: cached });

  onMount(() => {
    if (cached !== null) return;
    let live = true;
    const show = (next: Notices) => {
      if (live) notices = next;
    };
    void (async () => {
      try {
        const response = await fetch(NOTICES_FILE);
        if (response.status === 404) return show({ kind: 'missing' });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
        cached = await response.text();
        show({ kind: 'ready', text: cached });
      } catch (e) {
        show({ kind: 'failed', message: errorText(e) });
      }
    })();
    return () => {
      live = false;
    };
  });

  function close(): void {
    open = false;
    onclose();
  }
</script>

<Dialog
  bind:open
  title="Open-source licenses"
  description="Reskin is built with these open-source components, under their own licenses. The list comes first, then every license text."
  size="lg"
  {onclose}
>
  <div class="content" data-testid="licenses-dialog" data-state={notices.kind}>
    {#if notices.kind === 'loading'}
      <div class="state"><Spinner size={20} label="Loading the licenses" /></div>
    {:else if notices.kind === 'ready'}
      <textarea class="notices" readonly spellcheck="false" aria-label="Third-party notices" value={notices.text}></textarea>
    {:else if notices.kind === 'missing'}
      <p class="state">
        This build doesn't include the license list: only release builds do. Every release also offers it as
        THIRD_PARTY_NOTICES.txt on the Releases page.
      </p>
    {:else}
      <p class="state" role="alert">The license list couldn't be loaded: {notices.message}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button variant="ghost" icon={ExternalLink} onclick={onreleases}>Releases</Button>
    <Button onclick={close}>Close</Button>
  {/snippet}
</Dialog>

<style>
  .content {
    display: flex;
    flex-direction: column;
  }
  .notices {
    height: min(420px, calc(100vh - 260px));
    min-height: 160px;
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--shell-well);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    resize: none;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .notices:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .state {
    display: grid;
    place-items: center;
    min-height: 120px;
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-md);
    line-height: var(--leading-relaxed);
    text-align: center;
  }
</style>

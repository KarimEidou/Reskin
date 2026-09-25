<!--
  "Save to Library": asks for a name, then saves under it. A design linked
  to a Library design (it came from it or was saved as it) says so: Save
  changes updates that design — the notice names it, and says so when the
  typed name renames it — and "Save as new" adds another (under the name
  typed, or "<name> copy" when it is still the linked design's). Open while
  `shell.saveFormOpen` is: its button toggles it, and Ctrl+S / the palette
  open it for a linked design (shell.requestSaveToLibrary).
-->
<script lang="ts">
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import { untrack } from 'svelte';
  import Button from '$lib/ui/Button.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { getShell } from '../chrome/shell.svelte';
  import { getSession } from '../state/context';
  import { commitPendingWork } from './stage.svelte';

  const session = getSession();
  const shell = getShell();

  let anchor: HTMLElement | undefined = $state();
  let name = $state('');
  /** Which save runs: over the linked Library design, or as a new one. */
  let saving = $state<'update' | 'new' | null>(null);
  const id = $props.id();

  /** The name of the Library design a save updates, or null when it adds one. */
  const linked = $derived(session.libraryId !== null ? session.libraryName : null);
  const typed = $derived(name.trim());

  /** The name the form starts with: the linked design's, else the design's own. */
  function prefill(): void {
    const docName = session.engine.doc.meta.name?.trim();
    name = linked ?? (docName && docName !== 'Untitled' ? docName : (session.item?.name ?? 'My icon'));
  }

  // The name is filled in as the form opens, however it opens (also as
  // this mounts with the form asked for: Ctrl+S from another view) and
  // before the field is laid out, so it starts selected.
  let wasOpen = false;
  $effect.pre(() => {
    const open = shell.saveFormOpen;
    if (open && !wasOpen) untrack(prefill);
    wasOpen = open;
  });

  // The form belongs to the Edit view: leaving it closes the form.
  $effect(() => () => {
    shell.saveFormOpen = false;
  });

  function toggle(): void {
    shell.saveFormOpen = !shell.saveFormOpen;
  }

  /** Closes the form and gives focus back to the button that opened it. */
  function close(): void {
    shell.saveFormOpen = false;
    anchor?.querySelector('button')?.focus({ preventScroll: true });
  }

  async function save(asNew: boolean): Promise<void> {
    if (!typed || saving) return;
    saving = asNew ? 'new' : 'update';
    commitPendingWork(session.engine);
    // A new design never takes the linked one's name as it is.
    const saveAs = asNew && linked !== null && typed === linked ? `${linked} copy` : typed;
    try {
      if ((await shell.saveToLibrary(saveAs, { asNew })) && shell.saveFormOpen) close();
    } finally {
      saving = null;
    }
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    // Only the form that names the linked design ever saves over it.
    void save(linked === null);
  }

  function selectAll(node: HTMLInputElement) {
    queueMicrotask(() => node.select());
  }
</script>

<span class="anchor" bind:this={anchor}>
  <Tooltip text="Save to Library" placement="top" describe={false}>
    <Button
      variant="ghost"
      icon={BookmarkPlus}
      aria-label="Save to Library"
      aria-haspopup="dialog"
      aria-expanded={shell.saveFormOpen}
      disabled={!session.hasDesign}
      data-testid="save-library"
      onclick={toggle}
    >
      <span class="collapsible-label">Save</span>
    </Button>
  </Tooltip>
</span>

<Popover
  bind:open={shell.saveFormOpen}
  anchor={anchor?.querySelector('button')}
  label="Save to Library"
  placement="top-end"
  offset={8}
  width={linked === null ? '280px' : '320px'}
  initialFocus="first"
>
  <form class="form" onsubmit={submit}>
    {#if linked === null}
      <label class="label" for="{id}-name">Save this design to your Library as</label>
    {:else}
      <p class="linked" id="{id}-linked" data-testid="library-link">
        {#if typed && typed !== linked}
          Updates "{linked}" in your Library and renames it "{typed}".
        {:else}
          Updates "{linked}" in your Library.
        {/if}
      </p>
      <label class="label" for="{id}-name">Name</label>
    {/if}
    <input
      id="{id}-name"
      type="text"
      autocomplete="off"
      spellcheck="false"
      maxlength="80"
      aria-describedby={linked === null ? undefined : `${id}-linked`}
      bind:value={name}
      {@attach selectAll}
    />
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={close}>Cancel</Button>
      {#if linked === null}
        <Button size="sm" variant="primary" type="submit" loading={saving !== null} disabled={!typed}>Save</Button>
      {:else}
        <Button size="sm" loading={saving === 'new'} disabled={!typed || saving === 'update'} onclick={() => save(true)}>Save as new</Button>
        <Button size="sm" variant="primary" type="submit" loading={saving === 'update'} disabled={!typed || saving === 'new'}>Save changes</Button>
      {/if}
    </div>
  </form>
</Popover>

<style>
  .anchor {
    display: inline-flex;
    flex: none;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .label {
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .linked {
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  input {
    height: var(--control-md);
    padding: 0 var(--space-3);
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-md);
    background: var(--surface-sunken);
    color: var(--text);
    font-size: var(--text-md);
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
    box-shadow: inset 0 -1px 0 var(--accent);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }
</style>

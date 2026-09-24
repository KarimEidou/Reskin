<!-- "Save to Library": asks for a name, then session.saveToLibrary(name). -->
<script lang="ts">
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import Button from '$lib/ui/Button.svelte';
  import Popover from '$lib/ui/Popover.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { getSession } from '../state/context';

  const session = getSession();

  let open = $state(false);
  let anchor: HTMLElement | undefined = $state();
  let name = $state('');
  let saving = $state(false);
  const id = $props.id();

  function toggle(): void {
    if (!open) {
      const docName = session.engine.doc.meta.name?.trim();
      name = docName && docName !== 'Untitled' ? docName : (session.item?.name ?? 'My icon');
    }
    open = !open;
  }

  async function save(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    saving = true;
    try {
      if (await session.saveToLibrary(trimmed)) open = false;
    } finally {
      saving = false;
    }
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
      aria-expanded={open}
      disabled={!session.hasDesign}
      data-testid="save-library"
      onclick={toggle}
    >
      <span class="collapsible-label">Save</span>
    </Button>
  </Tooltip>
</span>

<Popover
  bind:open
  anchor={anchor?.querySelector('button')}
  label="Save to Library"
  placement="top-end"
  offset={8}
  width="280px"
  initialFocus="first"
>
  <form class="form" onsubmit={save}>
    <label class="label" for="{id}-name">Save this design to your Library as</label>
    <input id="{id}-name" type="text" autocomplete="off" spellcheck="false" maxlength="80" bind:value={name} {@attach selectAll} />
    <div class="actions">
      <Button size="sm" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
      <Button size="sm" variant="primary" type="submit" loading={saving} disabled={!name.trim()}>Save</Button>
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

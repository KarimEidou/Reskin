<!--
  Files dropped onto the editor window. Shortcuts/folders join the queue;
  images and projects open as a design — or, while a design is open, a
  popover at the drop point asks: add as a layer, or open instead?
  Also drives `shell.dragging` (the drop highlight).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Layers from '@lucide/svelte/icons/layers';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { commands } from '$lib/ipc/commands';
  import type { ItemInfo } from '$lib/ipc/types';
  import { play } from '$lib/sound/synth';
  import { physicalToCss } from '$lib/ui/box-geometry';
  import Popover from '$lib/ui/Popover.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getShell } from '../chrome/shell.svelte';
  import { getSession } from '../state/context';
  import { errorText, isTarget } from '../state/session.svelte';

  const session = getSession();
  const shell = getShell();

  let ask = $state.raw<{ sources: ItemInfo[]; x: number; y: number } | null>(null);
  let open = $state(false);
  let anchor: HTMLSpanElement | undefined = $state();

  const images = $derived(ask ? ask.sources.filter((s) => s.kind !== 'project') : []);
  const projects = $derived(ask ? ask.sources.filter((s) => s.kind === 'project') : []);
  const what = $derived(
    images.length === 1 ? `“${images[0]!.name}”` : images.length > 1 ? `${images.length} images` : projects.length === 1 ? `“${projects[0]!.name}”` : 'these files',
  );

  $effect(() => {
    if (!open) ask = null;
  });

  async function handleDrop(paths: string[], at: { x: number; y: number }): Promise<void> {
    if (paths.length === 0) return;
    let items: ItemInfo[];
    try {
      items = await commands.inspectPaths(paths);
    } catch (e) {
      toast({ message: `Could not read what you dropped: ${errorText(e)}`, kind: 'error' });
      play('error');
      return;
    }
    if (items.length === 0) {
      toast({ message: 'None of these items can be reskinned.', kind: 'error' });
      play('error');
      return;
    }
    play('drop');
    const targets = items.filter(isTarget);
    const sources = items.filter((i) => !isTarget(i));
    const editing = session.hasDesign;
    if (targets.length > 0) {
      const hadQueue = session.queue.length > 0;
      await shell.openItems(targets);
      if (hadQueue) {
        toast({ message: `Added ${targets.length} item${targets.length === 1 ? '' : 's'} to the queue.`, kind: 'info' });
      }
    }
    if (sources.length === 0) return;
    if (!editing) {
      await shell.openItems(sources);
      return;
    }
    const css = physicalToCss(at, window.devicePixelRatio);
    ask = { sources, x: css.x, y: css.y };
    open = true;
  }

  async function addAsLayers(): Promise<void> {
    const list = images;
    open = false;
    try {
      for (const s of list) await session.addSource(s);
      session.navigate('edit');
    } catch (e) {
      toast({ message: `Could not add the image: ${errorText(e)}`, kind: 'error' });
    }
  }

  async function openInstead(): Promise<void> {
    const list = ask?.sources ?? [];
    open = false;
    if (list.length === 0) return;
    // A project replaces the design; images start a new standalone design.
    if (list.some((s) => s.kind === 'project')) {
      const project = list.find((s) => s.kind === 'project')!;
      try {
        await session.addSource(project);
        session.navigate('edit');
      } catch (e) {
        toast({ message: `Could not open the project: ${errorText(e)}`, kind: 'error' });
      }
      return;
    }
    session.reset();
    await shell.openItems(list);
  }

  onMount(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        switch (payload.type) {
          case 'enter':
            shell.dragging = shell.interactive;
            break;
          case 'leave':
            shell.dragging = false;
            break;
          case 'drop':
            shell.dragging = false;
            if (shell.interactive) void handleDrop(payload.paths, payload.position);
            break;
          default:
            break;
        }
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch((e: unknown) => console.error('[editor] drag-drop unavailable', e));
    return () => {
      disposed = true;
      unlisten?.();
    };
  });
</script>

{#if ask}
  <span class="anchor" bind:this={anchor} style:left="{ask.x}px" style:top="{ask.y}px"></span>
{/if}

<Popover bind:open {anchor} label="Import dropped files" placement="bottom-start" initialFocus="first" width="300px">
  <div class="pop" data-testid="import-popover">
    <p class="title">Use {what} how?</p>
    {#if images.length > 0}
      <button type="button" class="choice" onclick={addAsLayers}>
        <Layers size={18} aria-hidden="true" />
        <span>
          <strong>Add as layer{images.length > 1 ? 's' : ''}</strong>
          <small>Place it on top of the current design.</small>
        </span>
      </button>
    {/if}
    <button type="button" class="choice" onclick={openInstead}>
      <FolderOpen size={18} aria-hidden="true" />
      <span>
        <strong>{projects.length > 0 ? 'Open the project' : 'Open as a new design'}</strong>
        <small>
          {projects.length === 0 && session.queue.length > 1
            ? `Replaces what you're editing and clears the queue (${session.queue.length} icons).`
            : "Replaces what you're editing now."}
        </small>
      </span>
    </button>
    <button type="button" class="cancel" onclick={() => (open = false)}>Cancel</button>
  </div>
</Popover>

<style>
  .anchor {
    position: fixed;
    width: 1px;
    height: 1px;
    pointer-events: none;
  }
  .pop {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .title {
    margin: 0 0 var(--space-1) var(--space-1);
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }
  .choice {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .choice:hover {
    background: var(--surface-hover);
  }
  .choice:focus-visible,
  .cancel:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
  .choice :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--accent-text);
  }
  .choice span {
    display: flex;
    flex-direction: column;
  }
  .choice strong {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }
  .choice small {
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .cancel {
    align-self: flex-end;
    height: 26px;
    margin-top: var(--space-1);
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  .cancel:hover {
    background: var(--surface-hover);
  }
</style>

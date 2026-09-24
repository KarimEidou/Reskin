<!--
  The import popover. Files dropped on the editor window go through
  shell.askImport (as do picked files and anything else brought in): with
  nothing open they open right away; with a design open this popover asks
  what they become — layers of the design, new queue items (the design
  keeps its own entry), or, for a shortcut dropped on a design that has no
  target yet, that shortcut's design. Nothing open is ever replaced.
  Also drives `shell.dragging` (the drop highlight).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Layers from '@lucide/svelte/icons/layers';
  import ListPlus from '@lucide/svelte/icons/list-plus';
  import Wand from '@lucide/svelte/icons/wand-sparkles';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { commands } from '$lib/ipc/commands';
  import type { ItemInfo } from '$lib/ipc/types';
  import { play } from '$lib/sound/synth';
  import { physicalToCss } from '$lib/ui/box-geometry';
  import Popover from '$lib/ui/Popover.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import type { IconComponent } from '$lib/ui/types';
  import { getShell } from '../chrome/shell.svelte';
  import { getSession } from '../state/context';
  import { errorText, isTarget, type ImportChoice } from '../state/session.svelte';

  const session = getSession();
  const shell = getShell();

  interface Choice {
    how: ImportChoice;
    icon: IconComponent;
    title: string;
    detail: string;
  }

  let anchor: HTMLSpanElement | undefined = $state();

  const question = $derived(shell.importQuestion);
  const sources = $derived(question?.sources ?? []);
  const items = $derived(sources.flatMap((s) => (s.kind === 'item' ? [s.info] : [])));
  const targets = $derived(items.filter(isTarget));
  /** What can become a layer: pictures, images and other items' icons (not projects). */
  const layerable = $derived(sources.filter((s) => s.kind === 'image' || s.info.kind !== 'project').length);
  const what = $derived(sources.length === 1 ? `“${nameOf(sources[0]!)}”` : `${sources.length} items`);
  const at = $derived(question?.at ?? { x: window.innerWidth / 2 - 150, y: window.innerHeight / 3 });

  function nameOf(source: (typeof sources)[number]): string {
    return source.kind === 'item' ? source.info.name : source.name;
  }

  const choices = $derived.by((): Choice[] => {
    // The first shortcut that can take over the open design (when it has no target yet).
    const first: ItemInfo | undefined = targets.find((t) => session.canAdopt(t));
    const others = sources.length - 1;
    const one = sources.length === 1;
    const onlyTargets = targets.length === sources.length;
    const layer: Choice = {
      how: 'layer',
      icon: Layers,
      title: onlyTargets ? (one ? 'Use its icon as a layer' : 'Use their icons as layers') : layerable === 1 ? 'Add as layer' : 'Add as layers',
      detail: layerable === 1 ? 'Place it on top of the current design.' : 'Place them on top of the current design.',
    };
    const queue: Choice = {
      how: 'queue',
      icon: ListPlus,
      title: onlyTargets ? (one ? 'Queue it' : `Queue ${sources.length} items`) : one ? 'Queue as new item' : 'Queue as new items',
      detail: onlyTargets
        ? one
          ? 'Edit it next, starting from its own icon.'
          : 'Edit them next, each starting from its own icon.'
        : 'Nothing you are editing is replaced.',
    };
    const list: Choice[] = [];
    if (first) {
      list.push({
        how: 'adopt',
        icon: Wand,
        title: `Apply this design to “${first.name}”`,
        detail: others > 0 ? `It gets your design; the other ${others} join the queue.` : 'Your design becomes its new icon.',
      });
    }
    if (targets.length > 0) list.push(queue);
    if (layerable > 0) list.push(layer);
    if (targets.length === 0) list.push(queue);
    return list;
  });

  function choose(how: ImportChoice): void {
    const q = question;
    if (q) void shell.importAs(q.sources, how);
  }

  async function handleDrop(paths: string[], position: { x: number; y: number }): Promise<void> {
    if (paths.length === 0) return;
    let dropped: ItemInfo[];
    try {
      dropped = await commands.inspectPaths(paths);
    } catch (e) {
      toast({ message: `Could not read what you dropped: ${errorText(e)}`, kind: 'error' });
      play('error');
      return;
    }
    if (dropped.length === 0) {
      toast({ message: 'None of these items can be reskinned.', kind: 'error' });
      play('error');
      return;
    }
    play('drop');
    await shell.askImport(
      dropped.map((info) => ({ kind: 'item', info })),
      physicalToCss(position, window.devicePixelRatio),
    );
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

{#if question}
  <span class="anchor" bind:this={anchor} style:left="{at.x}px" style:top="{at.y}px"></span>
{/if}

<Popover
  bind:open={() => question !== null, (open) => {
    if (!open) shell.importQuestion = null;
  }}
  {anchor}
  label="Import"
  placement="bottom-start"
  initialFocus="first"
  width="320px"
>
  <div class="pop" data-testid="import-popover">
    <p class="title">Use {what} how?</p>
    {#each choices as c (c.how)}
      <button type="button" class="choice" data-choice={c.how} onclick={() => choose(c.how)}>
        <c.icon size={18} aria-hidden="true" />
        <span>
          <strong>{c.title}</strong>
          <small>{c.detail}</small>
        </span>
      </button>
    {/each}
    <button type="button" class="cancel" onclick={() => (shell.importQuestion = null)}>Cancel</button>
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

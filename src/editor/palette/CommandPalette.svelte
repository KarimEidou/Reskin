<!--
  Command palette (Ctrl+K): fuzzy search over every available command,
  grouped when the query is empty. ↑/↓ move, Enter runs, Esc closes.
  Combobox + listbox with aria-activedescendant; focus stays in the input.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
  import Search from '@lucide/svelte/icons/search';
  import Kbd from '$lib/ui/Kbd.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { errorText } from '../state/session.svelte';
  import { availableCommands, GROUP_ORDER, type Command, type CommandContext, type CommandGroup } from './commands';
  import { fuzzyFilter, highlightRuns } from './fuzzy';
  import { commandIcon } from './icons';
  import { comboKeys } from './keys';

  interface Props {
    open?: boolean;
    commands: readonly Command[];
    ctx: CommandContext;
  }

  let { open = $bindable(false), commands, ctx }: Props = $props();

  const uid = $props.id();
  let dialog: HTMLDialogElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let query = $state('');
  let active = $state(0);
  let available = $state.raw<Command[]>([]);

  type Row = { cmd: Command; indices: number[] };
  type Section = { heading: CommandGroup | null; rows: Row[] };

  const sections: Section[] = $derived.by(() => {
    if (!query.trim()) {
      return GROUP_ORDER.map((g) => ({
        heading: g,
        rows: available.filter((c) => c.group === g).map((cmd) => ({ cmd, indices: [] })),
      })).filter((s) => s.rows.length > 0);
    }
    const ranked = fuzzyFilter(
      available,
      query,
      (c) => c.label,
      (c) => [...(c.keywords ?? []), c.group],
    );
    return [{ heading: null, rows: ranked.slice(0, 60).map((r) => ({ cmd: r.item, indices: r.indices })) }];
  });
  const flat = $derived(sections.flatMap((s) => s.rows));
  const optionId = (i: number) => `${uid}-opt-${i}`;

  $effect(() => {
    const el = dialog;
    if (!el) return;
    if (open && !el.open) {
      untrack(() => {
        available = availableCommands(commands, ctx);
        query = '';
        active = 0;
      });
      el.showModal();
      input?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  });

  // A new query starts at the best match.
  $effect(() => {
    void query;
    active = 0;
  });

  // Keep the active row in view.
  $effect(() => {
    const id = optionId(active);
    if (!open || !list) return;
    list.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'nearest' });
  });

  function close(): void {
    open = false;
  }

  async function run(cmd: Command | undefined): Promise<void> {
    if (!cmd) return;
    close();
    await tick();
    try {
      await cmd.run(ctx);
    } catch (e) {
      toast({ message: `${cmd.label} failed: ${errorText(e)}`, kind: 'error' });
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    const n = flat.length;
    switch (e.key) {
      case 'ArrowDown':
        if (n) active = (active + 1) % n;
        break;
      case 'ArrowUp':
        if (n) active = (active - 1 + n) % n;
        break;
      case 'PageDown':
        if (n) active = Math.min(n - 1, active + 8);
        break;
      case 'PageUp':
        if (n) active = Math.max(0, active - 8);
        break;
      case 'Enter':
        void run(flat[active]?.cmd);
        break;
      case 'Tab':
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function behaviour(node: HTMLDialogElement) {
    const onCancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    const onClick = (e: MouseEvent) => {
      if (e.target === node) close();
    };
    // The close event is queued, not dispatched by close(): it can arrive
    // after the palette was opened again (a command run with Enter, then
    // Ctrl+K at once), when it must not close the new one.
    const onClose = () => {
      if (open && !node.open) open = false;
    };
    node.addEventListener('cancel', onCancel);
    node.addEventListener('click', onClick);
    node.addEventListener('close', onClose);
    return () => {
      node.removeEventListener('cancel', onCancel);
      node.removeEventListener('click', onClick);
      node.removeEventListener('close', onClose);
      if (node.open) node.close();
    };
  }

  /** Mouse selection on a listbox option (options are not focusable). */
  function pick(index: number) {
    return (node: HTMLElement) => {
      const click = () => void run(flat[index]?.cmd);
      node.addEventListener('click', click);
      return () => node.removeEventListener('click', click);
    };
  }
</script>

<dialog bind:this={dialog} class="palette" aria-label="Command palette" data-testid="command-palette" {@attach behaviour}>
  <div class="search">
    <Search size={18} aria-hidden="true" />
    <input
      bind:this={input}
      bind:value={query}
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="{uid}-list"
      aria-activedescendant={flat.length ? optionId(active) : undefined}
      aria-autocomplete="list"
      aria-label="Search commands"
      placeholder="Type a command or search…"
      autocomplete="off"
      spellcheck="false"
      onkeydown={onKeyDown}
    />
    <Kbd keys="Esc" size="sm" />
  </div>

  <div class="list" id="{uid}-list" role="listbox" aria-label="Commands" bind:this={list}>
    {#if flat.length === 0}
      <p class="empty" role="status">No commands match “{query}”.</p>
    {:else}
      {#each sections as section, s (section.heading ?? s)}
        {@const offset = sections.slice(0, s).reduce((sum, x) => sum + x.rows.length, 0)}
        <div role="group" aria-labelledby={section.heading ? `${uid}-g${s}` : undefined}>
          {#if section.heading}
            <div class="heading" id="{uid}-g{s}">{section.heading}</div>
          {/if}
          {#each section.rows as row, r (row.cmd.id)}
            {@const i = offset + r}
            {@const Icon = commandIcon(row.cmd)}
            {@const shortcut = row.cmd.keys ?? row.cmd.stageKey}
            <div
              id={optionId(i)}
              class="option"
              class:active={i === active}
              role="option"
              aria-selected={i === active}
              tabindex="-1"
              data-command={row.cmd.id}
              onpointermove={() => {
                if (active !== i) active = i;
              }}
              {@attach pick(i)}
            >
              <span class="icon" aria-hidden="true"><Icon size={16} /></span>
              <span class="label">
                {#each highlightRuns(row.cmd.label, row.indices) as seg, k (k)}
                  {#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
                {/each}
              </span>
              {#if !section.heading}<span class="group">{row.cmd.group}</span>{/if}
              {#if shortcut}<Kbd keys={comboKeys(shortcut)} size="sm" />{/if}
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>

  <footer class="hints" aria-hidden="true">
    <span><Kbd keys="↑" size="sm" /><Kbd keys="↓" size="sm" /> navigate</span>
    <span><span class="enter"><CornerDownLeft size={11} /></span> run</span>
    <span><Kbd keys="Esc" size="sm" /> close</span>
  </footer>
</dialog>

<style>
  .palette {
    width: min(600px, calc(100vw - 64px));
    max-height: min(520px, calc(100vh - 140px));
    margin: 84px auto auto;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-dialog);
    overflow: hidden;
    flex-direction: column;
    opacity: 1;
    transform: none;
    transition:
      opacity var(--fade-2) linear,
      transform var(--dur-3) var(--ease-spring),
      overlay var(--fade-2) allow-discrete,
      display var(--fade-2) allow-discrete;
  }
  .palette[open] {
    display: flex;
  }
  .palette:not([open]) {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
  @starting-style {
    .palette[open] {
      opacity: 0;
      transform: translateY(-6px) scale(0.98);
    }
  }
  .palette::backdrop {
    background: rgb(var(--bg-rgb) / 0.35);
  }

  .search {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
    height: 52px;
    padding: 0 var(--space-4);
    border-bottom: 1px solid var(--divider);
    color: var(--text-3);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    background: transparent;
    color: var(--text);
    font-size: var(--text-base);
    outline: none;
  }
  input::placeholder {
    color: var(--text-3);
  }

  .list {
    flex: 1;
    min-height: 0;
    padding: var(--space-1-5);
    overflow: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .heading {
    padding: var(--space-2) var(--space-2) var(--space-1);
    color: var(--text-3);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: 36px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-md);
    color: var(--text-2);
    font-size: var(--text-md);
    cursor: default;
  }
  .option.active {
    background: var(--surface-selected);
    color: var(--text);
  }
  .option.active .icon {
    color: var(--accent-text);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: none;
    border-radius: var(--radius-sm);
    background: var(--surface-hover);
    color: var(--text-3);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: none;
    color: var(--accent-text);
    font-weight: var(--weight-semibold);
  }
  .group {
    color: var(--text-3);
    font-size: var(--text-xs);
  }
  .empty {
    margin: 0;
    padding: var(--space-8) var(--space-4);
    color: var(--text-3);
    font-size: var(--text-md);
    text-align: center;
  }

  .hints {
    display: flex;
    gap: var(--space-4);
    flex: none;
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--divider);
    color: var(--text-3);
    font-size: var(--text-xs);
  }
  .hints span {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
  }
  .enter {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
  }
</style>

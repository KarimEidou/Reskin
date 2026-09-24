<!-- Keyboard map ("?"): every command shortcut, grouped, plus canvas gestures. -->
<script lang="ts">
  import Dialog from '$lib/ui/Dialog.svelte';
  import Kbd from '$lib/ui/Kbd.svelte';
  import { GROUP_ORDER, type Command, type CommandGroup } from './commands';
  import { comboKeys } from './keys';

  interface Props {
    open?: boolean;
    commands: readonly Command[];
  }

  let { open = $bindable(false), commands }: Props = $props();

  type Entry = { label: string; keys: string[][]; note?: string };

  /** Canvas gestures handled by the workspace (docs/UI.md). */
  const CANVAS_EXTRA: Entry[] = [
    { label: 'Pan the canvas', keys: [['Space']], note: 'hold + drag' },
    { label: 'Compare with the original', keys: [['\\']], note: 'hold' },
    { label: 'Commit a transform or text', keys: [['Enter']] },
    { label: 'Cancel the current operation', keys: [['Esc']] },
  ];
  const APP_EXTRA: Entry[] = [{ label: 'Close the editor (nothing else open)', keys: [['Esc']] }];

  const groups = $derived.by(() => {
    const out: Array<{ group: CommandGroup; entries: Entry[] }> = [];
    for (const group of GROUP_ORDER) {
      const entries: Entry[] = commands
        .filter((c) => c.group === group && c.keys)
        .map((c) => ({ label: c.label, keys: [c.keys!, ...(c.altKeys ?? [])].map(comboKeys) }));
      if (group === 'Canvas') entries.push(...CANVAS_EXTRA);
      if (group === 'App') entries.push(...APP_EXTRA);
      if (entries.length > 0) out.push({ group, entries });
    }
    return out;
  });
</script>

<Dialog bind:open title="Keyboard shortcuts" size="lg">
  <div class="grid" data-testid="shortcuts-overlay">
    {#each groups as g (g.group)}
      <section aria-label={g.group}>
        <h3>{g.group}</h3>
        <dl>
          {#each g.entries as e (e.label)}
            <div class="row">
              <dt>{e.label}</dt>
              <dd>
                {#each e.keys as k, i (i)}
                  {#if i > 0}<span class="or">or</span>{/if}
                  <Kbd keys={k} size="sm" />
                {/each}
                {#if e.note}<span class="note">{e.note}</span>{/if}
              </dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
</Dialog>

<style>
  .grid {
    columns: 2;
    column-gap: var(--space-8);
    padding-right: var(--space-1);
  }
  section {
    break-inside: avoid;
    margin-bottom: var(--space-5);
  }
  h3 {
    margin: 0 0 var(--space-2);
    color: var(--text-3);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  dl {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 28px;
    border-bottom: 1px solid var(--border-subtle);
  }
  dt {
    min-width: 0;
    color: var(--text-2);
    font-size: var(--text-sm);
  }
  dd {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex: none;
    margin: 0;
  }
  .or,
  .note {
    color: var(--text-3);
    font-size: var(--text-2xs);
  }
</style>

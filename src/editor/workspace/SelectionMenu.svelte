<!--
  The options bar's Selection menu (selection tools): select all, deselect,
  invert, select layer pixels, and Feather… / Grow… / Shrink… / Border…,
  which ask for an amount in the refine prompt (RefinePopover).
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import SquareDashed from '@lucide/svelte/icons/square-dashed';
  import Menu, { type MenuEntry } from '$lib/ui/Menu.svelte';
  import { SELECTION_KEYS } from '../palette/commands';
  import { getSession } from '../state/context';
  import { REFINE, REFINE_KINDS, refinePrompt, type RefineKind } from './refine.svelte';

  interface Props {
    /** The menu button (the refine prompt anchors to it). */
    anchor?: HTMLElement | null;
  }

  let { anchor = $bindable(null) }: Props = $props();

  const session = getSession();
  const engine = session.engine;

  const hasSelection = $derived.by(() => {
    void session.rev.selection;
    void session.rev.document;
    return engine.doc.selection !== null;
  });
  const hasLayer = $derived.by(() => {
    void session.rev.layers;
    void session.rev.document;
    return engine.activeLayer !== null;
  });

  const items: MenuEntry[] = $derived([
    { id: 'selectAll', label: 'Select all', shortcut: SELECTION_KEYS.selectAll },
    { id: 'deselect', label: 'Deselect', shortcut: SELECTION_KEYS.deselect, disabled: !hasSelection },
    { id: 'invert', label: 'Invert', shortcut: SELECTION_KEYS.invert, disabled: !hasSelection },
    { id: 'layerPixels', label: 'Select layer pixels', disabled: !hasLayer },
    { separator: true },
    ...REFINE_KINDS.map((kind) => ({ id: kind, label: REFINE[kind].label, disabled: !hasSelection })),
  ]);

  function choose(id: string): void {
    switch (id) {
      case 'selectAll':
        engine.selectAll();
        break;
      case 'deselect':
        engine.deselect();
        break;
      case 'invert':
        engine.invertSelection();
        break;
      case 'layerPixels':
        engine.selectByAlpha();
        break;
      default:
        refinePrompt.open(id as RefineKind);
    }
  }

  function capture(node: HTMLElement) {
    anchor = node;
    return () => {
      if (anchor === node) anchor = null;
    };
  }
</script>

<Menu label="Selection" {items} onselect={choose}>
  {#snippet trigger(props)}
    <button {...props} {@attach capture} type="button" class="menu-button" aria-label="Selection" data-testid="selection-menu">
      <SquareDashed size={16} strokeWidth={1.75} aria-hidden="true" />
      <span class="text">Selection</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  {/snippet}
</Menu>

<style>
  .menu-button {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1-5);
    height: var(--control-sm);
    padding: 0 var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      color var(--fade-1) linear;
  }
  .menu-button:hover,
  .menu-button[aria-expanded='true'] {
    background: var(--surface-hover);
    color: var(--text);
  }
  .menu-button:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .menu-button :global(svg:last-child) {
    color: var(--text-3);
  }
  /* Narrow bars keep the icon; the button keeps its name. */
  @container (max-width: 620px) {
    .text {
      display: none;
    }
  }
</style>

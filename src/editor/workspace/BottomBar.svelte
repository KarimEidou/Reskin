<!--
  Bottom bar: batch queue · zoom (click the % to fit) · keyline guides ·
  pixel-art mode with its grid · before/after split ·· Save to Library ·
  Export ▾ · Save & Apply ▾.
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
  import Download from '@lucide/svelte/icons/download';
  import FileArchive from '@lucide/svelte/icons/file-archive';
  import FileImage from '@lucide/svelte/icons/file-image';
  import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
  import ImageDown from '@lucide/svelte/icons/image-down';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import Scan from '@lucide/svelte/icons/scan';
  import SquareSplitHorizontal from '@lucide/svelte/icons/square-split-horizontal';
  import { isPixelGrid, PIXEL_GRIDS, type PixelGrid } from '$engine/index';
  import { settings, updateSettings } from '$lib/settings/store.svelte';
  import Button from '$lib/ui/Button.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Menu, { type MenuEntry } from '$lib/ui/Menu.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Tooltip from '$lib/ui/Tooltip.svelte';
  import { getSession } from '../state/context';
  import ApplyButton from './ApplyButton.svelte';
  import { formatZoom } from './geometry';
  import QueueStrip from './QueueStrip.svelte';
  import SaveToLibrary from './SaveToLibrary.svelte';
  import { stage } from './stage.svelte';

  const session = getSession();
  const engine = session.engine;

  const GRID_OPTIONS = PIXEL_GRIDS.map((g) => ({ value: String(g), label: `${g} × ${g}` }));

  const pixelArt = $derived.by(() => {
    void session.rev.document;
    void session.rev.layers;
    void session.rev.history;
    return engine.doc.pixelArt?.grid ?? null;
  });
  const preferredGrid = $derived.by((): PixelGrid => {
    const g = settings().pixelGrid;
    return isPixelGrid(g) ? g : 32;
  });
  const grid = $derived(String(pixelArt ?? preferredGrid));

  const EXPORT_ITEMS: MenuEntry[] = [
    { id: 'ico', label: 'Icon file (.ico)', icon: FileImage },
    { id: 'png', label: 'PNG image (256 px)', icon: ImageDown },
    { id: 'copy', label: 'Copy to clipboard', icon: ClipboardCopy },
    { separator: true },
    { id: 'project', label: 'Reskin project (.reskin)', icon: FileArchive },
  ];

  function togglePixelArt(): void {
    engine.setPixelArt(pixelArt === null ? preferredGrid : null);
  }

  function chooseGrid(value: string): void {
    const g = Number(value);
    if (!isPixelGrid(g)) return;
    if (g !== settings().pixelGrid) {
      updateSettings({ pixelGrid: g }).catch((e: unknown) => console.warn('could not save the grid size', e));
    }
    if (pixelArt !== null && g !== pixelArt) engine.setPixelArt(g);
  }

  function onExport(id: string): void {
    if (id === 'copy') void session.copyToClipboard();
    else if (id === 'ico' || id === 'png' || id === 'project') void session.exportAs(id);
  }
</script>

<div class="bar" data-testid="bottom-bar">
  <div class="start">
    <QueueStrip />
  </div>

  <div class="view" role="group" aria-label="View">
    <IconButton icon={Minus} label="Zoom out" shortcut="Ctrl+Minus" size="sm" disabled={!session.hasDesign} onclick={() => stage.zoomOut()} />
    <Tooltip text="Zoom to fit" shortcut="Ctrl+0" placement="top">
      <button
        type="button"
        class="zoom"
        aria-label="Zoom {formatZoom(stage.zoom)}, zoom to fit"
        disabled={!session.hasDesign}
        data-testid="zoom-level"
        onclick={() => stage.fit()}
      >
        {formatZoom(stage.zoom)}
      </button>
    </Tooltip>
    <IconButton icon={Plus} label="Zoom in" shortcut="Ctrl+Plus" size="sm" disabled={!session.hasDesign} onclick={() => stage.zoomIn()} />
    <span class="divider" aria-hidden="true"></span>
    <IconButton
      icon={Scan}
      label="Keyline guides"
      shortcut="K"
      size="sm"
      pressed={stage.keylines}
      disabled={!session.hasDesign}
      onclick={() => stage.toggleKeylines()}
    />
    <IconButton
      icon={SquareSplitHorizontal}
      label="Before / after"
      tooltip={session.original ? 'Before / after (hold \\ to peek)' : 'Before / after (no original icon)'}
      size="sm"
      pressed={session.compare === 'split'}
      disabled={!session.hasDesign || !session.original}
      data-testid="compare-toggle"
      onclick={() => (session.compare = session.compare === 'split' ? 'off' : 'split')}
    />
    <span class="divider" aria-hidden="true"></span>
    <div class="pixel" role="group" aria-label="Pixel art">
      <IconButton
        icon={Grid3x3}
        label="Pixel art"
        tooltip="Pixel-art mode (crisp {grid} × {grid} grid)"
        size="sm"
        pressed={pixelArt !== null}
        disabled={!session.hasDesign}
        data-testid="pixel-art-toggle"
        onclick={togglePixelArt}
      />
      <div class="grid-select">
        <Select
          size="sm"
          label="Pixel grid"
          hideLabel
          options={GRID_OPTIONS}
          value={grid}
          disabled={!session.hasDesign}
          onchange={chooseGrid}
        />
      </div>
    </div>
  </div>

  <div class="end">
    <SaveToLibrary />
    <Menu label="Export" items={EXPORT_ITEMS} placement="top-end" disabled={!session.hasDesign} onselect={onExport}>
      {#snippet trigger(props)}
        <Button {...props} variant="secondary" icon={Download} iconRight={ChevronDown} aria-label="Export" data-testid="export-menu">
          <span class="collapsible-label">Export</span>
        </Button>
      {/snippet}
    </Menu>
    <ApplyButton />
  </div>
</div>

<style>
  .bar {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: 100%;
    padding: 0 var(--space-3) 0 var(--space-3);
  }
  .start {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    min-width: 0;
  }
  .view {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: rgb(var(--text-rgb) / 0.025);
  }
  .end {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
  }
  .divider {
    width: 1px;
    height: 16px;
    margin: 0 4px;
    background: var(--divider);
  }

  .zoom {
    min-width: 52px;
    height: var(--control-sm);
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    font-variant-numeric: tabular-nums;
    cursor: default;
    transition: background-color var(--fade-1) linear;
  }
  .zoom:hover:not(:disabled) {
    background: var(--surface-hover);
  }
  .zoom:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  .zoom:disabled {
    opacity: 0.4;
  }

  .pixel {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .grid-select {
    width: 104px;
  }

  @container (max-width: 820px) {
    .end :global(.collapsible-label) {
      display: none;
    }
  }
  @container (max-width: 760px) {
    .grid-select {
      width: 96px;
    }
  }
</style>

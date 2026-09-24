<!--
  Layers panel: the layer stack top-first with thumbnails, visibility and
  lock toggles, inline rename (double-click / F2), pointer-drag reordering
  (Alt+↑/↓ from the keyboard), and the active layer's blend mode and
  opacity. Toolbar: add image / text layer, duplicate, delete, and a menu
  with merge down, flatten and rasterize text.
-->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import Copy from '@lucide/svelte/icons/copy';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import GripVertical from '@lucide/svelte/icons/grip-vertical';
  import Layers2 from '@lucide/svelte/icons/layers-2';
  import Lock from '@lucide/svelte/icons/lock';
  import LockOpen from '@lucide/svelte/icons/lock-open';
  import Merge from '@lucide/svelte/icons/merge';
  import Plus from '@lucide/svelte/icons/plus';
  import SquareDashed from '@lucide/svelte/icons/square-dashed';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Type from '@lucide/svelte/icons/type';
  import PencilLine from '@lucide/svelte/icons/pencil-line';
  import { BLEND_MODES, type BlendMode } from '$engine/index';
  import Button from '$lib/ui/Button.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import Menu from '$lib/ui/Menu.svelte';
  import Select from '$lib/ui/Select.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import NumField from '../common/NumField.svelte';
  import ToolButton from '../common/ToolButton.svelte';
  import { getSession } from '../../state/context';
  import { watchDpr } from '../common/canvas';
  import PixelThumb from '../common/PixelThumb.svelte';
  import { rafThrottle } from '../common/schedule';
  import { dropListIndex, rowShift, toDocIndex } from './reorder';
  import { LayerThumbs } from './thumbs.svelte';

  const session = getSession();
  const engine = session.engine;

  const ROW = 46; // row height incl. gap, px
  const THUMB = 34;

  const BLEND_LABELS: Record<BlendMode, string> = {
    normal: 'Normal',
    multiply: 'Multiply',
    screen: 'Screen',
    overlay: 'Overlay',
    darken: 'Darken',
    lighten: 'Lighten',
    'color-dodge': 'Color dodge',
    'color-burn': 'Color burn',
    'hard-light': 'Hard light',
    'soft-light': 'Soft light',
    difference: 'Difference',
    exclusion: 'Exclusion',
  };
  const blendOptions = BLEND_MODES.map((m) => ({ value: m, label: BLEND_LABELS[m] }));

  interface Row {
    id: string;
    name: string;
    kind: 'raster' | 'text';
    visible: boolean;
    locked: boolean;
    opacity: number;
    blend: BlendMode;
    active: boolean;
    effects: number;
  }

  const rows = $derived.by((): Row[] => {
    void session.rev.layers;
    void session.rev.document;
    void session.rev.history;
    const doc = engine.doc;
    return [...doc.layers].reverse().map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity,
      blend: l.blend,
      active: l.id === doc.activeLayerId,
      effects: l.effects.filter((e) => e.enabled).length,
    }));
  });
  const active = $derived(rows.find((r) => r.active) ?? null);
  const activeIndex = $derived(rows.findIndex((r) => r.active));

  // ---- thumbnails ------------------------------------------------------------------
  let thumbs: LayerThumbs | null = $state(null);
  onMount(() => {
    const t = new LayerThumbs(engine, Math.round(THUMB * (devicePixelRatio || 1)));
    thumbs = t;
    const stop = watchDpr((dpr) => t.setSize(Math.round(THUMB * dpr)));
    return () => {
      stop();
      t.dispose();
    };
  });

  // ---- selection / keyboard ----------------------------------------------------------
  const buttons: Record<string, HTMLButtonElement> = $state({});

  function select(id: string): void {
    engine.setActiveLayer(id);
  }

  function focusRow(id: string): void {
    void tick().then(() => buttons[id]?.focus());
  }

  function move(row: Row, delta: number): void {
    const i = rows.findIndex((r) => r.id === row.id);
    const to = Math.max(0, Math.min(rows.length - 1, i + delta));
    if (to === i) return;
    engine.moveLayer(row.id, toDocIndex(to, rows.length));
    focusRow(row.id);
  }

  function onRowKey(e: KeyboardEvent, row: Row, i: number): void {
    if (editing) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      move(row, e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    let next = -1;
    if (e.key === 'ArrowUp') next = i - 1;
    else if (e.key === 'ArrowDown') next = i + 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      startRename(row);
      return;
    } else if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      remove(row.id);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (target) {
      select(target.id);
      focusRow(target.id);
    }
  }

  // ---- pointer drag reordering --------------------------------------------------------
  let drag = $state<{ id: string; from: number; startY: number; dy: number; started: boolean } | null>(null);
  let suppressClick = false;
  const dropAt = $derived(drag?.started ? dropListIndex(drag.from, drag.dy, ROW, rows.length) : -1);

  function onPointerDown(e: PointerEvent, row: Row, i: number): void {
    if (e.button !== 0 || editing === row.id) return;
    // A drag whose release produced no click must not swallow this one.
    suppressClick = false;
    drag = { id: row.id, from: i, startY: e.clientY, dy: 0, started: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    drag.dy = dy;
    if (!drag.started && Math.abs(dy) > 4) drag.started = true;
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const d = drag;
    drag = null;
    if (!d.started) return;
    suppressClick = true;
    const to = dropListIndex(d.from, d.dy, ROW, rows.length);
    if (to !== d.from) engine.moveLayer(d.id, toDocIndex(to, rows.length));
    focusRow(d.id);
  }

  function offsetFor(i: number, row: Row): number {
    if (!drag?.started) return 0;
    if (row.id === drag.id) return drag.dy;
    return rowShift(i, drag.from, dropAt, ROW);
  }

  // ---- rename ------------------------------------------------------------------------
  let editing = $state<string | null>(null);
  let draft = $state('');

  function startRename(row: Row): void {
    editing = row.id;
    draft = row.name;
  }

  function finishRename(commit: boolean): void {
    const id = editing;
    if (!id) return;
    editing = null;
    const name = draft.trim();
    if (commit && name && name !== engine.getLayer(id)?.name) engine.renameLayer(id, name);
    focusRow(id);
  }

  function renameInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  // ---- actions -----------------------------------------------------------------------
  let list: HTMLUListElement | undefined = $state();

  function remove(id: string): void {
    // Park focus on the list first: the row (or the button) may go away.
    if (buttons[id]?.contains(document.activeElement) || document.activeElement?.closest('.row')) list?.focus();
    engine.deleteLayer(id);
    const next = engine.doc.activeLayerId;
    if (next) focusRow(next);
  }

  function addText(): void {
    const id = engine.addTextLayer({ text: 'Text' });
    if (!id) return;
    engine.setTool('text');
    engine.beginTextEdit(id);
  }

  const menuItems = $derived([
    { id: 'rename', label: 'Rename', icon: PencilLine, shortcut: 'F2', disabled: !active },
    { id: 'merge', label: 'Merge down', icon: Merge, disabled: !active || activeIndex >= rows.length - 1 },
    { id: 'flatten', label: 'Flatten image', icon: Layers2, disabled: rows.length < 2 },
    { id: 'rasterize', label: 'Rasterize text', icon: SquareDashed, disabled: active?.kind !== 'text' },
  ]);

  function onMenu(id: string): void {
    const a = active;
    switch (id) {
      case 'rename':
        if (a) startRename(a);
        break;
      case 'merge':
        if (a) engine.mergeDown(a.id);
        break;
      case 'flatten':
        engine.flatten();
        break;
      case 'rasterize':
        if (a) engine.rasterizeLayer(a.id);
        break;
    }
  }

  // Opacity drags coalesce into one history entry (merge key) and one engine update per frame.
  const setOpacity = rafThrottle((id: string, v: number) => engine.setLayerProps(id, { opacity: v / 100 }, { merge: 'opacity' }));
  // Leaving the panel mid-drag applies the latest value now.
  onDestroy(() => setOpacity.flush());
</script>

<div class="layers" data-testid="layers-panel">
  <div class="toolbar" role="toolbar" aria-label="Layer actions">
    <IconButton label="New layer" icon={Plus} size="sm" onclick={() => engine.addLayer()} data-testid="add-layer" />
    <IconButton label="New text layer" icon={Type} size="sm" onclick={addText} data-testid="add-text" />
    <ToolButton label="Duplicate layer" icon={Copy} size="sm" disabled={!active} onclick={() => active && engine.duplicateLayer(active.id)} data-testid="duplicate-layer" />
    <ToolButton label="Delete layer" icon={Trash2} size="sm" disabled={!active || rows.length < 2} onclick={() => active && remove(active.id)} data-testid="delete-layer" />
    <span class="spacer"></span>
    <Menu label="More layer actions" items={menuItems} placement="bottom-end" onselect={onMenu}>
      {#snippet trigger(props)}
        <Button {...props} variant="ghost" size="sm" icon={Ellipsis} aria-label="More layer actions" title="More layer actions" />
      {/snippet}
    </Menu>
  </div>

  {#if active}
    <div class="props">
      <div class="blend">
        <Select
          label="Blend mode"
          hideLabel
          size="sm"
          options={blendOptions}
          value={active.blend}
          onchange={(m) => engine.setLayerProps(active.id, { blend: m })}
        />
      </div>
      <div class="opacity">
        <Slider
          label="Opacity"
          hideLabel
          value={Math.round(active.opacity * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          oninput={(v) => setOpacity(active.id, v)}
          onchange={(v) => {
            setOpacity.cancel();
            engine.setLayerProps(active.id, { opacity: v / 100 }, { merge: 'opacity' });
          }}
        />
        <NumField
          label="Opacity"
          hideLabel
          value={Math.round(active.opacity * 100)}
          min={0}
          max={100}
          unit="%"
          width="64px"
          onchange={(v) => engine.setLayerProps(active.id, { opacity: v / 100 }, { merge: 'opacity' })}
        />
      </div>
    </div>
  {/if}

  <ul class="list" aria-label="Layers, top first" style:--row="{ROW}px" class:dragging={drag?.started} tabindex="-1" bind:this={list}>
    {#each rows as row, i (row.id)}
      {@const offset = offsetFor(i, row)}
      <li
        class="row"
        class:active={row.active}
        class:hidden-layer={!row.visible}
        class:lifted={drag?.started && drag.id === row.id}
        class:editing={editing === row.id}
        style:transform={offset ? `translateY(${offset}px)` : undefined}
        data-testid="layer-row"
        data-layer={row.id}
      >
        <button
          bind:this={buttons[row.id]}
          type="button"
          class="main"
          aria-pressed={row.active}
          aria-label="{row.name}{row.kind === 'text' ? ' (text layer)' : ''}{row.visible ? '' : ', hidden'}{row.locked ? ', locked' : ''}"
          aria-describedby="layers-help"
          tabindex={row.active || (activeIndex < 0 && i === 0) ? 0 : -1}
          onclick={() => {
            if (suppressClick) {
              suppressClick = false;
              return;
            }
            select(row.id);
          }}
          ondblclick={() => startRename(row)}
          onkeydown={(e) => onRowKey(e, row, i)}
          onpointerdown={(e) => onPointerDown(e, row, i)}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={() => (drag = null)}
        >
          <span class="grip" aria-hidden="true"><GripVertical size={14} /></span>
          <PixelThumb pixels={thumbs?.thumbs[row.id] ?? null} size={THUMB} />
          {#if editing !== row.id}
            <span class="name">
              <span class="text">{row.name}</span>
              {#if row.kind === 'text' || row.effects > 0 || row.blend !== 'normal' || row.opacity < 1}
                <span class="meta">
                  {#if row.kind === 'text'}<span class="tag" title="Text layer">T</span>{/if}
                  {#if row.effects > 0}<span class="tag fx" title="{row.effects} effect{row.effects === 1 ? '' : 's'}">fx</span>{/if}
                  {#if row.blend !== 'normal'}<span class="sub">{BLEND_LABELS[row.blend]}</span>{/if}
                  {#if row.opacity < 1}<span class="sub">{Math.round(row.opacity * 100)}%</span>{/if}
                </span>
              {/if}
            </span>
          {/if}
        </button>
        {#if editing === row.id}
          <input
            class="rename"
            aria-label="Layer name"
            bind:value={draft}
            maxlength="64"
            {@attach renameInput}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                finishRename(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                finishRename(false);
              }
            }}
            onblur={() => finishRename(true)}
          />
        {/if}
        <div class="toggles">
          <IconButton
            label={row.visible ? `Hide ${row.name}` : `Show ${row.name}`}
            icon={row.visible ? Eye : EyeOff}
            size="sm"
            pressed={!row.visible}
            tooltip={row.visible ? 'Hide layer' : 'Show layer'}
            tabindex={row.active ? 0 : -1}
            onclick={() => engine.setLayerProps(row.id, { visible: !row.visible })}
            data-testid="toggle-visible"
          />
          <IconButton
            label={row.locked ? `Unlock ${row.name}` : `Lock ${row.name}`}
            icon={row.locked ? Lock : LockOpen}
            size="sm"
            pressed={row.locked}
            tooltip={row.locked ? 'Unlock layer' : 'Lock layer'}
            tabindex={row.active ? 0 : -1}
            class={row.locked ? '' : 'quiet'}
            onclick={() => engine.setLayerProps(row.id, { locked: !row.locked })}
            data-testid="toggle-lock"
          />
        </div>
      </li>
    {/each}
  </ul>
  <p id="layers-help" class="sr-only">Arrow keys select, Alt+Arrow keys reorder, F2 renames, Delete removes the layer. Drag rows to reorder.</p>
</div>

<style>
  .layers {
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: var(--space-0-5);
    padding: var(--space-2) var(--space-3) var(--space-2);
    background: var(--surface-1);
  }
  .spacer {
    flex: 1;
  }
  .props {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3) var(--space-3);
    border-bottom: 1px solid var(--divider);
  }
  .opacity {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .opacity > :global(.slider) {
    flex: 1;
  }
  .list:focus {
    outline: none;
  }
  .list {
    position: relative;
    margin: 0;
    padding: var(--space-2) var(--space-2) var(--space-3);
    list-style: none;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    height: calc(var(--row) - 4px);
    margin-bottom: 4px;
    border-radius: var(--radius-md);
    background: transparent;
    transition:
      transform var(--dur-2) var(--ease-standard),
      background-color var(--fade-1) linear;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.active {
    background: var(--surface-selected);
  }
  .row.active::before {
    position: absolute;
    top: 8px;
    bottom: 8px;
    left: 0;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--accent);
    content: '';
  }
  .row.lifted {
    z-index: 3;
    background: var(--surface-3);
    box-shadow: var(--shadow-3);
    transition: background-color var(--fade-1) linear;
  }
  .dragging .row {
    cursor: grabbing;
  }
  .hidden-layer .main {
    opacity: 0.55;
  }
  .main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    height: 100%;
    padding: 0 var(--space-1) 0 2px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: default;
    touch-action: none;
  }
  .main:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
  .grip {
    display: inline-flex;
    color: var(--text-3);
    opacity: 0;
    transition: opacity var(--fade-1) linear;
  }
  .row:hover .grip,
  .row.lifted .grip {
    opacity: 1;
  }
  .name {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .text {
    overflow: hidden;
    font-size: var(--text-md);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .active .text {
    font-weight: var(--weight-medium);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    min-height: 14px;
    color: var(--text-3);
    font-size: var(--text-2xs);
  }
  .tag {
    padding: 0 4px;
    border-radius: 3px;
    background: var(--surface-3);
    color: var(--text-2);
    font-size: 10px;
    font-weight: var(--weight-bold);
    line-height: 14px;
  }
  .tag.fx {
    background: rgb(var(--accent-rgb) / 0.2);
    color: var(--accent-text);
    font-style: italic;
  }
  .sub {
    font-variant-numeric: tabular-nums;
  }
  .rename {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 var(--space-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    font-size: var(--text-md);
    outline: none;
  }
  .editing .main {
    flex: none;
  }
  .toggles {
    display: flex;
    align-items: center;
    padding-right: var(--space-1);
  }
  .toggles :global(.quiet) {
    opacity: 0;
    transition: opacity var(--fade-1) linear;
  }
  .row:hover .toggles :global(.quiet),
  .row.active .toggles :global(.quiet),
  .toggles :global(.quiet:focus-visible) {
    opacity: 1;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>

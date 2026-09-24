<!--
  Stickers panel: vector stickers (recolourable, optional outline) and
  emoji, with search. Clicking one adds it as a new layer centred on the
  canvas at the chosen size and switches to the move tool so it can be
  placed. Its Stamp button (shown on hover / focus), Alt+click or Alt+Enter
  loads it into the stamp tool instead, rendered with the same colour,
  outline and size options, to click it onto the canvas anywhere — and
  while the stamp tool is the selected tool, a plain click does that too.
-->
<script lang="ts">
  import Search from '@lucide/svelte/icons/search';
  import Stamp from '@lucide/svelte/icons/stamp';
  import Sticker from '@lucide/svelte/icons/sticker';
  import type { Pixels } from '$engine/filters/types';
  import { Surface } from '$engine/index';
  import { insertLayer, makeRasterLayer } from '$engine/presets';
  import {
    EMOJI_GROUPS,
    canRenderEmoji,
    renderEmoji,
    renderEmojiStamp,
    searchEmoji,
    searchStickers,
    stickerSvgElements,
    type StickerDef,
    type StickerOutline,
  } from '$engine/stickers';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import SegmentedControl from '$lib/ui/SegmentedControl.svelte';
  import Slider from '$lib/ui/Slider.svelte';
  import Toggle from '$lib/ui/Toggle.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { getSession } from '../../state/context';
  import ColorField from '../color/ColorField.svelte';
  import { hexOf } from '../common/color';
  import Section from '../common/Section.svelte';
  import { isCancelled } from '../worker/client';

  const session = getSession();
  const engine = session.engine;

  let query = $state('');
  let colorMode = $state<'own' | 'custom'>('own');
  let custom = $state(hexOf(engine.primary));
  let outline = $state(true);
  let outlineColor = $state('#ffffff');
  let outlineWidth = $state(4); // % of the sticker size
  let size = $state(46); // % of the canvas
  let adding = $state<string | null>(null);
  /** Items whose Stamp button shows: the one under the pointer and the one holding focus. */
  let hovered = $state<string | null>(null);
  let focused = $state<string | null>(null);

  /** The stamp tool is selected: a click loads the stamp rather than adding a layer. */
  const stamping = $derived.by(() => {
    void session.rev.tool;
    return engine.selectedToolId === 'stamp';
  });
  const clickHint = $derived(stamping ? 'click to stamp' : 'click to add, Alt+click to stamp');

  const stickers = $derived(searchStickers(query));
  const emojiOk = canRenderEmoji();
  const emoji = $derived(emojiOk ? searchEmoji(query) : []);
  const emojiGroups = $derived(EMOJI_GROUPS.map((g) => ({ ...g, items: emoji.filter((e) => e.group === g.id) })).filter((g) => g.items.length > 0));

  function colorFor(def: StickerDef): string {
    return colorMode === 'custom' ? custom : def.color;
  }

  /** The sticker box at the chosen size, document px. */
  function boxSize(): number {
    return (engine.doc.width * size) / 100;
  }

  function outlineFor(box: number): StickerOutline | null {
    return outline ? { color: outlineColor, width: Math.max(0.5, (box * outlineWidth) / 100) } : null;
  }

  function place(label: string, pixels: Pixels): void {
    const layer = makeRasterLayer(engine, label, pixels);
    insertLayer(engine, `Add ${label.toLowerCase()}`, layer);
    engine.setTool('move');
  }

  /** Loads an image into the stamp tool and selects the tool. */
  function useStamp(pixels: Pixels): void {
    engine.setToolOptions('stamp', { stamp: Surface.fromRgba(pixels.width, pixels.height, pixels.data) });
    engine.setTool('stamp');
  }

  async function addSticker(def: StickerDef, stamp: boolean): Promise<void> {
    if (adding) return;
    adding = def.id;
    const token = session.designToken;
    const size = engine.doc.width;
    const box = boxSize();
    const color = colorFor(def);
    try {
      if (stamp) {
        const px = await session.panels.request({ op: 'stickerStamp', id: def.id, box, color, outline: outlineFor(box) });
        // Another design opened meanwhile: the size was meant for the old one.
        if (!session.isOpenDesign(token) || !px) return;
        useStamp(px);
      } else {
        const px = await session.panels.request({ op: 'sticker', id: def.id, size, box, color, outline: outlineFor(box) });
        // Another design opened (or this one was resized) meanwhile: not meant for it.
        if (!session.isOpenDesign(token) || engine.doc.width !== px.width) return;
        place(def.label, px);
      }
    } catch (e) {
      if (!isCancelled(e)) toast({ message: `Could not ${stamp ? 'stamp' : 'add'} the sticker: ${e instanceof Error ? e.message : String(e)}`, kind: 'error' });
    } finally {
      adding = null;
    }
  }

  function addEmoji(char: string, name: string, stamp: boolean): void {
    const px = stamp ? renderEmojiStamp(char, boxSize()) : renderEmoji(char, { size: engine.doc.width, box: boxSize() });
    if (!px) {
      toast({ message: 'Emoji cannot be drawn here.', kind: 'error' });
      return;
    }
    if (stamp) useStamp(px);
    else place(name.replace(/^./, (c) => c.toUpperCase()), px);
  }

  /** Alt+Enter on an item stamps it (Enter alone adds it). */
  function stampKey(e: KeyboardEvent, run: () => void): void {
    if (e.key !== 'Enter' || !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    run();
  }

  /** Hover and focus tracking that shows an item's Stamp button. */
  function reveal(key: string) {
    return {
      onpointerenter: () => (hovered = key),
      onpointerleave: () => {
        if (hovered === key) hovered = null;
      },
      onfocusin: () => (focused = key),
      onfocusout: (e: FocusEvent) => {
        const next = e.relatedTarget;
        if (focused === key && !(next instanceof Node && (e.currentTarget as HTMLElement).contains(next))) focused = null;
      },
    };
  }

  const COLOR_MODES = [
    { value: 'own', label: 'Sticker colours' },
    { value: 'custom', label: 'One colour' },
  ];
</script>

<div class="stickers" data-testid="stickers-panel">
  <div class="search">
    <span class="icon" aria-hidden="true"><Search size={14} /></span>
    <input type="search" placeholder="Search stickers and emoji" aria-label="Search stickers and emoji" bind:value={query} data-testid="sticker-search" />
  </div>

  <Section title="Options" open={false}>
    <SegmentedControl label="Sticker colours" size="sm" fullWidth options={COLOR_MODES} bind:value={colorMode} />
    {#if colorMode === 'custom'}
      <ColorField label="Colour" value={custom} alpha={false} onchange={(c) => (custom = c)} />
    {/if}
    <Toggle label="Outline" size="sm" bind:checked={outline} />
    {#if outline}
      <ColorField label="Outline colour" value={outlineColor} alpha={false} onchange={(c) => (outlineColor = c)} />
      <Slider label="Outline width" bind:value={outlineWidth} min={1} max={10} unit="%" />
    {/if}
    <Slider label="Size" bind:value={size} min={15} max={90} unit="%" />
  </Section>

  <Section title="Stickers">
    {#if stickers.length === 0}
      <p class="none">No stickers match “{query}”.</p>
    {:else}
      <div class="grid" role="list">
        {#each stickers as def (def.id)}
          {@const els = stickerSvgElements(def, colorFor(def))}
          {@const ow = outline ? outlineWidth * 2 : 0}
          {@const key = `s:${def.id}`}
          <div role="listitem" class="item" {...reveal(key)}>
            <button
              type="button"
              class="cell"
              aria-label={stamping ? `Use ${def.label} as the stamp` : `Add ${def.label} sticker`}
              aria-keyshortcuts="Alt+Enter"
              title="{def.label} — {clickHint}"
              aria-busy={adding === def.id}
              onclick={(e) => void addSticker(def, e.altKey || stamping)}
              onkeydown={(e) => stampKey(e, () => void addSticker(def, true))}
              data-testid="sticker"
              data-sticker={def.id}
            >
              <svg viewBox="-12 -12 124 124" aria-hidden="true">
                {#if ow > 0}
                  <g fill={outlineColor} stroke={outlineColor} stroke-linejoin="round" stroke-linecap="round">
                    {#each els as el, k (k)}
                      {#if el.kind === 'fill'}
                        <path d={el.d} fill-rule={el.rule} stroke-width={ow} />
                      {:else}
                        <path d={el.d} fill="none" stroke-width={el.width + ow} />
                      {/if}
                    {/each}
                  </g>
                {/if}
                {#each els as el, k (k)}
                  {#if el.kind === 'fill'}
                    <path d={el.d} fill={el.color} fill-rule={el.rule} opacity={el.opacity} />
                  {:else}
                    <path d={el.d} fill="none" stroke={el.color} stroke-width={el.width} stroke-linecap={el.cap} stroke-linejoin={el.join} opacity={el.opacity} />
                  {/if}
                {/each}
              </svg>
            </button>
            {#if hovered === key || focused === key}
              <button type="button" class="stamp" aria-label="Stamp {def.label}" title="Stamp it on the canvas" onclick={() => void addSticker(def, true)} data-testid="stamp-sticker">
                <Stamp size={12} aria-hidden="true" />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </Section>

  {#if emojiOk}
    <Section title="Emoji">
      {#if emoji.length === 0}
        <p class="none">No emoji match “{query}”.</p>
      {:else}
        {#each emojiGroups as g (g.id)}
          <h4>{g.label}</h4>
          <div class="emoji" role="list">
            {#each g.items as e (e.char)}
              {@const key = `e:${e.char}`}
              <div role="listitem" class="item" {...reveal(key)}>
                <button
                  type="button"
                  class="em"
                  aria-label={stamping ? `Use ${e.name} as the stamp` : `Add ${e.name} emoji`}
                  aria-keyshortcuts="Alt+Enter"
                  title="{e.name} — {clickHint}"
                  onclick={(ev) => addEmoji(e.char, e.name, ev.altKey || stamping)}
                  onkeydown={(ev) => stampKey(ev, () => addEmoji(e.char, e.name, true))}
                  data-testid="emoji">{e.char}</button
                >
                {#if hovered === key || focused === key}
                  <button type="button" class="stamp" aria-label="Stamp {e.name}" title="Stamp it on the canvas" onclick={() => addEmoji(e.char, e.name, true)} data-testid="stamp-emoji">
                    <Stamp size={12} aria-hidden="true" />
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </Section>
  {:else if stickers.length === 0}
    <EmptyState icon={Sticker} title="Nothing found" compact />
  {/if}
</div>

<style>
  .stickers {
    display: flex;
    flex-direction: column;
  }
  .search {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    padding: var(--space-3) var(--space-3) var(--space-2);
    background: var(--surface-1);
  }
  .search .icon {
    position: absolute;
    left: calc(var(--space-3) + 9px);
    display: inline-flex;
    color: var(--text-3);
  }
  input[type='search'] {
    width: 100%;
    height: var(--control-md);
    padding: 0 var(--space-2) 0 30px;
    border: 1px solid var(--control-border);
    border-bottom-color: var(--control-border-bottom);
    border-radius: var(--radius-md);
    background: var(--surface-sunken);
    font-size: var(--text-md);
    outline: none;
  }
  input[type='search']:focus {
    border-color: var(--accent);
    box-shadow: inset 0 -1px 0 var(--accent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 2px;
  }
  .item {
    position: relative;
  }
  .cell,
  .em {
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 1;
    padding: 5px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    cursor: default;
    transition:
      background-color var(--fade-1) linear,
      transform var(--dur-1) var(--ease-standard);
  }
  .cell:hover,
  .em:hover {
    background: var(--surface-hover);
  }
  .cell:active,
  .em:active {
    transform: scale(0.92);
  }
  .cell:focus-visible,
  .em:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: -2px;
  }
  .cell[aria-busy='true'] {
    opacity: 0.5;
  }
  /* The item's Stamp button, on its top-right corner while hovered or
     focused (half outside, so the item's own centre stays clickable). */
  .stamp {
    position: absolute;
    top: -4px;
    right: -4px;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    background: var(--surface-overlay);
    color: var(--text-2);
    box-shadow: var(--shadow-1);
    cursor: default;
    animation: stamp-in var(--fade-1) linear;
  }
  .stamp:hover {
    color: var(--accent-text);
  }
  .stamp:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 1px;
  }
  @keyframes stamp-in {
    from {
      opacity: 0;
    }
  }
  svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  h4 {
    margin: var(--space-1) 0 0;
    color: var(--text-3);
    font-size: var(--text-2xs);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
  }
  .emoji {
    display: grid;
    grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 1px;
  }
  .em {
    padding: 0;
    font-family: 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif;
    font-size: 20px;
    line-height: 1;
  }
  .none {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-sm);
  }
</style>

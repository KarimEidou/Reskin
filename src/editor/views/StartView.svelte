<!--
  Start (clicking the box): the drop target and ways in — open an image, a
  blank icon, system icons, the Library — plus recent designs, recent
  changes with Undo, crash recovery and "Restore all icons…".
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import FilePlus from '@lucide/svelte/icons/file-plus';
  import ImagePlus from '@lucide/svelte/icons/image-plus';
  import Library from '@lucide/svelte/icons/library';
  import Monitor from '@lucide/svelte/icons/monitor';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import ClockFading from '@lucide/svelte/icons/clock-fading';
  import Palette from '@lucide/svelte/icons/palette';
  import LifeBuoy from '@lucide/svelte/icons/life-buoy';
  import { commands } from '$lib/ipc/commands';
  import type { HistoryEntry, LibraryEntry } from '$lib/ipc/types';
  import { motion } from '$lib/motion/speed.svelte';
  import { settings } from '$lib/settings/store.svelte';
  import BoxVisual from '$lib/ui/BoxVisual.svelte';
  import { metricsFor } from '$lib/ui/box-geometry';
  import Button from '$lib/ui/Button.svelte';
  import EmptyState from '$lib/ui/EmptyState.svelte';
  import { toast } from '$lib/ui/toasts.svelte';
  import { reportRestore, getShell } from '../chrome/shell.svelte';
  import { getSession } from '../state/context';
  import { errorText } from '../state/session.svelte';
  import { fullDate, pngSrc, timeAgo } from './format';
  import ViewScaffold from './ViewScaffold.svelte';

  const session = getSession();
  const shell = getShell();

  let designs = $state.raw<LibraryEntry[] | null>(null);
  let changes = $state.raw<HistoryEntry[] | null>(null);
  let busy = $state<string | null>(null);

  const s = $derived(settings());
  const boxMetrics = metricsFor('small');
  /** Offer the autosave only when nothing is open (an open design autosaves itself). */
  const recovery = $derived(session.hasDesign ? null : shell.recovery);

  async function load(): Promise<void> {
    const [lib, hist] = await Promise.all([
      commands.libraryList().catch(() => [] as LibraryEntry[]),
      commands.historyList().catch(() => [] as HistoryEntry[]),
      shell.refreshRecovery(),
    ]);
    designs = lib.slice(0, 6);
    changes = hist.slice(0, 4);
  }

  $effect(() => {
    void shell.openEpoch;
    void shell.historyEpoch;
    void shell.libraryEpoch;
    void load();
  });

  async function openDesign(entry: LibraryEntry): Promise<void> {
    try {
      await shell.openLibraryDesign(entry);
    } catch (e) {
      toast({ message: `Could not open "${entry.name}": ${errorText(e)}`, kind: 'error' });
    }
  }

  async function undo(entry: HistoryEntry): Promise<void> {
    busy = entry.id;
    try {
      reportRestore(await commands.restore({ type: 'entry', id: entry.id }), 'one');
      shell.historyEpoch += 1;
    } catch (e) {
      toast({ message: `Could not undo: ${errorText(e)}`, kind: 'error' });
    } finally {
      busy = null;
    }
  }

  async function restoreDraft(): Promise<void> {
    const json = recovery;
    if (!json) return;
    try {
      await shell.restoreRecovery(json);
    } catch (e) {
      toast({ message: `Could not restore the design: ${errorText(e)}`, kind: 'error' });
    }
  }

  async function discardDraft(): Promise<void> {
    try {
      await shell.discardRecovery();
    } catch (e) {
      toast({ message: `Could not discard: ${errorText(e)}`, kind: 'error' });
    }
  }

</script>

<ViewScaffold
  title="Reskin an icon"
  subtitle="Drop a shortcut, folder or image to start — or pick something below."
  testid="start-view"
>
  {#if recovery}
    <div class="recovery" data-stagger role="region" aria-label="Unsaved design">
      <span class="badge" aria-hidden="true"><LifeBuoy size={18} /></span>
      <div class="text">
        <strong>Continue where you left off</strong>
        <span>A design from your last session wasn't applied or saved.</span>
      </div>
      <Button variant="ghost" size="sm" onclick={discardDraft}>Discard</Button>
      <Button variant="primary" size="sm" onclick={restoreDraft}>Restore</Button>
    </div>
  {/if}

  <div class="drop" class:over={shell.dragging} data-stagger data-testid="drop-zone">
    <div class="box" aria-hidden="true">
      <BoxVisual
        metrics={boxMetrics}
        skin={s.boxSkin}
        state={shell.dragging ? 'armed' : 'idle'}
        opacity={s.idleOpacity}
        reducedMotion={motion.reduced}
      />
    </div>
    <div class="pitch">
      <h2>{shell.dragging ? 'Drop to start editing' : 'Drag a shortcut, folder or image here'}</h2>
      <p>…or onto the box on your desktop. Several at once become a queue you can style in one go.</p>
      <div class="actions">
        <Button variant="primary" icon={ImagePlus} onclick={() => shell.openImage()}>Open image…</Button>
        <Button icon={FilePlus} onclick={() => shell.newBlank()}>New blank icon</Button>
        <Button icon={Monitor} onclick={() => shell.navigate('systemIcons')}>System icons</Button>
        <Button icon={Library} onclick={() => shell.navigate('library')}>Library</Button>
      </div>
    </div>
  </div>

  <div class="columns">
    <section class="card" data-stagger aria-labelledby="recent-designs">
      <header>
        <h2 id="recent-designs"><Palette size={16} aria-hidden="true" /> Recent designs</h2>
        {#if designs && designs.length > 0}
          <button type="button" class="more" onclick={() => shell.navigate('library')}>
            See all <ArrowRight size={14} aria-hidden="true" />
          </button>
        {/if}
      </header>
      {#if designs === null}
        <div class="thumbs skeleton" aria-hidden="true">
          {#each [0, 1, 2] as i (i)}<span class="tile"></span>{/each}
        </div>
      {:else if designs.length === 0}
        <EmptyState compact icon={Palette} title="No saved designs yet" description="Save a design to the Library to reuse it on other icons." />
      {:else}
        <ul class="thumbs">
          {#each designs as d (d.id)}
            <li>
              <button type="button" class="design" onclick={() => openDesign(d)} title="Open “{d.name}”">
                <span class="tile"><img src={pngSrc(d.thumb)} alt="" draggable="false" /></span>
                <span class="label">{d.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="card" data-stagger aria-labelledby="recent-changes">
      <header>
        <h2 id="recent-changes"><ClockFading size={16} aria-hidden="true" /> Recent changes</h2>
        {#if changes && changes.length > 0}
          <button type="button" class="more" onclick={() => shell.navigate('history')}>
            History <ArrowRight size={14} aria-hidden="true" />
          </button>
        {/if}
      </header>
      {#if changes === null}
        <div class="rows skeleton" aria-hidden="true">
          {#each [0, 1] as i (i)}<span class="row-skel"></span>{/each}
        </div>
      {:else if changes.length === 0}
        <EmptyState compact icon={ClockFading} title="Nothing changed yet" description="Icons you apply show up here, with Undo." />
      {:else}
        <ul class="rows">
          {#each changes as c (c.id)}
            <li class="change">
              <span class="mini"><img src={pngSrc(c.thumb)} alt="" draggable="false" /></span>
              <span class="what">
                <span class="name">{c.name}</span>
                <span class="when" title={fullDate(c.appliedAt)}>
                  {c.state === 'applied' ? timeAgo(c.appliedAt) : c.state === 'restored' ? 'restored' : c.state}
                </span>
              </span>
              {#if c.state === 'applied'}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Undo2}
                  loading={busy === c.id}
                  aria-label="Undo the change to {c.name}"
                  onclick={() => undo(c)}>Undo</Button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <footer class="foot" data-stagger>
    <button type="button" class="restore" onclick={() => shell.restoreAll()}>
      <RotateCcw size={14} aria-hidden="true" /> Restore all icons…
    </button>
    <span>Puts back every original icon Reskin changed.</span>
  </footer>
</ViewScaffold>

<style>
  .recovery {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-lg);
    background: linear-gradient(100deg, var(--accent-soft-strong), var(--accent-soft) 60%);
  }
  .recovery .badge {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: none;
    border-radius: var(--radius-md);
    background: rgb(var(--accent-rgb) / 0.22);
    color: var(--accent-text);
  }
  .recovery .text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    font-size: var(--text-md);
  }
  .recovery .text span {
    color: var(--text-2);
    font-size: var(--text-sm);
  }

  .drop {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-6);
    padding: var(--space-5) var(--space-6) var(--space-5) var(--space-4);
    border-radius: var(--radius-xl);
    background:
      radial-gradient(120% 140% at 0% 0%, rgb(var(--accent-rgb) / 0.12), transparent 55%),
      var(--shell-well);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
    transition:
      box-shadow var(--fade-2) linear,
      background-color var(--fade-2) linear;
  }
  /* Dashed outline that doesn't dance: an SVG-free gradient border. */
  .drop::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    border: 1.5px dashed var(--border-strong);
    pointer-events: none;
    transition: border-color var(--fade-2) linear;
  }
  .drop.over {
    box-shadow:
      inset 0 0 0 1px var(--accent-border),
      0 0 0 4px var(--accent-soft);
  }
  .drop.over::after {
    border-color: var(--accent);
  }
  .box {
    flex: none;
    display: grid;
    place-items: center;
  }
  .pitch {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .pitch h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  .pitch p {
    margin: 0;
    max-width: 520px;
    color: var(--text-2);
    font-size: var(--text-md);
    line-height: var(--leading-relaxed);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: var(--space-4);
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 200px;
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: rgb(var(--bg-rgb) / 0.25);
  }
  :global([data-theme='light']) .card {
    background: rgb(255 255 255 / 0.55);
  }
  .card header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .card h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }
  .card h2 :global(svg) {
    color: var(--text-3);
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: 24px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--accent-text);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .more:hover {
    background: var(--surface-hover);
  }
  .more:focus-visible,
  .restore:focus-visible,
  .design:focus-visible {
    outline: var(--focus-width) solid var(--focus-color);
    outline-offset: 2px;
  }

  .thumbs {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .design {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-1-5);
    width: 100%;
    padding: var(--space-1-5);
    border: 0;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--text-2);
    transition: background-color var(--fade-1) linear;
  }
  .design:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .tile {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border-radius: var(--radius-md);
    background: var(--checker);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
    overflow: hidden;
  }
  .tile img {
    width: 72%;
    height: 72%;
    object-fit: contain;
    filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.25));
    -webkit-user-drag: none;
  }
  .label {
    overflow: hidden;
    font-size: var(--text-sm);
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .change {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 44px;
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-1-5);
    border-radius: var(--radius-md);
  }
  .change:hover {
    background: var(--surface-hover);
  }
  .mini {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: none;
    border-radius: var(--radius-sm);
    background: var(--checker);
    overflow: hidden;
  }
  .mini img {
    width: 26px;
    height: 26px;
    object-fit: contain;
  }
  .what {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    font-size: var(--text-md);
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    color: var(--text-3);
    font-size: var(--text-xs);
  }

  .skeleton .tile,
  .row-skel {
    background: var(--surface-hover);
    box-shadow: none;
  }
  .row-skel {
    display: block;
    height: 44px;
    border-radius: var(--radius-md);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--text-3);
    font-size: var(--text-sm);
  }
  .restore {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    height: 28px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }
  .restore:hover {
    background: rgb(var(--danger-rgb) / 0.12);
    color: var(--danger);
  }
</style>

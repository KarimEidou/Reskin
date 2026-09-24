// The editor session: the one reactive hub every editor component talks to.
//
// It owns the image engine, the workers the panels compute in (created on
// first use, terminated with the session), the queue of dropped items (each
// keeps its own design and style recipe while you switch between them), the
// apply / elevation / batch flows, library + export + clipboard actions and
// the crash-recovery autosave. Components read `$state` fields directly and
// re-derive engine data from the `rev` counters, which are bumped by engine
// events.
//
// Rust talks to the editor through the mailbox (see App.svelte / the morph
// controller); this module only calls commands.

import type {
  ApplyMode,
  ApplyOutcome,
  EditorView,
  ExportKind,
  ItemId,
  ItemInfo,
  LibraryEntry,
  SizedPng,
} from '$lib/ipc/types';
import { commands } from '$lib/ipc/commands';
import { settings } from '$lib/settings/store.svelte';
import { toast } from '$lib/ui/toasts.svelte';
import { play } from '$lib/sound/synth';
import { Engine, Surface, type EngineEvent, type EngineEventKind, type LayerPreview } from '$engine/index';
import { FilterClient } from '$engine/filters/client';
import { PanelsClient } from '../panels/worker/client';

export type SidebarTab =
  | 'layers'
  | 'color'
  | 'adjust'
  | 'effects'
  | 'styles'
  | 'backdrop'
  | 'stickers'
  | 'history';

export type QueueStatus = 'pending' | 'editing' | 'applying' | 'applied' | 'failed';

export interface QueueEntry {
  info: ItemInfo;
  status: QueueStatus;
  /** Serialized design while another item is being edited. */
  project: string | null;
  /** The style recipe of that design while another item is being edited. */
  recipe: StyleRecipe | null;
  /** Small preview (data URL) for the queue strip. */
  thumb: string | null;
  outcome: ApplyOutcome | null;
}

/**
 * A re-playable style (preset / backdrop / adjustments) so "Apply style to
 * all" can rebuild it on every queued item's own icon. `apply` receives an
 * engine holding a fresh document whose only layer is the item's icon.
 *
 * A recipe belongs to one design: the panels chain their steps onto the
 * current design's recipe, each queued item keeps its own while another one
 * is edited, and a new design (a standalone image or project, New blank, a
 * Library design, a recovered autosave) starts without one.
 */
export interface StyleRecipe {
  label: string;
  apply(engine: Engine, iconLayerId: string): void | Promise<void>;
}

export interface PendingElevation {
  ticket: string;
  reason: string;
  item: ItemId;
  mode: ApplyMode;
}

/** Things the session needs from the outside world (injectable in tests). */
export interface SessionDeps {
  commands: Pick<
    typeof commands,
    | 'itemFrames'
    | 'readProject'
    | 'applyIcon'
    | 'applyIconElevated'
    | 'restore'
    | 'exportFile'
    | 'librarySave'
    | 'libraryLoad'
    | 'autosave'
    | 'autosaveLoad'
    | 'editorClose'
  >;
  /** Decodes a PNG (base64, no data: prefix) or a data URL into a Surface. */
  decode(png: string): Promise<Surface>;
  /** Encodes a surface to a PNG data URL (thumbnails). */
  encode(surface: Surface): Promise<string>;
}

type Rev = Record<EngineEventKind, number>;

const REV_KINDS: EngineEventKind[] = [
  'pixels',
  'layers',
  'selection',
  'history',
  'tool',
  'color',
  'symmetry',
  'document',
  'overlay',
  'interaction',
  'textEdit',
  'message',
  'preview',
];

const AUTOSAVE_DELAY_MS = 2000;
const THUMB_SIZE = 64;

/** An item can be applied to (has at least one apply mode). */
export function isTarget(info: ItemInfo): boolean {
  return info.modes.length > 0;
}

export class EditorSession {
  readonly engine: Engine;
  private readonly deps: SessionDeps;
  private filterClient: FilterClient | null = null;
  private panelsClient: PanelsClient | null = null;

  view = $state<EditorView>('start');
  queue = $state<QueueEntry[]>([]);
  currentIndex = $state(-1);
  sidebarTab = $state<SidebarTab>('layers');
  /** Before/after comparison: hold `\` or the split toggle. */
  compare = $state<'off' | 'hold' | 'split'>('off');
  /** Long-running action shown by the apply ring (progress 0..1 or null). */
  busy = $state<{ label: string; progress: number | null } | null>(null);
  elevation = $state<PendingElevation | null>(null);
  /** The icon the current item had before editing (for before/after). */
  original = $state.raw<Surface | null>(null);
  /** A design is loaded (queued item, standalone image, project or blank). */
  hasDesign = $state(false);
  /** The current design's style recipe (Styles/Backdrop/Adjust panels), replayed by "Apply style to all". */
  recipe = $state.raw<StyleRecipe | null>(null);
  /**
   * The design's recipe once the open layer preview is kept: set by the
   * Adjust panel for the adjustment being tuned, used by `keepPreview`.
   */
  previewRecipe: { preview: LayerPreview; recipe: () => StyleRecipe } | null = null;
  /** Bumped on every engine event of that kind; read to re-derive. */
  rev = $state<Rev>(Object.fromEntries(REV_KINDS.map((k) => [k, 0])) as Rev);

  private unsubscribe: () => void;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(deps: SessionDeps, engine: Engine = new Engine()) {
    this.deps = deps;
    this.engine = engine;
    this.unsubscribe = engine.subscribe((e) => this.onEngineEvent(e));
  }

  // --- workers -----------------------------------------------------------------

  /**
   * Filters and backdrop renders off the main thread. The worker starts on
   * first use and ends with the session; afterwards requests reject as
   * cancelled.
   */
  get filters(): FilterClient {
    if (!this.filterClient) {
      this.filterClient = new FilterClient(this.disposed ? { worker: false } : {});
      if (this.disposed) this.filterClient.dispose();
    }
    return this.filterClient;
  }

  /**
   * The panels worker (thumbnails, previews, presets, icon helpers,
   * stickers). Starts on first use and ends with the session; afterwards
   * requests reject as cancelled.
   */
  get panels(): PanelsClient {
    if (!this.panelsClient) {
      this.panelsClient = new PanelsClient(this.disposed ? false : undefined);
      if (this.disposed) this.panelsClient.dispose();
    }
    return this.panelsClient;
  }

  // --- derived state ---------------------------------------------------------

  get current(): QueueEntry | null {
    return this.queue[this.currentIndex] ?? null;
  }

  get item(): ItemInfo | null {
    return this.current?.info ?? null;
  }

  /** Apply modes available for the current item, preferred first. */
  get modes(): ApplyMode[] {
    return this.item?.modes ?? [];
  }

  get canApply(): boolean {
    return this.modes.length > 0 && this.busy === null;
  }

  // --- engine events -----------------------------------------------------------

  private onEngineEvent(e: EngineEvent): void {
    this.rev[e.kind] += 1;
    if (e.kind === 'message') {
      toast({ message: e.text, kind: e.level });
    }
    if (e.kind === 'pixels' || e.kind === 'layers' || e.kind === 'document' || e.kind === 'history') {
      this.scheduleAutosave();
    }
  }

  // --- opening items -----------------------------------------------------------

  /**
   * Adds dropped / picked items. Targets join the queue; with no target yet,
   * an image starts a design of its own and a project is opened; while
   * editing, images become layers and projects replace the design.
   */
  async openItems(items: ItemInfo[], opts: { replace?: boolean } = {}): Promise<void> {
    // Loading can take a moment; don't yank the user back to the Edit view
    // if they (or Rust) navigated elsewhere meanwhile.
    const viewAtStart = this.view;
    const showEdit = () => {
      if (this.view === viewAtStart) this.view = 'edit';
    };
    if (opts.replace) {
      await this.stashCurrent();
      this.queue = [];
      this.currentIndex = -1;
    }
    const targets = items.filter(isTarget);
    const sources = items.filter((i) => !isTarget(i));
    const firstNew = this.queue.length;
    for (const info of targets) {
      if (this.queue.some((q) => q.info.id === info.id || q.info.path === info.path)) continue;
      this.queue.push({ info, status: 'pending', project: null, recipe: null, thumb: info.icon, outcome: null });
    }
    if (this.currentIndex < 0 && this.queue.length > firstNew) {
      await this.select(firstNew);
    } else if (this.currentIndex < 0 && !this.hasDesign && sources.length > 0) {
      // No target: the first source becomes a standalone design.
      const [first, ...rest] = sources;
      await this.startFromSource(first!);
      for (const s of rest) await this.addSource(s);
      showEdit();
      return;
    }
    for (const s of sources) await this.addSource(s);
    if (this.queue.length > 0 || sources.length > 0) showEdit();
  }

  /**
   * Switches to queue entry `index`, keeping the current design. Calls are
   * serialised: a switch requested while another is loading runs after it.
   */
  select(index: number): Promise<void> {
    const run = this.switching.then(() => this.selectNow(index));
    this.switching = run.catch(() => {});
    return run;
  }

  private switching: Promise<void> = Promise.resolve();

  private async selectNow(index: number): Promise<void> {
    if (index === this.currentIndex || !this.queue[index]) return;
    await this.stashCurrent();
    this.currentIndex = index;
    const entry = this.queue[index]!;
    if (entry.status === 'pending') entry.status = 'editing';
    this.original = await this.loadIcon(entry.info);
    if (entry.project) {
      await this.engine.loadProject(JSON.parse(entry.project));
    } else {
      this.newDesignFromIcon(entry.info, this.original);
    }
    this.engine.clearHistory();
    this.recipe = entry.recipe;
    this.hasDesign = true;
  }

  /** Removes a queued item (not the only one being edited). */
  async remove(index: number): Promise<void> {
    if (!this.queue[index]) return;
    const wasCurrent = index === this.currentIndex;
    this.queue.splice(index, 1);
    if (index < this.currentIndex) this.currentIndex -= 1;
    if (wasCurrent) {
      this.currentIndex = -1;
      if (this.queue.length > 0) {
        await this.select(Math.min(index, this.queue.length - 1));
      } else {
        this.hasDesign = false;
        this.recipe = null;
      }
    }
  }

  /** A blank design (Start view "New icon"). */
  newBlank(): void {
    this.original = null;
    this.engine.newDocument({ name: 'Untitled' });
    this.engine.clearHistory();
    this.recipe = null;
    this.hasDesign = true;
  }

  /**
   * Keeps the open layer preview (an adjustment being tuned) as a step of
   * the design, and its step in the recipe (see `previewRecipe`). Returns
   * true when a step was recorded.
   */
  keepPreview(): boolean {
    const preview = this.engine.preview;
    const pending = this.previewRecipe;
    this.previewRecipe = null;
    if (!preview?.commit()) return false;
    if (pending?.preview === preview) this.recipe = pending.recipe();
    return true;
  }

  /** Keeps the current item's design and recipe in its queue entry. */
  private async stashCurrent(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    // An adjustment still being previewed is kept, as when leaving its panel.
    this.keepPreview();
    entry.recipe = this.recipe;
    try {
      entry.project = await this.engine.serialize();
      entry.thumb = await this.deps.encode(this.engine.thumbnail(THUMB_SIZE));
    } catch (e) {
      console.warn('could not keep the design', e);
    }
  }

  /** The item's current icon as a surface (largest frame), or null. */
  async loadIcon(info: ItemInfo): Promise<Surface | null> {
    try {
      const frames = await this.deps.commands.itemFrames(info.id);
      const best = [...frames].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (best) return await this.deps.decode(best.png);
    } catch (e) {
      console.warn('item_frames failed; using the preview', e);
    }
    return info.icon ? this.deps.decode(info.icon).catch(() => null) : null;
  }

  private newDesignFromIcon(info: ItemInfo, icon: Surface | null): void {
    this.engine.newDocument({
      name: info.name,
      source: { kind: info.kind, name: info.name, path: info.path },
    });
    if (icon) {
      const doc = this.engine.doc;
      const blank = doc.layers[0];
      this.engine.importImage(icon, info.name, { padding: 0 });
      // The empty starter layer adds nothing under an imported icon.
      if (blank && this.engine.doc.layers.length > 1) this.engine.deleteLayer(blank.id);
    }
  }

  private async startFromSource(info: ItemInfo): Promise<void> {
    if (info.kind === 'project') {
      await this.openProject(info);
      return;
    }
    const icon = await this.loadIcon(info);
    this.original = icon;
    this.newDesignFromIcon(info, icon);
    this.engine.clearHistory();
    this.recipe = null;
    this.hasDesign = true;
  }

  /** Adds a design source to the current design (image → layer). */
  async addSource(info: ItemInfo): Promise<void> {
    if (info.kind === 'project') {
      await this.openProject(info);
      return;
    }
    const surface = await this.loadIcon(info);
    if (surface) this.engine.importImage(surface, info.name);
  }

  private async openProject(info: ItemInfo): Promise<void> {
    const json = await this.deps.commands.readProject(info.id);
    await this.engine.loadProject(JSON.parse(json));
    this.engine.clearHistory();
    this.recipe = null;
    this.hasDesign = true;
  }

  /** Imports an already-decoded image (paste / drop onto the canvas). */
  importSurface(surface: Surface, name = 'Pasted image'): string | null {
    return this.engine.importImage(surface, name);
  }

  // --- apply -------------------------------------------------------------------

  /** Renders every configured ICO size through the export pipeline. */
  renderIcon(): Promise<SizedPng[]> {
    return this.engine.exportPngs(settings().icoSizes);
  }

  /**
   * Save & Apply for the current item. Rust collapses the editor and flies
   * the box when `flourish` is on, so the promise can resolve after the
   * editor is already hidden.
   */
  async apply(opts: { mode?: ApplyMode; flourish?: boolean } = {}): Promise<ApplyOutcome | null> {
    const entry = this.current;
    if (!entry || this.busy) return null;
    const mode = opts.mode ?? entry.info.modes[0];
    if (!mode) return null;
    this.busy = { label: 'Applying', progress: null };
    entry.status = 'applying';
    try {
      const images = await this.renderIcon();
      const s = settings();
      const outcome = await this.deps.commands.applyIcon({
        item: entry.info.id,
        images,
        designName: this.engine.doc.meta.name || entry.info.name,
        mode,
        flourish: opts.flourish ?? s.flourish,
        updatePins: s.updatePins,
      });
      this.afterApply(entry, outcome, mode);
      return outcome;
    } catch (e) {
      entry.status = 'failed';
      toast({ message: `Could not apply: ${errorText(e)}`, kind: 'error' });
      play('error');
      return null;
    } finally {
      this.busy = null;
    }
  }

  private afterApply(entry: QueueEntry, outcome: ApplyOutcome, mode: ApplyMode): void {
    entry.outcome = outcome;
    switch (outcome.type) {
      case 'applied':
        entry.status = 'applied';
        entry.info = { ...entry.info, reskinned: true, customIcon: true };
        this.cancelAutosave();
        void this.deps.commands.autosave(null);
        play('success');
        break;
      case 'needsElevation':
        entry.status = 'editing';
        this.elevation = { ticket: outcome.ticket, reason: outcome.reason, item: entry.info.id, mode };
        break;
      case 'unsupported':
        entry.status = 'editing';
        toast({ message: outcome.reason, kind: 'error' });
        play('error');
        break;
      case 'failed':
        entry.status = 'failed';
        toast({ message: outcome.hint ? `${outcome.message} — ${outcome.hint}` : outcome.message, kind: 'error' });
        play('error');
        break;
      case 'cancelled':
        entry.status = 'editing';
        break;
    }
  }

  /** The user agreed to the UAC prompt path. */
  async approveElevation(): Promise<ApplyOutcome | null> {
    const pending = this.elevation;
    const entry = this.current;
    if (!pending || !entry) return null;
    this.elevation = null;
    this.busy = { label: 'Waiting for approval', progress: null };
    try {
      const outcome = await this.deps.commands.applyIconElevated(pending.ticket);
      this.afterApply(entry, outcome, pending.mode);
      return outcome;
    } catch (e) {
      toast({ message: `Could not apply: ${errorText(e)}`, kind: 'error' });
      return null;
    } finally {
      this.busy = null;
    }
  }

  /** Instead of elevating: copy the shortcut to the user's desktop. */
  async personalCopy(): Promise<ApplyOutcome | null> {
    this.elevation = null;
    return this.apply({ mode: 'personalCopy' });
  }

  dismissElevation(): void {
    this.elevation = null;
  }

  /**
   * Batch: replays the current design's recipe on every other pending
   * item's own icon and applies it (no flourish), then returns to the
   * current item. Each styled item keeps the recipe as its own.
   */
  async applyStyleToAll(): Promise<{ applied: number; failed: number }> {
    const result = { applied: 0, failed: 0 };
    if (this.busy) return result;
    const others = this.queue
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) => index !== this.currentIndex && entry.status !== 'applied');
    if (others.length === 0) return result;
    // An adjustment still being tuned is part of the design, so of its recipe.
    this.keepPreview();
    const recipe = this.recipe;
    if (!recipe) return result;
    await this.stashCurrent();
    const back = this.currentIndex;
    const scratch = new Engine();
    try {
      for (let n = 0; n < others.length; n++) {
        const { entry } = others[n]!;
        this.busy = { label: `Applying ${n + 1} of ${others.length}`, progress: n / others.length };
        entry.status = 'applying';
        const icon = await this.loadIcon(entry.info);
        scratch.newDocument({ name: entry.info.name });
        const base = scratch.doc.layers[0];
        const iconLayer = icon ? scratch.importImage(icon, entry.info.name, { padding: 0 }) : null;
        if (base && iconLayer) scratch.deleteLayer(base.id);
        await recipe.apply(scratch, iconLayer ?? scratch.doc.layers[0]!.id);
        const mode = entry.info.modes[0];
        if (!mode) {
          entry.status = 'failed';
          result.failed++;
          continue;
        }
        try {
          const outcome = await this.deps.commands.applyIcon({
            item: entry.info.id,
            images: await scratch.exportPngs(settings().icoSizes),
            designName: recipe.label,
            mode,
            flourish: false,
            updatePins: settings().updatePins,
          });
          entry.outcome = outcome;
          entry.project = await scratch.serialize();
          entry.recipe = recipe;
          entry.thumb = await this.deps.encode(scratch.thumbnail(THUMB_SIZE));
          if (outcome.type === 'applied') {
            entry.status = 'applied';
            result.applied++;
          } else {
            entry.status = 'failed';
            result.failed++;
          }
        } catch (e) {
          entry.status = 'failed';
          result.failed++;
          console.warn('batch apply failed', e);
        }
      }
    } finally {
      scratch.dispose();
      this.busy = null;
      this.currentIndex = -1;
      await this.select(back);
    }
    toast({
      message:
        result.failed === 0
          ? `Applied "${recipe.label}" to ${result.applied} more icon${result.applied === 1 ? '' : 's'}.`
          : `Applied to ${result.applied}; ${result.failed} failed.`,
      kind: result.failed === 0 ? 'success' : 'error',
    });
    return result;
  }

  // --- library, export, clipboard ------------------------------------------------

  async saveToLibrary(name?: string, id?: string): Promise<LibraryEntry | null> {
    try {
      const entry = await this.deps.commands.librarySave({
        id: id ?? null,
        name: name ?? this.engine.doc.meta.name ?? 'Untitled',
        thumb: stripDataUrl(await this.deps.encode(this.engine.thumbnail(128))),
        data: await this.engine.serialize(),
      });
      toast({ message: `Saved "${entry.name}" to the Library.`, kind: 'success' });
      return entry;
    } catch (e) {
      toast({ message: `Could not save: ${errorText(e)}`, kind: 'error' });
      return null;
    }
  }

  async openLibraryDesign(id: string): Promise<void> {
    const json = await this.deps.commands.libraryLoad(id);
    await this.engine.loadProject(JSON.parse(json));
    this.engine.clearHistory();
    this.recipe = null;
    this.hasDesign = true;
    this.view = 'edit';
  }

  async exportAs(kind: ExportKind): Promise<string | null> {
    const name = this.engine.doc.meta.name || this.item?.name || 'icon';
    try {
      const images =
        kind === 'ico'
          ? await this.renderIcon()
          : kind === 'png'
            ? (await this.engine.exportPngs([256])).slice(-1)
            : [];
      const data = kind === 'project' ? await this.engine.serialize() : null;
      const path = await this.deps.commands.exportFile({ kind, suggestedName: name, images, data });
      if (path) toast({ message: `Exported to ${path}`, kind: 'success' });
      return path;
    } catch (e) {
      toast({ message: `Export failed: ${errorText(e)}`, kind: 'error' });
      return null;
    }
  }

  /** Copies the 256 px icon to the clipboard as PNG. */
  async copyToClipboard(): Promise<boolean> {
    try {
      const [png] = (await this.engine.exportPngs([256])).slice(-1);
      if (!png) return false;
      const bytes = Uint8Array.from(atob(png.png), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
      toast({ message: 'Copied to the clipboard.', kind: 'success' });
      return true;
    } catch (e) {
      toast({ message: `Could not copy: ${errorText(e)}`, kind: 'error' });
      return false;
    }
  }

  // --- autosave ------------------------------------------------------------------

  private scheduleAutosave(): void {
    if (this.disposed || this.view !== 'edit') return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => void this.flushAutosave(), AUTOSAVE_DELAY_MS);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  async flushAutosave(): Promise<void> {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    try {
      await this.deps.commands.autosave(await this.engine.serialize());
    } catch (e) {
      console.warn('autosave failed', e);
    }
  }

  /** A design left over from a crash / an unfinished session, if any. */
  async recoverable(): Promise<string | null> {
    try {
      return await this.deps.commands.autosaveLoad();
    } catch {
      return null;
    }
  }

  async restoreAutosave(json: string): Promise<void> {
    await this.engine.loadProject(JSON.parse(json));
    this.engine.clearHistory();
    this.recipe = null;
    this.hasDesign = true;
    this.view = 'edit';
  }

  discardAutosave(): Promise<void> {
    this.cancelAutosave();
    return this.deps.commands.autosave(null);
  }

  // --- navigation --------------------------------------------------------------

  navigate(view: EditorView): void {
    this.view = view;
  }

  /** Close button / Esc: Rust runs the collapse handoff. */
  async requestClose(): Promise<void> {
    if (this.view === 'edit') await this.flushAutosave();
    await this.deps.commands.editorClose('user');
  }

  /** Forgets the queue (after the editor closed). */
  reset(): void {
    this.cancelAutosave();
    this.queue = [];
    this.currentIndex = -1;
    this.elevation = null;
    this.busy = null;
    this.original = null;
    this.recipe = null;
    this.previewRecipe = null;
    this.compare = 'off';
    this.hasDesign = false;
  }

  /** Ends the session: timers, engine listeners and both workers go away. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAutosave();
    this.unsubscribe();
    this.filterClient?.dispose();
    this.panelsClient?.dispose();
    this.engine.dispose();
  }
}

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function stripDataUrl(s: string): string {
  const i = s.indexOf(';base64,');
  return i >= 0 ? s.slice(i + 8) : s;
}

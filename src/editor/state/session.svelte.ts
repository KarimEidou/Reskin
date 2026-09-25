// The editor session: the one reactive hub every editor component talks to.
//
// It owns the image engine, the workers the panels compute in (created on
// first use, terminated with the session), the queue of dropped items (each
// keeps its own design, style recipe and Library link while you switch
// between them), the apply / elevation / batch flows, library + export +
// clipboard actions and the crash-recovery autosave. Components read
// `$state` fields directly and re-derive engine data from the `rev`
// counters, which are bumped by engine events.
//
// The open design belongs to the current queue entry, or — with an empty
// queue — stands alone (an image, a project, New blank, a Library design, a
// paste). Nothing is dropped on the way: a standalone design gets a queue
// entry of its own before anything else joins the queue, and a target that
// arrives while the open design has none takes that design over.
//
// Rust talks to the editor through the mailbox (see App.svelte / the morph
// controller); this module only calls commands.

import type {
  ApplyMode,
  ApplyOutcome,
  EditorView,
  ExportKind,
  ItemInfo,
  LibraryEntry,
  SizedPng,
  SystemIconId,
} from '$lib/ipc/types';
import { commands } from '$lib/ipc/commands';
import { settings } from '$lib/settings/store.svelte';
import { toast, type ToastKind } from '$lib/ui/toasts.svelte';
import { play } from '$lib/sound/synth';
import {
  Engine,
  MASTER_SIZE,
  Surface,
  deserializeProject,
  migrateProject,
  type Doc,
  type EngineEvent,
  type EngineEventKind,
  type LayerPreview,
  type SourceInfo,
} from '$engine/index';
import { FilterClient } from '$engine/filters/client';
import { Autosave } from '$engine/io/autosave';
import { ProjectEncoder } from '$engine/io/encoder';
import { isCancelled, PanelsClient } from '../panels/worker/client';
import { orderedModes, preferredMode } from '../workspace/apply-modes';

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
  /** The target — or, for a design without one yet, the file it came from (or a stand-in, see `designItem`). */
  info: ItemInfo;
  status: QueueStatus;
  /** Serialized design while another item is being edited. */
  project: string | null;
  /** The style recipe of that design while another item is being edited. */
  recipe: StyleRecipe | null;
  /** Small preview (data URL) for the queue strip. */
  thumb: string | null;
  outcome: ApplyOutcome | null;
  /** Why the last apply did not go through, shown with the item. */
  problem: string | null;
  /** The design has changes that were not applied, saved or exported (while another item is edited). */
  unsaved: boolean;
  /** The Library design that design came from or was saved as (while another item is edited). */
  libraryId: string | null;
  /** That Library design's name, as the Library has it. */
  libraryName: string | null;
}

/**
 * A re-playable style (preset / backdrop / adjustments) so "Apply style to
 * all" can rebuild it on every queued item's own icon. `apply` receives an
 * engine holding a fresh document whose only layer is the item's icon.
 *
 * A recipe belongs to one design: the panels chain their steps onto the
 * current design's recipe, each queued item keeps its own while another one
 * is edited, and a new design (a standalone image or project, New blank, a
 * Library design, a recovered autosave) starts without one. It follows the
 * design's history: undoing the change that added a step takes the step
 * back out, redoing it brings it back (see `EditorSession.recipe`).
 */
export interface StyleRecipe {
  label: string;
  apply(engine: Engine, iconLayerId: string): void | Promise<void>;
}

/** Where the open design stood when it was saved, applied or exported (see `unsaved`). */
export interface SavePoint {
  token: number;
  entry: number | null;
}

/** One item's Save & Apply. */
export interface ApplyJob {
  mode: ApplyMode;
  images: SizedPng[];
  designName: string;
  /** A flourish was asked for; it plays only for the last item waiting. */
  flourish: boolean;
  /** The open design being applied: it counts as saved once applied. */
  saved?: SavePoint;
}

/**
 * An apply waiting for administrator approval (the item is on the Public
 * Desktop). A personal copy sends the same images instead.
 */
export interface ElevationRequest extends ApplyJob {
  entry: QueueEntry;
  ticket: string;
  reason: string;
}

/** An applied change the Undo of its toast can take back. */
export interface AppliedChange {
  entry: QueueEntry;
  before: ItemInfo;
  /**
   * The apply's main journal entry, if it has one: undoing it undoes the
   * Start menu and taskbar pins applied with it (its group) too.
   */
  historyId: string | null;
}

export interface PendingElevation {
  requests: ElevationRequest[];
  /**
   * From "Apply style to all": approved or copied together, with one
   * summary for the whole batch once the dialog is answered.
   */
  batch: boolean;
  /** What the batch applied before asking (its Undo goes with that summary). */
  applied: AppliedChange[];
  /** How many of the batch's items failed before asking. */
  failed: number;
}

/** Something to bring into the editor: an inspected item, or a picture (a paste). */
export type ImportSource = { kind: 'item'; info: ItemInfo } | { kind: 'image'; name: string; surface: Surface };

/**
 * What imports become while a design is open (the import popover's
 * choices): `layer` — pictures and other items' icons become layers of the
 * design; `queue` — everything joins the queue, and the open design keeps
 * an entry of its own; `adopt` — the open design, which has no target yet,
 * becomes the first target's, and the rest joins the queue.
 */
export type ImportChoice = 'layer' | 'queue' | 'adopt';

/** Things the session needs from the outside world (injectable in tests). */
export interface SessionDeps {
  commands: Pick<
    typeof commands,
    | 'inspectPaths'
    | 'inspectSystemIcon'
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
/** Continuous editing still autosaves at least this often. */
const AUTOSAVE_MAX_WAIT_MS = 10_000;
const THUMB_SIZE = 64;
/** How long the "Applied" toast offers Undo (PLAN: 6 s). */
const UNDO_MS = 6000;
const NEEDS_ADMIN = 'Needs administrator approval';
const SYSTEM_ICONS: readonly SystemIconId[] = [
  'thisPc',
  'recycleBinEmpty',
  'recycleBinFull',
  'userFiles',
  'network',
  'controlPanel',
];

/** An item can be applied to (has at least one apply mode). */
export function isTarget(info: ItemInfo): boolean {
  return info.modes.length > 0;
}

/** A design's `meta.source` for an item. */
function sourceOf(info: ItemInfo): SourceInfo {
  return { kind: info.kind, name: info.name, path: info.path };
}

/**
 * Starts `engine` on a fresh design of `info`'s icon (its only layer; best
 * fitted to the document already, see `EditorSession.fitted`); returns that
 * layer's id.
 */
function designFromIcon(engine: Engine, info: ItemInfo, icon: Surface | null): string {
  engine.newDocument({ name: info.name, source: sourceOf(info) });
  const blank = engine.doc.layers[0]!;
  const layer = icon ? engine.importImage(icon, info.name, { padding: 0 }) : null;
  // The empty starter layer adds nothing under an imported icon.
  if (layer) engine.deleteLayer(blank.id);
  return layer ?? blank.id;
}

/** The message of a failed apply outcome, with its hint. */
function failureText(outcome: Extract<ApplyOutcome, { type: 'failed' }>): string {
  return outcome.hint ? `${outcome.message} — ${outcome.hint}` : outcome.message;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class EditorSession {
  readonly engine: Engine;
  private readonly deps: SessionDeps;
  private filterClient: FilterClient | null = null;
  private panelsClient: PanelsClient | null = null;
  private encoderClient: ProjectEncoder | null = null;

  view = $state<EditorView>('start');
  queue = $state<QueueEntry[]>([]);
  currentIndex = $state(-1);
  sidebarTab = $state<SidebarTab>('layers');
  /** Before/after comparison: hold `\` or the split toggle. */
  compare = $state<'off' | 'hold' | 'split'>('off');
  /** Long-running action shown by the apply ring (progress 0..1 or null). */
  busy = $state<{ label: string; progress: number | null } | null>(null);
  /** Item switches running or waiting (`select`). */
  switching = $state(0);
  elevation = $state<PendingElevation | null>(null);
  /** The icon the current item had before editing (for before/after). */
  original = $state.raw<Surface | null>(null);
  /** A design is loaded (queued item, standalone image, project or blank). */
  hasDesign = $state(false);
  /** The Library design the open design came from or was last saved as: saving updates it. */
  libraryId = $state<string | null>(null);
  /** That Library design's name, as the Library has it (the open design goes by it too). */
  libraryName = $state<string | null>(null);
  /**
   * Identity of the open design. It changes when another design starts
   * loading and again once it is in: work that awaits something (a render
   * in a worker, a decode) reads it first and, once back, asks
   * `isOpenDesign(token)` — so its result never lands on a design being
   * put away or not open any more.
   */
  designToken = $state(0);
  /**
   * The design's recipe once the open layer preview is kept: set by the
   * Adjust panel for the adjustment being tuned, used by `keepPreview`.
   */
  previewRecipe: { preview: LayerPreview; recipe: () => StyleRecipe } | null = null;
  /** Bumped on every engine event of that kind; read to re-derive. */
  rev = $state<Rev>(Object.fromEntries(REV_KINDS.map((k) => [k, 0])) as Rev);

  /** See `interactive`. */
  private panelOpen = $state(false);
  /** Waiting for the panel to open (see `whenInteractive`). */
  private openWaiters: Array<() => void> = [];
  /** See `recipe`. */
  private recipeNow = $state.raw<StyleRecipe | null>(null);
  /** The recipe before the oldest history step the design still has. */
  private recipeBase: StyleRecipe | null = null;
  /** The recipe after each history step a panel set it at, by entry id. */
  private readonly recipeSteps = new Map<number, StyleRecipe | null>();
  /** The history steps that were applied when the recipe last followed the history. */
  private appliedSteps = new Set<number>();
  /** History step the open design was loaded or last saved at (see `unsaved`). */
  private cleanEntry = $state<number | null>(null);
  /** The open design came with unsaved changes (a recovered draft, a stashed unsaved design). */
  private baseUnsaved = $state(false);
  /** The file a standalone design started from (an image or project), for its queue entry later. */
  private standalone: ItemInfo | null = null;
  private designSerial = 0;
  /** Designs being put in the engine right now (see `replaceDesign`). */
  private replacing = 0;
  /**
   * Bumped by `reset`: loads started for the queue it forgot (an item still
   * loading as the editor closed) read it first and, once back, put
   * nothing in the next open.
   */
  private generation = 0;
  private switchChain: Promise<void> = Promise.resolve();
  private readonly autosaver: Autosave;
  /**
   * The live autosave holds a draft of the open design, or of the one it
   * replaced in place (New blank, a Library design): once the open design
   * is clean, that draft goes (see `produceAutosave`). A design put away
   * in the queue takes its draft along (see `selectNow`).
   */
  private draftWritten = false;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(deps: SessionDeps, engine: Engine = new Engine()) {
    this.deps = deps;
    this.engine = engine;
    this.autosaver = new Autosave({
      produce: () => this.produceAutosave(),
      save: (data) => this.deps.commands.autosave(data),
      delayMs: AUTOSAVE_DELAY_MS,
      maxWaitMs: AUTOSAVE_MAX_WAIT_MS,
      onError: (e) => console.warn('autosave failed', e),
    });
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
      this.panelsClient.holdBackground(!this.panelOpen);
      if (this.disposed) this.panelsClient.dispose();
    }
    return this.panelsClient;
  }

  /**
   * .reskin serialization off the main thread; starts on first use — at
   * the latest with the first unsaved change (see `onEngineEvent`) — and
   * ends with the session.
   */
  private get encoder(): ProjectEncoder {
    if (!this.encoderClient) {
      this.encoderClient = new ProjectEncoder(this.disposed ? { worker: false } : {});
      if (this.disposed) this.encoderClient.dispose();
    }
    return this.encoderClient;
  }

  /** A design (the open one by default) as .reskin JSON, as it is now; encoded off the main thread. */
  encodeProject(doc: Doc = this.engine.doc): Promise<string> {
    return this.encoder.encode(doc);
  }

  // --- the panel ---------------------------------------------------------------

  /**
   * The editor panel is open and takes input (the shell mirrors the morph
   * state here). Until it is — hidden, or morphing open — work nobody is
   * waiting for waits: the panels worker holds its background renders
   * (layer thumbnails, previews, preset thumbnails) and `whenInteractive`
   * holds the rest, so none of it lands on the page mid-morph
   * (docs/ARCHITECTURE.md, "Performance").
   */
  get interactive(): boolean {
    return this.panelOpen;
  }

  set interactive(on: boolean) {
    this.panelOpen = on;
    this.panelsClient?.holdBackground(!on);
    if (!on) return;
    const waiting = this.openWaiters;
    this.openWaiters = [];
    for (const resolve of waiting) resolve();
  }

  /** Resolves once the panel is open and takes input (see `interactive`); at once when it is. */
  whenInteractive(): Promise<void> {
    if (this.panelOpen) return Promise.resolve();
    return new Promise((resolve) => this.openWaiters.push(resolve));
  }

  // --- derived state ---------------------------------------------------------

  get current(): QueueEntry | null {
    return this.queue[this.currentIndex] ?? null;
  }

  get item(): ItemInfo | null {
    return this.current?.info ?? null;
  }

  /** Apply modes available for the current item, the one Save & Apply uses first. */
  get modes(): ApplyMode[] {
    const info = this.item;
    return info ? orderedModes(info) : [];
  }

  /** A job runs or an item is loading: applies, batches and the user's switches wait. */
  get queueLocked(): boolean {
    return this.busy !== null || this.switching > 0;
  }

  get canApply(): boolean {
    return this.modes.length > 0 && !this.queueLocked;
  }

  /** The queued targets "Apply style to all" applies to: every other one not applied yet. */
  get styleTargets(): QueueEntry[] {
    return this.queue.filter((entry, index) => index !== this.currentIndex && entry.status !== 'applied' && isTarget(entry.info));
  }

  /** The open design has changes that were not applied, saved to the Library or exported. */
  get unsaved(): boolean {
    void this.rev.history;
    return this.hasDesign && (this.baseUnsaved || this.engine.currentEntryId !== this.cleanEntry);
  }

  /** The open design has a target to apply to. */
  private get hasTarget(): boolean {
    const entry = this.current;
    return entry !== null && isTarget(entry.info);
  }

  // --- the style recipe -----------------------------------------------------------

  /**
   * The current design's style recipe (Styles/Backdrop/Adjust/Effects
   * panels), replayed by "Apply style to all". A panel sets it right after
   * the change it made, so each value belongs to a history step: undoing
   * that step brings back the recipe before it, redoing it brings the value
   * back, and a step undone and then replaced by another change is gone for
   * good — the recipe never holds a look the design does not have.
   */
  get recipe(): StyleRecipe | null {
    return this.recipeNow;
  }

  set recipe(recipe: StyleRecipe | null) {
    const step = this.engine.currentEntryId;
    if (step === null) this.recipeBase = recipe;
    else this.recipeSteps.set(step, recipe);
    this.recipeNow = recipe;
  }

  /** A design comes with `recipe` and no history of its own yet (a load or reset). */
  private startRecipe(recipe: StyleRecipe | null): void {
    this.recipeBase = recipe;
    this.recipeSteps.clear();
    this.appliedSteps = new Set(this.engine.historyEntries.slice(0, this.engine.historyIndex).map((e) => e.id));
    this.recipeNow = recipe;
  }

  /** The history moved: the recipe is the one of the newest step still applied. */
  private followHistory(): void {
    const entries = this.engine.historyEntries;
    const applied = entries.slice(0, this.engine.historyIndex);
    const listed = new Set(entries.map((e) => e.id));
    let newestDropped = -1;
    for (const [id, recipe] of [...this.recipeSteps]) {
      if (listed.has(id)) continue;
      // Gone from the history: a step it let go of (its memory cap, a
      // clear) while applied stays part of the design — the newest such
      // one is the base now; an undone one another change replaced is gone.
      if (this.appliedSteps.has(id) && id > newestDropped) {
        newestDropped = id;
        this.recipeBase = recipe;
      }
      this.recipeSteps.delete(id);
    }
    this.appliedSteps = new Set(applied.map((e) => e.id));
    const newest = applied.findLast((e) => this.recipeSteps.has(e.id));
    this.recipeNow = newest ? this.recipeSteps.get(newest.id)! : this.recipeBase;
  }

  // --- engine events -----------------------------------------------------------

  private onEngineEvent(e: EngineEvent): void {
    this.rev[e.kind] += 1;
    if (e.kind === 'message') {
      toast({ message: e.text, kind: e.level });
    }
    if (e.kind === 'history') {
      this.followHistory();
      // Every change to a design is a history step (a load clears the history).
      if (this.hasDesign) this.autosaver.schedule();
      // Unsaved work is encoded before long — by its autosave, or by the
      // close's flush, which Clear waits for only so long: the encoder's
      // worker loads now, not in the middle of that close.
      if (this.unsaved) void this.encoder;
    }
  }

  // --- the open design -------------------------------------------------------

  /**
   * Runs `load`, which puts another design in the engine: `designToken`
   * changes when it starts and again when it is done.
   */
  private async replaceDesign(load: () => Promise<void>): Promise<void> {
    this.designToken += 1;
    this.replacing += 1;
    try {
      await load();
    } finally {
      this.replacing -= 1;
      this.designToken += 1;
    }
  }

  /**
   * Work that read `designToken` before awaiting may still land: the same
   * design is open, and no other one is on its way in (work started while
   * one was would otherwise land on the design being put away).
   */
  isOpenDesign(token: number): boolean {
    return token === this.designToken && this.replacing === 0;
  }

  /** Bookkeeping for a design just put in the engine. */
  private loaded(
    opts: {
      recipe?: StyleRecipe | null;
      library?: { id: string; name: string } | null;
      unsaved?: boolean;
      standalone?: ItemInfo | null;
    } = {},
  ): void {
    this.startRecipe(opts.recipe ?? null);
    this.libraryId = opts.library?.id ?? null;
    this.libraryName = opts.library?.name ?? null;
    this.standalone = opts.standalone ?? null;
    this.cleanEntry = this.engine.currentEntryId;
    this.baseUnsaved = opts.unsaved ?? false;
    this.hasDesign = true;
  }

  /**
   * Where the open design stands, before it is saved somewhere. Seals the
   * newest history step, so a later change is a step of its own (and the
   * design unsaved again) even where steps merge.
   */
  private savePoint(): SavePoint {
    this.engine.sealHistory();
    return { token: this.designToken, entry: this.engine.currentEntryId };
  }

  /** The design saved at `point` is safe now (applied, in the Library or exported). */
  private markSaved(point: SavePoint): void {
    if (point.token !== this.designToken) return;
    this.cleanEntry = point.entry;
    this.baseUnsaved = false;
  }

  /** The open design belongs to the current target (recovery finds it again through `meta.source`). */
  private claimSource(): void {
    const info = this.item;
    if (info && isTarget(info)) this.engine.doc.meta.source = sourceOf(info);
  }

  // --- opening items -----------------------------------------------------------

  /**
   * Adds dropped / picked items (`replace`: instead of the queue and the
   * open design). Targets join the queue: with nothing open the first one
   * opens; a design without a target becomes the first new target's (its
   * history kept). Images start a design of their own when nothing is
   * open and become layers otherwise; projects open when nothing is open
   * and join the queue otherwise.
   */
  async openItems(items: ItemInfo[], opts: { replace?: boolean } = {}): Promise<void> {
    const generation = this.generation;
    // Loading can take a moment; don't yank the user back to the Edit view
    // if they (or Rust) navigated elsewhere meanwhile.
    const viewAtStart = this.view;
    if (opts.replace) {
      this.queue = [];
      this.currentIndex = -1;
      this.hasDesign = false;
    }
    let first: QueueEntry | null = null;
    for (const info of items.filter(isTarget)) {
      const entry = this.enqueue(info);
      first ??= entry;
    }
    let sources = items.filter((i) => !isTarget(i));
    if (first) {
      if (!this.hasDesign) await this.select(this.queue.indexOf(first));
      else if (!this.hasTarget) this.adopt(first);
    } else if (!this.hasDesign && sources.length > 0) {
      await this.startFromSource(sources[0]!);
      sources = sources.slice(1);
    }
    // The editor closed and opened again meanwhile: the rest was for the queue it forgot.
    if (generation !== this.generation) return;
    for (const s of sources) {
      if (s.kind !== 'project') {
        await this.addAsLayer(s);
        if (generation !== this.generation) return;
      } else {
        this.ensureQueued();
        this.enqueue(s);
      }
    }
    if (items.length > 0 && this.hasDesign && this.view === viewAtStart) this.view = 'edit';
  }

  /**
   * Brings dropped, picked or pasted things in, as `how` says (see
   * ImportChoice; projects, which cannot be layers, join the queue); with
   * nothing open they simply open. Resolves to how many of them joined
   * the queue.
   */
  async importSources(sources: readonly ImportSource[], how: ImportChoice): Promise<number> {
    const generation = this.generation;
    const items = sources.flatMap((s) => (s.kind === 'item' ? [s.info] : []));
    const pictures = sources.flatMap((s) => (s.kind === 'image' ? [s] : []));
    const queued = this.queue.length;
    if (!this.hasDesign) {
      if (items.length > 0) await this.openItems(items);
      // Reset meanwhile (see `openItems`): the pictures were for the queue it forgot.
      if (generation !== this.generation) return 0;
      for (const p of pictures) {
        if (this.hasDesign) this.engine.importImage(p.surface, p.name);
        else this.startFromSurface(p.surface, p.name);
      }
      if (pictures.length > 0) this.view = 'edit';
      return this.queue.length - queued;
    }
    const target = how === 'adopt' ? items.find((i) => this.canAdopt(i)) : undefined;
    if (target) this.adopt(this.queued(target) ?? this.pushEntry(target));
    // A project cannot be a layer: it joins the queue whatever the choice.
    const asLayer = (s: ImportSource) => how === 'layer' && (s.kind === 'image' || s.info.kind !== 'project');
    if (!sources.every(asLayer)) this.ensureQueued();
    // An adjustment still being tuned is kept (as when leaving its panel),
    // not thrown away by the new layer; pending tool work is committed by it.
    if (sources.some(asLayer)) this.keepPreview();
    let added = 0;
    for (const s of sources) {
      if (s.kind === 'item' && s.info === target) continue;
      if (asLayer(s)) {
        if (s.kind === 'image') this.engine.importImage(s.surface, s.name);
        else await this.addAsLayer(s.info);
      } else if (s.kind === 'image') {
        if (await this.queuePicture(s.name, s.surface)) added++;
      } else if (this.enqueue(s.info)) {
        added++;
      }
      // Reset meanwhile: the queue they joined is gone.
      if (generation !== this.generation) return 0;
    }
    this.view = 'edit';
    return added;
  }

  /** Appends a queue entry; returns it (the queue's reactive copy). */
  private pushEntry(info: ItemInfo, patch: Partial<QueueEntry> = {}): QueueEntry {
    this.queue.push({
      info,
      status: 'pending',
      project: null,
      recipe: null,
      thumb: info.icon,
      outcome: null,
      problem: null,
      unsaved: false,
      libraryId: null,
      libraryName: null,
      ...patch,
    });
    return this.queue[this.queue.length - 1]!;
  }

  /** The queue entry of an item, if it is queued. */
  private queued(info: ItemInfo): QueueEntry | undefined {
    return this.queue.find((q) => q.info.id === info.id || (info.path !== '' && q.info.path === info.path));
  }

  /** Queues an item unless it is queued already; returns the new entry. */
  private enqueue(info: ItemInfo): QueueEntry | null {
    return this.queued(info) ? null : this.pushEntry(info);
  }

  /**
   * The open design has no target yet and `info` can take it over: a
   * target not queued, or queued but not opened yet (no design of its own
   * would be lost).
   */
  canAdopt(info: ItemInfo): boolean {
    if (!this.hasDesign || this.hasTarget || !isTarget(info)) return false;
    const entry = this.queued(info);
    return !entry || (entry.status === 'pending' && entry.project === null);
  }

  /** A queue entry's item for a design with no file behind it (its `project` holds it). */
  private designItem(name: string): ItemInfo {
    this.designSerial += 1;
    return {
      id: `design-${this.designSerial}`,
      kind: 'project',
      name: name || 'Untitled',
      path: '',
      target: null,
      location: 'other',
      access: 'readOnly',
      modes: [],
      icon: null,
      iconSource: 'none',
      customIcon: false,
      reskinned: false,
      storeApp: false,
      systemIcon: null,
      notes: [],
    };
  }

  /** A standalone design gets a queue entry of its own (before anything else joins the queue). */
  private ensureQueued(): void {
    if (!this.hasDesign || this.current) return;
    const entry = this.pushEntry(this.standalone ?? this.designItem(this.engine.doc.meta.name), {
      status: 'editing',
      thumb: null,
      recipe: this.recipe,
      libraryId: this.libraryId,
      libraryName: this.libraryName,
    });
    this.currentIndex = this.queue.indexOf(entry);
    this.standalone = null;
    const thumb = this.engine.thumbnail(THUMB_SIZE);
    void this.deps.encode(thumb).then(
      (url) => (entry.thumb ??= url),
      (e: unknown) => console.warn('could not draw the queue thumbnail', e),
    );
  }

  /**
   * The open design has no target yet: `target`, queued and not opened,
   * takes it over — design, history and recipe. A queued design source
   * it came from gives its place in the queue to the target.
   */
  private adopt(target: QueueEntry): void {
    const holder = this.current;
    if (holder) {
      const at = this.queue.indexOf(target);
      this.queue.splice(at, 1);
      if (at < this.currentIndex) this.currentIndex -= 1;
      holder.info = target.info;
      holder.status = 'editing';
      holder.problem = null;
    } else {
      target.status = 'editing';
      this.currentIndex = this.queue.indexOf(target);
    }
    this.standalone = null;
    this.claimSource();
    // Its own icon is only for before/after; it may arrive a little later.
    const token = this.designToken;
    void this.loadIcon(target.info).then((icon) => {
      if (this.isOpenDesign(token)) this.original = icon;
    });
  }

  /** Queues a picture as a design of its own; false when `reset` forgot the queue meanwhile. */
  private async queuePicture(name: string, surface: Surface): Promise<boolean> {
    const generation = this.generation;
    const scratch = new Engine();
    try {
      scratch.newDocument({ name });
      const blank = scratch.doc.layers[0]!;
      if (scratch.importImage(surface, name)) scratch.deleteLayer(blank.id);
      const thumb = scratch.thumbnail(THUMB_SIZE);
      const project = await this.encodeProject(scratch.doc);
      const url = await this.deps.encode(thumb);
      if (generation !== this.generation) return false;
      this.pushEntry(this.designItem(name), { project, thumb: url });
      return true;
    } finally {
      scratch.dispose();
    }
  }

  /**
   * Switches to queue entry `index`, keeping the current design. Calls are
   * serialised: a switch requested while another is loading runs after it.
   */
  select(index: number): Promise<void> {
    const generation = this.generation;
    this.switching += 1;
    const run = this.switchChain.then(() => this.selectNow(index, generation));
    this.switchChain = run.catch(() => {});
    return run.finally(() => {
      this.switching -= 1;
    });
  }

  /**
   * The user picked an item (the queue strip, the title bar's queue menu):
   * ignored — false — while a job runs or another item is still loading.
   */
  async switchTo(index: number): Promise<boolean> {
    if (this.queueLocked || index === this.currentIndex || !this.queue[index]) return false;
    await this.select(index);
    return true;
  }

  /** Switches to entry `index` of the queue of `generation` (none, once `reset` forgot it). */
  private async selectNow(index: number, generation: number): Promise<void> {
    if (generation !== this.generation || index === this.currentIndex || !this.queue[index]) return;
    await this.replaceDesign(async () => {
      await this.stashCurrent();
      if (generation !== this.generation) return;
      const previous = { index: this.currentIndex, original: this.original, draftWritten: this.draftWritten };
      // Put away: a draft of it the autosave holds is a queued design's now.
      this.draftWritten = false;
      const entry = this.queue[index]!;
      const status = entry.status;
      this.currentIndex = index;
      if (status === 'pending') entry.status = 'editing';
      try {
        await this.loadEntry(entry, generation);
      } catch (e) {
        // Its queue is gone: nothing to put back, nobody to tell.
        if (generation !== this.generation) return;
        // Nothing replaced the design in the engine: it stays the open one.
        this.currentIndex = previous.index;
        this.original = previous.original;
        this.draftWritten = previous.draftWritten;
        entry.status = status;
        throw e;
      }
    });
  }

  /**
   * Puts a queue entry's design in the engine. Everything is read first:
   * the engine and `original` change only once it is all in, and not at
   * all when `reset` forgot the queue of `generation` meanwhile.
   */
  private async loadEntry(entry: QueueEntry, generation: number): Promise<void> {
    const { info } = entry;
    const original = info.kind === 'project' ? null : await this.loadIcon(info);
    const json = entry.project ?? (info.kind === 'project' ? await this.deps.commands.readProject(info.id) : null);
    const doc = json === null ? null : await deserializeProject(json);
    const icon = doc === null && original ? await this.fitted(original, MASTER_SIZE) : null;
    if (generation !== this.generation) return;
    this.original = original;
    if (doc) {
      this.engine.loadDocument(doc);
    } else {
      designFromIcon(this.engine, info, icon);
      this.engine.clearHistory();
    }
    const library = entry.libraryId !== null && entry.libraryName !== null ? { id: entry.libraryId, name: entry.libraryName } : null;
    // Its Library design may have been renamed while it waited.
    if (library) this.engine.setDocumentName(library.name);
    this.loaded({ recipe: entry.recipe, library, unsaved: entry.unsaved });
  }

  /**
   * Removes a queued item, with its design; refused — false — while a job
   * runs or an item is loading. Unsaved changes it had are not offered for
   * recovery any more.
   */
  async remove(index: number): Promise<boolean> {
    if (this.queueLocked || !this.queue[index]) return false;
    const generation = this.generation;
    const wasCurrent = index === this.currentIndex;
    // With its unsaved changes, or (the open one) a draft written before they were undone.
    const dropped = wasCurrent ? this.unsaved || this.draftWritten : this.queue[index]!.unsaved;
    this.queue.splice(index, 1);
    if (index < this.currentIndex) this.currentIndex -= 1;
    if (wasCurrent) {
      this.currentIndex = -1;
      if (this.queue.length > 0) {
        await this.select(Math.min(index, this.queue.length - 1));
      } else {
        this.designToken += 1;
        this.hasDesign = false;
        this.original = null;
        this.startRecipe(null);
        this.libraryId = null;
        this.libraryName = null;
      }
    }
    // Its draft may be the one the autosave holds.
    if (dropped && generation === this.generation) await this.settleAutosave();
    return true;
  }

  /**
   * A blank design (Start view "New icon"), with nothing to compare it to.
   * The current item keeps its target.
   */
  newBlank(): void {
    this.designToken += 1;
    this.original = null;
    this.engine.newDocument({ name: 'Untitled' });
    this.engine.clearHistory();
    this.claimSource();
    this.loaded();
  }

  /** A standalone design of a picture (a paste with nothing open). */
  private startFromSurface(surface: Surface, name: string): void {
    this.designToken += 1;
    this.original = null;
    this.engine.newDocument({ name });
    const blank = this.engine.doc.layers[0];
    if (this.engine.importImage(surface, name) && blank) this.engine.deleteLayer(blank.id);
    this.engine.clearHistory();
    this.loaded();
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

  /**
   * Keeps the current item's design (with its recipe, Library link and
   * unsaved state) in its queue entry. Unsaved changes the autosave has
   * not written yet go to it now, before another design is edited.
   * Rejects when the design could not be kept: the switch must not go on.
   */
  private async stashCurrent(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    // An adjustment still being previewed is kept, as when leaving its panel.
    this.keepPreview();
    entry.recipe = this.recipe;
    entry.libraryId = this.libraryId;
    entry.libraryName = this.libraryName;
    entry.unsaved = this.unsaved;
    const autosave = entry.unsaved && this.autosaver.pending;
    if (autosave) this.draftWritten = true;
    // Both take the design as it is now, before anything is awaited.
    const thumb = this.deps.encode(this.engine.thumbnail(THUMB_SIZE)).then(
      (url) => (entry.thumb = url),
      (e: unknown) => console.warn('could not draw the queue thumbnail', e),
    );
    const project = await this.encodeProject();
    entry.project = project;
    await thumb;
    if (autosave) await this.autosaver.write(project).catch((e: unknown) => console.warn('autosave failed', e));
    // Undone back to where it was loaded since its draft was written: the draft goes.
    else if (!entry.unsaved && this.draftWritten) await this.settleAutosave();
  }

  /**
   * `surface` fitted and centred into a `size` px document, in the panels
   * worker: the engine's import only copies a picture of the document's
   * size, so opening an item never resamples on the main thread (a 256 px
   * icon takes a 512 px one's worth of float maths; docs/ARCHITECTURE.md,
   * "Performance"). Should the worker fail, the surface comes back as it
   * is and the engine fits it.
   */
  async fitted(surface: Surface, size: number): Promise<Surface> {
    if (surface.width === size && surface.height === size) return surface;
    try {
      const { width, height, data } = await this.panels.request(
        { op: 'fit', pixels: { width: surface.width, height: surface.height, data: surface.data }, size },
        { priority: 'high' },
      );
      return Surface.fromRgba(width, height, data);
    } catch (e) {
      if (isCancelled(e)) throw e;
      console.warn('fitting the picture in the panels worker failed; the engine fits it', e);
      return surface;
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

  /**
   * A standalone design from an image or a project file (nothing was
   * open). Everything is read first; the design does not open when `reset`
   * forgot the queue meanwhile.
   */
  private async startFromSource(info: ItemInfo): Promise<void> {
    const generation = this.generation;
    if (info.kind === 'project') {
      const doc = await deserializeProject(await this.deps.commands.readProject(info.id));
      if (generation !== this.generation) return;
      await this.replaceDesign(async () => {
        this.engine.loadDocument(doc);
        this.original = null;
        this.loaded({ standalone: info });
      });
      return;
    }
    const icon = await this.loadIcon(info);
    const fitted = icon && (await this.fitted(icon, MASTER_SIZE));
    if (generation !== this.generation) return;
    await this.replaceDesign(async () => {
      this.original = icon;
      designFromIcon(this.engine, info, fitted);
      this.engine.clearHistory();
      this.loaded({ standalone: info });
    });
  }

  /**
   * Adds an item's icon (an image: the image) to the open design as a
   * layer. False when it could not be read, or another design opened
   * while it loaded.
   */
  async addAsLayer(info: ItemInfo): Promise<boolean> {
    const token = this.designToken;
    const icon = await this.loadIcon(info);
    const surface = icon && (await this.fitted(icon, this.engine.doc.width));
    if (!surface || !this.hasDesign || !this.isOpenDesign(token)) return false;
    return this.engine.importImage(surface, info.name) !== null;
  }

  // --- apply -------------------------------------------------------------------

  /** Renders every configured ICO size through the export pipeline. */
  renderIcon(): Promise<SizedPng[]> {
    return this.engine.exportPngs(settings().icoSizes);
  }

  /**
   * Save & Apply for the current item, in `mode` (default: its preferred
   * one). While other queued items still wait, the editor stays open: the
   * item is marked applied, a toast offers Undo and the next waiting item
   * opens. Only the last one plays the flourish, where Rust collapses the
   * editor and flies the box — so the promise can resolve after the
   * editor is hidden.
   */
  async apply(opts: { mode?: ApplyMode; flourish?: boolean } = {}): Promise<ApplyOutcome | null> {
    const entry = this.current;
    if (!entry || this.queueLocked) return null;
    const mode = opts.mode ?? preferredMode(entry.info);
    if (!mode) return null;
    this.busy = { label: 'Applying', progress: null };
    entry.status = 'applying';
    try {
      const saved = this.savePoint();
      const images = await this.renderIcon();
      const job: ApplyJob = {
        mode,
        images,
        designName: this.engine.doc.meta.name || entry.info.name,
        flourish: opts.flourish ?? settings().flourish,
        saved,
      };
      const outcome = await this.send(entry, job);
      await this.settle(entry, outcome, job);
      return outcome;
    } catch (e) {
      this.applyFailed(entry, e);
      return null;
    } finally {
      this.busy = null;
      await this.applySettled();
    }
  }

  /**
   * An apply is settled — its outcome handled, the autosave following it.
   * When its flourish closed the editor, Rust hears so: in low-memory mode
   * it destroys the editor only now, as the autosave written as the
   * collapse started still held the design being applied.
   */
  private async applySettled(): Promise<void> {
    if (this.interactive) return;
    await this.deps.commands.editorClose('applied').catch((e: unknown) => console.warn('editor_close failed', e));
  }

  /**
   * Every queued target but `entry` is applied: its apply may end the
   * session with the flourish. Design sources (entries without a target)
   * wait for nothing: they do not keep the editor open.
   */
  private lastToApply(entry: QueueEntry): boolean {
    return this.queue.every((q) => q === entry || q.status === 'applied' || !isTarget(q.info));
  }

  private send(entry: QueueEntry, job: ApplyJob): Promise<ApplyOutcome> {
    entry.status = 'applying';
    entry.problem = null;
    return this.deps.commands.applyIcon({
      item: entry.info.id,
      images: job.images,
      designName: job.designName,
      mode: job.mode,
      flourish: job.flourish && this.lastToApply(entry),
      updatePins: settings().updatePins,
    });
  }

  /** Settles one item's Save & Apply (not a batch's). */
  private async settle(entry: QueueEntry, outcome: ApplyOutcome, job: ApplyJob): Promise<void> {
    entry.outcome = outcome;
    switch (outcome.type) {
      case 'applied': {
        const change = this.markApplied(entry, outcome, job);
        play('success');
        // After the flourish the editor is gone: the box offers Undo instead.
        if (this.interactive) this.report(`Applied to ${change.before.name}.`, 'success', [change]);
        await this.settleAutosave();
        await this.advance(entry).catch((e: unknown) => {
          toast({ message: `Could not open the next icon: ${errorText(e)}`, kind: 'error' });
        });
        break;
      }
      case 'needsElevation':
        entry.status = 'editing';
        this.elevation = {
          requests: [{ ...job, entry, ticket: outcome.ticket, reason: outcome.reason }],
          batch: false,
          applied: [],
          failed: 0,
        };
        break;
      case 'unsupported':
        entry.status = 'editing';
        entry.problem = outcome.reason;
        toast({ message: outcome.reason, kind: 'error' });
        play('error');
        break;
      case 'failed':
        entry.status = 'failed';
        entry.problem = failureText(outcome);
        toast({ message: entry.problem, kind: 'error' });
        play('error');
        break;
      case 'cancelled':
        entry.status = 'editing';
        break;
    }
  }

  private applyFailed(entry: QueueEntry, e: unknown): void {
    entry.status = 'failed';
    entry.problem = errorText(e);
    toast({ message: `Could not apply: ${errorText(e)}`, kind: 'error' });
    play('error');
  }

  /**
   * Marks `entry` applied; returns what undoing it takes: its main journal
   * entry, which Rust undoes together with the pins applied with it (the
   * outcome's other entries).
   */
  private markApplied(entry: QueueEntry, outcome: Extract<ApplyOutcome, { type: 'applied' }>, job: ApplyJob): AppliedChange {
    const before = entry.info;
    entry.outcome = outcome;
    entry.status = 'applied';
    entry.problem = null;
    entry.info = { ...before, reskinned: true, customIcon: true };
    entry.unsaved = false;
    if (job.saved) this.markSaved(job.saved);
    return { entry, before, historyId: outcome.entries[0]?.id ?? null };
  }

  /** A batch item that was not applied, and why. */
  private markProblem(entry: QueueEntry, outcome: Exclude<ApplyOutcome, { type: 'applied' }>): void {
    entry.outcome = outcome;
    entry.status = 'failed';
    switch (outcome.type) {
      case 'failed':
        entry.problem = failureText(outcome);
        break;
      case 'unsupported':
        entry.problem = outcome.reason;
        break;
      case 'needsElevation':
        entry.problem = NEEDS_ADMIN;
        break;
      case 'cancelled':
        entry.problem = 'Administrator approval was declined';
        break;
    }
  }

  /**
   * Reports applied changes. While the editor stays open, the toast offers
   * Undo for 6 s.
   */
  private report(message: string, kind: ToastKind, changes: AppliedChange[]): void {
    const undo = this.interactive && changes.length > 0;
    toast(
      undo
        ? { message, kind, timeout: UNDO_MS, action: { label: 'Undo', run: () => this.undoApplied(changes) } }
        : { message, kind },
    );
  }

  /**
   * Takes applied changes back (the toast's Undo): their items can be
   * applied again. Every change is tried; the ones that could not be undone
   * are reported together at the end.
   */
  private async undoApplied(changes: AppliedChange[]): Promise<void> {
    const failed: string[] = [];
    let needsAdmin = 0;
    let reopened = false;
    for (const { entry, before, historyId } of changes) {
      let undone = true;
      if (historyId !== null) {
        try {
          const report = await this.deps.commands.restore({ type: 'entry', id: historyId });
          failed.push(...report.failed);
          needsAdmin += report.needsElevation;
          undone = report.failed.length === 0 && report.needsElevation === 0;
        } catch (e) {
          failed.push(`${before.name} — ${errorText(e)}`);
          undone = false;
        }
      }
      if (!undone || entry.status !== 'applied') continue;
      entry.status = 'editing';
      entry.info = before;
      entry.outcome = null;
      // Its design is on the desktop no more: unsaved work again.
      if (entry === this.current) this.baseUnsaved = true;
      else entry.unsaved = true;
      reopened = true;
    }
    if (reopened) await this.settleAutosave();
    if (failed.length > 0 || needsAdmin > 0) {
      const why = [...failed.slice(0, 2), ...(needsAdmin > 0 ? [`${plural(needsAdmin, 'icon')} need administrator rights`] : [])];
      throw new Error(`Could not undo everything: ${why.join('; ')}`);
    }
    toast({
      message: changes.length === 1 ? `Undid the change to ${changes[0]!.before.name}.` : `Undid ${plural(changes.length, 'change')}.`,
      kind: 'success',
    });
  }

  /** After a Save & Apply with targets still waiting: on to the next one not applied yet. */
  private async advance(from: QueueEntry): Promise<void> {
    const at = this.queue.indexOf(from);
    if (at < 0 || at !== this.currentIndex) return;
    for (let k = 1; k < this.queue.length; k++) {
      const next = (at + k) % this.queue.length;
      const entry = this.queue[next]!;
      if (entry.status !== 'applied' && isTarget(entry.info)) {
        await this.select(next);
        return;
      }
    }
  }

  /**
   * The user agreed to the UAC path: each waiting apply runs through the
   * elevated helper in turn (Windows asks for each one). Declining one
   * stops the rest.
   */
  approveElevation(): Promise<void> {
    return this.runElevation('approve');
  }

  /** Instead of elevating: personal copies on the user's desktop, for the items that allow one. */
  personalCopy(): Promise<void> {
    return this.runElevation('copy');
  }

  /**
   * Cancel in the elevation dialog: the items waiting stay as they are; an
   * "Apply style to all" reports what it applied. Nothing to report once
   * the dialog was answered or dismissed.
   */
  cancelElevation(): void {
    const pending = this.elevation;
    this.elevation = null;
    if (pending?.batch) this.reportBatch(pending, pending.applied);
  }

  /** Closes the elevation dialog without a word (the editor is closing). */
  dismissElevation(): void {
    this.elevation = null;
  }

  private async runElevation(how: 'approve' | 'copy'): Promise<void> {
    const pending = this.elevation;
    if (!pending || this.busy) return;
    this.elevation = null;
    const requests =
      how === 'copy' ? pending.requests.filter((r) => r.entry.info.modes.includes('personalCopy')) : pending.requests;
    if (requests.length === 0) {
      if (pending.batch) this.reportBatch(pending, pending.applied);
      return;
    }
    const label = how === 'approve' ? 'Waiting for approval' : 'Making a personal copy';
    const run = (req: ElevationRequest, job: ApplyJob): Promise<ApplyOutcome> => {
      if (how === 'copy') return this.send(req.entry, job);
      req.entry.status = 'applying';
      return this.deps.commands.applyIconElevated(req.ticket);
    };
    const jobOf = (req: ElevationRequest): ApplyJob => (how === 'copy' ? { ...req, mode: 'personalCopy' } : req);
    try {
      if (!pending.batch) {
        const req = requests[0]!;
        const job = jobOf(req);
        this.busy = { label, progress: null };
        try {
          await this.settle(req.entry, await run(req, job), job);
        } catch (e) {
          this.applyFailed(req.entry, e);
        }
        return;
      }
      const changes = [...pending.applied];
      for (const [n, req] of requests.entries()) {
        this.busy = { label: `${label} (${n + 1} of ${requests.length})`, progress: n / requests.length };
        const job = jobOf(req);
        let outcome: ApplyOutcome;
        try {
          outcome = await run(req, job);
        } catch (e) {
          req.entry.status = 'failed';
          req.entry.problem = errorText(e);
          continue;
        }
        if (outcome.type === 'applied') {
          changes.push(this.markApplied(req.entry, outcome, job));
          continue;
        }
        this.markProblem(req.entry, outcome);
        // Declined in Windows' prompt: the others are not asked about.
        if (outcome.type === 'cancelled') break;
      }
      if (changes.length > pending.applied.length) await this.settleAutosave();
      this.reportBatch(pending, changes);
    } finally {
      this.busy = null;
      await this.applySettled();
    }
  }

  /**
   * The one summary of an "Apply style to all" that asked for approval,
   * once the dialog is answered: `changes` is everything the batch
   * applied, taken back together by the toast's Undo.
   */
  private reportBatch(pending: PendingElevation, changes: AppliedChange[]): void {
    const total = pending.applied.length + pending.failed + pending.requests.length;
    const n = changes.length;
    if (n === total) this.report(`Applied to ${plural(n, 'more icon')}.`, 'success', changes);
    else this.report(`Applied to ${n} of ${plural(total, 'icon')}.`, n > 0 ? 'warning' : 'error', changes);
  }

  /**
   * "Apply style to all": replays the current item's recipe on every other
   * queued icon not applied yet — each on its own icon — and applies it
   * (no flourish). The current item and its design, undo history
   * included, stay as they are; each styled item keeps the recipe as its
   * own. Items that need administrator approval are asked about together
   * at the end (the elevation dialog), with personal copies as the
   * alternative; the batch's summary then waits for the answer.
   */
  async applyStyleToAll(): Promise<{ applied: number; failed: number; needsElevation: number }> {
    const result = { applied: 0, failed: 0, needsElevation: 0 };
    if (this.queueLocked) return result;
    const others = this.styleTargets;
    if (others.length === 0) return result;
    // An adjustment still being tuned is part of the design, so of its recipe.
    this.keepPreview();
    const recipe = this.recipe;
    if (!recipe) return result;
    const changes: AppliedChange[] = [];
    const waiting: ElevationRequest[] = [];
    const scratch = new Engine();
    try {
      for (const [n, entry] of others.entries()) {
        this.busy = { label: `Applying ${n + 1} of ${others.length}`, progress: n / others.length };
        entry.status = 'applying';
        entry.problem = null;
        try {
          const icon = await this.loadIcon(entry.info);
          const layer = designFromIcon(scratch, entry.info, icon && (await this.fitted(icon, MASTER_SIZE)));
          await recipe.apply(scratch, layer);
          // The item's design is kept with it whatever the outcome: made
          // before the apply, so a failure here never hides an applied icon.
          const [images, project, thumb] = await Promise.all([
            scratch.exportPngs(settings().icoSizes),
            this.encodeProject(scratch.doc),
            this.deps.encode(scratch.thumbnail(THUMB_SIZE)),
          ]);
          const job: ApplyJob = { mode: preferredMode(entry.info)!, images, designName: recipe.label, flourish: false };
          const outcome = await this.send(entry, job);
          entry.project = project;
          entry.recipe = recipe;
          entry.libraryId = null;
          entry.libraryName = null;
          entry.thumb = thumb;
          if (outcome.type === 'applied') {
            changes.push(this.markApplied(entry, outcome, job));
            result.applied++;
            continue;
          }
          this.markProblem(entry, outcome);
          if (outcome.type === 'needsElevation') {
            waiting.push({ ...job, entry, ticket: outcome.ticket, reason: outcome.reason });
            result.needsElevation++;
          } else {
            result.failed++;
          }
        } catch (e) {
          entry.status = 'failed';
          entry.problem = errorText(e);
          result.failed++;
          console.warn('batch apply failed', e);
        }
      }
    } finally {
      scratch.dispose();
      this.busy = null;
    }
    // Applied designs are safe now: the autosave keeps what is still unsaved.
    if (result.applied > 0) await this.settleAutosave();
    if (waiting.length > 0) {
      // Reported as a whole once the dialog is answered (see `reportBatch`).
      this.elevation = { requests: waiting, batch: true, applied: changes, failed: result.failed };
    } else if (result.failed === 0) {
      this.report(`Applied "${recipe.label}" to ${plural(result.applied, 'more icon')}.`, 'success', changes);
    } else {
      this.report(`Applied to ${result.applied}; ${result.failed} failed.`, 'error', changes);
    }
    return result;
  }

  // --- library, export, clipboard ------------------------------------------------

  /**
   * Saves the open design to the Library — over the Library design it came
   * from or was saved as before (keeping its name unless `name` renames
   * it), or as a new one with `asNew`. The toast says which.
   */
  async saveToLibrary(name?: string, opts: { asNew?: boolean } = {}): Promise<LibraryEntry | null> {
    const saved = this.savePoint();
    const over = opts.asNew || this.libraryId === null ? null : { id: this.libraryId, name: this.libraryName };
    try {
      // Both take the design as it is now, before anything is awaited.
      const [thumb, data] = await Promise.all([this.deps.encode(this.engine.thumbnail(128)), this.encodeProject()]);
      const entry = await this.deps.commands.librarySave({
        id: over?.id ?? null,
        name: name ?? (over?.name || this.engine.doc.meta.name || 'Untitled'),
        thumb: stripDataUrl(thumb),
        data,
      });
      if (saved.token === this.designToken) {
        this.libraryId = entry.id;
        this.markSaved(saved);
      }
      // The design goes by its Library name from now on, and so does every
      // other design linked to it.
      this.libraryDesignRenamed(entry.id, entry.name);
      if (saved.token === this.designToken) await this.settleAutosave();
      toast({ message: savedText(entry.name, over?.name ?? null), kind: 'success' });
      return entry;
    } catch (e) {
      toast({ message: `Could not save: ${errorText(e)}`, kind: 'error' });
      return null;
    }
  }

  /**
   * Opens a Library design in place of the open one (named after its
   * entry). The current item keeps its target; saving updates that
   * Library design. False when it was not opened: the editor closed and
   * opened again while it loaded.
   */
  async openLibraryDesign(id: string, name?: string): Promise<boolean> {
    const generation = this.generation;
    const doc = await deserializeProject(await this.deps.commands.libraryLoad(id));
    // The editor closed and opened again meanwhile: not for the next open.
    if (generation !== this.generation) return false;
    await this.replaceDesign(async () => {
      this.engine.loadDocument(doc);
      if (name) this.engine.setDocumentName(name);
      if (!this.hasTarget) this.original = null;
      this.claimSource();
      this.loaded({ library: { id, name: this.engine.doc.meta.name } });
    });
    this.view = 'edit';
    return true;
  }

  /** A Library design was deleted: saving no longer updates it. */
  forgetLibraryDesign(id: string): void {
    if (this.libraryId === id) {
      this.libraryId = null;
      this.libraryName = null;
    }
    for (const q of this.queue) {
      if (q.libraryId !== id) continue;
      q.libraryId = null;
      q.libraryName = null;
    }
  }

  /** A Library design was renamed: the designs linked to it go by the new name. */
  libraryDesignRenamed(id: string, name: string): void {
    if (this.libraryId === id) {
      this.libraryName = name;
      if (this.hasDesign) this.engine.setDocumentName(name);
    }
    for (const q of this.queue) if (q.libraryId === id) q.libraryName = name;
  }

  async exportAs(kind: ExportKind): Promise<string | null> {
    const name = this.engine.doc.meta.name || this.item?.name || 'icon';
    try {
      const saved = kind === 'project' ? this.savePoint() : null;
      const images =
        kind === 'ico'
          ? await this.renderIcon()
          : kind === 'png'
            ? (await this.engine.exportPngs([256])).slice(-1)
            : [];
      const data = kind === 'project' ? await this.encodeProject() : null;
      const path = await this.deps.commands.exportFile({ kind, suggestedName: name, images, data });
      if (path) toast({ message: `Exported to ${path}`, kind: 'success' });
      // A project file keeps the whole design: nothing is unsaved any more.
      if (path && saved && saved.token === this.designToken) {
        this.markSaved(saved);
        await this.settleAutosave();
      }
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
  //
  // The live autosave holds the latest unsaved design. Changes are written
  // 2 s after the last edit (at least every 10 s while editing goes on),
  // before another design is opened and when the editor closes; a design
  // without unsaved changes is never written. Once the open design is
  // safe (applied, saved to the Library, exported as a project), clean
  // again (its changes undone) or gone with its changes (removed from the
  // queue, a new blank or Library design in its place), the slot takes
  // another queued design with unsaved changes, or empties.

  /**
   * What the scheduled autosave writes: the open design while it has
   * unsaved changes; once they are gone again after its draft was written,
   * whatever else is unsaved (see `otherDraft`), so a later launch never
   * offers a design the user reverted; otherwise nothing.
   */
  private produceAutosave(): Promise<string> | string | null {
    if (this.unsaved) {
      this.draftWritten = true;
      // Serialized off the main thread.
      return this.encodeProject();
    }
    return this.draftWritten ? this.otherDraft() : null;
  }

  /** The slot's content once the open design leaves it: another queued design's unsaved changes, or none (''). */
  private otherDraft(): string {
    this.draftWritten = false;
    return this.queue.find((q) => q !== this.current && q.unsaved && q.project !== null)?.project ?? '';
  }

  /**
   * Writes the open design's unsaved changes now (nothing when there are
   * none), as they are at this moment: whatever comes next — another design
   * opening, `reset` at the next open — cannot take them back. Resolves once
   * every save so far is done; never rejects (a failure is logged).
   */
  flushAutosave(): Promise<void> {
    if (!this.autosaver.pending || !this.unsaved) return this.autosaver.flush();
    this.draftWritten = true;
    return this.autosaver.write(this.encodeProject()).catch((e: unknown) => console.warn('autosave failed', e));
  }

  /** The live autosave follows what is unsaved now (see above). */
  private async settleAutosave(): Promise<void> {
    if (this.unsaved) {
      this.autosaver.schedule();
      return;
    }
    await this.autosaver.write(this.otherDraft()).catch((e: unknown) => console.warn('autosave failed', e));
  }

  /** A design left over from a crash / an earlier launch, if any. */
  async recoverable(): Promise<string | null> {
    try {
      const draft = await this.deps.commands.autosaveLoad();
      return draft?.trim() ? draft : null;
    } catch {
      return null;
    }
  }

  /**
   * Opens a recovered design with its unsaved changes. The item it was
   * made for joins the queue again when it still exists; anything open
   * stays in the queue too. From now on it autosaves as this session's
   * own work, and the recovery offer is answered.
   */
  async restoreAutosave(json: string): Promise<void> {
    const generation = this.generation;
    const project = migrateProject(json);
    const target = await this.findTarget(project.meta.source);
    // The editor closed and opened again meanwhile: the offer stays for later.
    if (generation !== this.generation) return;
    if (target || this.hasDesign) {
      this.ensureQueued();
      const entry = (target && this.enqueue(target)) || this.pushEntry(this.designItem(project.meta.name));
      entry.project = json;
      entry.unsaved = true;
      await this.select(this.queue.indexOf(entry));
    } else {
      const doc = await deserializeProject(json);
      if (generation !== this.generation) return;
      await this.replaceDesign(async () => {
        this.engine.loadDocument(doc);
        this.original = null;
        this.loaded({ unsaved: true });
      });
    }
    if (generation !== this.generation) return;
    this.view = 'edit';
    this.autosaver.cancel();
    await this.autosaver.enqueue(() => this.deps.commands.autosave(null));
    await this.autosaver.write(json);
  }

  /** The item a recovered design was made for, when it still exists and takes an icon. */
  private async findTarget(source: SourceInfo | null): Promise<ItemInfo | null> {
    if (!source?.path) return null;
    try {
      const found =
        source.kind === 'systemIcon'
          ? await this.findSystemIcon(source)
          : ((await this.deps.commands.inspectPaths([source.path]))[0] ?? null);
      return found && isTarget(found) ? found : null;
    } catch (e) {
      console.warn('could not look for the design’s icon', e);
      return null;
    }
  }

  private async findSystemIcon(source: SourceInfo): Promise<ItemInfo | null> {
    for (const id of SYSTEM_ICONS) {
      const info = await this.deps.commands.inspectSystemIcon(id).catch(() => null);
      if (info && info.path === source.path && info.name === source.name) return info;
    }
    return null;
  }

  /** Forgets every unsaved design left for recovery (rejects when it can't be removed). */
  async discardAutosave(): Promise<void> {
    this.autosaver.cancel();
    await this.autosaver.enqueue(() => this.deps.commands.autosave(null));
    if (this.unsaved) this.autosaver.schedule();
  }

  // --- navigation --------------------------------------------------------------

  navigate(view: EditorView): void {
    this.view = view;
  }

  /** Close button / Esc: Rust runs the collapse handoff. */
  async requestClose(): Promise<void> {
    await this.flushAutosave();
    await this.deps.commands.editorClose('user');
  }

  /**
   * Forgets the queue (after the editor closed). Items still loading for
   * it are dropped as they come in (see `generation`); a draft written
   * before stays in the autosave.
   */
  reset(): void {
    this.generation += 1;
    this.autosaver.cancel();
    this.draftWritten = false;
    this.designToken += 1;
    this.queue = [];
    this.currentIndex = -1;
    this.elevation = null;
    this.busy = null;
    this.original = null;
    this.startRecipe(null);
    this.previewRecipe = null;
    this.libraryId = null;
    this.libraryName = null;
    this.standalone = null;
    this.baseUnsaved = false;
    this.cleanEntry = null;
    this.compare = 'off';
    this.hasDesign = false;
  }

  /** Ends the session: timers, engine listeners and the workers go away. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.autosaver.dispose();
    this.unsubscribe();
    this.filterClient?.dispose();
    this.panelsClient?.dispose();
    this.encoderClient?.dispose();
    this.engine.dispose();
  }
}

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** What a Library save did: a new design, or an update (renaming it or not) of `over`. */
function savedText(name: string, over: string | null): string {
  if (over === null) return `Saved "${name}" to the Library.`;
  return over === name ? `Updated "${name}" in the Library.` : `Updated "${over}" in the Library, now named "${name}".`;
}

function stripDataUrl(s: string): string {
  const i = s.indexOf(';base64,');
  return i >= 0 ? s.slice(i + 8) : s;
}

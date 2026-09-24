/**
 * e2e-only fake Tauri backend. The e2e build (`vite build --mode e2e`) calls
 * `install('box' | 'editor')` first thing in each page entry; production
 * builds drop it. It implements every command in `COMMAND_NAMES` with
 * stateful, plausible behaviour and exposes a control surface for tests as
 * `window.__e2e` (typed in ./e2e-api.ts).
 *
 * Start-up configuration: set `window.__E2E_CONFIG__` (see `E2EConfig`)
 * before the page loads, e.g. with Playwright's `page.addInitScript`.
 *
 * Commands (what the fake does)
 * - app_boot: BootInfo for this page from the fake settings/config.
 * - box_drag: waits `boxDragMs`, resolves `boxDragResult` ('click').
 * - inspect_paths: after `inspectDelayMs`, maps every path to an ItemInfo:
 *   kind by extension (.lnk shortcut, .url internetShortcut, .exe executable,
 *   images, .reskin project, trailing slash/no extension folder, else file),
 *   location/access from the folder (…\Users\Public\Desktop\ needs
 *   elevation), a generated 256 px icon, ids stable per path. Paths
 *   containing "::unreadable" are left out. `setInspectOverride(fn)`
 *   replaces the mapping (e.g. `() => []` for the error path).
 * - inspect_system_icon / item_frames / pick_files / read_project: sample
 *   system items, rescaled frames (16…256), `setPickFiles`, `setProject`.
 * - open_editor: validates that every id was inspected (else rejects).
 * - apply_icon: returns `setApplyOutcome(o)` verbatim when set; otherwise
 *   journals a HistoryEntry and returns `{type:'applied', landed:true}`. In
 *   the editor, a flourish apply while the editor is open first runs the
 *   close handoff with then = fly (landed) / celebrate, as Rust does (turn
 *   off with `setApplyCollapses(false)`). NeedsElevation tickets are
 *   accepted by apply_icon_elevated.
 * - restore / history_list / library_* / autosave*: in-memory state.
 * - export_file: `setExportPath` (null = cancelled) or an automatic path.
 * - wallpaper: a generated 1920×1080 JPEG; wallpaper_info, system_fonts and
 *   accent_color return fixed plausible values.
 * - settings_get / settings_set: normalised like Rust; a change is
 *   announced like Rust does — `settings:changed` event on the box page,
 *   a `Settings` mailbox command on the editor page.
 * - editor_next: sequence-numbered long poll over the fake mailbox;
 *   resolves as soon as commands with seq > after are queued, else a
 *   heartbeat after `heartbeatMs` (25 s).
 * - editor_ack: recorded in `acks`; drives the handoff simulator.
 * - editor_close(reason): runs `simulateClose('hide')` when the editor is
 *   open (reason 'applied' is a no-op, the apply flow drives the close).
 * - everything else (box_menu, refresh_icons, open_external, set_box_visible,
 *   quit_app, smoke_ready): recorded, resolves null.
 * Errors reject with a plain string, like Tauri commands.
 *
 * `window.__e2e` (E2EApi)
 * - calls, callsOf(cmd), clearCalls(), waitForCall(cmd, match?, timeout?)
 * - emit(event, payload): delivers a Tauri event to this page's listeners,
 *   e.g. `emit('tauri://drag-enter', { paths, position: { x, y } })` — the
 *   position is PHYSICAL px, as Tauri sends it; `emitted`, listenerCount(e)
 * - pushEditorCmd(cmd), acks, waitForAck(session, stage, timeout?)
 * - simulateOpen(items | paths, view = 'edit', opts): Rust's open FSM —
 *   Prepare → wait 'prepared' (400 ms) → Reveal → wait 'revealed' →
 *   Expand{morph} → wait 'expanded'. A late 'prepared' takes Rust's
 *   fallback: Reveal and Expand{morph: false} (crossfade) back to back,
 *   without waiting for 'revealed'.
 * - simulateClose(then = 'hide', opts): Collapse → wait 'collapsed' →
 *   Clear → wait 'cleared'. `editor` shows the FSM phase.
 * - knobs: setApplyOutcome, setInspectOverride, setInspectDelay,
 *   setBoxDragResult, failNext(cmd, message), setExportPath, setPickFiles,
 *   setProject, setApplyCollapses, setHeartbeatMs
 * - state: settings, setSettings(patch), makeItems(paths), history,
 *   library, autosaveData, smokeReports, boxVisible
 */

import { emit as tauriEmit } from '@tauri-apps/api/event';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { COMMAND_NAMES, type CommandName } from '$lib/ipc/commands';
import type {
  AckStage,
  ApplyOutcome,
  ApplyRequest,
  BootInfo,
  CloseReason,
  CollapseThen,
  DragResult,
  EditorCmd,
  EditorView,
  Envelope,
  ExportRequest,
  HistoryEntry,
  IconFrame,
  ItemInfo,
  LibraryEntry,
  LibrarySave,
  PickPurpose,
  Rect,
  RestoreReport,
  RestoreTarget,
  Settings,
  SizedPng,
  SmokeReport,
  SystemIconId,
  TargetKind,
  WallpaperInfo,
} from '$lib/ipc/types';
import { defaultSettings, normalizeSettings } from '$lib/settings/defaults';
import { metricsFor } from '$lib/ui/box-geometry';
import type {
  E2EAck,
  E2EApi,
  E2ECall,
  E2EEditorState,
  E2EEmitted,
  SimulateCloseOptions,
  SimulateCloseResult,
  SimulateOpenOptions,
  SimulateOpenResult,
} from './e2e-api';
import { hueFor, scaledPngBase64, wallpaperBytes } from './fake-images';
import { makeItem, makeSystemItem, UNREADABLE_MARKER } from './fake-items';

export type { E2EApi, E2EConfig } from './e2e-api';

type Args = Record<string, unknown>;
type Handler = (args: Args) => unknown;

const DEFAULT_ACCENT = '#0078d4';
const PREPARE_TIMEOUT_MS = 400;
const ACK_TIMEOUT_MS = 3000;
const FRAME_SIZES = [16, 24, 32, 48, 64, 256];
const USER_DIR = 'C:\\Users\\e2e';
const ICON_DIR = `${USER_DIR}\\AppData\\Local\\com.karimeidou.reskin\\icons`;

const SYSTEM_FONTS = [
  'Arial',
  'Bahnschrift',
  'Calibri',
  'Cambria',
  'Candara',
  'Cascadia Code',
  'Cascadia Mono',
  'Comic Sans MS',
  'Consolas',
  'Constantia',
  'Corbel',
  'Courier New',
  'Ebrima',
  'Franklin Gothic Medium',
  'Gabriola',
  'Gadugi',
  'Georgia',
  'Impact',
  'Ink Free',
  'Leelawadee UI',
  'Lucida Console',
  'Lucida Sans Unicode',
  'Malgun Gothic',
  'Microsoft YaHei',
  'MV Boli',
  'Nirmala UI',
  'Palatino Linotype',
  'Segoe Fluent Icons',
  'Segoe Print',
  'Segoe Script',
  'Segoe UI',
  'Segoe UI Emoji',
  'Segoe UI Symbol',
  'Segoe UI Variable Display',
  'Segoe UI Variable Text',
  'Sitka Text',
  'Sylfaen',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'Yu Gothic UI',
];

/** Tauri command errors reach JS as plain strings. */
function fail(message: string): never {
  throw message;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // e.g. reactive proxies: fall back to a JSON copy.
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** 12 lowercase hex chars derived from `text` (stands in for sha256[..12]). */
function shortHash(text: string): string {
  const a = hueFor(text).toString(16);
  let h = 0x811c9dc5;
  for (let i = text.length - 1; i >= 0; i--) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(16).padStart(8, '0')}${a.padStart(4, '0')}`.slice(0, 12);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'icon'
  );
}

interface TauriInternals {
  invoke: (cmd: string, args?: Args, options?: unknown) => Promise<unknown>;
}

let installed: E2EApi | null = null;

export function install(kind: 'box' | 'editor'): E2EApi {
  if (installed) return installed;
  const config = window.__E2E_CONFIG__ ?? {};

  // ---- state ----------------------------------------------------------------
  let settings = normalizeSettings({ ...defaultSettings(), ...config.settings });
  const accent = config.accent === undefined ? DEFAULT_ACCENT : config.accent;
  let heartbeatMs = config.heartbeatMs ?? 25_000;
  let boxDragResult: DragResult = config.boxDragResult ?? 'click';
  let inspectDelayMs = config.inspectDelayMs ?? 40;
  let applyCollapses = config.applyCollapses ?? true;
  let applyOutcome: ApplyOutcome | null = null;
  let inspectOverride: ((paths: string[]) => ItemInfo[] | Promise<ItemInfo[]>) | null = null;
  let exportPath: string | null | undefined;
  let pickFiles: string[] = [];
  let autosaveData: string | null = null;
  let boxVisible = true;

  const calls: E2ECall[] = [];
  const emitted: E2EEmitted[] = [];
  const acks: E2EAck[] = [];
  const failures = new Map<string, string>();
  const itemsById = new Map<string, ItemInfo>();
  const idByPath = new Map<string, string>();
  const projects = new Map<string, string>();
  const history: HistoryEntry[] = [];
  const library = new Map<string, { entry: LibraryEntry; data: string }>();
  const tickets = new Map<string, ApplyRequest>();
  const smokeReports: SmokeReport[] = [];
  const listeners = new Map<string, number>();
  const listenerIds = new Map<number, string>();
  let nextItem = 1;
  let nextHistory = 1;
  let nextLibrary = 1;

  const callWaiters = new Set<() => void>();
  const ackWaiters = new Set<() => void>();

  // ---- mailbox ----------------------------------------------------------------
  let seq = 0;
  let queue: Envelope[] = [];
  const pollWaiters = new Set<() => void>();

  function pushEditorCmd(cmd: EditorCmd): number {
    seq += 1;
    queue.push({ seq, cmd: clone(cmd) });
    for (const wake of [...pollWaiters]) wake();
    return seq;
  }

  function editorNext(after: number): Promise<Envelope[]> {
    // Everything up to `after` has been received by the page.
    queue = queue.filter((e) => e.seq > after);
    const ready = () => queue.filter((e) => e.seq > after).map((e) => clone(e));
    const now = ready();
    if (now.length > 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const wake = () => {
        const r = ready();
        if (r.length === 0) return;
        clearTimeout(timer);
        pollWaiters.delete(wake);
        resolve(r);
      };
      const timer = setTimeout(() => {
        pollWaiters.delete(wake);
        seq += 1;
        resolve([{ seq, cmd: { type: 'heartbeat' } }]);
      }, heartbeatMs);
      pollWaiters.add(wake);
    });
  }

  function waitForAck(session: number, stage: AckStage, timeoutMs = ACK_TIMEOUT_MS): Promise<boolean> {
    const has = () => acks.some((a) => a.session === session && a.stage === stage);
    if (has()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => {
        if (!has()) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        ackWaiters.delete(check);
      };
      ackWaiters.add(check);
    });
  }

  // ---- handoff FSM (mirrors src-tauri windows/morph.rs) ---------------------
  const fsm: E2EEditorState = { session: 0, phase: 'closed', visible: false, morph: false };

  function defaultBoxRect(s: Settings): Rect {
    const m = metricsFor(s.boxSize);
    return { x: 32, y: 32, w: m.window, h: m.window };
  }

  async function simulateOpen(
    itemsOrPaths: ItemInfo[] | string[],
    view: EditorView = 'edit',
    opts: SimulateOpenOptions = {},
  ): Promise<SimulateOpenResult> {
    if (fsm.phase !== 'closed') throw new Error(`simulateOpen: editor is ${fsm.phase}`);
    const items =
      itemsOrPaths.length > 0 && typeof itemsOrPaths[0] === 'string'
        ? await makeItems(itemsOrPaths as string[])
        : (itemsOrPaths as ItemInfo[]);
    items.forEach(register);
    const snapshot = clone(opts.settings ?? settings);
    const wantMorph =
      opts.morph ??
      (snapshot.openStyle === 'morph' &&
        snapshot.motion !== 'reduced' &&
        !(snapshot.motion === 'system' && config.systemReducedMotion));
    const ackTimeout = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    const timedOut: AckStage[] = [];
    const session = ++fsm.session;

    fsm.phase = 'preparing';
    pushEditorCmd({
      type: 'prepare',
      session,
      boxRect: opts.boxRect ?? defaultBoxRect(snapshot),
      items,
      view,
      settings: snapshot,
      morph: wantMorph,
    });
    const preparedInTime = await waitForAck(session, 'prepared', opts.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS);
    if (!preparedInTime) timedOut.push('prepared');
    const morph = wantMorph && preparedInTime;

    fsm.phase = 'revealing';
    fsm.visible = true;
    pushEditorCmd({ type: 'reveal', session });
    // Like morph.rs: the swap waits for the proxy only when it was prepared
    // in time; the fallback hides the box and crossfades right away.
    if (preparedInTime && !(await waitForAck(session, 'revealed', ackTimeout))) timedOut.push('revealed');

    fsm.phase = 'expanding';
    boxVisible = false;
    pushEditorCmd({ type: 'expand', session, morph });
    if (!(await waitForAck(session, 'expanded', ackTimeout))) timedOut.push('expanded');

    fsm.phase = 'open';
    fsm.morph = morph;
    return { session, morph, preparedInTime, timedOut };
  }

  async function simulateClose(
    then: CollapseThen = 'hide',
    opts: SimulateCloseOptions = {},
  ): Promise<SimulateCloseResult> {
    if (fsm.phase !== 'open') throw new Error(`simulateClose: editor is ${fsm.phase}`);
    const session = fsm.session;
    const ackTimeout = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    const timedOut: AckStage[] = [];

    fsm.phase = 'collapsing';
    pushEditorCmd({
      type: 'collapse',
      session,
      boxRect: opts.boxRect ?? defaultBoxRect(settings),
      then,
      icon: opts.icon ?? null,
      morph: opts.morph ?? fsm.morph,
    });
    if (!(await waitForAck(session, 'collapsed', ackTimeout))) timedOut.push('collapsed');

    fsm.phase = 'clearing';
    boxVisible = true;
    pushEditorCmd({ type: 'clear', session });
    if (!(await waitForAck(session, 'cleared', ackTimeout))) timedOut.push('cleared');

    fsm.phase = 'closed';
    fsm.visible = false;
    return { session, timedOut };
  }

  // ---- items ------------------------------------------------------------------
  function register(item: ItemInfo): void {
    itemsById.set(item.id, item);
    idByPath.set(item.path, item.id);
  }

  function hasApplied(path: string): boolean {
    return history.some((e) => e.target === path && e.state === 'applied');
  }

  async function inspectOne(path: string): Promise<ItemInfo | null> {
    if (path.includes(UNREADABLE_MARKER)) return null;
    const id = idByPath.get(path) ?? `item-${nextItem++}`;
    const item = await makeItem(path, { id, reskinned: hasApplied(path) });
    register(item);
    return item;
  }

  async function makeItems(paths: string[]): Promise<ItemInfo[]> {
    const items = await Promise.all(paths.map(inspectOne));
    return items.filter((i): i is ItemInfo => i !== null);
  }

  function itemOrFail(id: unknown): ItemInfo {
    const item = typeof id === 'string' ? itemsById.get(id) : undefined;
    return item ?? fail(`unknown item ${String(id)}`);
  }

  // ---- apply / history ------------------------------------------------------
  function targetKind(item: ItemInfo, req: ApplyRequest): TargetKind {
    if (req.mode !== 'inPlace') return 'createdShortcut';
    switch (item.kind) {
      case 'shortcut':
      case 'internetShortcut':
      case 'folder':
      case 'systemIcon':
        return item.kind;
      default:
        return 'createdShortcut';
    }
  }

  function largest(images: SizedPng[]): SizedPng {
    return images.reduce((a, b) => (b.size > a.size ? b : a));
  }

  async function journal(item: ItemInfo, req: ApplyRequest, elevated: boolean): Promise<HistoryEntry[]> {
    const kindOfTarget = targetKind(item, req);
    const target =
      kindOfTarget === 'createdShortcut'
        ? `${USER_DIR}\\Desktop\\${item.name}.lnk`
        : item.systemIcon
          ? slugify(item.name)
          : item.path;
    const previous = history.find((e) => e.target === target && e.state === 'applied');
    const big = largest(req.images);
    const entry: HistoryEntry = {
      id: `h-${nextHistory++}`,
      kind: kindOfTarget,
      target,
      name: item.name,
      systemIcon: item.systemIcon,
      iconPath: `${ICON_DIR}\\${slugify(req.designName ?? item.name)}-${shortHash(big.png)}.ico`,
      original: previous?.original ?? { location: null, index: 0, existed: false },
      state: 'applied',
      elevated,
      thumb: await scaledPngBase64(big.png, 48),
      designName: req.designName,
      appliedAt: Date.now(),
      restoredAt: null,
      supersedes: previous?.id ?? null,
    };
    if (previous) previous.state = 'superseded';
    history.push(entry);
    const updated = { ...item, customIcon: true, reskinned: true };
    register(updated);
    return [clone(entry)];
  }

  async function finishApply(req: ApplyRequest, outcome: ApplyOutcome): Promise<ApplyOutcome> {
    if (
      outcome.type === 'applied' &&
      req.flourish &&
      kind === 'editor' &&
      applyCollapses &&
      fsm.phase === 'open'
    ) {
      const icon = `data:image/png;base64,${largest(req.images).png}`;
      await simulateClose(outcome.landed ? 'fly' : 'celebrate', { icon });
    }
    return outcome;
  }

  // ---- settings ------------------------------------------------------------------
  async function announceSettings(): Promise<void> {
    if (kind === 'box') await emitEvent('settings:changed', clone(settings));
    else pushEditorCmd({ type: 'settings', settings: clone(settings) });
  }

  async function emitEvent(event: string, payload?: unknown): Promise<void> {
    emitted.push({ event, payload: clone(payload), t: performance.now() });
    await tauriEmit(event, payload);
  }

  // ---- command handlers ----------------------------------------------------------
  const handlers = {
    app_boot: (): BootInfo => ({
      window: kind,
      version: '1.0.0-e2e',
      settings: clone(settings),
      systemReducedMotion: config.systemReducedMotion ?? false,
      accent,
      build: 'e2e',
      smoke: config.smoke ?? false,
      firstRun: config.firstRun ?? false,
      boxMetrics: metricsFor(settings.boxSize),
      windows11: config.windows11 ?? true,
    }),

    box_drag: async (): Promise<DragResult> => {
      await sleep(config.boxDragMs ?? 30);
      return boxDragResult;
    },
    box_menu: () => null,
    open_editor: (args) => {
      const ids = args.items as string[];
      const view = args.view as EditorView;
      if (!Array.isArray(ids)) fail('items must be an array');
      ids.forEach(itemOrFail);
      if (view === 'edit' && ids.length === 0) fail('nothing to edit');
      return null;
    },

    editor_next: (args) => editorNext(Number(args.after ?? 0)),
    editor_ack: (args) => {
      acks.push({ session: Number(args.session), stage: args.stage as AckStage, t: performance.now() });
      for (const check of [...ackWaiters]) check();
      return null;
    },
    editor_close: (args) => {
      const reason = args.reason as CloseReason;
      if (reason !== 'applied' && fsm.phase === 'open') {
        void simulateClose('hide').catch((e: unknown) => console.error('[e2e] close failed', e));
      }
      return null;
    },

    inspect_paths: async (args): Promise<ItemInfo[]> => {
      const paths = args.paths as string[];
      await sleep(inspectDelayMs);
      if (inspectOverride) {
        const items = await inspectOverride([...paths]);
        items.forEach(register);
        return clone(items);
      }
      return clone(await makeItems(paths));
    },
    inspect_system_icon: async (args): Promise<ItemInfo> => {
      const id = args.id as SystemIconId;
      const path = `sys:${id}`;
      const itemId = idByPath.get(path) ?? `item-${nextItem++}`;
      const item = await makeSystemItem(id, itemId, history.some((e) => e.systemIcon === id && e.state === 'applied'));
      itemsById.set(itemId, item);
      idByPath.set(path, itemId);
      return clone(item);
    },
    item_frames: async (args): Promise<IconFrame[]> => {
      const item = itemOrFail(args.item);
      if (!item.icon) return [];
      return Promise.all(
        FRAME_SIZES.map(async (size) => ({ width: size, height: size, png: await scaledPngBase64(item.icon!, size) })),
      );
    },
    pick_files: async (args): Promise<ItemInfo[]> => {
      const purpose = args.purpose as PickPurpose;
      const paths = purpose === 'project' ? pickFiles.filter((p) => p.toLowerCase().endsWith('.reskin')) : pickFiles;
      return clone(await makeItems(paths));
    },
    read_project: (args): string => {
      const item = itemOrFail(args.item);
      return projects.get(item.id) ?? projects.get(item.path) ?? fail('Not a Reskin project');
    },

    apply_icon: async (args): Promise<ApplyOutcome> => {
      const req = args.req as ApplyRequest;
      const item = itemOrFail(req.item);
      if (req.images.length === 0) fail('no images to apply');
      let outcome: ApplyOutcome;
      if (applyOutcome) {
        outcome = clone(applyOutcome);
        if (outcome.type === 'needsElevation') tickets.set(outcome.ticket, clone(req));
      } else {
        outcome = { type: 'applied', entries: await journal(item, req, false), landed: true };
      }
      return finishApply(req, outcome);
    },
    apply_icon_elevated: async (args): Promise<ApplyOutcome> => {
      const ticket = String(args.ticket);
      const req = tickets.get(ticket) ?? fail('unknown or expired ticket');
      tickets.delete(ticket);
      const item = itemOrFail(req.item);
      const outcome: ApplyOutcome = { type: 'applied', entries: await journal(item, req, true), landed: true };
      return finishApply(req, outcome);
    },
    restore: (args): RestoreReport => {
      const target = args.target as RestoreTarget;
      let affected: HistoryEntry[];
      if (target.type === 'all') {
        affected = history.filter((e) => e.state === 'applied');
      } else if (target.type === 'entry') {
        const entry = history.find((e) => e.id === target.id) ?? fail(`no history entry ${target.id}`);
        affected = entry.state === 'applied' ? [entry] : [];
      } else {
        const item = itemOrFail(target.item);
        affected = history.filter(
          (e) => e.state === 'applied' && (e.target === item.path || (item.systemIcon && e.systemIcon === item.systemIcon)),
        );
      }
      const now = Date.now();
      for (const e of affected) {
        e.state = 'restored';
        e.restoredAt = now;
      }
      return { restored: affected.length, failed: [], needsElevation: 0 };
    },
    history_list: (): HistoryEntry[] => clone([...history].reverse()),
    refresh_icons: () => null,
    export_file: (args): string | null => {
      const req = args.req as ExportRequest;
      if (exportPath !== undefined) return exportPath;
      const ext = req.kind === 'ico' ? 'ico' : req.kind === 'png' ? 'png' : 'reskin';
      return `${USER_DIR}\\Pictures\\${req.suggestedName}.${ext}`;
    },

    library_list: (): LibraryEntry[] =>
      clone([...library.values()].map((l) => l.entry).sort((a, b) => b.updatedAt - a.updatedAt)),
    library_save: (args): LibraryEntry => {
      const save = args.entry as LibrarySave;
      const id = save.id && library.has(save.id) ? save.id : `lib-${nextLibrary++}`;
      const entry: LibraryEntry = {
        id,
        name: save.name,
        thumb: save.thumb,
        updatedAt: Date.now(),
        bytes: new TextEncoder().encode(save.data).length,
      };
      library.set(id, { entry, data: save.data });
      return clone(entry);
    },
    library_load: (args): string => library.get(String(args.id))?.data ?? fail(`no library entry ${String(args.id)}`),
    library_delete: (args) => {
      if (!library.delete(String(args.id))) fail(`no library entry ${String(args.id)}`);
      return null;
    },
    autosave: (args) => {
      autosaveData = (args.data as string | null) ?? null;
      return null;
    },
    autosave_load: (): string | null => autosaveData,

    wallpaper: (): Promise<ArrayBuffer> => wallpaperBytes(),
    wallpaper_info: (): WallpaperInfo => ({
      hasImage: true,
      fit: 'fill',
      background: '#0a1a33',
      monitorWidth: 1920,
      monitorHeight: 1080,
      iconSize: 48,
      darkTaskbar: true,
      accent,
    }),
    system_fonts: (): string[] => [...SYSTEM_FONTS],
    accent_color: (): string | null => accent,
    settings_get: (): Settings => clone(settings),
    settings_set: async (args): Promise<Settings> => {
      settings = normalizeSettings(clone(args.settings as Settings));
      await announceSettings();
      return clone(settings);
    },
    open_external: () => null,
    set_box_visible: (args) => {
      boxVisible = Boolean(args.visible);
      return null;
    },
    quit_app: () => null,
    smoke_ready: (args) => {
      smokeReports.push(clone(args.report as SmokeReport));
      return null;
    },
  } satisfies Record<CommandName, Handler>;

  // Every name in COMMAND_NAMES must have a handler (also enforced by the
  // `satisfies` above); this catches drift at runtime in the e2e build too.
  for (const name of COMMAND_NAMES) {
    if (!(name in handlers)) throw new Error(`tauri-mock: missing handler for ${name}`);
  }

  async function handle(cmd: string, rawArgs?: Args): Promise<unknown> {
    const args = rawArgs ?? {};
    // Window/webview plugin traffic (the event plugin is mocked by mockIPC).
    if (cmd.startsWith('plugin:')) return null;
    const call: E2ECall = { cmd, args: clone(args), t: performance.now() };
    calls.push(call);
    for (const wake of [...callWaiters]) wake();
    const failure = failures.get(cmd);
    if (failure !== undefined) {
      failures.delete(cmd);
      throw failure;
    }
    const handler = (handlers as Record<string, Handler>)[cmd];
    if (!handler) throw `unknown command ${cmd}`;
    return handler(args);
  }

  mockWindows(kind, kind === 'box' ? 'editor' : 'box');
  mockIPC((cmd, args) => handle(cmd, args as Args | undefined), { shouldMockEvents: true });

  // Count live event listeners (the mocked event plugin keeps its own map).
  const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
  const mockedInvoke = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    const result = mockedInvoke(cmd, args, options);
    if (cmd === 'plugin:event|listen' && args) {
      const event = String(args.event);
      listenerIds.set(Number(args.handler), event);
      listeners.set(event, (listeners.get(event) ?? 0) + 1);
    } else if (cmd === 'plugin:event|unlisten' && args) {
      const event = listenerIds.get(Number(args.eventId));
      if (event !== undefined) {
        listenerIds.delete(Number(args.eventId));
        listeners.set(event, Math.max(0, (listeners.get(event) ?? 1) - 1));
      }
    }
    return result;
  };

  // ---- window.__e2e -------------------------------------------------------------
  const api: E2EApi = {
    kind,
    get calls() {
      return calls;
    },
    callsOf: (cmd) => calls.filter((c) => c.cmd === cmd),
    clearCalls: () => {
      calls.length = 0;
    },
    waitForCall: (cmd, match = () => true, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const find = () => calls.find((c) => c.cmd === cmd && match(c));
        const found = find();
        if (found) return resolve(found);
        const check = () => {
          const c = find();
          if (!c) return;
          cleanup();
          resolve(c);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`no ${cmd} call within ${timeoutMs} ms`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          callWaiters.delete(check);
        };
        callWaiters.add(check);
      }),

    emit: emitEvent,
    get emitted() {
      return emitted;
    },
    listenerCount: (event) => listeners.get(event) ?? 0,

    pushEditorCmd,
    get acks() {
      return acks;
    },
    waitForAck,
    get editor() {
      return { ...fsm };
    },
    simulateOpen,
    simulateClose,
    setHeartbeatMs: (ms) => {
      heartbeatMs = ms;
    },

    setApplyOutcome: (o) => {
      applyOutcome = o ? clone(o) : null;
    },
    setInspectOverride: (fn) => {
      inspectOverride = fn;
    },
    setInspectDelay: (ms) => {
      inspectDelayMs = ms;
    },
    setBoxDragResult: (r) => {
      boxDragResult = r;
    },
    failNext: (cmd, message) => {
      failures.set(cmd, message);
    },
    setExportPath: (p) => {
      exportPath = p;
    },
    setPickFiles: (paths) => {
      pickFiles = [...paths];
    },
    setProject: (key, json) => {
      projects.set(key, json);
    },
    setApplyCollapses: (on) => {
      applyCollapses = on;
    },

    get settings() {
      return clone(settings);
    },
    setSettings: async (patch) => {
      settings = normalizeSettings({ ...settings, ...clone(patch) });
      await announceSettings();
      return clone(settings);
    },
    makeItems: async (paths) => clone(await makeItems(paths)),
    get history() {
      return clone(history);
    },
    get library() {
      return clone([...library.values()].map((l) => l.entry));
    },
    get autosaveData() {
      return autosaveData;
    },
    get smokeReports() {
      return smokeReports;
    },
    get boxVisible() {
      return boxVisible;
    },
  };

  window.__e2e = api;
  installed = api;
  return api;
}

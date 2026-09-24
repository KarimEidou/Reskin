// Types of the e2e fake backend's control surface (`window.__e2e`) and its
// start-up configuration (`window.__E2E_CONFIG__`). See tauri-mock.ts for
// the behaviour behind them.

import type { CommandName } from '$lib/ipc/commands';
import type {
  AckStage,
  ApplyOutcome,
  CollapseThen,
  DragResult,
  EditorCmd,
  EditorView,
  HistoryEntry,
  ItemInfo,
  LibraryEntry,
  Rect,
  Settings,
  SmokeReport,
} from '$lib/ipc/types';

/** One invocation of an app command (plugin/event traffic is not logged). */
export interface E2ECall {
  cmd: string;
  /** Deep copy of the invoke arguments (camelCase keys, as sent). */
  args: Record<string, unknown>;
  /** `performance.now()` when the call arrived. */
  t: number;
}

/** One `editor_ack`. */
export interface E2EAck {
  session: number;
  stage: AckStage;
  t: number;
}

/** One event emitted through `__e2e.emit` or by the fake itself. */
export interface E2EEmitted {
  event: string;
  payload: unknown;
  t: number;
}

/**
 * Optional start-up configuration. Set it before the page loads, e.g.
 * `page.addInitScript((c) => { window.__E2E_CONFIG__ = c }, config)`.
 */
export interface E2EConfig {
  /** Merged over the default settings (then normalised). */
  settings?: Partial<Settings>;
  /** Windows accent colour reported by boot / accent_color (default #0078d4). */
  accent?: string | null;
  firstRun?: boolean;
  smoke?: boolean;
  systemReducedMotion?: boolean;
  windows11?: boolean;
  /** Mailbox heartbeat after this many ms of silence (default 25 000). */
  heartbeatMs?: number;
  /** What `box_drag` resolves to (default 'click'). */
  boxDragResult?: DragResult;
  /** How long `box_drag` "holds the mouse" before resolving (default 30 ms). */
  boxDragMs?: number;
  /** Simulated inspection latency per `inspect_paths` call (default 40 ms). */
  inspectDelayMs?: number;
  /** When false, a flourish apply does not collapse the open editor (default true). */
  applyCollapses?: boolean;
}

export type EditorPhase =
  | 'closed'
  | 'preparing'
  | 'revealing'
  | 'expanding'
  | 'open'
  | 'collapsing'
  | 'clearing';

export interface SimulateOpenOptions {
  /** Ask for a morph (default: settings.openStyle === 'morph' and motion not reduced). */
  morph?: boolean;
  /** Box rect in editor CSS px (default: box window at (32, 32)). */
  boxRect?: Rect;
  /** Settings snapshot sent with Prepare (default: the fake's settings). */
  settings?: Settings;
  /** How long to wait for `prepared` before falling back to crossfade (default 400 ms, like Rust). */
  prepareTimeoutMs?: number;
  /** Timeout for the other acks (default 3000 ms); the FSM proceeds after it. */
  ackTimeoutMs?: number;
}

export interface SimulateOpenResult {
  session: number;
  /** The morph flag sent with Expand (false after a late `prepared`). */
  morph: boolean;
  /** `prepared` arrived within the prepare timeout. */
  preparedInTime: boolean;
  /** Stages whose ack never came (the FSM went on without them). */
  timedOut: AckStage[];
}

export interface SimulateCloseOptions {
  /** Icon the box should carry (Collapse.icon). */
  icon?: string | null;
  /** Collapse into the proxy (default: the morph flag of the open). */
  morph?: boolean;
  boxRect?: Rect;
  ackTimeoutMs?: number;
}

export interface SimulateCloseResult {
  session: number;
  timedOut: AckStage[];
}

export interface SimulateBoxReturnResult {
  /** Session number sent with `box:collapse`. */
  session: number;
  /** `box_painted` came within Rust's 300 ms. */
  painted: boolean;
}

export interface E2EEditorState {
  /** Current (last) handoff session number; 0 before the first open. */
  session: number;
  phase: EditorPhase;
  /** The simulated editor window is shown. */
  visible: boolean;
  /** Morph flag of the last open. */
  morph: boolean;
}

export interface E2EApi {
  /** Which page this fake serves. */
  readonly kind: 'box' | 'editor';

  // ---- call log -----------------------------------------------------------
  readonly calls: readonly E2ECall[];
  callsOf(cmd: CommandName): E2ECall[];
  clearCalls(): void;
  /** Resolves with the first call to `cmd` (optionally matching) — including past ones. */
  waitForCall(cmd: CommandName, match?: (call: E2ECall) => boolean, timeoutMs?: number): Promise<E2ECall>;

  // ---- events ---------------------------------------------------------------
  /**
   * Emits a Tauri event to this page's listeners, e.g.
   * `emit('tauri://drag-enter', { paths, position: { x, y } })` (position in
   * PHYSICAL px) or `emit('box:flight', { phase: 'depart', … })`.
   */
  emit(event: string, payload?: unknown): Promise<void>;
  readonly emitted: readonly E2EEmitted[];
  /** Number of live listeners for an event (drag-drop listens to tauri://drag-*). */
  listenerCount(event: string): number;

  // ---- editor mailbox & handoff FSM ------------------------------------------
  /** Queues a mailbox command for `editor_next`; returns its seq. */
  pushEditorCmd(cmd: EditorCmd): number;
  readonly acks: readonly E2EAck[];
  waitForAck(session: number, stage: AckStage, timeoutMs?: number): Promise<boolean>;
  readonly editor: E2EEditorState;
  /**
   * Runs Rust's open handoff: Prepare → prepared (400 ms) → Reveal →
   * revealed → Expand → expanded. After a late `prepared`, Reveal and
   * Expand{morph: false} follow at once (no wait for `revealed`).
   */
  simulateOpen(
    items: ItemInfo[] | string[],
    view?: EditorView,
    opts?: SimulateOpenOptions,
  ): Promise<SimulateOpenResult>;
  /** Runs Rust's close handoff: Collapse → collapsed → Clear → cleared. */
  simulateClose(then?: CollapseThen, opts?: SimulateCloseOptions): Promise<SimulateCloseResult>;
  /**
   * Box page: the box's part of Rust's close handoff (morph.rs close_inner,
   * after `collapsed`): `box:collapse` to the hidden box, then show it
   * (`box:shown`) and wait up to 300 ms for its `box_painted`.
   */
  simulateBoxReturn(then?: CollapseThen, icon?: string | null): Promise<SimulateBoxReturnResult>;
  setHeartbeatMs(ms: number): void;

  // ---- behaviour knobs -----------------------------------------------------------
  /** Outcome for the next `apply_icon` calls; null restores the default (applied). */
  setApplyOutcome(outcome: ApplyOutcome | null): void;
  /** Replaces the path → ItemInfo mapping of `inspect_paths`; null restores it. */
  setInspectOverride(fn: ((paths: string[]) => ItemInfo[] | Promise<ItemInfo[]>) | null): void;
  setInspectDelay(ms: number): void;
  setBoxDragResult(result: DragResult): void;
  /** The next call to `cmd` rejects with `message` (Tauri error string). */
  failNext(cmd: CommandName, message: string): void;
  /** Path returned by `export_file`; null simulates a cancelled dialog; undefined = auto. */
  setExportPath(path: string | null | undefined): void;
  /** Paths "picked" by the next `pick_files` dialogs (default none = cancelled). */
  setPickFiles(paths: string[]): void;
  /** Content `read_project` returns for an item id or path. */
  setProject(itemIdOrPath: string, json: string): void;
  setApplyCollapses(on: boolean): void;

  // ---- state -------------------------------------------------------------------
  /** Current backend settings (a copy). */
  readonly settings: Settings;
  /** Changes settings "elsewhere" (normalised; notifies the page like Rust). */
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Inspects paths without logging a call (fixtures for simulateOpen etc.). */
  makeItems(paths: string[]): Promise<ItemInfo[]>;
  readonly history: readonly HistoryEntry[];
  readonly library: readonly LibraryEntry[];
  readonly autosaveData: string | null;
  readonly smokeReports: readonly SmokeReport[];
  readonly boxVisible: boolean;
}

declare global {
  interface Window {
    /** Present in the e2e build only. */
    __e2e?: E2EApi;
    __E2E_CONFIG__?: E2EConfig;
  }
}

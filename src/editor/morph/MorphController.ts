// The editor side of the box ⇄ editor handoff (docs/ARCHITECTURE.md,
// "Morph / handoff protocol"). Rust drives the protocol through the mailbox;
// this controller turns each handoff command into one step on the visual
// "surface" (App's proxy + panel) and acks the stage once the picture is on
// screen.
//
// Rules it enforces:
// * Only the session of the latest Prepare is live. Commands for any other
//   session are ignored (never acked), so a late command from an earlier
//   open can't disturb the current one.
// * Steps run in protocol order; a repeated command for a stage that is
//   already done is re-acked without redoing the work.
// * Every step is time-boxed. Chromium pauses rAF and animations in hidden
//   windows, and a stuck image decode must not stall Rust's handoff, so a
//   step that overruns is abandoned and the ack is sent anyway.
// * A failing step is reported and still acked: the ack means "I am done
//   with this stage", and Rust's timeouts are the only other way out.
// * Nothing is painted before Reveal (Prepare holds the proxy), and the two
//   swaps with the box — Reveal paints the proxy, Clear stops painting —
//   happen on the page's next frame: Rust sends the box its half at the
//   same moment, the box makes its change on its next frame too, and both
//   windows follow the same display, so the two land in one composed frame.
//
// Pure TypeScript (no DOM); the surface, ack and timer are injected so the
// ordering / timeout / stale-session logic is unit tested.

import type { AckStage, EditorCmd } from '$lib/ipc/types';

export type PrepareCmd = Extract<EditorCmd, { type: 'prepare' }>;
export type RevealCmd = Extract<EditorCmd, { type: 'reveal' }>;
export type ExpandCmd = Extract<EditorCmd, { type: 'expand' }>;
export type CollapseCmd = Extract<EditorCmd, { type: 'collapse' }>;
export type ClearCmd = Extract<EditorCmd, { type: 'clear' }>;
export type HandoffCmd = PrepareCmd | RevealCmd | ExpandCmd | CollapseCmd | ClearCmd;

export type MorphPhase =
  /** Nothing prepared yet (fresh page). */
  | 'idle'
  | 'preparing'
  /** Proxy laid out and held (nothing painted); the window may be on screen. */
  | 'prepared'
  /** Window visible, proxy painted over the (no longer painted) box. */
  | 'revealed'
  | 'expanding'
  | 'open'
  | 'collapsing'
  /** Panel gone; the proxy (or nothing) at the box's place. */
  | 'collapsed'
  | 'clearing'
  /** Fully transparent. */
  | 'cleared';

/** What the controller drives: App's proxy + panel. */
export interface MorphSurface {
  /**
   * Resets for a new open and lays out the box proxy, held (not painted
   * until `reveal`); resolves once its image is decoded.
   */
  prepare(cmd: PrepareCmd): Promise<void> | void;
  /** Paints the held proxy. */
  reveal(): Promise<void> | void;
  /** Proxy → panel (FLIP morph, or a crossfade when `morph` is false). */
  expand(morph: boolean): Promise<void> | void;
  /** Panel → proxy at `cmd.boxRect` (or a fade out when `cmd.morph` is false). */
  collapse(cmd: CollapseCmd): Promise<void> | void;
  /** Paints nothing at all. */
  clear(): Promise<void> | void;
  /**
   * Waits for the next frame (its rAF callback, time-boxed): a change made
   * right then is in that frame.
   */
  nextFrame(timeoutMs: number): Promise<unknown>;
  /** Waits until the current DOM state is on screen (double rAF, time-boxed). */
  frames(timeoutMs: number): Promise<unknown>;
}

export interface MorphTimeouts {
  /** Drawing the proxy incl. decoding its icon (Rust falls back to a crossfade after 400 ms). */
  prepare: number;
  /**
   * Frames after preparing (a hidden window runs no rAF, and one just shown
   * none for a moment).
   */
  prepareFrames: number;
  /**
   * The frame a swap with the box happens in (the window is on screen: the
   * next frame is due within a vsync).
   */
  swapFrame: number;
  /** Frames after Reveal. */
  reveal: number;
  /** The whole expand animation. */
  expand: number;
  /** The whole collapse animation. */
  collapse: number;
  /** Frames after collapsing / clearing. */
  settle: number;
}

export const DEFAULT_TIMEOUTS: Readonly<MorphTimeouts> = Object.freeze({
  prepare: 700,
  prepareFrames: 120,
  swapFrame: 100,
  reveal: 400,
  expand: 2400,
  collapse: 1700,
  settle: 400,
});

export interface MorphControllerOptions {
  surface: MorphSurface;
  ack(session: number, stage: AckStage): Promise<unknown> | unknown;
  timeouts?: Partial<MorphTimeouts>;
  /** Resolves after `ms` (setTimeout by default); injectable for tests. */
  delay?(ms: number): Promise<void>;
  /** Every phase change (the UI mirrors it, e.g. for `data-phase`). */
  onPhase?(phase: MorphPhase, session: number): void;
  /** A surface step threw or overran its time box. */
  onIssue?(issue: MorphIssue): void;
}

export interface MorphIssue {
  session: number;
  step: HandoffCmd['type'] | 'frames';
  kind: 'timeout' | 'error';
  error?: unknown;
}

export type HandleResult = 'done' | 'repeated' | 'stale';

const HANDOFF_TYPES = new Set<EditorCmd['type']>(['prepare', 'reveal', 'expand', 'collapse', 'clear']);

export function isHandoffCmd(cmd: EditorCmd): cmd is HandoffCmd {
  return HANDOFF_TYPES.has(cmd.type);
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MorphController {
  private readonly surface: MorphSurface;
  private readonly sendAck: MorphControllerOptions['ack'];
  private readonly timeouts: MorphTimeouts;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly onPhase?: MorphControllerOptions['onPhase'];
  private readonly onIssue?: MorphControllerOptions['onIssue'];

  private _session = 0;
  private _phase: MorphPhase = 'idle';
  /** Stages acked for the current session (for repeats). */
  private readonly acked = new Set<AckStage>();

  constructor(opts: MorphControllerOptions) {
    this.surface = opts.surface;
    this.sendAck = opts.ack;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.delay = opts.delay ?? defaultDelay;
    this.onPhase = opts.onPhase;
    this.onIssue = opts.onIssue;
  }

  /** The live handoff session (0 before the first Prepare). */
  get session(): number {
    return this._session;
  }

  get phase(): MorphPhase {
    return this._phase;
  }

  /** The editor is (or is becoming) visible to the user. */
  get visible(): boolean {
    return this._phase === 'revealed' || this._phase === 'expanding' || this._phase === 'open' || this._phase === 'collapsing';
  }

  /** Handles one handoff command; resolves after its ack (or when ignored). */
  async handle(cmd: HandoffCmd): Promise<HandleResult> {
    switch (cmd.type) {
      case 'prepare':
        return this.prepare(cmd);
      case 'reveal':
        return this.reveal(cmd);
      case 'expand':
        return this.expand(cmd);
      case 'collapse':
        return this.collapse(cmd);
      case 'clear':
        return this.clear(cmd);
    }
  }

  // ---- steps ------------------------------------------------------------------

  private async prepare(cmd: PrepareCmd): Promise<HandleResult> {
    if (cmd.session <= this._session) {
      // An old or duplicate Prepare: the current session already moved on.
      if (cmd.session === this._session && this.acked.has('prepared') && this._phase === 'prepared') {
        await this.ack('prepared');
        return 'repeated';
      }
      return 'stale';
    }
    this._session = cmd.session;
    this.acked.clear();
    this.setPhase('preparing');
    await this.step(cmd.session, 'prepare', () => this.surface.prepare(cmd), this.timeouts.prepare);
    if (!this.live(cmd.session)) return 'stale';
    await this.settle(cmd.session, this.timeouts.prepareFrames);
    if (!this.live(cmd.session)) return 'stale';
    this.setPhase('prepared');
    await this.ack('prepared');
    return 'done';
  }

  private async reveal(cmd: RevealCmd): Promise<HandleResult> {
    if (!this.live(cmd.session)) return 'stale';
    if (this.acked.has('revealed')) {
      await this.ack('revealed');
      return 'repeated';
    }
    if (this._phase !== 'prepared') return 'stale';
    // The swap: the proxy shows from the frame the box stops painting in.
    await this.swapFrame(cmd.session);
    if (!this.live(cmd.session)) return 'stale';
    await this.step(cmd.session, 'reveal', () => this.surface.reveal(), this.timeouts.reveal);
    if (!this.live(cmd.session)) return 'stale';
    await this.settle(cmd.session, this.timeouts.reveal);
    if (!this.live(cmd.session)) return 'stale';
    this.setPhase('revealed');
    await this.ack('revealed');
    return 'done';
  }

  private async expand(cmd: ExpandCmd): Promise<HandleResult> {
    if (!this.live(cmd.session)) return 'stale';
    if (this.acked.has('expanded')) {
      await this.ack('expanded');
      return 'repeated';
    }
    if (this._phase !== 'prepared' && this._phase !== 'revealed') return 'stale';
    this.setPhase('expanding');
    await this.step(cmd.session, 'expand', () => this.surface.expand(cmd.morph), this.timeouts.expand);
    if (!this.live(cmd.session)) return 'stale';
    this.setPhase('open');
    await this.ack('expanded');
    return 'done';
  }

  private async collapse(cmd: CollapseCmd): Promise<HandleResult> {
    // A page that never saw a Prepare (it was reloaded while open) adopts
    // the session so Rust's close can still complete.
    if (this._session === 0 && cmd.session > 0) this._session = cmd.session;
    if (!this.live(cmd.session)) return 'stale';
    if (this.acked.has('collapsed')) {
      await this.ack('collapsed');
      return 'repeated';
    }
    if (this._phase === 'clearing' || this._phase === 'cleared') return 'stale';
    this.setPhase('collapsing');
    await this.step(cmd.session, 'collapse', () => this.surface.collapse(cmd), this.timeouts.collapse);
    if (!this.live(cmd.session)) return 'stale';
    await this.settle(cmd.session, this.timeouts.settle);
    if (!this.live(cmd.session)) return 'stale';
    this.setPhase('collapsed');
    await this.ack('collapsed');
    return 'done';
  }

  private async clear(cmd: ClearCmd): Promise<HandleResult> {
    if (this._session === 0 && cmd.session > 0) this._session = cmd.session;
    if (!this.live(cmd.session)) return 'stale';
    if (this.acked.has('cleared')) {
      await this.ack('cleared');
      return 'repeated';
    }
    this.setPhase('clearing');
    // The swap: nothing shows from the frame the box paints its picture in.
    await this.swapFrame(cmd.session);
    if (!this.live(cmd.session)) return 'stale';
    await this.step(cmd.session, 'clear', () => this.surface.clear(), this.timeouts.settle);
    if (!this.live(cmd.session)) return 'stale';
    await this.settle(cmd.session, this.timeouts.settle);
    if (!this.live(cmd.session)) return 'stale';
    this.setPhase('cleared');
    await this.ack('cleared');
    return 'done';
  }

  // ---- helpers ---------------------------------------------------------------------

  private live(session: number): boolean {
    return session === this._session;
  }

  private setPhase(phase: MorphPhase): void {
    this._phase = phase;
    this.onPhase?.(phase, this._session);
  }

  private async ack(stage: AckStage): Promise<void> {
    this.acked.add(stage);
    try {
      await this.sendAck(this._session, stage);
    } catch (error) {
      this.onIssue?.({ session: this._session, step: stageStep(stage), kind: 'error', error });
    }
  }

  /** Runs a surface step, time-boxed; never throws. */
  private async step(
    session: number,
    step: HandoffCmd['type'],
    run: () => Promise<void> | void,
    timeoutMs: number,
  ): Promise<void> {
    const outcome = await race(run, timeoutMs, this.delay);
    if (outcome.kind !== 'ok') this.onIssue?.({ session, step, ...outcome });
  }

  /**
   * Waits for the frame a swap with the box happens in, time-boxed; never
   * throws. The step that follows makes its change right then, before
   * anything else runs, so it is in that frame.
   */
  private async swapFrame(session: number): Promise<void> {
    const timeoutMs = this.timeouts.swapFrame;
    // As in settle, the race is a backstop for nextFrame's own timeout.
    const outcome = await race(() => this.surface.nextFrame(timeoutMs), timeoutMs + 100, this.delay);
    if (outcome.kind !== 'ok') this.onIssue?.({ session, step: 'frames', ...outcome });
  }

  /** Waits for the picture to reach the screen, time-boxed; never throws. */
  private async settle(session: number, timeoutMs: number): Promise<void> {
    // The surface's frames() has its own timeout; the race is a backstop
    // against an implementation that never resolves.
    const outcome = await race(() => this.surface.frames(timeoutMs), timeoutMs + 100, this.delay);
    if (outcome.kind !== 'ok') this.onIssue?.({ session, step: 'frames', ...outcome });
  }
}

function stageStep(stage: AckStage): HandoffCmd['type'] {
  switch (stage) {
    case 'prepared':
      return 'prepare';
    case 'revealed':
      return 'reveal';
    case 'expanded':
      return 'expand';
    case 'collapsed':
      return 'collapse';
    case 'cleared':
      return 'clear';
  }
}

type RaceOutcome = { kind: 'ok' } | { kind: 'timeout' } | { kind: 'error'; error: unknown };

async function race(
  run: () => Promise<unknown> | unknown,
  timeoutMs: number,
  delay: (ms: number) => Promise<void>,
): Promise<RaceOutcome> {
  let work: Promise<RaceOutcome>;
  try {
    work = Promise.resolve(run()).then(
      (): RaceOutcome => ({ kind: 'ok' }),
      (error: unknown): RaceOutcome => ({ kind: 'error', error }),
    );
  } catch (error) {
    return { kind: 'error', error };
  }
  const timer = delay(Math.max(0, timeoutMs)).then((): RaceOutcome => ({ kind: 'timeout' }));
  return Promise.race([work, timer]);
}

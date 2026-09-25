// The box page's state machine as a pure reducer: (state, event) → state.
// Box.svelte feeds it pointer, drag-and-drop, inspection and Rust events and
// renders BoxVisual from the result; timers and IPC live in the component.
//
//   idle ⇄ hover                 pointer enter / leave
//   idle|hover → armed           drag enter (count = number of paths)
//   armed → idle|hover           drag leave
//   armed → absorbing            drop (inspection may still be running)
//   absorbing → error            inspection failed / found nothing
//   absorbing → idle (handoff)   the editor was asked to open
//   * → flying → celebrate → flying → idle     box:flight legs
//   * → busy → idle              box:progress
//   idle|hover|… → celebrate     undone: the Undo chip restored the icon
//   celebrate|error → idle|hover settled (after their one-shot animation)
//   * → idle (handoff)           box:handoff: the editor opens over the box
//                                (an open from the tray, the menu, Explorer…
//                                too): the picture its proxy draws
//   handoff → veiled             box:conceal: the editor's proxy took over
//                                the picture; the window is hidden next
//   * → idle (handoff)           box:collapse: the editor collapsed onto its
//                                proxy; the hidden box takes that picture
//                                over (see collapseItems) before it is shown
//                                — held (veiled) under the proxy
//   veiled → idle (handoff)      box:reveal: the box paints the picture it
//                                took over from the proxy, still frozen
//   * → idle                     box:shown (the editor closed) keeps the
//                                picture taken over from the editor, frozen,
//                                else resets; the window was hidden, or a
//                                handoff Rust never followed up on
//                                (unfreeze), resets (so it never reappears on
//                                a stale picture)
//   handoff → idle               box:released: the close is over, the
//                                editor's proxy gone — after a plain close
//                                the picture is the box's own again
//
// "handoff": the box is frozen on a picture the other window reproduces —
// after asking the editor to open, the one the editor's proxy will draw
// (see handoffProps); after box:collapse, the one the proxy ended on. It
// ignores pointer/drag input, and shows nothing of its own (the hint, the
// Undo chip), until the close released it (a plain close) or, after an
// apply, until its flight takes over (depart / celebrate).
//
// "veiled": the box paints nothing, because the editor's proxy paints its
// picture over it (both windows are translucent: never both at once). Set
// by box:conceal (the box stays blank while hidden, until it is told what
// to show) and by a held box:collapse; box:reveal ends it, as do a new
// handoff picture, box:shown without a collapse picture, and a flight or an
// error (the box shows on its own again).

import type { CollapseThen, FlightPhase, RestoreReport } from '$lib/ipc/types';
import { collapseItems, type BoxVisualState } from '$lib/ui/box-geometry';

export type BoxStateName = BoxVisualState;

export interface BoxState {
  name: BoxStateName;
  /** The pointer is over the box (so transient states settle to hover). */
  hovering: boolean;
  /** Items being dragged / absorbed / handed over (badge when > 1). */
  count: number;
  /** Icon shown in the box: absorbed, carried on a flight, or celebrated. */
  icon: string | null;
  /** Batch progress for the busy ring. */
  progress: { done: number; total: number } | null;
  /** Why the box is in the error state. */
  message: string | null;
  /** Frozen on the handoff picture (see above). */
  handoff: boolean;
  /** The picture was taken over from the editor's collapse (`box:collapse`). */
  collapsed: CollapseThen | null;
  /** Paints nothing: the editor's proxy paints the picture (see above). */
  veiled: boolean;
  /** Bumped on every entry into a one-shot state (restarts its timer). */
  epoch: number;
}

export type BoxEvent =
  | { type: 'pointerEnter' }
  | { type: 'pointerLeave' }
  | { type: 'dragEnter'; count: number }
  | { type: 'dragLeave' }
  | { type: 'drop'; count: number }
  | { type: 'inspectDone'; icon: string | null; count: number }
  | { type: 'inspectFailed'; message?: string }
  | { type: 'openRequested'; icon?: string | null; count?: number }
  | { type: 'openFailed'; message?: string }
  | { type: 'flight'; phase: FlightPhase; icon?: string | null; message?: string | null }
  | { type: 'progress'; done: number; total: number }
  | { type: 'conceal' }
  | { type: 'collapse'; then: CollapseThen; icon: string | null; held: boolean }
  | { type: 'reveal' }
  | { type: 'shown' }
  | { type: 'released' }
  | { type: 'hidden' }
  | { type: 'unfreeze' }
  | { type: 'error'; message?: string }
  | { type: 'undone' }
  | { type: 'settled'; epoch: number };

export const initialBoxState: BoxState = Object.freeze({
  name: 'idle',
  hovering: false,
  count: 0,
  icon: null,
  progress: null,
  message: null,
  handoff: false,
  collapsed: null,
  veiled: false,
  epoch: 0,
}) as BoxState;

const rest = (s: BoxState): BoxStateName => (s.hovering ? 'hover' : 'idle');

/**
 * The close released the box: after a plain close it rests on the picture
 * it took over from the editor's collapse; after an apply it holds the new
 * icon (frozen) until its flight carries it on.
 */
const showCollapsed = (s: BoxState): BoxState => (s.collapsed === 'hide' ? { ...s, handoff: false, collapsed: null } : s);

/** The icon taken over from the editor's collapse, which a flight carries on. */
const carried = (s: BoxState): string | null => (s.collapsed ? s.icon : null);

/** States from which a new drag may arm the box. */
const ARMABLE: ReadonlySet<BoxStateName> = new Set(['idle', 'hover', 'armed', 'error', 'celebrate']);

/** States with nothing in progress: a finished undo may celebrate. */
const AT_REST: ReadonlySet<BoxStateName> = new Set(['idle', 'hover', 'error', 'celebrate']);

function toError(s: BoxState, message: string | null | undefined): BoxState {
  return {
    ...s,
    name: 'error',
    message: message ?? null,
    icon: null,
    count: 0,
    handoff: false,
    collapsed: null,
    veiled: false,
    progress: null,
    epoch: s.epoch + 1,
  };
}

export function boxReducer(s: BoxState, e: BoxEvent): BoxState {
  switch (e.type) {
    case 'pointerEnter':
      if (s.hovering) return s;
      return { ...s, hovering: true, name: s.name === 'idle' && !s.handoff ? 'hover' : s.name };

    case 'pointerLeave':
      if (!s.hovering) return s;
      return { ...s, hovering: false, name: s.name === 'hover' ? 'idle' : s.name };

    case 'dragEnter':
      if (s.handoff || !ARMABLE.has(s.name)) return s;
      return { ...s, name: 'armed', count: Math.max(0, e.count), icon: null, message: null };

    case 'dragLeave':
      if (s.name !== 'armed') return s;
      return { ...s, name: rest(s), count: 0 };

    case 'drop':
      if (s.handoff || !(s.name === 'armed' || s.name === 'idle' || s.name === 'hover')) return s;
      return { ...s, name: 'absorbing', count: Math.max(0, e.count), icon: null, message: null, epoch: s.epoch + 1 };

    case 'inspectDone':
      if (s.name !== 'absorbing') return s;
      return { ...s, icon: e.icon, count: e.count };

    case 'inspectFailed':
      if (s.name !== 'absorbing' && s.name !== 'armed') return s;
      return toError(s, e.message);

    case 'openRequested':
      return {
        ...s,
        name: 'idle',
        handoff: true,
        collapsed: null,
        veiled: false,
        icon: e.icon !== undefined ? e.icon : s.icon,
        count: e.count ?? s.count,
        progress: null,
        message: null,
      };

    case 'openFailed':
      return toError(s, e.message);

    case 'flight':
      switch (e.phase) {
        // The legs continue from the picture the box took over.
        case 'depart':
          return {
            ...s,
            name: 'flying',
            icon: e.icon ?? carried(s),
            count: 0,
            handoff: false,
            collapsed: null,
            veiled: false,
            progress: null,
          };
        case 'return':
          return { ...s, name: 'flying', icon: null, count: 0, handoff: false, collapsed: null, veiled: false };
        case 'land':
          return {
            ...s,
            name: 'celebrate',
            icon: null,
            handoff: false,
            collapsed: null,
            veiled: false,
            epoch: s.epoch + 1,
          };
        case 'celebrate':
          return {
            ...s,
            name: 'celebrate',
            icon: e.icon ?? carried(s),
            count: 0,
            handoff: false,
            collapsed: null,
            veiled: false,
            progress: null,
            epoch: s.epoch + 1,
          };
        case 'home':
          return {
            ...s,
            name: rest(s),
            icon: null,
            count: 0,
            handoff: false,
            collapsed: null,
            veiled: false,
            progress: null,
          };
        case 'error':
          return toError(s, e.message);
      }
      return s;

    case 'progress':
      if (e.total > 0 && e.done < e.total) {
        return {
          ...s,
          name: 'busy',
          handoff: false,
          collapsed: null,
          progress: { done: Math.max(0, e.done), total: e.total },
        };
      }
      return s.name === 'busy' ? { ...s, name: rest(s), progress: null } : { ...s, progress: null };

    case 'conceal':
      return { ...s, handoff: true, veiled: true };

    case 'collapse': {
      const items = collapseItems(e.then, e.icon);
      return {
        ...initialBoxState,
        handoff: true,
        collapsed: e.then,
        veiled: e.held,
        icon: items[0]?.icon ?? null,
        count: items.length,
        epoch: s.epoch,
      };
    }

    case 'reveal':
      if (!s.veiled) return s;
      return { ...s, veiled: false };

    case 'shown':
      // Back from the editor's collapse: frozen on its picture (held under
      // the proxy, unpainted until box:reveal) until the close releases it.
      if (s.collapsed) return s;
      return { ...initialBoxState, epoch: s.epoch };

    case 'released':
      return showCollapsed(s);

    case 'hidden':
      // A concealed box stays blank until it is told what to show.
      return { ...initialBoxState, veiled: s.veiled, epoch: s.epoch };

    case 'unfreeze':
      return { ...initialBoxState, epoch: s.epoch };

    case 'error':
      return toError(s, e.message);

    case 'undone':
      if (s.handoff || !AT_REST.has(s.name)) return s;
      return { ...s, name: 'celebrate', icon: null, count: 0, message: null, progress: null, epoch: s.epoch + 1 };

    case 'settled':
      if (e.epoch !== s.epoch || (s.name !== 'celebrate' && s.name !== 'error')) return s;
      return { ...s, name: rest(s), icon: null, message: null, count: 0 };
  }
}

/**
 * What the box shows once the restore behind its Undo chip came back: a
 * short celebration, or a shake saying why the icon is not back.
 */
export function undoOutcome(report: RestoreReport): BoxEvent {
  if (report.failed.length > 0) return { type: 'error', message: `Couldn't undo: ${report.failed[0]}` };
  if (report.needsElevation > 0) return { type: 'error', message: 'Undo needs administrator approval' };
  return { type: 'undone' };
}

/** Progress 0..1 for the ring, or null (indeterminate / not busy). */
export function progressFraction(s: BoxState): number | null {
  if (!s.progress || s.progress.total <= 0) return null;
  return Math.min(1, s.progress.done / s.progress.total);
}

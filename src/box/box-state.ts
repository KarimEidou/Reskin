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
//   celebrate|error → idle|hover settled (after their one-shot animation)
//   * → idle (handoff)           box:collapse: the editor collapsed onto its
//                                proxy; the hidden box takes that picture
//                                over (see collapseItems) before it is shown
//   * → idle                     box:shown (the editor closed) keeps the
//                                picture taken over from the editor, else
//                                resets; the window was hidden, or a handoff
//                                Rust never followed up on (unfreeze), resets
//                                (so it never reappears on a stale picture)
//
// "handoff": the box is frozen on a picture the other window reproduces —
// after asking the editor to open, the one the editor's proxy will draw
// (see handoffProps); after box:collapse, the one the proxy ended on. It
// ignores pointer/drag input until it is shown again (a plain close) or,
// after an apply, until its flight takes over (depart / celebrate).

import type { CollapseThen, FlightPhase } from '$lib/ipc/types';
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
  | { type: 'collapse'; then: CollapseThen; icon: string | null }
  | { type: 'shown' }
  | { type: 'hidden' }
  | { type: 'unfreeze' }
  | { type: 'error'; message?: string }
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
  epoch: 0,
}) as BoxState;

const rest = (s: BoxState): BoxStateName => (s.hovering ? 'hover' : 'idle');

/** The icon taken over from the editor's collapse, which a flight carries on. */
const carried = (s: BoxState): string | null => (s.collapsed ? s.icon : null);

/** States from which a new drag may arm the box. */
const ARMABLE: ReadonlySet<BoxStateName> = new Set(['idle', 'hover', 'armed', 'error', 'celebrate']);

function toError(s: BoxState, message: string | null | undefined): BoxState {
  return {
    ...s,
    name: 'error',
    message: message ?? null,
    icon: null,
    count: 0,
    handoff: false,
    collapsed: null,
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
            progress: null,
          };
        case 'return':
          return { ...s, name: 'flying', icon: null, count: 0, handoff: false, collapsed: null };
        case 'land':
          return { ...s, name: 'celebrate', icon: null, handoff: false, collapsed: null, epoch: s.epoch + 1 };
        case 'celebrate':
          return {
            ...s,
            name: 'celebrate',
            icon: e.icon ?? carried(s),
            count: 0,
            handoff: false,
            collapsed: null,
            progress: null,
            epoch: s.epoch + 1,
          };
        case 'home':
          return { ...s, name: rest(s), icon: null, count: 0, handoff: false, collapsed: null, progress: null };
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

    case 'collapse': {
      const items = collapseItems(e.then, e.icon);
      return {
        ...initialBoxState,
        handoff: true,
        collapsed: e.then,
        icon: items[0]?.icon ?? null,
        count: items.length,
        epoch: s.epoch,
      };
    }

    case 'shown':
      // After a plain close the box rests on the picture it took over; after
      // an apply it holds the new icon (frozen) until its flight carries it on.
      if (s.collapsed === 'hide') return { ...s, handoff: false, collapsed: null };
      if (s.collapsed) return s;
      return { ...initialBoxState, epoch: s.epoch };

    case 'hidden':
    case 'unfreeze':
      return { ...initialBoxState, epoch: s.epoch };

    case 'error':
      return toError(s, e.message);

    case 'settled':
      if (e.epoch !== s.epoch || (s.name !== 'celebrate' && s.name !== 'error')) return s;
      return { ...s, name: rest(s), icon: null, message: null, count: 0 };
  }
}

/** Progress 0..1 for the ring, or null (indeterminate / not busy). */
export function progressFraction(s: BoxState): number | null {
  if (!s.progress || s.progress.total <= 0) return null;
  return Math.min(1, s.progress.done / s.progress.total);
}

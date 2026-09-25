// Rust -> box events. (The editor gets its commands through the mailbox in
// ./mailbox.ts instead: events to a window created hidden can be dropped.)
// `system:changed` goes to both pages; the editor re-reads the same state
// whenever its window shows anyway (src/lib/boot.ts).

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { BoxCollapse, BoxFlight, BoxHandoff, BoxProgress, BoxSwap, Settings } from './types';

export const EVENTS = {
  /** Fly-to-icon legs and celebrate/error states for the box. */
  flight: 'box:flight',
  /** Batch progress ring. */
  progress: 'box:progress',
  /**
   * The editor starts to open over the box: take on the picture its proxy
   * draws, then confirm with `box_painted` once it is on screen.
   */
  handoff: 'box:handoff',
  /**
   * The editor starts to paint its proxy over the box: stop painting on the
   * next frame (the box hides next), then confirm with `box_painted`.
   */
  conceal: 'box:conceal',
  /**
   * The editor collapsed onto its proxy (or faded out): take on its final
   * picture while still hidden — `held`, without painting it — then confirm
   * with `box_painted` once shown.
   */
  collapse: 'box:collapse',
  /**
   * The editor stops painting its proxy: paint the held picture on the
   * next frame, then confirm with `box_painted`.
   */
  reveal: 'box:reveal',
  /** The box was shown again (after the editor collapsed / hotkey). */
  shown: 'box:shown',
  /** Settings changed anywhere; payload is the full settings. */
  settings: 'settings:changed',
  /** An apply succeeded: show the Undo chip; payload is the history entry id. */
  undo: 'box:undo',
  /**
   * Windows state a page shows changed behind its back (Rust's start-up
   * check found the saved hotkey taken after the pages booted): read it
   * again (`refreshSystem`).
   */
  system: 'system:changed',
} as const;

export interface EventPayloads {
  'box:flight': BoxFlight;
  'box:progress': BoxProgress;
  'box:handoff': BoxHandoff;
  'box:conceal': BoxSwap;
  'box:collapse': BoxCollapse;
  'box:reveal': BoxSwap;
  'box:shown': null;
  'settings:changed': Settings;
  'box:undo': string;
  'system:changed': null;
}

export function on<K extends keyof EventPayloads>(
  name: K,
  handler: (payload: EventPayloads[K]) => void,
): Promise<UnlistenFn> {
  return listen<EventPayloads[K]>(name, (e) => handler(e.payload));
}

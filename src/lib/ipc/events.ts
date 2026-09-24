// Rust -> box events. (The editor gets its commands through the mailbox in
// ./mailbox.ts instead: events to a window created hidden can be dropped.)

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { BoxFlight, BoxProgress, Settings } from './types';

export const EVENTS = {
  /** Fly-to-icon legs and celebrate/error states for the box. */
  flight: 'box:flight',
  /** Batch progress ring. */
  progress: 'box:progress',
  /** The box was shown again (after the editor collapsed / hotkey). */
  shown: 'box:shown',
  /** Settings changed anywhere; payload is the full settings. */
  settings: 'settings:changed',
  /** An apply succeeded: show the Undo chip; payload is the history entry id. */
  undo: 'box:undo',
} as const;

export interface EventPayloads {
  'box:flight': BoxFlight;
  'box:progress': BoxProgress;
  'box:shown': null;
  'settings:changed': Settings;
  'box:undo': string;
}

export function on<K extends keyof EventPayloads>(
  name: K,
  handler: (payload: EventPayloads[K]) => void,
): Promise<UnlistenFn> {
  return listen<EventPayloads[K]>(name, (e) => handler(e.payload));
}

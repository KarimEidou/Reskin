// The editor's global keyboard handling:
//
// * Shortcuts: a window *capture* listener finds the command for a keydown
//   (see commandForKey) and runs it; a handled key is `preventDefault`ed and
//   stops propagating, so a component can never act on the same key twice
//   (the canvas stage owns a disjoint set of keys, see workspace/keys.ts).
//   Keys typed into text fields, keys inside widgets with their own letter
//   keys, keys while a modal dialog is open and keys recorded by
//   `[data-capture-keys]` elements (the hotkey recorder) are left alone.
// * Escape closes the editor (collapse handoff) when nothing else wants it:
//   no dialog / popover / menu (they stop the event), no text field focus,
//   no pending transform, text edit or gesture in the engine.

import type { Engine } from '$engine/index';
import { commandForKey, type Command, type CommandContext, compileBindings } from './commands';
import { isTypingTarget } from './keys';

export interface KeyboardOptions {
  commands: readonly Command[];
  ctx: () => CommandContext;
  /** Shortcuts are live (the panel is open and interactive). */
  active: () => boolean;
  engine: () => Engine;
  /** Runs when Escape is not needed by anything else. */
  onEscape: () => void;
  onError?: (cmd: Command, error: unknown) => void;
}

function captured(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-capture-keys]') !== null;
}

function modalOpen(): boolean {
  return document.querySelector('dialog:modal') !== null;
}

/** Installs the listeners on `window`; returns the uninstaller. */
export function installKeyboard(opts: KeyboardOptions): () => void {
  const bindings = compileBindings(opts.commands);
  /** Escape was spoken for when it started propagating (engine state changes on the way). */
  let escapeTaken = false;

  const onCapture = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      const engine = opts.engine();
      escapeTaken =
        !opts.active() ||
        modalOpen() ||
        captured(e.target) ||
        isTypingTarget(e.target as Element | null) ||
        engine.hasPending ||
        engine.isInteracting ||
        engine.textEditLayerId !== null;
      return;
    }
    if (e.isComposing || !opts.active() || modalOpen() || captured(e.target)) return;
    const ctx = opts.ctx();
    const cmd = commandForKey(bindings, { ...pick(e), defaultPrevented: e.defaultPrevented, target: e.target }, ctx);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !cmd.repeatable) return;
    try {
      const result = cmd.runKey ? cmd.runKey(ctx) : cmd.run(ctx);
      if (result instanceof Promise) result.catch((err: unknown) => opts.onError?.(cmd, err));
    } catch (err) {
      opts.onError?.(cmd, err);
    }
  };

  const onBubble = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.repeat) return;
    const taken = escapeTaken;
    escapeTaken = false;
    if (taken || !opts.active() || modalOpen()) return;
    e.preventDefault();
    opts.onEscape();
  };

  window.addEventListener('keydown', onCapture, true);
  window.addEventListener('keydown', onBubble);
  return () => {
    window.removeEventListener('keydown', onCapture, true);
    window.removeEventListener('keydown', onBubble);
  };
}

function pick(e: KeyboardEvent) {
  return {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    repeat: e.repeat,
  };
}

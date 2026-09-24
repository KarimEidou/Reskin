// Selection refinement by a number of pixels (Feather… / Grow… / Shrink… /
// Border…): what each does, and the one prompt that asks for the amount.
// The options bar shows the prompt; its Selection menu and the command
// palette open it:
//
//   refinePrompt.open('grow');   // ToolOptions pops up "Grow selection"
//   refinePrompt.kind            // what is being asked for, or null

import type { Engine } from '$engine/index';

export type RefineKind = 'feather' | 'grow' | 'shrink' | 'border';

export interface RefineInfo {
  /** Menu item, e.g. "Grow…". */
  label: string;
  /** Prompt title (its accessible name), e.g. "Grow selection". */
  title: string;
  /** The prompt's slider label. */
  amount: string;
  /** The apply button. */
  verb: string;
  /** Amount the prompt starts with, px. */
  initial: number;
  apply(engine: Engine, px: number): void;
}

/** Prompt range, px. */
export const REFINE_MIN = 1;
export const REFINE_MAX = 64;

export const REFINE: Readonly<Record<RefineKind, RefineInfo>> = {
  feather: {
    label: 'Feather…',
    title: 'Feather selection',
    amount: 'Radius',
    verb: 'Feather',
    initial: 4,
    apply: (engine, px) => engine.featherSelection(px),
  },
  grow: {
    label: 'Grow…',
    title: 'Grow selection',
    amount: 'Grow by',
    verb: 'Grow',
    initial: 2,
    apply: (engine, px) => void engine.growSelection(px),
  },
  shrink: {
    label: 'Shrink…',
    title: 'Shrink selection',
    amount: 'Shrink by',
    verb: 'Shrink',
    initial: 2,
    apply: (engine, px) => void engine.shrinkSelection(px),
  },
  border: {
    label: 'Border…',
    title: 'Border selection',
    amount: 'Width',
    verb: 'Border',
    initial: 2,
    apply: (engine, px) => void engine.borderSelection(px),
  },
};

export const REFINE_KINDS: readonly RefineKind[] = ['feather', 'grow', 'shrink', 'border'];

class RefinePrompt {
  /** The refinement being asked for, or null when the prompt is closed. */
  kind = $state<RefineKind | null>(null);
  /** Last amount per kind: the prompt reopens with it. */
  amounts = $state(Object.fromEntries(REFINE_KINDS.map((k) => [k, REFINE[k].initial])) as Record<RefineKind, number>);

  open(kind: RefineKind): void {
    this.kind = kind;
  }

  close(): void {
    this.kind = null;
  }

  /** Applies the open refinement with its amount and closes the prompt. */
  apply(engine: Engine): void {
    const kind = this.kind;
    if (!kind) return;
    this.kind = null;
    REFINE[kind].apply(engine, this.amounts[kind]);
  }
}

/** The editor page's refine prompt (one per page). */
export const refinePrompt = new RefinePrompt();

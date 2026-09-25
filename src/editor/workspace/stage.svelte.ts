// Canvas stage view state + controls, shared by the stage, the bottom bar
// and anything else in the editor that needs the view (command palette,
// morph controller):
//
//   import { stage } from './workspace/stage.svelte';
//   stage.fit(); stage.actualSize(); stage.zoomIn(); stage.toggleKeylines();
//   stage.zoom      → current zoom (1 = 100 %), reactive
//   stage.docRect() → the document's client rect on screen (or null)
//   stage.hold()    → a still picture of the canvas until released (the morph)
//
// The CanvasStage component registers the live controller while mounted;
// without it the actions are no-ops and `docRect()` returns null.

export interface StageController {
  fit(animate?: boolean): void;
  actualSize(animate?: boolean): void;
  zoomStep(direction: 1 | -1, animate?: boolean): void;
  setZoom(zoom: number): void;
  /** The document's rectangle in client (page) CSS px. */
  docRect(): DOMRect | null;
  /**
   * Keyboard focus to the canvas. `pointer`: for a press of the pointer,
   * so no focus ring shows (the ring is for keyboard focus).
   */
  focus(pointer?: boolean): void;
  /**
   * Shows a still picture of the canvas instead of the canvas until the
   * returned function is called (see `StageState.hold`); resolves once the
   * picture is in place.
   */
  hold?(): Promise<() => void>;
}

class StageState {
  /** Windows keyline guides (K). */
  keylines = $state(false);
  /** Pixel grid when zoomed in ≥ 8× (and in pixel-art mode). */
  grid = $state(true);
  /** Current zoom relative to the 512 master (1 = 100 %). */
  zoom = $state(1);
  /** The view shows the whole document (zoom-to-fit state). */
  fitted = $state(true);
  /** Before/after split position, 0..1 of the document width. */
  split = $state(0.5);
  /** A canvas stage is mounted and controllable. */
  ready = $state(false);

  private controller: StageController | null = null;

  /** Called by CanvasStage; returns the detach function. */
  attach(c: StageController): () => void {
    this.controller = c;
    this.ready = true;
    return () => {
      if (this.controller !== c) return;
      this.controller = null;
      this.ready = false;
    };
  }

  fit(animate = true): void {
    this.controller?.fit(animate);
  }

  actualSize(animate = true): void {
    this.controller?.actualSize(animate);
  }

  zoomIn(animate = true): void {
    this.controller?.zoomStep(1, animate);
  }

  zoomOut(animate = true): void {
    this.controller?.zoomStep(-1, animate);
  }

  setZoom(zoom: number): void {
    this.controller?.setZoom(zoom);
  }

  toggleKeylines(): void {
    this.keylines = !this.keylines;
  }

  toggleGrid(): void {
    this.grid = !this.grid;
  }

  docRect(): DOMRect | null {
    return this.controller?.docRect() ?? null;
  }

  focusCanvas(opts: { pointer?: boolean } = {}): void {
    this.controller?.focus(opts.pointer);
  }

  /**
   * Holds the canvas still while the panel morphs around it: a still
   * picture of it shows instead, which the compositor draws from the one
   * copy it has, where the live canvas would be copied again at every frame
   * the page commits (its picture is not re-drawn, but it is handed over
   * anew). Nothing changes on screen: the picture is the canvas's. Redraws
   * asked for meanwhile wait until the returned function lets the canvas
   * go, which draws them before the canvas shows again. Without a canvas
   * (another view, nothing to edit) it holds nothing.
   */
  async hold(): Promise<() => void> {
    return (await this.controller?.hold?.()) ?? (() => {});
  }
}

/**
 * Commits pending tool work (a Move/Transform session) before the design
 * leaves the editor — apply, export, copy, Save to Library — so what is
 * saved is exactly what is on screen, as one undo step (like any command).
 */
export function commitPendingWork(engine: { hasPending: boolean; commitPending(): void }): void {
  if (engine.hasPending) engine.commitPending();
}

/** The editor page's canvas stage (one per page). */
export const stage = new StageState();

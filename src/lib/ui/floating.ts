// Svelte attachments for floating UI (tooltips, popovers, menus):
//
//   <div {@attach portal(() => anchor)} {@attach floating({ anchor: () => anchor, placement: 'bottom-start' })}>
//
// `portal` moves the element out of its container so no ancestor's overflow
// or transform can clip or displace it: into the modal <dialog> that holds
// the anchor (everything outside an open modal dialog is inert and painted
// below it, in the top layer), else into <body>. Keep a portalled element
// the only node of its `{#if}` block. `floating` keeps it `position: fixed`
// next to its anchor, flipping/shifting inside the window, and tracks
// scroll, resize and size changes. It exposes `data-side` and `--available`
// (space on the chosen side) for styling. `dismissable` closes stacked
// layers innermost-first.

import type { Attachment } from 'svelte/attachments';
import { computePosition, type Placement } from './position';

/** Where floating UI for `anchor` must live: its modal dialog, else <body>. */
export function layerHost(anchor: Element | null | undefined): HTMLElement {
  return anchor?.closest('dialog') ?? document.body;
}

/**
 * Moves the node into `target` (an element, or the anchor whose layer host
 * — see `layerHost` — receives it; default <body>).
 */
export function portal(target?: HTMLElement | (() => Element | null | undefined)): Attachment<HTMLElement> {
  return (node) => {
    const host = typeof target === 'function' ? layerHost(target()) : (target ?? document.body);
    host.appendChild(node);
    return () => node.remove();
  };
}

export interface FloatingOptions {
  /** The element to sit next to (read on every update). */
  anchor: () => Element | null | undefined;
  placement?: Placement;
  offset?: number;
  padding?: number;
  flip?: boolean;
  /** Make the floating element at least as wide as the anchor. */
  matchWidth?: boolean;
}

export function floating(opts: FloatingOptions): Attachment<HTMLElement> {
  return (node) => {
    node.style.position = 'fixed';
    node.style.left = '0px';
    node.style.top = '0px';
    let frame = 0;

    const update = () => {
      const anchor = opts.anchor();
      if (!anchor || !anchor.isConnected) return;
      const r = anchor.getBoundingClientRect();
      if (opts.matchWidth) node.style.minWidth = `${r.width}px`;
      const p = computePosition(
        { x: r.left, y: r.top, width: r.width, height: r.height },
        { width: node.offsetWidth, height: node.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        opts,
      );
      node.style.left = `${p.x}px`;
      node.style.top = `${p.y}px`;
      node.dataset.side = p.side;
      node.style.setProperty('--available', `${p.available}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    const anchor = opts.anchor();
    if (anchor) observer.observe(anchor);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  };
}

/** Open dismissable layers, outermost first. */
const layers: HTMLElement[] = [];

/**
 * Calls `onDismiss` for pointer presses outside the node (and outside any
 * `ignore`d element, typically the anchor) and for Escape. Layers stack: a
 * press inside a layer opened later (a menu or popover opened from this
 * one, portalled elsewhere) does not dismiss this one, and Escape closes
 * only the innermost layer.
 */
export function dismissable(
  onDismiss: (reason: 'outside' | 'escape') => void,
  ignore: () => Array<Element | null | undefined> = () => [],
): Attachment<HTMLElement> {
  return (node) => {
    layers.push(node);
    const nestedContains = (target: Node) =>
      layers.slice(layers.indexOf(node) + 1).some((layer) => layer.contains(target));
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || node.contains(target) || nestedContains(target)) return;
      if (ignore().some((el) => el?.contains(target))) return;
      onDismiss('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || layers[layers.length - 1] !== node) return;
      // A modal dialog opened from this layer closes itself first.
      const dialog = e.target instanceof Element ? e.target.closest('dialog') : null;
      if (dialog && dialog !== node && node.contains(dialog)) return;
      // Handled here: a surrounding <dialog> must not close too.
      e.preventDefault();
      e.stopPropagation();
      onDismiss('escape');
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      const index = layers.indexOf(node);
      if (index >= 0) layers.splice(index, 1);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  };
}

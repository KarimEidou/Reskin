// Svelte attachments for floating UI (tooltips, popovers, menus):
//
//   <div {@attach portal()} {@attach floating({ anchor: () => btn, placement: 'bottom-start' })}>
//
// `portal` moves the element to <body> so no ancestor's overflow or
// transform can clip or displace it; keep a portalled element the only node
// of its `{#if}` block. `floating` keeps it `position: fixed` next to its
// anchor, flipping/shifting inside the window, and tracks scroll, resize
// and size changes. It exposes `data-side` and `--available` (space on the
// chosen side) for styling.

import type { Attachment } from 'svelte/attachments';
import { computePosition, type Placement } from './position';

export function portal(target?: HTMLElement): Attachment<HTMLElement> {
  return (node) => {
    (target ?? document.body).appendChild(node);
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

/**
 * Calls `onDismiss` for pointer presses outside the node (and outside any
 * `ignore`d element, typically the anchor) and for Escape.
 */
export function dismissable(
  onDismiss: (reason: 'outside' | 'escape') => void,
  ignore: () => Array<Element | null | undefined> = () => [],
): Attachment<HTMLElement> {
  return (node) => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || node.contains(target)) return;
      if (ignore().some((el) => el?.contains(target))) return;
      onDismiss('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        onDismiss('escape');
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  };
}

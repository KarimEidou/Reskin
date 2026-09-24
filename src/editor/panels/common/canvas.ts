// Canvas helpers for panel previews: drawing straight-RGBA pixels crisply,
// device-pixel-aware sizing, and snapping elements to the device pixel grid
// so a 16 px icon covers exactly 16 × 16 device pixels.

import type { Attachment } from 'svelte/attachments';

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Draws an image into a canvas at its native size (canvas resized to match). */
export function putPixels(canvas: HTMLCanvasElement, img: PixelImage): void {
  if (canvas.width !== img.width) canvas.width = img.width;
  if (canvas.height !== img.height) canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(data, 0, 0);
}

/**
 * Draws an image scaled into a canvas whose backing store is `cssSize` ×
 * devicePixelRatio (smooth, high quality) — for thumbnails whose source
 * resolution differs from their display size.
 */
export function drawFitted(canvas: HTMLCanvasElement, img: PixelImage, cssSize: number, dpr = devicePixelRatio || 1): void {
  const px = Math.max(1, Math.round(cssSize * dpr));
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== px) canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, px, px);
  if (img.width === px && img.height === px) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return;
  }
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const k = Math.min(px / img.width, px / img.height);
  const w = img.width * k;
  const h = img.height * k;
  ctx.drawImage(src, (px - w) / 2, (px - h) / 2, w, h);
}

/**
 * Keeps an element's top-left corner on the device pixel grid (a
 * sub-pixel translate compensates for fractional layout positions), so
 * 1:1 canvases are never resampled by the compositor.
 */
export function snapToDevicePixels(): Attachment<HTMLElement> {
  return (node) => {
    let frame = 0;
    const update = () => {
      frame = 0;
      node.style.translate = '';
      const dpr = devicePixelRatio || 1;
      const r = node.getBoundingClientRect();
      const fx = r.left * dpr - Math.round(r.left * dpr);
      const fy = r.top * dpr - Math.round(r.top * dpr);
      if (Math.abs(fx) > 0.01 || Math.abs(fy) > 0.01) node.style.translate = `${-fx / dpr}px ${-fy / dpr}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    const ro = new ResizeObserver(schedule);
    ro.observe(node);
    if (node.parentElement) ro.observe(node.parentElement);
    window.addEventListener('resize', schedule);
    const mq = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', schedule);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      mq.removeEventListener('change', schedule);
    };
  };
}

/** A reactive devicePixelRatio (updates when the window moves between screens). */
export function watchDpr(onChange: (dpr: number) => void): () => void {
  let mq: MediaQueryList | null = null;
  const listen = () => {
    mq?.removeEventListener('change', handler);
    mq = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', handler);
  };
  const handler = () => {
    onChange(devicePixelRatio || 1);
    listen();
  };
  listen();
  return () => mq?.removeEventListener('change', handler);
}

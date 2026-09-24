// Images for the e2e fake backend, drawn at runtime with OffscreenCanvas so
// no binary fixtures ship: app-style icons per item kind, rescaled frames
// and a Windows-11-like wallpaper.

import type { ItemKind } from '$lib/ipc/types';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Deterministic 0..360 hue from a string (FNV-1a). */
export function hueFor(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function canvasToBase64(canvas: OffscreenCanvas, type = 'image/png', quality?: number): Promise<string> {
  const blob = await canvas.convertToBlob({ type, quality });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Glossy top highlight clipped to the current path. */
function gloss(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.clip();
  const g = ctx.createLinearGradient(0, y, 0, y + h * 0.55);
  g.addColorStop(0, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h * 0.55);
  ctx.restore();
}

function tile(ctx: Ctx, hue: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  roundRect(ctx, 20, 16, 216, 216, 54);
  const g = ctx.createLinearGradient(20, 16, 236, 232);
  g.addColorStop(0, `hsl(${hue} 88% 64%)`);
  g.addColorStop(1, `hsl(${(hue + 38) % 360} 78% 42%)`);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  roundRect(ctx, 20, 16, 216, 216, 54);
  gloss(ctx, 20, 16, 216, 216);
}

function letter(ctx: Ctx, text: string, y = 128, size = 128): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.font = `700 ${size}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, y + size * 0.04);
  ctx.restore();
}

function drawFolder(ctx: Ctx): void {
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#e59a1a';
  roundRect(ctx, 24, 44, 96, 48, 14);
  ctx.fill();
  roundRect(ctx, 24, 64, 208, 150, 18);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const g = ctx.createLinearGradient(0, 84, 0, 214);
  g.addColorStop(0, '#ffd46b');
  g.addColorStop(1, '#f5b02e');
  ctx.fillStyle = g;
  roundRect(ctx, 24, 84, 208, 130, 18);
  ctx.fill();
  roundRect(ctx, 24, 84, 208, 130, 18);
  gloss(ctx, 24, 84, 208, 130);
}

function drawPhoto(ctx: Ctx, hue: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  roundRect(ctx, 20, 36, 216, 176, 30);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  roundRect(ctx, 32, 48, 192, 152, 20);
  ctx.clip();
  const sky = ctx.createLinearGradient(0, 48, 0, 200);
  sky.addColorStop(0, `hsl(${hue} 80% 70%)`);
  sky.addColorStop(1, `hsl(${(hue + 40) % 360} 85% 88%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(32, 48, 192, 152);
  ctx.fillStyle = '#ffe27a';
  ctx.beginPath();
  ctx.arc(172, 92, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `hsl(${(hue + 150) % 360} 45% 38%)`;
  ctx.beginPath();
  ctx.moveTo(32, 200);
  ctx.lineTo(100, 110);
  ctx.lineTo(150, 170);
  ctx.lineTo(180, 140);
  ctx.lineTo(224, 200);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDocument(ctx: Ctx, hue: number, label: string): void {
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#fbfcff';
  ctx.beginPath();
  ctx.moveTo(56, 20);
  ctx.lineTo(160, 20);
  ctx.lineTo(208, 68);
  ctx.lineTo(208, 220);
  ctx.quadraticCurveTo(208, 236, 192, 236);
  ctx.lineTo(64, 236);
  ctx.quadraticCurveTo(48, 236, 48, 220);
  ctx.lineTo(48, 36);
  ctx.quadraticCurveTo(48, 20, 64, 20);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#d9dee8';
  ctx.beginPath();
  ctx.moveTo(160, 20);
  ctx.lineTo(160, 68);
  ctx.lineTo(208, 68);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = `hsl(${hue} 70% 52%)`;
  roundRect(ctx, 68, 150, 120, 56, 12);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 34px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.slice(0, 4).toUpperCase(), 128, 180);
  ctx.fillStyle = '#c3cad8';
  for (const y of [92, 112, 132]) {
    roundRect(ctx, 72, y, 112, 8, 4);
    ctx.fill();
  }
}

function drawGlobe(ctx: Ctx, hue: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 6;
  const g = ctx.createRadialGradient(100, 90, 20, 128, 128, 112);
  g.addColorStop(0, `hsl(${hue} 90% 68%)`);
  g.addColorStop(1, `hsl(${(hue + 30) % 360} 80% 38%)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(128, 124, 104, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.ellipse(128, 124, 44, 104, 0, 0, Math.PI * 2);
  ctx.moveTo(24, 124);
  ctx.lineTo(232, 124);
  ctx.moveTo(40, 72);
  ctx.quadraticCurveTo(128, 96, 216, 72);
  ctx.moveTo(40, 176);
  ctx.quadraticCurveTo(128, 152, 216, 176);
  ctx.stroke();
}

function drawMonitor(ctx: Ctx, hue: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#2b3140';
  roundRect(ctx, 20, 40, 216, 146, 18);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  const g = ctx.createLinearGradient(32, 52, 224, 174);
  g.addColorStop(0, `hsl(${hue} 85% 62%)`);
  g.addColorStop(1, `hsl(${(hue + 60) % 360} 80% 50%)`);
  ctx.fillStyle = g;
  roundRect(ctx, 32, 52, 192, 122, 10);
  ctx.fill();
  ctx.fillStyle = '#2b3140';
  roundRect(ctx, 104, 186, 48, 26, 4);
  ctx.fill();
  roundRect(ctx, 76, 208, 104, 14, 7);
  ctx.fill();
}

function drawSparkle(ctx: Ctx, hue: number): void {
  tile(ctx, hue);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(128, 56);
  ctx.bezierCurveTo(136, 112, 144, 120, 200, 128);
  ctx.bezierCurveTo(144, 136, 136, 144, 128, 200);
  ctx.bezierCurveTo(120, 144, 112, 136, 56, 128);
  ctx.bezierCurveTo(112, 120, 120, 112, 128, 56);
  ctx.fill();
}

export interface IconSpec {
  kind: ItemKind;
  /** Display name (drives colour and glyph). */
  name: string;
}

const iconCache = new Map<string, Promise<string>>();

/** A 256 px PNG data URL that looks like a plausible icon for the item. */
export function iconDataUrl(spec: IconSpec): Promise<string> {
  const key = `${spec.kind}:${spec.name}`;
  let cached = iconCache.get(key);
  if (!cached) {
    cached = (async () => {
      const canvas = new OffscreenCanvas(256, 256);
      const ctx = canvas.getContext('2d')!;
      const hue = hueFor(spec.name);
      const initial = (spec.name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
      switch (spec.kind) {
        case 'folder':
          drawFolder(ctx);
          break;
        case 'image':
          drawPhoto(ctx, hue);
          break;
        case 'file':
          drawDocument(ctx, hue, spec.name.split('.').pop() ?? 'file');
          break;
        case 'internetShortcut':
          drawGlobe(ctx, hue);
          break;
        case 'systemIcon':
          drawMonitor(ctx, hue);
          break;
        case 'project':
          drawSparkle(ctx, 262);
          break;
        default:
          tile(ctx, hue);
          letter(ctx, initial);
      }
      return `data:image/png;base64,${await canvasToBase64(canvas)}`;
    })();
    iconCache.set(key, cached);
  }
  return cached;
}

/** Decodes a data URL (or base64 PNG) into an ImageBitmap. */
async function bitmapFrom(src: string): Promise<ImageBitmap> {
  const url = src.startsWith('data:') ? src : `data:image/png;base64,${src}`;
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob);
}

/** Rescales an image (data URL or base64 PNG) to a `size` px base64 PNG. */
export async function scaledPngBase64(src: string, size: number): Promise<string> {
  const bitmap = await bitmapFrom(src);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();
  return canvasToBase64(canvas);
}

let wallpaperCache: Promise<ArrayBuffer> | null = null;

/** A 1920×1080 JPEG reminiscent of the Windows 11 "bloom" wallpaper. */
export function wallpaperBytes(): Promise<ArrayBuffer> {
  wallpaperCache ??= (async () => {
    const w = 1920;
    const h = 1080;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#0b1a3a');
    bg.addColorStop(1, '#050b1c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const petals: Array<[number, number, number, string]> = [
      [0.52, 0.55, 520, 'rgba(64,140,255,0.85)'],
      [0.62, 0.48, 380, 'rgba(120,90,255,0.6)'],
      [0.42, 0.62, 420, 'rgba(40,200,255,0.5)'],
      [0.56, 0.7, 300, 'rgba(255,255,255,0.18)'],
    ];
    for (const [x, y, r, color] of petals) {
      const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return blob.arrayBuffer();
  })();
  return wallpaperCache.then((b) => b.slice(0));
}

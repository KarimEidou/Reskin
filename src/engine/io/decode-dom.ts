// DOM ONLY. Decodes image files (PNG, JPEG, GIF, WebP, BMP, ICO, SVG) into
// straight-alpha surfaces for import — e.g. `IconFrame.png` from
// `item_frames`, dropped/pasted images, or a `data:` URL.

import { Surface } from '../raster/surface';
import { decodeBase64, decodeDataUrl } from '../util/base64';
import { createCanvas } from '../render/canvas-view';

export type ImageInput = Blob | ArrayBuffer | Uint8Array | string;

/** Best-effort MIME type from magic bytes. */
export function sniffImageType(bytes: Uint8Array): string {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    return 'image/webp';
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

function toBlob(input: ImageInput): Blob {
  if (input instanceof Blob) return input;
  let bytes: Uint8Array;
  if (typeof input === 'string') bytes = input.startsWith('data:') ? decodeDataUrl(input) : decodeBase64(input);
  else bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const copy = new Uint8Array(bytes); // own ArrayBuffer (BlobPart needs one)
  return new Blob([copy], { type: sniffImageType(copy) });
}

async function viaImageElement(blob: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Longest side a decoded image keeps; larger images are scaled down while decoding. */
export const MAX_DECODE_SIZE = 4096;

/**
 * Decodes an image to a surface. SVGs without intrinsic size render at
 * `fallbackSize`; images larger than `maxSize` on a side are scaled down
 * (aspect kept) so huge files cannot exhaust memory — everything is fitted
 * into the 512 document afterwards anyway. Rejects when the data is not a
 * decodable image.
 */
export async function decodeImage(
  input: ImageInput,
  fallbackSize = 512,
  maxSize = MAX_DECODE_SIZE,
): Promise<Surface> {
  if (typeof createImageBitmap !== 'function' && typeof Image === 'undefined') {
    throw new Error('Image decoding needs a browser environment');
  }
  const blob = toBlob(input);
  let source: CanvasImageSource & { width: number; height: number };
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    source = bitmap;
  } catch {
    // e.g. SVG in Chromium's createImageBitmap.
    source = await viaImageElement(blob);
  }
  try {
    const sw = source.width || fallbackSize;
    const sh = source.height || fallbackSize;
    const k = Math.min(1, maxSize / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k));
    const h = Math.max(1, Math.round(sh * k));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    return new Surface(w, h, data);
  } finally {
    bitmap?.close();
  }
}

// Keyline guides for Windows-style 256 px icons, as a design aid. They
// follow the common 256-unit app-icon keyline template: an 8 px safe
// margin, a Ø216 circle, a 192 square and 232×176 / 176×232 rectangles,
// all centred. Scaled to the document size by `keylines()`.

export type KeylineShape =
  | { kind: 'rect'; label: string; x: number; y: number; w: number; h: number; radius: number }
  | { kind: 'circle'; label: string; cx: number; cy: number; r: number };

/** In 256-unit icon space. */
export const KEYLINES_256: readonly KeylineShape[] = [
  { kind: 'rect', label: 'Safe area', x: 8, y: 8, w: 240, h: 240, radius: 0 },
  { kind: 'circle', label: 'Circle', cx: 128, cy: 128, r: 108 },
  { kind: 'rect', label: 'Square', x: 32, y: 32, w: 192, h: 192, radius: 16 },
  { kind: 'rect', label: 'Landscape', x: 12, y: 40, w: 232, h: 176, radius: 16 },
  { kind: 'rect', label: 'Portrait', x: 40, y: 12, w: 176, h: 232, radius: 16 },
];

/** Keylines scaled to a document of `size` px. */
export function keylines(size: number): KeylineShape[] {
  const k = size / 256;
  return KEYLINES_256.map((s) =>
    s.kind === 'rect'
      ? { ...s, x: s.x * k, y: s.y * k, w: s.w * k, h: s.h * k, radius: s.radius * k }
      : { ...s, cx: s.cx * k, cy: s.cy * k, r: s.r * k },
  );
}

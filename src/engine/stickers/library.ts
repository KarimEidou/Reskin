/**
 * The vector sticker set. Every sticker is drawn in a 100 × 100 box as one
 * or more colour layers; each layer is the union of filled SVG paths and
 * stroked polylines. Layer colours are either the sticker colour (`main`,
 * recolourable), a darker / lighter variant of it (`shade` / `tint`) or a
 * fixed CSS colour for details that must not follow the recolour (eyes…).
 */
import { roundPolygon } from '../backdrop/shapes';

export type StickerFillRule = 'nonzero' | 'evenodd';

/** A filled path (SVG path data in the 100 × 100 box). */
export interface StickerPathPart {
  d: string;
  rule?: StickerFillRule;
}

/** A stroked open or closed polyline (points in the 100 × 100 box). */
export interface StickerStrokePart {
  line: readonly number[];
  width: number;
  closed?: boolean;
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round';
}

export type StickerPart = StickerPathPart | StickerStrokePart;

/** `main` = the sticker colour; `shade` / `tint` = darker / lighter variants of it; anything else is a CSS colour. */
export type StickerColorRef = 'main' | 'shade' | 'tint' | (string & {});

export interface StickerLayer {
  parts: readonly StickerPart[];
  color: StickerColorRef;
  /** 0..1 (default 1). */
  opacity?: number;
}

export interface StickerDef {
  id: string;
  label: string;
  /** Search words (the label is always searched too). */
  keywords: readonly string[];
  /** Default colour (`#rrggbb`). */
  color: string;
  layers: readonly StickerLayer[];
}

// ---------------------------------------------------------------------------
// Geometry generators (all in the 100 × 100 box)
// ---------------------------------------------------------------------------

const f = (v: number) => String(Math.round(v * 100) / 100);

/** Closed polygon → path data. */
function polyPath(pts: readonly number[]): string {
  let s = `M${f(pts[0]!)} ${f(pts[1]!)}`;
  for (let i = 2; i < pts.length; i += 2) s += `L${f(pts[i]!)} ${f(pts[i + 1]!)}`;
  return `${s}Z`;
}

/** Polygon with filleted corners. */
function rounded(pts: readonly number[], r: number): string {
  return polyPath(roundPolygon([...pts], r));
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, rotDeg = 0, n = 96): number[] {
  const phi = (rotDeg * Math.PI) / 180;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    out.push(cx + x * c - y * s, cy + x * s + y * c);
  }
  return out;
}

function circle(cx: number, cy: number, r: number): string {
  return polyPath(ellipsePts(cx, cy, r, r));
}

function ellipse(cx: number, cy: number, rx: number, ry: number, rotDeg: number): string {
  return polyPath(ellipsePts(cx, cy, rx, ry, rotDeg));
}

/** Points along a circular arc (degrees, clockwise on screen for a1 > a0). */
function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, n = 48): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

function starPts(n: number, cx: number, cy: number, ro: number, ri: number, rotDeg = -90): number[] {
  const out: number[] = [];
  for (let k = 0; k < n * 2; k++) {
    const r = k % 2 === 0 ? ro : ri;
    const a = ((rotDeg + (k * 180) / n) * Math.PI) / 180;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

function gearPts(teeth: number, cx: number, cy: number, ro: number, rr: number): number[] {
  const out: number[] = [];
  const pitch = (Math.PI * 2) / teeth;
  for (let k = 0; k < teeth; k++) {
    const a = k * pitch - Math.PI / 2;
    // Tooth: narrower at the tip than at the root.
    const tip = pitch * 0.2;
    const root = pitch * 0.3;
    for (const [ang, r] of [
      [a - root, rr],
      [a - tip, ro],
      [a + tip, ro],
      [a + root, rr],
    ] as const) {
      out.push(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
    }
  }
  return out;
}

/** A radially scalloped disc (seal). */
function sealPts(cx: number, cy: number, r: number, bumps: number, depth: number, n = 360): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rad = r - depth + depth * Math.cos(t * bumps);
    out.push(cx + Math.cos(t - Math.PI / 2) * rad, cy + Math.sin(t - Math.PI / 2) * rad);
  }
  return out;
}

/** An arc stroke with an arrow head at its end (clockwise when a1 > a0). */
function arcArrow(cx: number, cy: number, r: number, a0: number, a1: number, width: number, head: number): StickerPart[] {
  const dir = Math.sign(a1 - a0) || 1;
  // Shorten the stroke so the head's base sits on the arc.
  const headDeg = ((head * 0.9) / r) * (180 / Math.PI);
  const end = a1 - dir * headDeg;
  const line = arcPts(cx, cy, r, a0, end);
  const ea = (a1 * Math.PI) / 180;
  const ba = (end * Math.PI) / 180;
  const tipX = cx + Math.cos(ea) * r;
  const tipY = cy + Math.sin(ea) * r;
  const bx = cx + Math.cos(ba) * r;
  const by = cy + Math.sin(ba) * r;
  // Head base perpendicular to the radius at the base point.
  const nx = Math.cos(ba);
  const ny = Math.sin(ba);
  const w = head * 0.95;
  return [
    { line, width, cap: 'round', join: 'round' },
    { d: rounded([tipX + (tipX - bx) * 0.25, tipY + (tipY - by) * 0.25, bx + nx * w, by + ny * w, bx - nx * w, by - ny * w], 2) },
  ];
}

function rect(x: number, y: number, w: number, h: number, r = 0): string {
  return r > 0 ? rounded([x, y, x + w, y, x + w, y + h, x, y + h], r) : polyPath([x, y, x + w, y, x + w, y + h, x, y + h]);
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

const sunRays: StickerPart[] = Array.from({ length: 8 }, (_, k) => {
  const a = (k * Math.PI) / 4 - Math.PI / 2;
  return {
    line: [50 + Math.cos(a) * 33, 50 + Math.sin(a) * 33, 50 + Math.cos(a) * 45, 50 + Math.sin(a) * 45],
    width: 9,
    cap: 'round' as const,
  };
});

export const STICKERS: readonly StickerDef[] = [
  {
    id: 'star',
    label: 'Star',
    keywords: ['favourite', 'favorite', 'rating', 'gold'],
    color: '#ffc83d',
    layers: [
      { color: 'main', parts: [{ d: rounded(starPts(5, 50, 54, 48, 21), 4) }] },
      { color: 'tint', parts: [{ d: rounded([50, 16, 59.5, 40.5, 50, 50, 40.5, 40.5], 1.5) }], opacity: 0.8 },
    ],
  },
  {
    id: 'heart',
    label: 'Heart',
    keywords: ['love', 'like', 'favourite', 'valentine'],
    color: '#ff4d6d',
    layers: [
      {
        color: 'main',
        parts: [
          {
            d: 'M50 92 C21 72 5 54 5 34 C5 19 16 9 30 9 C39 9 46 14 50 21 C54 14 61 9 70 9 C84 9 95 19 95 34 C95 54 79 72 50 92Z',
          },
        ],
      },
      { color: '#ffffff', opacity: 0.55, parts: [{ line: [18, 38, 19, 30, 24, 23, 31, 20], width: 6, cap: 'round', join: 'round' }] },
    ],
  },
  {
    id: 'sparkle',
    label: 'Sparkle',
    keywords: ['shine', 'magic', 'new', 'twinkle', 'star'],
    color: '#ffd43b',
    layers: [
      {
        color: 'main',
        parts: [
          { d: 'M44 8 C47 36 60 49 88 52 C60 55 47 68 44 96 C41 68 28 55 2 52 C28 49 41 36 44 8Z' },
          { d: 'M82 4 C83 12 86 15 95 16 C86 17 83 20 82 28 C81 20 78 17 69 16 C78 15 81 12 82 4Z' },
        ],
      },
    ],
  },
  {
    id: 'check',
    label: 'Check',
    keywords: ['done', 'ok', 'yes', 'tick', 'success'],
    color: '#2fbf71',
    layers: [{ color: 'main', parts: [{ line: [14, 53, 39, 78, 86, 26], width: 17, cap: 'round', join: 'round' }] }],
  },
  {
    id: 'cross',
    label: 'Cross',
    keywords: ['no', 'close', 'x', 'delete', 'error'],
    color: '#ff5a5f',
    layers: [
      {
        color: 'main',
        parts: [
          { line: [20, 20, 80, 80], width: 17, cap: 'round' },
          { line: [80, 20, 20, 80], width: 17, cap: 'round' },
        ],
      },
    ],
  },
  {
    id: 'plus',
    label: 'Plus',
    keywords: ['add', 'new', 'more', 'positive'],
    color: '#4dabf7',
    layers: [
      {
        color: 'main',
        parts: [
          { line: [50, 12, 50, 88], width: 20, cap: 'round' },
          { line: [12, 50, 88, 50], width: 20, cap: 'round' },
        ],
      },
    ],
  },
  {
    id: 'bolt',
    label: 'Bolt',
    keywords: ['lightning', 'flash', 'power', 'energy', 'fast', 'zap'],
    color: '#ffc400',
    layers: [
      { color: 'main', parts: [{ d: rounded([60, 4, 16, 58, 46, 58, 38, 96, 84, 40, 54, 40, 64, 4], 3) }] },
      { color: 'tint', opacity: 0.85, parts: [{ d: rounded([55, 12, 26, 52, 44, 52], 1.5) }] },
    ],
  },
  {
    id: 'crown',
    label: 'Crown',
    keywords: ['king', 'queen', 'royal', 'premium', 'best'],
    color: '#ffc83d',
    layers: [
      {
        color: 'main',
        parts: [
          { d: rounded([14, 76, 8, 32, 31, 52, 50, 18, 69, 52, 92, 32, 86, 76], 3) },
          { d: circle(8, 30, 6) },
          { d: circle(50, 15, 6) },
          { d: circle(92, 30, 6) },
        ],
      },
      { color: 'shade', parts: [{ d: rect(13, 81, 74, 12, 3.5) }] },
      { color: '#ff6b6b', parts: [{ d: circle(50, 60, 7) }] },
    ],
  },
  {
    id: 'flame',
    label: 'Flame',
    keywords: ['fire', 'hot', 'trending', 'lit', 'burn'],
    color: '#ff6b2c',
    layers: [
      {
        color: 'main',
        parts: [
          {
            d: 'M50 97 C27 97 12 81 12 61 C12 42 25 33 31 13 C41 21 46 30 47 41 C53 35 56 25 55 16 C73 28 88 45 88 64 C88 83 72 97 50 97Z',
          },
        ],
      },
      {
        color: '#ffd166',
        parts: [
          {
            d: 'M50 90 C39 90 32 82 32 72 C32 61 40 55 44 45 C51 53 55 58 57 65 C61 61 63 57 63 52 C69 58 68 70 68 73 C68 83 60 90 50 90Z',
          },
        ],
      },
    ],
  },
  {
    id: 'drop',
    label: 'Drop',
    keywords: ['water', 'rain', 'liquid', 'tear'],
    color: '#3b9dff',
    layers: [
      { color: 'main', parts: [{ d: 'M50 4 C50 4 17 42 17 64 C17 83 32 97 50 97 C68 97 83 83 83 64 C83 42 50 4 50 4Z' }] },
      { color: '#ffffff', opacity: 0.6, parts: [{ line: [30, 62, 31, 71, 35, 79, 42, 85], width: 6, cap: 'round', join: 'round' }] },
    ],
  },
  {
    id: 'leaf',
    label: 'Leaf',
    keywords: ['nature', 'eco', 'green', 'plant'],
    color: '#40c057',
    layers: [
      { color: 'main', parts: [{ d: 'M90 8 C44 6 12 32 12 64 C12 80 22 90 36 92 C66 96 91 70 91 36 C91 26 91 16 90 8Z' }] },
      { color: 'shade', parts: [{ line: [8, 96, 22, 82, 42, 62, 62, 40, 80, 20], width: 5, cap: 'round', join: 'round' }] },
    ],
  },
  {
    id: 'moon',
    label: 'Moon',
    keywords: ['night', 'dark', 'sleep', 'crescent'],
    color: '#ffe066',
    layers: [
      {
        color: 'main',
        parts: [
          {
            d: 'M64 5 C38 9 17 31 17 56 C17 80 38 97 63 97 C76 97 87 92 95 83 C89 85 83 86 77 86 C52 86 33 67 33 44 C33 28 45 12 64 5Z',
          },
        ],
      },
    ],
  },
  {
    id: 'sun',
    label: 'Sun',
    keywords: ['day', 'light', 'summer', 'weather', 'bright'],
    color: '#ffb703',
    layers: [{ color: 'main', parts: [{ d: circle(50, 50, 23) }, ...sunRays] }],
  },
  {
    id: 'cloud',
    label: 'Cloud',
    keywords: ['weather', 'sky', 'storage', 'upload'],
    color: '#74c0fc',
    layers: [
      {
        color: 'main',
        parts: [
          {
            d: 'M27 82 H74 C86 82 95 73 95 61 C95 49 86 40 75 40 C73 27 62 18 49 18 C35 18 25 28 23 41 C12 43 5 52 5 62 C5 73 14 82 27 82Z',
          },
        ],
      },
      { color: '#ffffff', opacity: 0.45, parts: [{ line: [30, 44, 33, 36, 40, 30, 48, 28], width: 5.5, cap: 'round', join: 'round' }] },
    ],
  },
  {
    id: 'music',
    label: 'Music',
    keywords: ['note', 'song', 'audio', 'sound', 'play'],
    color: '#9775fa',
    layers: [
      {
        color: 'main',
        parts: [
          { d: 'M36 20 L90 7 V21 L36 34Z' },
          { d: rect(36, 24, 8, 58) },
          { d: rect(82, 10, 8, 60) },
          { d: ellipse(27, 81, 15, 11, -22) },
          { d: ellipse(73, 69, 15, 11, -22) },
        ],
      },
    ],
  },
  {
    id: 'gear',
    label: 'Gear',
    keywords: ['settings', 'cog', 'options', 'config', 'tools'],
    color: '#748ffc',
    layers: [{ color: 'main', parts: [{ d: rounded(gearPts(8, 50, 50, 46, 35), 2.5) + circle(50, 50, 14), rule: 'evenodd' }] }],
  },
  {
    id: 'arrow-right',
    label: 'Arrow right',
    keywords: ['next', 'forward', 'go', 'direction'],
    color: '#4dabf7',
    layers: [{ color: 'main', parts: [{ d: rounded([8, 38, 50, 38, 50, 14, 94, 50, 50, 86, 50, 62, 8, 62], 4) }] }],
  },
  {
    id: 'arrow-up',
    label: 'Arrow up',
    keywords: ['up', 'upload', 'increase', 'direction'],
    color: '#51cf66',
    layers: [{ color: 'main', parts: [{ d: rounded([38, 94, 38, 50, 14, 50, 50, 6, 86, 50, 62, 50, 62, 94], 4) }] }],
  },
  {
    id: 'refresh',
    label: 'Arrows',
    keywords: ['refresh', 'sync', 'reload', 'cycle', 'repeat', 'arrows'],
    color: '#20c997',
    layers: [
      {
        color: 'main',
        parts: [...arcArrow(50, 50, 34, 200, 330, 11, 13), ...arcArrow(50, 50, 34, 20, 150, 11, 13)],
      },
    ],
  },
  {
    id: 'speech',
    label: 'Speech bubble',
    keywords: ['chat', 'message', 'comment', 'talk', 'bubble'],
    color: '#4dabf7',
    layers: [
      {
        color: 'main',
        parts: [
          {
            d: 'M20 10 H80 C89 10 95 16 95 25 V57 C95 66 89 72 80 72 H46 L25 91 C22 93 20 92 21 89 L26 72 H20 C11 72 5 66 5 57 V25 C5 16 11 10 20 10Z',
          },
        ],
      },
      { color: '#ffffff', parts: [{ d: circle(30, 41, 6.5) }, { d: circle(50, 41, 6.5) }, { d: circle(70, 41, 6.5) }] },
    ],
  },
  {
    id: 'badge',
    label: 'Badge',
    keywords: ['verified', 'seal', 'check', 'approved', 'certified'],
    color: '#3b82f6',
    layers: [
      { color: 'main', parts: [{ d: polyPath(sealPts(50, 50, 47, 12, 4.5)) }] },
      { color: '#ffffff', parts: [{ line: [31, 52, 44, 65, 70, 37], width: 10, cap: 'round', join: 'round' }] },
    ],
  },
  {
    id: 'ribbon',
    label: 'Ribbon',
    keywords: ['award', 'medal', 'prize', 'winner', 'first'],
    color: '#f59f00',
    layers: [
      {
        color: 'shade',
        parts: [{ d: rounded([30, 52, 15, 92, 30, 86, 39, 98, 50, 62], 2) }, { d: rounded([70, 52, 85, 92, 70, 86, 61, 98, 50, 62], 2) }],
      },
      { color: 'main', parts: [{ d: circle(50, 38, 32) }] },
      { color: 'tint', parts: [{ d: circle(50, 38, 21) }] },
      { color: 'main', parts: [{ d: rounded(starPts(5, 50, 39.5, 14, 6.2), 1.2) }] },
    ],
  },
  {
    id: 'shield',
    label: 'Shield',
    keywords: ['security', 'protect', 'safe', 'guard'],
    color: '#5c7cfa',
    layers: [
      { color: 'main', parts: [{ d: 'M50 4 L88 17 V45 C88 70 72 88 50 96 C28 88 12 70 12 45 V17Z' }] },
      { color: 'shade', parts: [{ d: 'M50 4 L88 17 V45 C88 70 72 88 50 96Z' }] },
    ],
  },
  {
    id: 'trophy',
    label: 'Trophy',
    keywords: ['cup', 'win', 'champion', 'award', 'prize'],
    color: '#fab005',
    layers: [
      {
        color: 'main',
        parts: [
          { d: 'M25 6 H75 V33 C75 48 64 59 50 59 C36 59 25 48 25 33Z' },
          { line: arcPts(25, 24, 13, 90, 270), width: 7, cap: 'round' },
          { line: arcPts(75, 24, 13, -90, 90), width: 7, cap: 'round' },
          { d: rect(44, 56, 12, 20) },
        ],
      },
      { color: 'shade', parts: [{ d: 'M31 76 H69 C72 76 75 79 75 82 V94 H25 V82 C25 79 28 76 31 76Z' }] },
      { color: 'tint', parts: [{ d: rounded(starPts(5, 50, 29, 12, 5.3), 1) }] },
    ],
  },
  {
    id: 'bookmark',
    label: 'Bookmark',
    keywords: ['save', 'favourite', 'favorite', 'later', 'tag'],
    color: '#fa5252',
    layers: [{ color: 'main', parts: [{ d: 'M24 5 H76 C79 5 81 7 81 10 V95 L50 73 L19 95 V10 C19 7 21 5 24 5Z' }] }],
  },
  {
    id: 'pin',
    label: 'Pin',
    keywords: ['location', 'map', 'place', 'marker', 'gps'],
    color: '#fa5252',
    layers: [
      { color: 'main', parts: [{ d: 'M50 97 C50 97 15 60 15 38 C15 18 31 3 50 3 C69 3 85 18 85 38 C85 60 50 97 50 97Z' }] },
      { color: '#ffffff', parts: [{ d: circle(50, 38, 14) }] },
    ],
  },
  {
    id: 'flag',
    label: 'Flag',
    keywords: ['goal', 'finish', 'report', 'country', 'milestone'],
    color: '#e03131',
    layers: [
      { color: 'shade', parts: [{ line: [18, 94, 18, 8], width: 7, cap: 'round' }] },
      { color: 'main', parts: [{ d: 'M23 10 C38 3 51 16 66 12 C74 10 80 8 88 8 V53 C80 53 74 55 66 57 C51 61 38 48 23 54Z' }] },
    ],
  },
  {
    id: 'bell',
    label: 'Bell',
    keywords: ['notification', 'alert', 'alarm', 'ring', 'reminder'],
    color: '#fcc419',
    layers: [
      {
        color: 'main',
        parts: [
          { d: 'M50 10 C31 10 21 25 21 43 V59 L11 73 C10 75 11 79 14 79 H86 C89 79 90 75 89 73 L79 59 V43 C79 25 69 10 50 10Z' },
          { d: circle(50, 9, 6) },
        ],
      },
      { color: 'shade', parts: [{ d: circle(50, 87, 9) }] },
    ],
  },
  {
    id: 'gem',
    label: 'Gem',
    keywords: ['diamond', 'jewel', 'premium', 'crystal', 'value'],
    color: '#22b8cf',
    layers: [
      { color: 'main', parts: [{ d: rounded([28, 10, 72, 10, 95, 36, 50, 94, 5, 36], 2.5) }] },
      { color: 'tint', parts: [{ d: rounded([28, 10, 72, 10, 63, 36, 37, 36], 1.5) }] },
      { color: 'shade', parts: [{ d: rounded([63, 36, 95, 36, 50, 94], 1.5) }] },
    ],
  },
  {
    id: 'home',
    label: 'Home',
    keywords: ['house', 'start', 'main', 'building'],
    color: '#4dabf7',
    layers: [
      { color: 'main', parts: [{ d: rounded([50, 7, 95, 47, 83, 47, 83, 92, 61, 92, 61, 64, 39, 64, 39, 92, 17, 92, 17, 47, 5, 47], 3) }] },
    ],
  },
  {
    id: 'smile',
    label: 'Smile',
    keywords: ['happy', 'face', 'smiley', 'emoji', 'joy'],
    color: '#ffd43b',
    layers: [
      { color: 'main', parts: [{ d: circle(50, 50, 46) }] },
      {
        color: '#343a40',
        parts: [{ d: ellipse(35, 39, 6, 8, 0) }, { d: ellipse(65, 39, 6, 8, 0) }, { line: arcPts(50, 50, 27, 25, 155), width: 7, cap: 'round' }],
      },
    ],
  },
  {
    id: 'lock',
    label: 'Lock',
    keywords: ['secure', 'private', 'password', 'closed', 'safe'],
    color: '#845ef7',
    layers: [
      { color: 'shade', parts: [{ line: [30, 46, ...arcPts(50, 30, 20, 180, 360), 70, 46], width: 10, cap: 'round', join: 'round' }] },
      { color: 'main', parts: [{ d: rect(14, 42, 72, 54, 10) }] },
      { color: 'shade', parts: [{ d: circle(50, 64, 8) }, { d: rect(46.5, 64, 7, 16, 3) }] },
    ],
  },
];

const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));

export function getSticker(id: string): StickerDef | undefined {
  return BY_ID.get(id);
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
}

/** Stickers whose label or keywords contain every word of `query` (all when empty). */
export function searchStickers(query: string): StickerDef[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...STICKERS];
  return STICKERS.filter((s) => {
    const hay = [s.id, s.label, ...s.keywords].map(norm).join(' ');
    return words.every((w) => hay.includes(w));
  });
}

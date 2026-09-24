/**
 * Emoji stamps: a curated list of common emoji with search words, and a
 * canvas-based renderer (system colour-emoji font through OffscreenCanvas).
 * The renderer returns null where no canvas exists (node), so callers can
 * hide the emoji grid gracefully.
 */
import { createPixels, type Pixels } from '../filters/types';

export interface EmojiDef {
  char: string;
  name: string;
  keywords: readonly string[];
  group: EmojiGroup;
}

export type EmojiGroup = 'smileys' | 'gestures' | 'hearts' | 'nature' | 'food' | 'objects' | 'symbols';

export const EMOJI_GROUPS: readonly { id: EmojiGroup; label: string }[] = [
  { id: 'smileys', label: 'Smileys' },
  { id: 'gestures', label: 'Gestures' },
  { id: 'hearts', label: 'Hearts' },
  { id: 'nature', label: 'Nature' },
  { id: 'food', label: 'Food' },
  { id: 'objects', label: 'Objects' },
  { id: 'symbols', label: 'Symbols' },
];

type Row = [char: string, name: string, keywords: string];

const RAW: Record<EmojiGroup, Row[]> = {
  smileys: [
    ['😀', 'grinning', 'smile happy joy'],
    ['😃', 'smiley', 'happy open mouth'],
    ['😄', 'smile', 'happy laugh'],
    ['😁', 'beaming', 'grin teeth'],
    ['😆', 'laughing', 'haha lol'],
    ['😅', 'sweat smile', 'relief nervous'],
    ['😂', 'tears of joy', 'lol laugh crying'],
    ['🙂', 'slight smile', 'ok fine'],
    ['😉', 'wink', 'flirt joke'],
    ['😊', 'blush', 'happy shy'],
    ['😇', 'halo', 'angel innocent'],
    ['🥰', 'in love', 'hearts adore'],
    ['😍', 'heart eyes', 'love crush'],
    ['🤩', 'star struck', 'wow amazing'],
    ['😘', 'kiss', 'love'],
    ['😋', 'yum', 'tasty delicious'],
    ['😎', 'cool', 'sunglasses'],
    ['🤓', 'nerd', 'geek glasses'],
    ['🧐', 'monocle', 'curious inspect'],
    ['🤔', 'thinking', 'hmm wonder'],
    ['🤫', 'shush', 'quiet secret'],
    ['😴', 'sleeping', 'tired zzz'],
    ['🤯', 'mind blown', 'shocked explode'],
    ['😱', 'scream', 'fear shock'],
    ['🥳', 'party', 'celebrate birthday'],
    ['😢', 'crying', 'sad tear'],
    ['😡', 'angry', 'mad rage'],
    ['🤖', 'robot', 'bot ai machine'],
    ['👻', 'ghost', 'boo halloween'],
    ['👽', 'alien', 'ufo space'],
    ['💀', 'skull', 'dead danger'],
    ['🎃', 'pumpkin', 'halloween jack'],
  ],
  gestures: [
    ['👍', 'thumbs up', 'like yes ok approve'],
    ['👎', 'thumbs down', 'dislike no'],
    ['👏', 'clap', 'applause bravo'],
    ['🙌', 'raised hands', 'hooray celebrate'],
    ['👋', 'wave', 'hello hi bye'],
    ['✌️', 'victory', 'peace'],
    ['🤞', 'fingers crossed', 'luck hope'],
    ['👌', 'ok hand', 'perfect fine'],
    ['🤘', 'rock on', 'metal horns'],
    ['👉', 'point right', 'this direction'],
    ['💪', 'muscle', 'strong power flex'],
    ['🙏', 'pray', 'please thanks'],
    ['✍️', 'writing', 'write note'],
    ['👀', 'eyes', 'look see watch'],
    ['🧠', 'brain', 'smart think mind'],
  ],
  hearts: [
    ['❤️', 'red heart', 'love like'],
    ['🧡', 'orange heart', 'love'],
    ['💛', 'yellow heart', 'love friendship'],
    ['💚', 'green heart', 'love nature'],
    ['💙', 'blue heart', 'love trust'],
    ['💜', 'purple heart', 'love'],
    ['🖤', 'black heart', 'love dark'],
    ['🤍', 'white heart', 'love pure'],
    ['💖', 'sparkling heart', 'love shine'],
    ['💔', 'broken heart', 'sad breakup'],
    ['💯', 'hundred', 'perfect score full'],
    ['💥', 'boom', 'explosion collision'],
  ],
  nature: [
    ['🐱', 'cat', 'kitten pet meow'],
    ['🐶', 'dog', 'puppy pet woof'],
    ['🦊', 'fox', 'animal'],
    ['🐼', 'panda', 'bear animal'],
    ['🦄', 'unicorn', 'magic fantasy'],
    ['🐧', 'penguin', 'bird linux'],
    ['🦋', 'butterfly', 'insect pretty'],
    ['🐝', 'bee', 'honey insect'],
    ['🐢', 'turtle', 'slow animal'],
    ['🐙', 'octopus', 'sea animal'],
    ['🐳', 'whale', 'sea ocean docker'],
    ['🦖', 'dinosaur', 't-rex dino'],
    ['🌵', 'cactus', 'desert plant'],
    ['🌸', 'blossom', 'flower spring pink'],
    ['🌻', 'sunflower', 'flower summer'],
    ['🍀', 'clover', 'luck four leaf'],
    ['🌈', 'rainbow', 'colours pride weather'],
    ['⭐', 'star', 'favourite night'],
    ['🌙', 'moon', 'night crescent'],
    ['☀️', 'sun', 'weather day'],
    ['⚡', 'lightning', 'bolt power'],
    ['🔥', 'fire', 'hot flame lit'],
    ['❄️', 'snowflake', 'cold winter'],
    ['🌊', 'wave', 'ocean sea water'],
    ['🌍', 'globe', 'earth world'],
    ['🪐', 'planet', 'saturn space'],
  ],
  food: [
    ['🍎', 'apple', 'fruit red'],
    ['🍋', 'lemon', 'fruit sour'],
    ['🍉', 'watermelon', 'fruit summer'],
    ['🍓', 'strawberry', 'fruit berry'],
    ['🥑', 'avocado', 'fruit green'],
    ['🍕', 'pizza', 'food slice'],
    ['🍔', 'burger', 'food hamburger'],
    ['🍟', 'fries', 'food chips'],
    ['🌮', 'taco', 'food mexican'],
    ['🍩', 'donut', 'sweet dessert'],
    ['🍪', 'cookie', 'sweet biscuit'],
    ['🎂', 'cake', 'birthday party'],
    ['🍦', 'ice cream', 'dessert sweet'],
    ['☕', 'coffee', 'drink hot tea'],
    ['🍵', 'tea', 'drink green'],
    ['🍺', 'beer', 'drink'],
  ],
  objects: [
    ['🎮', 'game', 'controller play gaming'],
    ['🕹️', 'joystick', 'arcade game'],
    ['🎧', 'headphones', 'music audio'],
    ['🎵', 'music', 'note song'],
    ['🎨', 'palette', 'art paint design'],
    ['📷', 'camera', 'photo picture'],
    ['🎬', 'clapper', 'movie film video'],
    ['📚', 'books', 'read library study'],
    ['📝', 'memo', 'note write'],
    ['📁', 'folder', 'files directory'],
    ['📌', 'pushpin', 'pin location'],
    ['📎', 'paperclip', 'attach'],
    ['🔒', 'lock', 'secure private'],
    ['🔑', 'key', 'password unlock'],
    ['⚙️', 'gear', 'settings cog'],
    ['🔧', 'wrench', 'tool fix'],
    ['🔨', 'hammer', 'tool build'],
    ['💡', 'bulb', 'idea light'],
    ['🔋', 'battery', 'power energy'],
    ['💻', 'laptop', 'computer pc'],
    ['🖥️', 'desktop', 'computer monitor'],
    ['📱', 'phone', 'mobile'],
    ['⌨️', 'keyboard', 'type'],
    ['🖱️', 'mouse', 'computer click'],
    ['💾', 'floppy', 'save disk'],
    ['📦', 'package', 'box parcel'],
    ['🚀', 'rocket', 'launch space fast'],
    ['✈️', 'airplane', 'travel flight'],
    ['🚗', 'car', 'drive vehicle'],
    ['🏠', 'house', 'home'],
    ['🏆', 'trophy', 'win award'],
    ['🎁', 'gift', 'present box'],
    ['🎉', 'party popper', 'celebrate tada'],
    ['🎈', 'balloon', 'party'],
    ['💎', 'gem', 'diamond jewel'],
    ['🧩', 'puzzle', 'piece game'],
    ['🛒', 'cart', 'shopping store'],
    ['💰', 'money', 'bag cash'],
    ['⏰', 'alarm', 'clock time'],
    ['🔔', 'bell', 'notification'],
    ['✉️', 'envelope', 'mail email letter'],
    ['🗑️', 'wastebasket', 'trash delete bin'],
  ],
  symbols: [
    ['✅', 'check', 'done yes ok'],
    ['❌', 'cross', 'no wrong'],
    ['⚠️', 'warning', 'caution alert'],
    ['⛔', 'no entry', 'stop forbidden'],
    ['❓', 'question', 'help what'],
    ['❗', 'exclamation', 'important alert'],
    ['➕', 'plus', 'add'],
    ['♻️', 'recycle', 'eco green'],
    ['✨', 'sparkles', 'shine new magic'],
    ['🔴', 'red circle', 'dot record'],
    ['🟢', 'green circle', 'dot online'],
    ['🔵', 'blue circle', 'dot'],
    ['🆕', 'new', 'button'],
    ['🆗', 'ok', 'button'],
    ['🔝', 'top', 'arrow up'],
    ['▶️', 'play', 'start video'],
  ],
};

export const EMOJI: readonly EmojiDef[] = (Object.keys(RAW) as EmojiGroup[]).flatMap((group) =>
  RAW[group].map(([char, name, keywords]) => ({ char, name, keywords: keywords.split(' '), group })),
);

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
}

/** Emoji whose name or keywords contain every word of `query` (all when empty). */
export function searchEmoji(query: string): EmojiDef[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...EMOJI];
  return EMOJI.filter((e) => {
    const hay = [e.name, ...e.keywords, e.group].map(norm).join(' ');
    return words.every((w) => hay.includes(w));
  });
}

/** Colour-emoji font stack (Windows first). */
export const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';

/** True where emoji can be rasterized (a 2D OffscreenCanvas exists). */
export function canRenderEmoji(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    return new OffscreenCanvas(1, 1).getContext('2d') !== null;
  } catch {
    return false;
  }
}

export interface EmojiRenderOptions {
  /** Output canvas size (square), px. */
  size: number;
  /** Target size of the glyph's ink box, px (default 80 % of `size`). */
  box?: number;
  cx?: number;
  cy?: number;
}

/**
 * Rasterizes an emoji centred on a transparent size × size image, scaled so
 * its visible ink fits `box`. Null when no canvas is available.
 */
export function renderEmoji(char: string, opts: EmojiRenderOptions): Pixels | null {
  if (!canRenderEmoji()) return null;
  const size = Math.round(opts.size);
  if (!Number.isInteger(size) || size < 1 || size > 4096) throw new RangeError(`invalid emoji size ${opts.size}`);
  const box = opts.box ?? size * 0.8;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // Measure at a reference size, then scale the font so the ink box fits.
  const ref = 100;
  ctx.font = `${ref}px ${EMOJI_FONT}`;
  const m = ctx.measureText(char);
  const inkW = Math.max(1, m.actualBoundingBoxLeft + m.actualBoundingBoxRight);
  const inkH = Math.max(1, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent);
  const k = box / Math.max(inkW, inkH);
  const px = ref * k;
  ctx.font = `${px}px ${EMOJI_FONT}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const left = m.actualBoundingBoxLeft * k;
  const ascent = m.actualBoundingBoxAscent * k;
  const cx = opts.cx ?? size / 2;
  const cy = opts.cy ?? size / 2;
  // Ink centre → (cx, cy).
  const x = cx - (inkW * k) / 2 + left;
  const y = cy - (inkH * k) / 2 + ascent;
  ctx.fillText(char, x, y);
  const img = ctx.getImageData(0, 0, size, size);
  const out = createPixels(size, size);
  out.data.set(img.data);
  return out;
}

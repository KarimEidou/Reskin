// Standard (RFC 4648, padded) base64 for byte arrays. Works identically in
// the browser and in Node without going through binary strings, so large
// buffers do not hit argument-count or string-size limits.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const ENCODE = new Uint8Array(64);
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) {
  ENCODE[i] = ALPHABET.charCodeAt(i);
  DECODE[ALPHABET.charCodeAt(i)] = i;
}
// Accept the URL-safe alphabet on input as well.
DECODE['-'.charCodeAt(0)] = 62;
DECODE['_'.charCodeAt(0)] = 63;

const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = ENCODE[(v >> 18) & 63];
    out[o++] = ENCODE[(v >> 12) & 63];
    out[o++] = ENCODE[(v >> 6) & 63];
    out[o++] = ENCODE[v & 63];
  }
  const rest = n - i;
  if (rest === 1) {
    const v = bytes[i] << 16;
    out[o++] = ENCODE[(v >> 18) & 63];
    out[o++] = ENCODE[(v >> 12) & 63];
    out[o++] = 61; // '='
    out[o++] = 61;
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out[o++] = ENCODE[(v >> 18) & 63];
    out[o++] = ENCODE[(v >> 12) & 63];
    out[o++] = ENCODE[(v >> 6) & 63];
    out[o++] = 61;
  }
  let s = '';
  for (let c = 0; c < out.length; c += CHUNK) {
    s += String.fromCharCode.apply(null, out.subarray(c, c + CHUNK) as unknown as number[]);
  }
  return s;
}

/** Decodes base64 (padding optional, whitespace ignored). Throws on bad input. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/[\s=]+/g, '');
  const n = clean.length;
  if (n % 4 === 1) throw new Error('Invalid base64 length');
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? DECODE[c] : -1;
    if (v < 0) throw new Error(`Invalid base64 character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.slice(0, o);
}

/** `data:<mime>;base64,<...>` → bytes. Also accepts a bare base64 string. */
export function decodeDataUrl(url: string): Uint8Array<ArrayBuffer> {
  const comma = url.startsWith('data:') ? url.indexOf(',') : -1;
  return decodeBase64(comma >= 0 ? url.slice(comma + 1) : url);
}

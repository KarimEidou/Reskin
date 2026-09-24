// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) as used by PNG.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Continues a running CRC (pass the previous result as `crc`). */
export function crc32Update(crc: number, bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = ~crc >>> 0;
  for (let i = start; i < end; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  return crc32Update(0, bytes, start, end);
}

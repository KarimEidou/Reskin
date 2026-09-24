// zlib (RFC 1950) compression through the platform Compression Streams API,
// available in Chromium/WebView2 and Node >= 18. `'deflate'` is the zlib
// wrapper format — exactly what PNG IDAT chunks and .reskin pixel blobs use.

type ByteStream = CompressionStream | DecompressionStream;

/** Thrown by `inflate` when the output would exceed its `maxBytes`. */
export class OutputLimitError extends RangeError {
  constructor(limit: number) {
    super(`Decompressed data exceeds ${limit} bytes`);
    this.name = 'OutputLimitError';
  }
}

async function pump(bytes: Uint8Array, stream: ByteStream, maxBytes = Infinity): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  // Write and read concurrently so large inputs cannot deadlock on
  // back-pressure. The write promise is observed so a failure (e.g. corrupt
  // input to the decompressor) surfaces through the reader instead of as an
  // unhandled rejection.
  const writing = writer
    .write(toArrayBufferView(bytes))
    .then(() => writer.close());
  writing.catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      // Stop decompressing right away (zip bombs) instead of after the fact.
      await reader.cancel().catch(() => undefined);
      throw new OutputLimitError(maxBytes);
    }
    chunks.push(value);
  }
  await writing;
  if (chunks.length === 1) return chunks[0] as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  // SharedArrayBuffer-backed views are not valid BufferSources; copy those.
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

function requireStreams(): void {
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
    throw new Error('Compression Streams API is not available in this environment');
  }
}

/** zlib-deflates `bytes`. */
export function deflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  requireStreams();
  return pump(bytes, new CompressionStream('deflate'));
}

/**
 * Inflates zlib data; rejects on corrupt input, and with `OutputLimitError`
 * as soon as the output grows past `maxBytes` (use it for untrusted data).
 */
export function inflate(bytes: Uint8Array, maxBytes = Infinity): Promise<Uint8Array<ArrayBuffer>> {
  requireStreams();
  return pump(bytes, new DecompressionStream('deflate'), maxBytes);
}

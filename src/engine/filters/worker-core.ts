/**
 * The filter worker's request handler, shared by `filter.worker.ts` and the
 * client's synchronous fallback. DOM-free.
 *
 * Protocol (structured-clone messages; pixel buffers are transferred):
 *
 *   filter:   { id, reqId, pixels, params?, mask? }      → { reqId, pixels } | { reqId, error }
 *   backdrop: { op: 'backdrop', reqId, spec, size }       → { reqId, pixels } | { reqId, error }
 *
 * A filter request's `pixels` buffer is owned by the handler: the result is
 * written into it in place and sent back (no allocation, no copy).
 */
import { renderBackdrop } from '../backdrop/render';
import type { BackdropSpecInput } from '../backdrop/spec';
import type { ParamRecord } from './params';
import { applyFilter, isFilterId } from './registry';
import type { Mask, Pixels } from './types';

export interface FilterRequest {
  /** A `FilterId`. */
  id: string;
  reqId: number;
  pixels: Pixels;
  params?: ParamRecord | null;
  mask?: Mask | null;
}

export interface BackdropRequest {
  op: 'backdrop';
  reqId: number;
  spec: BackdropSpecInput | null;
  size: number;
}

export type WorkerRequest = FilterRequest | BackdropRequest;

export type WorkerResponse = { reqId: number; pixels: Pixels } | { reqId: number; error: string };

export interface HandledRequest {
  response: WorkerResponse;
  /** Buffers to transfer with the response. */
  transfer: Transferable[];
}

function transferable(p: Pixels): Transferable[] {
  const buf = p.data.buffer;
  return buf instanceof ArrayBuffer && p.data.byteOffset === 0 && p.data.byteLength === buf.byteLength ? [buf] : [];
}

/** Runs one request. Never throws; failures become `{ reqId, error }`. */
export function handleRequest(req: WorkerRequest): HandledRequest {
  const reqId = typeof req?.reqId === 'number' ? req.reqId : -1;
  try {
    if ('op' in req && req.op === 'backdrop') {
      const pixels = renderBackdrop(req.spec, req.size);
      return { response: { reqId, pixels }, transfer: transferable(pixels) };
    }
    const r = req as FilterRequest;
    if (!isFilterId(r.id)) throw new RangeError(`unknown filter "${String(r.id)}"`);
    const src = r.pixels;
    const pixels = applyFilter(r.id, src, r.params ?? null, r.mask ?? null, src);
    return { response: { reqId, pixels }, transfer: transferable(pixels) };
  } catch (e) {
    return { response: { reqId, error: e instanceof Error ? e.message : String(e) }, transfer: [] };
  }
}

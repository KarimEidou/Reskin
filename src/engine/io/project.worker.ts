/**
 * Module worker encoding .reskin projects off the main thread. Spawned by
 * `ProjectEncoder` (encoder.ts), which posts snapshots with their pixel
 * buffers transferred. Uses no DOM APIs.
 */
import { handleEncode, type EncodeRequest, type EncodeResponse } from './encoder';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: EncodeResponse): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  void handleEncode(ev.data).then((res) => scope.postMessage(res));
};

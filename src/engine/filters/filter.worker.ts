/**
 * Module worker running filters and backdrop renders off the main thread.
 * Spawned by `FilterClient` (client.ts); see worker-core.ts for the
 * protocol. Uses no DOM APIs.
 */
import { handleRequest, type WorkerRequest } from './worker-core';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { response, transfer } = handleRequest(ev.data);
  scope.postMessage(response, transfer);
};

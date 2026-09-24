// Module worker for the sidebar panels: layer thumbnails, export-size
// previews, style presets, icon helpers and stickers, off the main thread.
// See protocol.ts.

import { handlePanelMessage, type PanelMessage } from './protocol';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<PanelMessage>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { response, transfer } = handlePanelMessage(ev.data);
  scope.postMessage(response, transfer);
};

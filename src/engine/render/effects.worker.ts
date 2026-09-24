/**
 * Module worker rendering styled layers (pixels + effects) for the
 * interactive view, so dragging an effect slider never blocks the page.
 * Spawned by styled-worker.ts, which defines the protocol. Uses no DOM APIs.
 */
import { Surface } from '../raster/surface';
import { renderStyledPixels } from './effects';
import type { StyledJob, StyledJobResult } from './styled-worker';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<StyledJob>) => void) | null;
  postMessage(message: StyledJobResult, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (ev) => {
  const { id, width, height, pixels, effects } = ev.data;
  try {
    const styled = renderStyledPixels(new Surface(width, height, new Uint8ClampedArray(pixels)), JSON.parse(effects));
    if (!styled) {
      scope.postMessage({ id, rect: null, pixels: null }, []);
      return;
    }
    const data = styled.data.buffer;
    scope.postMessage({ id, rect: styled.rect, pixels: data }, [data]);
  } catch (e) {
    scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) }, []);
  }
};

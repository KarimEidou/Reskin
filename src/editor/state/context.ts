// Svelte context plumbing for the editor session plus the browser-side
// dependencies (commands, image decode/encode) it runs with.

import { getContext, setContext } from 'svelte';
import { commands } from '$lib/ipc/commands';
import { decodeImage, createCanvasTextRasterizer } from '$engine/dom';
import { Engine, encodePng, type Surface } from '$engine/index';
import { installLeakProbe, type LiveCounts } from './leak-probe';
import { EditorSession, type SessionDeps } from './session.svelte';

const KEY = Symbol('reskin.editor.session');

export function setSession(session: EditorSession): EditorSession {
  return setContext(KEY, session);
}

/** The session provided by App.svelte (throws outside the editor tree). */
export function getSession(): EditorSession {
  const s = getContext<EditorSession | undefined>(KEY);
  if (!s) throw new Error('getSession() used outside the editor');
  return s;
}

/** PNG data URL for a surface. */
export async function surfaceToDataUrl(surface: Surface): Promise<string> {
  const png = await encodePng(surface.data, surface.width, surface.height);
  let bin = '';
  for (let i = 0; i < png.length; i += 0x8000) {
    bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}

/** Real dependencies used by the running app. */
export function browserDeps(): SessionDeps {
  return {
    commands,
    decode: (png) => decodeImage(png),
    encode: surfaceToDataUrl,
  };
}

/** What the e2e build exposes on `globalThis` for the specs. */
export interface E2EHooks {
  /** The session: specs inspect the engine directly (pixels, history). */
  __reskinSession?: EditorSession;
  /** Live resources for leak checks across open / close cycles (see leak-probe.ts). */
  __reskinProbe?: () => LiveCounts & { engineListeners: number };
}

/** Creates the app's session with the canvas text rasterizer installed. */
export function createSession(deps: SessionDeps = browserDeps()): EditorSession {
  // Counts from before the session exists, so its own resources are seen.
  const counts = __E2E__ ? installLeakProbe() : null;
  const session = new EditorSession(deps, new Engine({ textRasterizer: createCanvasTextRasterizer() }));
  if (__E2E__ && counts) {
    const hooks = globalThis as unknown as E2EHooks;
    hooks.__reskinSession = session;
    hooks.__reskinProbe = () => ({ ...counts(), engineListeners: session.engine.subscriberCount });
  }
  return session;
}

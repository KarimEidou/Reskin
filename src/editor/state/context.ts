// Svelte context plumbing for the editor session plus the browser-side
// dependencies (commands, image decode/encode) it runs with.

import { getContext, setContext } from 'svelte';
import { commands } from '$lib/ipc/commands';
import { decodeImage, createCanvasTextRasterizer } from '$engine/dom';
import { Engine, encodePng, type Surface } from '$engine/index';
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

/** Creates the app's session with the canvas text rasterizer installed. */
export function createSession(deps: SessionDeps = browserDeps()): EditorSession {
  return new EditorSession(deps, new Engine({ textRasterizer: createCanvasTextRasterizer() }));
}

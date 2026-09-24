// Node-side helper for e2e specs: serves the panels harness (harness.html)
// with the Vite dev server in `--mode e2e` (fake Tauri backend), because
// the app build only contains the box and editor pages. One server per
// Playwright worker process, shared by the spec files it runs.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const HARNESS_PATH = '/src/editor/panels/dev/harness.html';

interface Running {
  url: string;
  close: () => Promise<void>;
}

let running: Promise<Running> | null = null;
let users = 0;

async function start(): Promise<Running> {
  const { createServer } = await import('vite');
  const cacheDir = join(ROOT, 'test-results', `.vite-panels-${process.pid}`);
  mkdirSync(cacheDir, { recursive: true });
  const server = await createServer({
    configFile: join(ROOT, 'vite.config.ts'),
    root: ROOT,
    mode: 'e2e',
    logLevel: 'error',
    clearScreen: false,
    cacheDir,
    // Serve dependencies as they are (all ESM): no pre-bundling, so no
    // "new dependency found, reloading" in the middle of a test.
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { port: 0, strictPort: false, hmr: false, watch: null, host: '127.0.0.1' },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('panels harness server has no port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

/** Starts (or reuses) the harness server; returns the harness page URL. */
export async function acquireHarness(): Promise<string> {
  users++;
  running ??= start();
  const r = await running;
  return `${r.url}${HARNESS_PATH}`;
}

/** Releases the server; the last user closes it. */
export async function releaseHarness(): Promise<void> {
  users = Math.max(0, users - 1);
  if (users > 0 || !running) return;
  const r = running;
  running = null;
  await (await r).close();
}

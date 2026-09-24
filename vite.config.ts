import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// Two pages: the floating box (tiny, no engine) and the editor.
// `--mode e2e` builds the same pages with the mocked Tauri backend
// (src/testing/tauri-mock.ts) into dist-e2e for Playwright.
//
// Each page is built on its own (one build environment per page, into the
// same outDir): chunks shared by two pages carry the union of what both
// use — above all Svelte's runtime — and the box must not load the
// editor's share of it.
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  clearScreen: false,
  resolve: {
    alias: {
      $lib: r('./src/lib'),
      $engine: r('./src/engine'),
    },
  },
  define: {
    __E2E__: JSON.stringify(mode === 'e2e'),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**'] },
  },
  preview: { port: mode === 'e2e' ? 4173 : 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  builder: {
    // The editor first (it empties outDir), then the box next to it.
    buildApp: async (builder) => {
      await builder.build(builder.environments.client!);
      await builder.build(builder.environments.box!);
    },
  },
  environments: {
    client: { build: { rolldownOptions: { input: { editor: r('./editor.html') } } } },
    box: {
      consumer: 'client',
      build: { emptyOutDir: false, rolldownOptions: { input: { box: r('./box.html') } } },
    },
  },
  build: {
    // WebView2 is evergreen Chromium.
    target: 'chrome120',
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1024,
    modulePreload: { polyfill: false },
  },
  worker: { format: 'es' },
}));

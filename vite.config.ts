import { defineConfig, type UserConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// Two pages: the floating box (tiny, no engine) and the editor.
// `--mode e2e` builds the same pages with the mocked Tauri backend
// (src/testing/tauri-mock.ts) into dist-e2e for Playwright.
const PAGES = { box: r('./box.html'), editor: r('./editor.html') };

// `vite build` builds each page on its own (one build environment per
// page, into the same outDir): chunks shared by two pages carry the union
// of what both use — above all Svelte's runtime — and the box must not
// load the editor's share of it. The dev server keeps one environment
// serving both pages.
const PER_PAGE_BUILD: UserConfig = {
  builder: {
    // The editor first (it empties outDir), then the box next to it.
    buildApp: async (builder) => {
      await builder.build(builder.environments.client!);
      await builder.build(builder.environments.box!);
    },
  },
  environments: {
    client: { build: { rolldownOptions: { input: { editor: PAGES.editor } } } },
    box: {
      consumer: 'client',
      build: { emptyOutDir: false, rolldownOptions: { input: { box: PAGES.box } } },
    },
  },
};

export default defineConfig(({ mode, command }) => ({
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
  ...(command === 'build' ? PER_PAGE_BUILD : {}),
  build: {
    // WebView2 is evergreen Chromium.
    target: 'chrome120',
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1024,
    modulePreload: { polyfill: false },
    // The dev server's dependency scan starts from both pages (a build sets
    // one page per environment instead: PER_PAGE_BUILD).
    rolldownOptions: command === 'build' ? undefined : { input: PAGES },
  },
  worker: { format: 'es' },
}));

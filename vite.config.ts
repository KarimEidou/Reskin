import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const host = process.env.TAURI_DEV_HOST;

// Two pages: the floating box (tiny, no engine) and the editor.
// `--mode e2e` builds the same pages with the mocked Tauri backend
// (src/testing/tauri-mock.ts) into dist-e2e for Playwright.
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
  build: {
    // WebView2 is evergreen Chromium.
    target: 'chrome120',
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1024,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        box: r('./box.html'),
        editor: r('./editor.html'),
      },
    },
  },
  worker: { format: 'es' },
}));

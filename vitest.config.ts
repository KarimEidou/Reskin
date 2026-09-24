import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Compiles `.svelte.ts` rune modules so they can be unit tested.
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: r('./src/lib'),
      $engine: r('./src/engine'),
    },
  },
  define: { __E2E__: 'false' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    passWithNoTests: true,
    // Export / serialisation tests do real 512² work; leave headroom for
    // slow, shared CI runners.
    testTimeout: 30_000,
  },
});

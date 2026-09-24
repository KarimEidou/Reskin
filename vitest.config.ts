import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
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
  },
});

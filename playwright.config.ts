import { defineConfig, devices } from '@playwright/test';

// The e2e suite runs the real pages (built with `--mode e2e`) against the
// mocked Tauri backend in src/testing/tauri-mock.ts. Set E2E_PORT to run
// several suites side by side (each builds and serves its own copy).
const port = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 3,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'dark',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite build --mode e2e && pnpm exec vite preview --mode e2e --port ${port} --strictPort`,
    url: `http://localhost:${port}/box.html`,
    // Never attach to a server started by another checkout.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

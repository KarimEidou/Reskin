// Playwright fixtures shared by the specs:
//   import { test, expect } from './support/fixtures';
//   test('…', async ({ openBox }) => { const box = await openBox(); … });
//
// Every test also fails on uncaught page errors (exceptions and unhandled
// rejections), so broken async flows cannot pass silently.

import { test as base, expect } from '@playwright/test';
import { BoxDriver } from './box';
import { openPage, type E2EConfig } from './e2e';

export interface Fixtures {
  /** Opens box.html (optionally configured) and returns its driver. */
  openBox: (config?: E2EConfig) => Promise<BoxDriver>;
  /** Opens editor.html (optionally configured) once it polls its mailbox. */
  openEditor: (config?: E2EConfig) => Promise<void>;
  /** Uncaught errors seen so far (checked automatically after each test). */
  pageErrors: string[];
}

export const test = base.extend<Fixtures>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
      await use(errors);
      expect(errors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
  openBox: async ({ page }, use) => {
    await use((config) => BoxDriver.open(page, config));
  },
  openEditor: async ({ page }, use) => {
    await use((config) => openPage(page, 'editor', config));
  },
});

export { expect };
export { BoxDriver } from './box';
export * from './e2e';

import { expect, test } from '@playwright/test';

// Both pages load against the fake backend without script errors.
for (const page of ['box', 'editor'] as const) {
  test(`${page} page boots`, async ({ page: p }) => {
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`/${page}.html`);
    await expect(p.locator('#app')).toBeAttached();
    await p.waitForTimeout(300);
    expect(errors).toEqual([]);
  });
}

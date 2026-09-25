// Settings keeps the editor's chrome in place: jumping to a section (the
// nav, or "About" from the tray) scrolls the settings page only, never the
// panel around it, so the title bar, Close and the section nav stay in the
// window — also the next time Settings opens. The nav names the section
// jumped to, and follows the page when it is scrolled by hand. Runs at every
// editor size (reskin-core's editor_size) with animations on and off. The
// box preview's caption stays legible on the desk drawn behind it.

import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { contrast } from '../src/lib/theme/color';
import { expect, simulateClose, simulateOpen, test } from './support/fixtures';

const SECTIONS = ['Appearance', 'Motion', 'Behaviour', 'Advanced', 'About'] as const;
type Section = (typeof SECTIONS)[number];

const EDITOR_SIZES = [
  { name: 'small', width: 900, height: 620 },
  { name: 'medium', width: 1080, height: 720 },
  { name: 'large', width: 1280, height: 820 },
] as const;

const view = (page: Page) => page.getByTestId('settings-view');
const nav = (page: Page) => view(page).getByRole('navigation', { name: 'Settings sections' });

/**
 * Resolves once the settings page has the section at its top, where a jump
 * puts it (or is at its end, for a section too near the end to get there).
 */
async function landedOn(page: Page, label: Section): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((name) => {
          const root = document.querySelector<HTMLElement>('[data-testid="settings-view"] .scroll')!;
          const heading = [...root.querySelectorAll('h2')].find((h) => h.textContent === name)!;
          const section = heading.closest('section')!;
          const margin = parseFloat(getComputedStyle(section).scrollMarginTop);
          const distance = section.getBoundingClientRect().top - root.getBoundingClientRect().top - margin;
          const atEnd = root.scrollTop >= root.scrollHeight - root.clientHeight - 1;
          return Math.abs(distance) < 1 || (distance > 0 && atEnd);
        }, label),
      { message: `the page has ${label} at its top`, timeout: 4000 },
    )
    .toBe(true);
}

/** The panel has nothing to scroll: its title bar stays at its top, inside the window. */
async function expectChromeInPlace(page: Page): Promise<void> {
  const at = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-testid="editor-panel"] > .content')!;
    const title = document.querySelector<HTMLElement>('header.titlebar')!;
    return {
      overflow: content.scrollHeight - content.clientHeight,
      scrollTop: content.scrollTop,
      contentTop: content.getBoundingClientRect().top,
      titleTop: title.getBoundingClientRect().top,
    };
  });
  expect(at.overflow, 'nothing overflows the panel').toBeLessThanOrEqual(0);
  expect(at.scrollTop, 'the panel itself is not scrolled').toBe(0);
  expect(at.titleTop, 'the title bar stays at the top of the panel').toBe(at.contentTop);
  expect(at.titleTop).toBeGreaterThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Close editor' })).toBeInViewport();
  await expect(nav(page).getByRole('heading', { name: 'Settings' })).toBeInViewport();
}

async function expectCurrent(page: Page, label: Section): Promise<void> {
  await expect(nav(page).getByRole('button', { name: label }), `${label} is the current section`).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(nav(page).locator('[aria-current="true"]')).toHaveCount(1);
}

/**
 * Scrolls the page by hand (whole pixels) to where a jump puts the
 * section; true when that is the end of the page.
 */
function scrollByHandTo(page: Page, label: Section): Promise<boolean> {
  return page.evaluate((name) => {
    const root = document.querySelector<HTMLElement>('[data-testid="settings-view"] .scroll')!;
    const heading = [...root.querySelectorAll('h2')].find((h) => h.textContent === name)!;
    const section = heading.closest('section')!;
    const margin = parseFloat(getComputedStyle(section).scrollMarginTop);
    const offset = root.scrollTop + section.getBoundingClientRect().top - root.getBoundingClientRect().top - margin;
    const max = root.scrollHeight - root.clientHeight;
    const top = Math.min(Math.round(offset), max);
    root.scrollTop = top;
    return top >= max - 4;
  }, label);
}

for (const size of EDITOR_SIZES) {
  for (const motion of ['full', 'reduced'] as const) {
    test.describe(`${size.name} editor, ${motion} motion`, () => {
      test.use({ viewport: { width: size.width, height: size.height } });

      test('the section nav scrolls the settings page only', async ({ openEditor, page }) => {
        await openEditor({ settings: { motion } });
        await simulateOpen(page, [], 'settings');
        await expect(view(page)).toBeVisible();
        await expectChromeInPlace(page);

        for (const label of [...SECTIONS, ...[...SECTIONS].reverse()]) {
          await nav(page).getByRole('button', { name: label }).click();
          await landedOn(page, label);
          await expectChromeInPlace(page);
          await expectCurrent(page, label);
        }
      });

      test('a jump cut short by another ends on the section picked last', async ({ openEditor, page }) => {
        await openEditor({ settings: { motion } });
        await simulateOpen(page, [], 'settings');
        await expect(view(page)).toBeVisible();
        // Advanced last: in the large editor it cannot reach the top.
        for (const label of ['Motion', 'About', 'Advanced'] as const) {
          await nav(page).getByRole('button', { name: label }).click();
        }
        await landedOn(page, 'Advanced');
        await expectCurrent(page, 'Advanced');
        await expectChromeInPlace(page);
      });

      test('the nav follows the page again once a jump is over', async ({ openEditor, page }) => {
        await openEditor({ settings: { motion } });
        await simulateOpen(page, [], 'settings');
        await nav(page).getByRole('button', { name: 'Advanced' }).click();
        await landedOn(page, 'Advanced');
        await expectCurrent(page, 'Advanced');

        await view(page).locator('.scroll').hover();
        await page.mouse.wheel(0, -10_000);
        await landedOn(page, 'Appearance');
        await expectCurrent(page, 'Appearance');
        await page.mouse.wheel(0, 10_000);
        await landedOn(page, 'About');
        await expectCurrent(page, 'About');
        await expectChromeInPlace(page);
      });

      test('the nav names the section scrolled to the top by hand', async ({ openEditor, page }) => {
        await openEditor({ settings: { motion } });
        await simulateOpen(page, [], 'settings');
        for (const label of SECTIONS) {
          const atEnd = await scrollByHandTo(page, label);
          await expectCurrent(page, atEnd ? 'About' : label);
        }
      });

      test('opening on About keeps the chrome, also the next time Settings opens', async ({ openEditor, page }) => {
        await openEditor({ settings: { motion } });

        // "About" from the tray: Settings opens on its last section.
        await simulateOpen(page, [], 'about');
        await landedOn(page, 'About');
        await expectChromeInPlace(page);
        await expectCurrent(page, 'About');
        await expect(view(page).getByRole('heading', { name: 'About' })).toBeInViewport();

        // Settings again: back at the top, the chrome where it belongs.
        await simulateClose(page);
        await simulateOpen(page, [], 'settings');
        await landedOn(page, 'Appearance');
        await expectChromeInPlace(page);
        await expectCurrent(page, 'Appearance');

        // A section picked in one open leaves the next one alone too.
        await nav(page).getByRole('button', { name: 'Advanced' }).click();
        await landedOn(page, 'Advanced');
        await expectChromeInPlace(page);
        await simulateClose(page);
        await simulateOpen(page, [], 'settings');
        await landedOn(page, 'Appearance');
        await expectChromeInPlace(page);
        await expectCurrent(page, 'Appearance');
      });
    });
  }
}

test.describe('the box preview', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`its caption keeps 4.5:1 on the desk behind it (${theme})`, async ({ openEditor, page }) => {
      await openEditor({ settings: { theme } });
      await simulateOpen(page, [], 'settings');
      const caption = view(page).locator('.caption');
      await expect(caption).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length))
        .toBe(0);

      // The text's own box and colour, then the desk there without it.
      const { clip, color } = await caption.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const { x, y, width, height } = range.getBoundingClientRect();
        return { clip: { x, y, width, height }, color: getComputedStyle(el).color };
      });
      await caption.evaluate((el) => (el.style.visibility = 'hidden'));
      const desk = PNG.sync.read(await page.screenshot({ clip }));

      const [r, g, b, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
      const mix = (fg: number, bg: number) => fg * alpha + bg * (1 - alpha);
      let worst = Infinity;
      for (let i = 0; i < desk.data.length; i += 4) {
        const bg = { r: desk.data[i]!, g: desk.data[i + 1]!, b: desk.data[i + 2]! };
        const text = { r: mix(r!, bg.r), g: mix(g!, bg.g), b: mix(b!, bg.b) };
        worst = Math.min(worst, contrast(text, bg));
      }
      expect(worst, 'the caption on the worst spot of the desk behind it').toBeGreaterThanOrEqual(4.5);
    });
  }
});

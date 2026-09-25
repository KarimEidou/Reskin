// The README's screenshots (docs/screenshots/*.png), made from the real
// pages of the e2e build against the fake backend. They only run with
// RESKIN_DOCS_SCREENSHOTS=1 — `pnpm docs:screenshots` — and are skipped by
// the normal e2e run.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';
import type { EditorSession } from '../src/editor/state/session.svelte';
import type { BoxSkin } from '../src/lib/ipc/types';
import { canvas, compositeHash, openTab, sidebar } from './panels-driver';
import { BoxDriver, expect, openPage, SAMPLE_PATHS, simulateOpen, test } from './support/fixtures';

test.skip(process.env.RESKIN_DOCS_SCREENSHOTS !== '1', 'refresh the README screenshots with `pnpm docs:screenshots`');

type Win = { __reskinSession: EditorSession };

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');

/** A Windows-11-like desktop: deep blue with soft violet, blue and cyan blooms. */
const WALLPAPER = [
  'radial-gradient(60% 90% at 12% 18%, rgb(124 92 255 / 0.55), transparent 70%)',
  'radial-gradient(55% 80% at 88% 90%, rgb(31 200 227 / 0.4), transparent 70%)',
  'radial-gradient(70% 110% at 55% 60%, rgb(79 125 255 / 0.55), transparent 75%)',
  'linear-gradient(160deg, #0d1640 0%, #0a1030 55%, #070b1f 100%)',
].join(', ');

/**
 * CSS painting the wallpaper behind the page as a fixed `selector::before`
 * layer, softened: a blurred gradient compresses far better than
 * Chromium's dithered one and looks the same.
 */
function desktop(selector: string): string {
  return `${selector}::before { content: ''; position: fixed; inset: -48px; z-index: -1; background: ${WALLPAPER}; filter: blur(24px); }`;
}

/** Type of the pictures: Windows' own where there is one, else the look-alike Inter. */
const FONT = `'Segoe UI Variable Display', 'Segoe UI', Inter, system-ui, sans-serif`;

/**
 * Gives the app's pages the type they have on Windows, Segoe UI, or where it
 * is missing (these pictures are usually made on Linux) Inter, which looks
 * much more like it than the system's default sans serif.
 */
async function windowsType(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `:root {
      --font-ui: 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif !important;
      --font-display: 'Segoe UI Variable Display', 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif !important;
      --font-small: 'Segoe UI Variable Small', 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif !important;
    }`,
  });
}

/** PNG row filters (-1: the best per row) and deflate strategies (0 default, 1 filtered) worth trying. */
const ENCODINGS = [-1, 1, 4].flatMap((filterType) => [0, 1].map((deflateStrategy) => ({ filterType, deflateStrategy })));

/**
 * Writes an opaque screenshot as a compact PNG: RGB (no alpha channel),
 * maximum deflate, with whichever filter and strategy compress it best.
 */
function save(name: string, png: Buffer): void {
  const image = PNG.sync.read(png);
  for (let i = 3; i < image.data.length; i += 4) {
    if (image.data[i] !== 255) throw new Error(`${name} has transparent pixels; paint a background behind it`);
  }
  const smallest = ENCODINGS.map((e) => PNG.sync.write(image, { colorType: 2, deflateLevel: 9, ...e })).reduce((a, b) =>
    b.length < a.length ? b : a,
  );
  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(join(DOCS_DIR, name), smallest);
}

/** Waits until nothing animates (entrances, previews and transitions settled). */
async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), {
      timeout: 10_000,
    })
    .toBe(0);
  await page.waitForTimeout(300);
}

test.describe('box skins', () => {
  test.use({ deviceScaleFactor: 2 });

  const SKINS: ReadonlyArray<{ skin: BoxSkin; label: string }> = [
    { skin: 'glass', label: 'Glass' },
    { skin: 'neon', label: 'Neon' },
    { skin: 'minimal', label: 'Minimal' },
    { skin: 'aurora', label: 'Aurora' },
  ];

  test('box-skins.png', async ({ context, page }) => {
    // Each skin in its own box page, captured without a background (the
    // box window is transparent), then laid out on one wallpaper.
    const boxes: string[] = [];
    for (const { skin } of SKINS) {
      const boxPage = await context.newPage();
      // Like the `pageErrors` fixture does for `page`.
      const errors: string[] = [];
      boxPage.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
      const box = await BoxDriver.open(boxPage, { settings: { boxSkin: skin, theme: 'dark' } });
      await expect(box.visual).toHaveAttribute('data-skin', skin);
      await box.expectStatic();
      const png = await box.root.screenshot({ omitBackground: true });
      boxes.push(`data:image/png;base64,${png.toString('base64')}`);
      await boxPage.close();
      expect(errors, `uncaught errors on the ${skin} box page`).toEqual([]);
    }

    await page.setViewportSize({ width: 720, height: 240 });
    await page.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; height: 100%; }
        html { background: #0a1030; }
        ${desktop('html')}
        body {
          display: flex;
          align-items: center;
          justify-content: space-evenly;
          padding: 0 12px;
          box-sizing: border-box;
          font: 12px/1 ${FONT};
          letter-spacing: 0.03em;
          color: rgb(255 255 255 / 0.86);
        }
        figure { margin: 0; display: flex; flex-direction: column; align-items: center; }
        img { width: 148px; height: 148px; display: block; }
        figcaption { margin-top: 2px; text-shadow: 0 1px 2px rgb(0 0 0 / 0.35); }
      </style>
      ${SKINS.map((s, i) => `<figure><img alt="" src="${boxes[i]}"><figcaption>${s.label}</figcaption></figure>`).join('')}`);
    await page.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    save('box-skins.png', await page.screenshot());
  });
});

test.describe('editor', () => {
  // The medium editor window (1080 × 720), rendered at 1.6× for a crisp,
  // still compact picture.
  test.use({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 1.6 });

  test('editor.png', async ({ page }) => {
    test.setTimeout(120_000);
    await openPage(page, 'editor', { settings: { theme: 'dark' } });
    // Three shortcuts in the queue; Steam open in the Neon style, with a
    // matching brush colour picked.
    await simulateOpen(page, [SAMPLE_PATHS.steam, SAMPLE_PATHS.notes, SAMPLE_PATHS.site]);
    await page.waitForFunction(() => (globalThis as unknown as Partial<Win>).__reskinSession?.hasDesign === true);
    await expect(sidebar(page)).toBeVisible();
    await expect(canvas(page)).toBeVisible();
    await page.evaluate(() => {
      (globalThis as unknown as Win).__reskinSession.engine.setColor('primary', { r: 56, g: 189, b: 248, a: 1 });
    });

    await openTab(page, 'styles');
    await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 30_000 });
    const before = await compositeHash(page);
    const neon = page.locator('[data-preset="neon"]');
    await neon.click();
    await expect.poll(() => compositeHash(page), { timeout: 30_000 }).not.toBe(before);
    await expect(neon).toHaveAttribute('aria-pressed', 'true');
    // The click scrolled the tile into view; show the panel from its top.
    await page.getByTestId('panel-styles').evaluate((panel) => panel.scrollTo(0, 0));

    // The desktop behind the transparent window.
    await page.addStyleTag({ content: desktop('html') });
    await windowsType(page);
    await settle(page);
    await expect(page.locator('.toasts').locator('[role="alert"], [role="status"]').locator(':scope > *')).toHaveCount(0);
    save('editor.png', await page.screenshot({ animations: 'disabled' }));
  });
});

// ---- Marketing pictures ----------------------------------------------------------------------
// The README's and the website's hero (an animated WebP), the twelve styles,
// the three steps and the repository's social preview. The icons are the
// fake backend's sample icons as the real Styles panel restyles them.

/** The desktop of the pictures. */
const DESKTOP = [
  { path: SAMPLE_PATHS.steam, label: 'Steam' },
  { path: SAMPLE_PATHS.notes, label: 'Notes' },
  { path: SAMPLE_PATHS.site, label: 'Docs Portal' },
  { path: SAMPLE_PATHS.folder, label: 'Projects' },
  { path: SAMPLE_PATHS.exe, label: 'Paint' },
  { path: SAMPLE_PATHS.image, label: 'Photos' },
] as const;

/** The styles the hero cycles through, in order. */
const HERO_STYLES = ['neon', 'glass', 'retroPixel', 'clay', 'pastel', 'duotone'] as const;

interface StyledIcon {
  /** The icon as dropped (data: URL). */
  original: string;
  /** Every style of the Styles panel, in its order (data: URLs, transparent). */
  styles: Array<{ id: string; name: string; src: string }>;
}

/** An item's icon and every look of the Styles panel, as the panel renders them. */
async function styledIcon(page: Page, path: string): Promise<StyledIcon> {
  await openPage(page, 'editor', { settings: { theme: 'dark' } });
  await simulateOpen(page, [path]);
  await page.waitForFunction(() => (globalThis as unknown as Partial<Win>).__reskinSession?.hasDesign === true);
  await openTab(page, 'styles');
  await expect(page.locator('[data-testid="preset-tile"][data-ready="true"]')).toHaveCount(12, { timeout: 30_000 });
  return page.evaluate(() => {
    const icon = (globalThis as unknown as Win).__reskinSession.original;
    if (!icon) throw new Error('no icon');
    const canvas = document.createElement('canvas');
    canvas.width = icon.width;
    canvas.height = icon.height;
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(icon.data), icon.width, icon.height), 0, 0);
    const styles = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="preset-tile"]'), (tile) => {
      const thumb = tile.querySelector('canvas');
      if (!thumb) throw new Error(`no picture for ${tile.dataset.preset}`);
      return { id: tile.dataset.preset ?? '', name: tile.textContent?.trim() ?? '', src: thumb.toDataURL('image/png') };
    });
    return { original: canvas.toDataURL('image/png'), styles };
  });
}

function styleOf(icon: StyledIcon, id: string): { name: string; src: string } {
  const style = icon.styles.find((s) => s.id === id);
  if (!style) throw new Error(`no style ${id}`);
  return style;
}

/** The glass box at rest, transparent around it (data: URL). */
async function glassBox(page: Page): Promise<string> {
  const box = await BoxDriver.open(page, { settings: { boxSkin: 'glass', theme: 'dark' } });
  await box.expectStatic();
  return `data:image/png;base64,${(await box.root.screenshot({ omitBackground: true })).toString('base64')}`;
}

/** The app's icon (data: URL). */
function appIcon(): string {
  const svg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app-icon.svg'));
  return `data:image/svg+xml;base64,${svg.toString('base64')}`;
}

/** A PNG screenshot as lossy WebP, encoded by the browser. */
async function toWebp(page: Page, png: Buffer, quality: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ([data, q]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
      return canvas.toDataURL('image/webp', q).split(',')[1] ?? '';
    },
    [png.toString('base64'), quality] as const,
  );
  return Buffer.from(b64, 'base64');
}

interface WebpFrame {
  /** Place on the canvas, in pixels (even). */
  x: number;
  y: number;
  /** A still WebP of the frame's rectangle. */
  webp: Buffer;
  width: number;
  height: number;
  /** Milliseconds. */
  duration: number;
}

/** A RIFF chunk, padded to an even size. */
function riffChunk(id: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}

function uint24(n: number): Buffer {
  const b = Buffer.alloc(3);
  b.writeUIntLE(n, 0, 3);
  return b;
}

/**
 * An animated WebP that loops forever: every frame is drawn over the canvas
 * at its place and stays (no blending, no disposal), so after the first,
 * full frame the others only need the part that changes.
 */
function animatedWebp(width: number, height: number, frames: WebpFrame[]): Buffer {
  let alpha = false;
  const anmf = frames.map((f) => {
    if (f.x % 2 !== 0 || f.y % 2 !== 0) throw new Error('WebP frame offsets must be even');
    if (f.x + f.width > width || f.y + f.height > height) throw new Error('WebP frame outside the canvas');
    const image: Buffer[] = [];
    // A still WebP: RIFF header, then its chunks.
    for (let at = 12; at + 8 <= f.webp.length; ) {
      const id = f.webp.toString('ascii', at, at + 4);
      const size = f.webp.readUInt32LE(at + 4);
      if (id === 'ALPH' || id === 'VP8 ' || id === 'VP8L') image.push(riffChunk(id, f.webp.subarray(at + 8, at + 8 + size)));
      if (id === 'ALPH' || id === 'VP8L') alpha = true;
      at += 8 + size + (size % 2);
    }
    const header = [f.x / 2, f.y / 2, f.width - 1, f.height - 1, f.duration].map(uint24);
    return riffChunk('ANMF', Buffer.concat([...header, Buffer.from([0b10]), ...image]));
  });
  const vp8x = Buffer.concat([Buffer.from([alpha ? 0x12 : 0x02, 0, 0, 0]), uint24(width - 1), uint24(height - 1)]);
  // Background colour (unused: the first frame covers the canvas) and loop count 0 (forever).
  const anim = Buffer.alloc(6);
  const payload = Buffer.concat([Buffer.from('WEBP', 'ascii'), riffChunk('VP8X', vp8x), riffChunk('ANIM', anim), ...anmf]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

test.describe('marketing', () => {
  // 76 px style tiles at 2.53× are the panel's largest pictures, 192 px.
  test.use({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 2.53 });

  test('hero.webp, styles.png and social-preview.png', async ({ browser, context, page }) => {
    test.setTimeout(300_000);
    const icons: StyledIcon[] = [];
    for (const item of DESKTOP) icons.push(await styledIcon(page, item.path));
    const boxPage = await context.newPage();
    const box = await glassBox(boxPage);
    await boxPage.close();

    const HERO = { width: 880, height: 340 };
    const stage = await browser.newPage({ viewport: HERO, deviceScaleFactor: 2 });
    const figure = (src: string, label: string, cls = '') =>
      `<figure class="${cls}"><span class="icon"><img alt="" src="${src}"><img alt="" class="next" src="${src}"></span><figcaption>${label}</figcaption></figure>`;

    // The hero: your icons, the box, and the same icons restyled, one style after another.
    await stage.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; height: 100%; }
        html { background: #0a1030; }
        ${desktop('html')}
        body { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 30px; box-sizing: border-box; font-family: ${FONT}; color: #fff; }
        section { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 22px 0; }
        h2 { margin: 0; height: 30px; display: flex; align-items: center; font-size: 13px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: rgb(255 255 255 / 0.72); }
        .after h2 { padding: 0 14px; border-radius: 15px; background: rgb(255 255 255 / 0.14); box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.22); color: #fff; }
        .grid { display: grid; grid-template-columns: repeat(3, 94px); gap: 16px 4px; }
        figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 7px; }
        .icon { position: relative; width: 64px; height: 64px; }
        .icon img { position: absolute; inset: 0; width: 100%; height: 100%; }
        .icon .next { opacity: 0; }
        figcaption { font-size: 12.5px; text-shadow: 0 1px 3px rgb(0 0 0 / 0.7); }
        .middle { display: flex; align-items: center; gap: 12px; padding: 0 6px; }
        .middle img { width: 128px; height: 128px; display: block; }
        .arrow { width: 28px; height: 28px; opacity: 0.8; }
      </style>
      <section class="before"><h2>Before</h2><div class="grid">${DESKTOP.map((d, i) => figure(icons[i]!.original, d.label)).join('')}</div></section>
      <div class="middle">
        <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        <img alt="" src="${box}">
        <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </div>
      <section class="after"><h2 data-testid="style-name"></h2><div class="grid">${DESKTOP.map((d, i) => figure(icons[i]!.original, d.label)).join('')}</div></section>`);
    await stage.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));

    /** Shows `from` in the after grid with `to` over it at `t` (0..1). */
    const show = (from: string, to: string, t: number) =>
      stage.evaluate(
        ([srcs, next, fade, title]) => {
          document.querySelectorAll('.after .icon').forEach((icon, i) => {
            const [a, b] = icon.querySelectorAll('img');
            if (a && b) {
              a.src = srcs[i] ?? '';
              b.src = next[i] ?? '';
              b.style.opacity = String(fade);
            }
          });
          const h2 = document.querySelector('.after h2');
          if (h2) h2.textContent = title;
          return Promise.all(Array.from(document.images, (img) => img.decode()));
        },
        [
          icons.map((icon) => styleOf(icon, from).src),
          icons.map((icon) => styleOf(icon, to).src),
          t,
          `After · ${styleOf(icons[0]!, t < 0.5 ? from : to).name}`,
        ] as const,
      );
    const after = await stage.locator('.after').boundingBox();
    if (!after) throw new Error('no after panel');
    // A clip on whole CSS pixels is on even device pixels at 2×.
    const clip = {
      x: Math.floor(after.x),
      y: Math.floor(after.y),
      width: Math.ceil(after.x + after.width) - Math.floor(after.x),
      height: Math.ceil(after.y + after.height) - Math.floor(after.y),
    };
    const HOLD = 1600;
    const FADES = [0.2, 0.4, 0.6, 0.8];
    const frames: WebpFrame[] = [];
    await show(HERO_STYLES[0], HERO_STYLES[0], 0);
    const first = await stage.screenshot();
    frames.push({ x: 0, y: 0, width: HERO.width * 2, height: HERO.height * 2, duration: HOLD, webp: await toWebp(stage, first, 0.9) });
    for (let s = 0; s < HERO_STYLES.length; s++) {
      const from = HERO_STYLES[s]!;
      const to = HERO_STYLES[(s + 1) % HERO_STYLES.length]!;
      for (const t of [...FADES, 1]) {
        await show(from, to, t);
        const png = await stage.screenshot({ clip });
        frames.push({
          x: clip.x * 2,
          y: clip.y * 2,
          width: clip.width * 2,
          height: clip.height * 2,
          duration: t === 1 ? HOLD : 45,
          webp: await toWebp(stage, png, 0.9),
        });
      }
    }
    // The last fade ends on the first style: the loop starts again there.
    frames.pop();
    mkdirSync(DOCS_DIR, { recursive: true });
    writeFileSync(join(DOCS_DIR, 'hero.webp'), animatedWebp(HERO.width * 2, HERO.height * 2, frames));

    // One icon, every style.
    const hero = icons[0]!;
    await stage.setViewportSize({ width: 880, height: 300 });
    await stage.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; height: 100%; }
        html { background: #0a1030; }
        ${desktop('html')}
        body { display: flex; align-items: center; justify-content: center; gap: 26px; font-family: ${FONT}; color: #fff; }
        .yours { display: flex; flex-direction: column; align-items: center; gap: 10px; }
        .yours img { width: 112px; height: 112px; }
        .yours span { font-size: 13px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: rgb(255 255 255 / 0.72); }
        .arrow { width: 28px; height: 28px; opacity: 0.8; }
        .grid { display: grid; grid-template-columns: repeat(6, 88px); gap: 14px 6px; }
        figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
        figure img { width: 72px; height: 72px; }
        figcaption { font-size: 12.5px; text-shadow: 0 1px 3px rgb(0 0 0 / 0.7); white-space: nowrap; }
      </style>
      <div class="yours"><img alt="" src="${hero.original}"><span>Your icon</span></div>
      <svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      <div class="grid">${hero.styles.map((s) => `<figure><img alt="" src="${s.src}"><figcaption>${s.name}</figcaption></figure>`).join('')}</div>`);
    await stage.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    save('styles.png', await stage.screenshot());

    // The repository's social preview: 1280 × 640, what a shared link shows.
    await stage.close();
    const card = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
    const mix = DESKTOP.map((_, i) => styleOf(icons[i]!, HERO_STYLES[i]!).src);
    await card.setContent(`<!doctype html>
      <style>
        html, body { margin: 0; height: 100%; }
        html { background: #0a1030; }
        ${desktop('html')}
        body { display: flex; align-items: center; justify-content: space-between; padding: 0 96px 0 104px; box-sizing: border-box; font-family: ${FONT}; color: #fff; }
        .brand { display: flex; flex-direction: column; gap: 22px; }
        .name { display: flex; align-items: center; gap: 22px; }
        .name img { width: 96px; height: 96px; }
        h1 { margin: 0; font-size: 92px; font-weight: 800; letter-spacing: -0.03em; }
        p { margin: 0; font-size: 40px; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; }
        small { font-size: 26px; color: rgb(255 255 255 / 0.74); }
        .grid { display: grid; grid-template-columns: repeat(3, 132px); gap: 22px; }
        .grid img { width: 132px; height: 132px; }
      </style>
      <div class="brand">
        <div class="name"><img alt="" src="${appIcon()}"><h1>Reskin</h1></div>
        <p>Give any desktop icon<br>a new look.</p>
        <small>Free for Windows 10 &amp; 11</small>
      </div>
      <div class="grid">${mix.map((src) => `<img alt="" src="${src}">`).join('')}</div>`);
    await card.evaluate(() => Promise.all(Array.from(document.images, (img) => img.decode())));
    save('social-preview.png', await card.screenshot());
    await card.close();
  });

});

test.describe('welcome steps', () => {
  test.use({ viewport: { width: 1080, height: 720 }, deviceScaleFactor: 2 });

  test('steps.png', async ({ page }) => {
    await openPage(page, 'editor', { settings: { theme: 'dark' }, firstRun: true });
    await simulateOpen(page, [], 'welcome');
    const steps = page.getByTestId('welcome-view').locator('ol.steps');
    await expect(steps.getByRole('listitem')).toHaveCount(3);
    await windowsType(page);
    await settle(page);
    const box = await steps.boundingBox();
    if (!box) throw new Error('no steps');
    const pad = 16;
    save(
      'steps.png',
      await page.screenshot({
        animations: 'disabled',
        clip: { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad },
      }),
    );
  });
});

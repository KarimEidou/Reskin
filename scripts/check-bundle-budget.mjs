#!/usr/bin/env node
// Fails when a page's initial JS (entry + modulepreloaded chunks, gzip -9)
// exceeds its budget. Run after `pnpm build`.
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
// The box builds on its own (vite.config.ts) at ~29.8 KB; its budget keeps
// about 10 % headroom so an accidental editor-sized import fails the build.
const BUDGETS = { 'box.html': 33 * 1024, 'editor.html': 250 * 1024 };

let failed = false;
for (const [page, budget] of Object.entries(BUDGETS)) {
  const htmlPath = join(dist, page);
  if (!existsSync(htmlPath)) {
    console.error(`✗ ${htmlPath} missing — run pnpm build first`);
    process.exit(1);
  }
  const html = readFileSync(htmlPath, 'utf8');
  const refs = new Set();
  for (const m of html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) refs.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) refs.add(m[1]);
  let total = 0;
  const rows = [];
  for (const ref of refs) {
    const file = join(dist, ref.replace(/^\//, ''));
    const gz = gzipSync(readFileSync(file), { level: 9 }).length;
    total += gz;
    rows.push(`    ${(gz / 1024).toFixed(1).padStart(7)} KB  ${ref}`);
  }
  const ok = total <= budget;
  failed ||= !ok;
  console.log(
    `${ok ? '✓' : '✗'} ${page}: ${(total / 1024).toFixed(1)} KB gz initial JS (budget ${(budget / 1024).toFixed(0)} KB)`,
  );
  console.log(rows.join('\n'));
}
process.exit(failed ? 1 : 0);

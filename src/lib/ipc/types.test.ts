import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const self = fileURLToPath(import.meta.url);
const here = dirname(self);
const src = join(here, '..', '..');

/** Every `.ts` / `.svelte` file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|svelte)$/.test(e.name) ? [path] : [];
  });
}

describe('the IPC type barrel', () => {
  it('re-exports every generated binding', () => {
    const barrel = readFileSync(join(here, 'types.ts'), 'utf8');
    const bindings = readdirSync(join(here, 'bindings'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.slice(0, -3));
    expect(bindings.length).toBeGreaterThan(0);
    const missing = bindings.filter((name) => !barrel.includes(`export type { ${name} } from './bindings/${name}';`));
    expect(missing).toEqual([]);
  });

  it('is the only way into the bindings', () => {
    const bindingsDir = join(here, 'bindings');
    const direct = sources(src)
      .filter((f) => f !== join(here, 'types.ts') && f !== self && !f.startsWith(bindingsDir))
      .filter((f) => /^\s*(?:import|export)\b[^;]*from\s+['"][^'"]*\/bindings\//m.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f));
    expect(direct).toEqual([]);
  });
});

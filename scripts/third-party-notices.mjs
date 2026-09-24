#!/usr/bin/env node
// Third-party notices: every open-source component that ships inside
// Reskin, and the license texts that come with them, as one text file. The
// editor shows it (Settings › About › Open-source licenses) and every
// release attaches it as THIRD_PARTY_NOTICES.txt.
//
//   node scripts/third-party-notices.mjs [--out <file>] [--target <triple>] [--if-tauri]
//
// * JavaScript: the production dependency tree of package.json, plus the
//   Svelte runtime: the compiled components run on it, although
//   package.json lists Svelte under devDependencies. Its own dependencies
//   come along, a few of which only the compiler uses (listed all the same:
//   erring on the side of completeness).
// * Rust: the crates linked into reskin.exe for the target: the app
//   crate's normal dependencies as `cargo tree` resolves them for it,
//   without build and dev dependencies and proc macros (they only run
//   while building) and without the workspace's own crates, described by
//   `cargo metadata`.
// * License texts are the files each component ships (LICENSE*, COPYING*,
//   NOTICE*, …), each distinct text once. A component that ships none gets
//   its license's text as another component ships it (Apache-2.0,
//   MPL-2.0: no per-author part), or the standard text with its authors as
//   the copyright holders (MIT, ISC, BSD-3-Clause). Anything else fails.
//
// Default output: dist/THIRD_PARTY_NOTICES.txt, next to the pages, so the
// app embeds it. With --if-tauri it runs only when the Tauri CLI builds the
// app (it sets TAURI_ENV_*): `pnpm tauri build` gets the notices, while the
// plain `pnpm build` of the web checks, e2e and dev work stays fast.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_CRATE = 'reskin';
const DEFAULT_TARGET = 'x86_64-pc-windows-msvc';
/** Compiled into the pages although package.json lists them as devDependencies. */
const BUNDLED_DEV_DEPENDENCIES = ['svelte'];

/**
 * @typedef {object} Component
 * @property {string} name
 * @property {string} version
 * @property {string} license SPDX expression as declared ("" when missing)
 * @property {string} url repository or homepage ("" when missing)
 * @property {string[]} authors
 * @property {string} dir package root
 * @property {string[]} files license files, absolute paths
 */

/** License-like files at a package root (not SPDX metadata). */
const LICENSE_FILE = /^(un)?licen[cs]e|^copying|^copyright|^notice/i;

/** @param {string} dir */
export function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && !/\.spdx$/i.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => join(dir, name));
}

/** A license text as printed: LF line ends, no BOM, no trailing blanks. @param {string} raw */
export function cleanText(raw) {
  return raw
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** @param {unknown} repo @param {unknown} homepage */
function sourceUrl(repo, homepage) {
  const raw = typeof repo === 'string' ? repo : repo && typeof repo === 'object' && 'url' in repo ? String(repo.url) : '';
  let url = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
  if (/^github:/.test(url)) url = `https://github.com/${url.slice('github:'.length)}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url || (typeof homepage === 'string' ? homepage : '');
}

/** @param {unknown} person */
function personName(person) {
  if (typeof person === 'string') return person;
  if (person && typeof person === 'object' && 'name' in person) return String(person.name);
  return '';
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

/**
 * Directory of package `name` as Node resolves it from `fromDir` (the
 * nearest node_modules/<name> up the tree), symlinks resolved.
 * @param {string} name @param {string} fromDir
 */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The packages `roots` pull in, transitively (dependencies and installed
 * optional dependencies), resolved from `rootDir`.
 * @param {string} rootDir @param {string[]} roots
 * @returns {Component[]}
 */
export function npmComponents(rootDir, roots) {
  /** @type {Map<string, Component>} */
  const byDir = new Map();
  /** @type {Array<[string, string]>} */
  const queue = roots.map((name) => [name, rootDir]);
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [name, from] = next;
    const dir = resolvePackage(name, from);
    if (!dir) throw new Error(`${name} is not installed (run pnpm install)`);
    if (byDir.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const license =
      typeof pkg.license === 'string'
        ? pkg.license
        : Array.isArray(pkg.licenses)
          ? pkg.licenses.map(/** @param {unknown} l */ (l) => personName(l) || String((/** @type {{type?: string}} */ (l)).type ?? '')).join(' OR ')
          : personName(pkg.license);
    byDir.set(dir, {
      name: pkg.name,
      version: pkg.version,
      license,
      url: sourceUrl(pkg.repository, pkg.homepage),
      authors: [pkg.author, ...(pkg.authors ?? []), ...(pkg.contributors ?? [])].map(personName).filter(Boolean),
      dir,
      files: licenseFiles(dir),
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dep, dir]);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      if (resolvePackage(dep, dir)) queue.push([dep, dir]);
    }
  }
  return [...byDir.values()];
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CargoMetadata
 * @property {Array<{id: string, name: string, version: string, license: string | null, license_file: string | null, repository: string | null, homepage: string | null, authors: string[], manifest_path: string}>} packages
 * @property {string[]} workspace_members
 */

/**
 * The crates in `tree` (`cargo tree --prefix none --format {p}` output:
 * "name vX.Y.Z" per line), described from `metadata`, without the
 * workspace's own crates.
 * @param {CargoMetadata} metadata @param {string} tree
 * @returns {Component[]}
 */
export function linkedCrates(metadata, tree) {
  const linked = new Set();
  for (const line of tree.split('\n')) {
    const m = /^(\S+) v(\S+)/.exec(line.trim());
    if (m) linked.add(`${m[1]} ${m[2]}`);
  }
  const members = new Set(metadata.workspace_members);
  return metadata.packages
    .filter((pkg) => linked.has(`${pkg.name} ${pkg.version}`) && !members.has(pkg.id))
    .map((pkg) => {
      const dir = dirname(pkg.manifest_path);
      const files = licenseFiles(dir);
      if (pkg.license_file) {
        const declared = resolve(dir, pkg.license_file);
        if (existsSync(declared) && !files.includes(declared)) files.push(declared);
      }
      return {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? '',
        url: sourceUrl(pkg.repository, pkg.homepage),
        authors: pkg.authors,
        dir,
        files,
      };
    });
}

/** Runs cargo in the repository; its stdout. @param {string[]} args */
function cargo(args) {
  return execFileSync('cargo', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// License texts
// ---------------------------------------------------------------------------

/** Licenses whose text has no per-author part: any copy of it will do. */
const SHARED_TEXTS = {
  'Apache-2.0': /Apache License\s+Version 2\.0, January 2004/,
  'MPL-2.0': /Mozilla Public License,? Version 2\.0/,
};

const MIT = `MIT License

Copyright (c) {holders}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC = `ISC License

Copyright (c) {holders}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

const BSD_3_CLAUSE = `BSD 3-Clause License

Copyright (c) {holders}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

/** Standard texts with a copyright line to fill in. */
const TEMPLATES = { MIT, ISC, 'BSD-3-Clause': BSD_3_CLAUSE };

/**
 * The first copy of each shared-text license found among the components'
 * files, for components that ship no text of their own.
 * @param {Component[]} components
 * @returns {Map<string, string>}
 */
export function sharedTexts(components) {
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const c of components) {
    for (const file of c.files) {
      const text = cleanText(readFileSync(file, 'utf8'));
      for (const [id, fingerprint] of Object.entries(SHARED_TEXTS)) {
        if (!found.has(id) && fingerprint.test(text)) found.set(id, text);
      }
    }
  }
  return found;
}

/**
 * The license texts of a component: its own files, or else (see the top of
 * this file) a shared or standard text for one of the licenses its
 * expression offers.
 * @param {Component} c @param {Map<string, string>} shared
 * @returns {string[]}
 */
export function textsOf(c, shared) {
  if (c.files.length > 0) return c.files.map((f) => cleanText(readFileSync(f, 'utf8')));
  const choices = c.license
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+|\//)
    .map((id) => id.trim())
    .filter(Boolean);
  if (choices.some((id) => /\sAND\s/.test(id))) {
    throw new Error(`${c.name} ${c.version} (${c.license}) ships no license file`);
  }
  for (const id of choices) {
    const text = shared.get(id);
    if (text) return [text];
  }
  for (const id of choices) {
    if (id in TEMPLATES) {
      const holders = c.authors.length > 0 ? c.authors.join(', ') : `the ${c.name} authors`;
      return [TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (id)].replace('{holders}', holders)];
    }
  }
  throw new Error(
    `${c.name} ${c.version} ships no license file and "${c.license || 'no license'}" has no standard text here`,
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const RULE = '-'.repeat(72);

/** @param {string} text @param {string} indent */
function wrap(text, indent) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > 72) {
      lines.push(line);
      line = indent + word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/**
 * The notices file: the components of every group, then each distinct
 * license text once (texts differing only in whitespace count as one) with
 * the components it belongs to.
 * @param {string} version Reskin's version
 * @param {Array<{title: string, components: Component[]}>} groups
 * @param {Map<string, string>} shared
 */
export function renderNotices(version, groups, shared) {
  /** @type {Map<string, {n: number, text: string, users: string[]}>} */
  const texts = new Map();
  const out = [
    `Reskin ${version}: third-party notices`,
    '='.repeat(`Reskin ${version}: third-party notices`.length),
    '',
    wrap(
      'Reskin itself is released under the MIT License. It includes the open-source components listed below, each under its own license. The license texts follow the list; [n] points to them.',
      '',
    ),
  ];
  for (const group of groups) {
    const sorted = [...group.components].sort(
      (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
    );
    const heading = `${group.title} (${sorted.length})`;
    out.push('', heading, '-'.repeat(heading.length));
    for (const c of sorted) {
      const label = `${c.name} ${c.version}`;
      const refs = textsOf(c, shared).map((text) => {
        const key = text.replace(/\s+/g, ' ');
        let entry = texts.get(key);
        if (!entry) {
          entry = { n: texts.size + 1, text, users: [] };
          texts.set(key, entry);
        }
        if (!entry.users.includes(label)) entry.users.push(label);
        return `[${entry.n}]`;
      });
      const parts = [label, c.license || 'license not declared', c.url].filter(Boolean);
      out.push(`${parts.join(' · ')}  ${refs.join(' ')}`);
    }
  }
  out.push('', '', 'License texts', '=============');
  for (const { n, text, users } of texts.values()) {
    out.push('', wrap(`[${n}] ${users.join(', ')}`, '    '), RULE, text);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  const value = (/** @type {string} */ flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    out: resolve(ROOT, value('--out') ?? 'dist/THIRD_PARTY_NOTICES.txt'),
    target: value('--target') ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? DEFAULT_TARGET,
    ifTauri: argv.includes('--if-tauri'),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ifTauri && !process.env.TAURI_ENV_PLATFORM) {
    console.log('third-party notices: skipped (only `tauri build` writes them)');
    return;
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const js = npmComponents(ROOT, [...Object.keys(pkg.dependencies ?? {}), ...BUNDLED_DEV_DEPENDENCIES]);
  // `cargo tree` picks the crates: normal dependencies only (no build or
  // dev dependencies), no proc macros (they run while building), with the
  // features Cargo builds for the target. `cargo metadata` describes them
  // (its own dependency graph merges in what build scripts use).
  const tree = cargo([
    ...['tree', '--locked', '-p', APP_CRATE, '--target', args.target],
    ...['-e', 'normal,no-proc-macro', '--prefix', 'none', '--format', '{p}'],
  ]);
  /** @type {CargoMetadata} */
  const metadata = JSON.parse(cargo(['metadata', '--format-version', '1', '--locked', '--filter-platform', args.target]));
  const rust = linkedCrates(metadata, tree);
  const text = renderNotices(
    pkg.version,
    [
      { title: 'JavaScript packages in the app pages', components: js },
      { title: `Rust crates linked into reskin.exe for ${args.target}`, components: rust },
    ],
    sharedTexts([...js, ...rust]),
  );
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, text);
  console.log(
    `✓ third-party notices: ${js.length} JavaScript packages, ${rust.length} Rust crates → ${args.out} (${(text.length / 1024).toFixed(0)} KB)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`✗ third-party notices: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
// The text of a GitHub release: what to download and how to install it,
// then the version's section of CHANGELOG.md. The release workflow runs it
// before it waits for CI, so a version the CHANGELOG doesn't describe fails
// at once.
//
//   node scripts/release-notes.mjs <tag> [--repo <url>] [--out <file>]
//
// The repository URL defaults to the one GitHub Actions runs in; the text
// goes to stdout unless --out names a file.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO = 'https://github.com/KarimEidou/Reskin';

/**
 * The files every release attaches under the same names, so
 * `releases/latest/download/<name>` always reaches the newest one. The
 * release workflow stages them under exactly these names.
 */
export const ASSETS = {
  setup: 'Reskin-Setup.exe',
  portable: 'Reskin-Portable.exe',
  msi: 'Reskin.msi',
};

/**
 * The `## [version]` section of the changelog, up to the next version or the
 * link references at the end. A release text shows every line break, so the
 * wrapped lines of a paragraph or list item become one; only plain text is
 * joined: code, headings, quotes, tables, HTML and hard breaks stay as they
 * are, and a line starting a list item or rule starts anew.
 * @param {string} changelog
 * @param {string} version
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## [') || /^\[[^\]]+\]:\s/.test(line));
  /** @param {string} line */
  const plain = (line) => line.trim() !== '' && !/^( {4}|\t)|^\s*(#|>|<|```|~~~)|\|/.test(line);
  /** @type {string[]} */
  const section = [];
  let fenced = false;
  for (const line of end < 0 ? rest : rest.slice(0, end)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const prev = section.at(-1);
    const joins =
      !fenced &&
      prev !== undefined &&
      plain(prev) &&
      !/( {2}|\\)$/.test(prev) &&
      plain(line) &&
      !/^\s*(?:[-*+](?:\s|$)|\d+[.)](?:\s|$)|[=-]+\s*$|([-*_])(?:\s*\1){2,}\s*$)/.test(line);
    if (joins && prev !== undefined) section[section.length - 1] = `${prev.trimEnd()} ${line.trimStart()}`;
    else section.push(line);
  }
  const text = section.join('\n').trim();
  if (!text) throw new Error(`the "## [${version}]" section of CHANGELOG.md is empty`);
  return text;
}

/**
 * The whole release text for `tag` (v1.2.3): the download first, for people
 * who came for the app, then what changed.
 * @param {{ changelog: string, tag: string, repo: string }} options
 */
export function releaseNotes({ changelog, tag, repo }) {
  const version = tag.replace(/^v/, '');
  const changes = changelogSection(changelog, version);
  /** @param {string} name */
  const file = (name) => `${repo}/releases/download/${tag}/${name}`;
  return [
    `### ⬇️ [Download Reskin for Windows](${file(ASSETS.setup)})`,
    '',
    `Open **${ASSETS.setup}** and the box appears on your desktop. No admin rights, no account. Windows 10 and 11 (64-bit).`,
    '',
    `Rather not install anything? Get **[${ASSETS.portable}](${file(ASSETS.portable)})**, which runs from any folder. Setting up many PCs? Use **[${ASSETS.msi}](${file(ASSETS.msi)})**.`,
    '',
    '> **"Windows protected your PC"?** Reskin is new and not code-signed yet, so SmartScreen may warn you the first time. Click **More info**, then **Run anyway**. The checksums of every file are in `SHA256SUMS.txt`.',
    '',
    `## What's new in ${version}`,
    '',
    changes,
    '',
  ].join('\n');
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @param {string} flag */
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const tag = argv.find((arg, i) => !arg.startsWith('--') && !['--repo', '--out'].includes(argv[i - 1] ?? ''));
  if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
    throw new Error('usage: release-notes.mjs <tag like v1.2.3> [--repo <url>] [--out <file>]');
  }
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: slug } = process.env;
  return { tag, repo: value('--repo') ?? (server && slug ? `${server}/${slug}` : DEFAULT_REPO), out: value('--out') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { tag, repo, out } = parseArgs(process.argv.slice(2));
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const notes = releaseNotes({ changelog, tag, repo });
    if (out) writeFileSync(out, notes);
    else process.stdout.write(notes);
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

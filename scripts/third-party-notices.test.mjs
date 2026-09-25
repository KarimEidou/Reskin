// Unit tests for third-party-notices.mjs (node --test; part of `pnpm test`).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  cleanText,
  licenseFiles,
  linkedCrates,
  nativeLibraries,
  npmComponents,
  renderNotices,
  sharedTexts,
  textsOf,
} from './third-party-notices.mjs';

const root = mkdtempSync(join(tmpdir(), 'reskin-notices-'));
after(() => rmSync(root, { recursive: true, force: true }));

const APACHE = 'Apache License\n                           Version 2.0, January 2004\n\nTERMS AND CONDITIONS';

/** Writes `files` ({relative path: content}) under a fresh folder. @param {Record<string, string>} files */
function tree(files) {
  const dir = mkdtempSync(join(root, 'fixture-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** @param {Partial<import('./third-party-notices.mjs').Component>} c */
const component = (c) => ({ name: 'x', version: '1.0.0', license: 'MIT', url: '', authors: [], dir: root, files: [], ...c });

describe('license files', () => {
  it('finds license-like files, not SPDX metadata', () => {
    const dir = tree({ 'LICENSE-MIT': 'm', 'license-apache-2.0': 'a', COPYING: 'c', 'LICENSE.spdx': 's', 'README.md': 'r' });
    assert.deepEqual(
      licenseFiles(dir).map((f) => f.slice(dir.length + 1)),
      ['COPYING', 'LICENSE-MIT', 'license-apache-2.0'],
    );
  });

  it('prints texts with LF ends and no BOM or trailing blanks', () => {
    assert.equal(cleanText('﻿\r\nMIT License  \r\n\r\nCopyright\t\r\n\n'), 'MIT License\n\nCopyright');
  });
});

describe('JavaScript packages', () => {
  it('follows dependencies and installed optional ones from the roots', () => {
    const dir = tree({
      'node_modules/app-ui/package.json': JSON.stringify({
        name: 'app-ui',
        version: '1.2.0',
        license: 'ISC',
        repository: { url: 'git+https://github.com/acme/app-ui.git' },
        author: { name: 'Acme' },
        dependencies: { helper: '^2' },
        optionalDependencies: { 'not-installed': '^1' },
      }),
      'node_modules/app-ui/LICENSE': 'ISC License\n\nCopyright (c) Acme',
      'node_modules/app-ui/node_modules/helper/package.json': JSON.stringify({
        name: 'helper',
        version: '2.0.1',
        license: 'MIT',
        repository: 'acme/helper',
      }),
      'node_modules/unused/package.json': JSON.stringify({ name: 'unused', version: '1.0.0' }),
    });
    const found = npmComponents(dir, ['app-ui']);
    assert.deepEqual(
      found.map((c) => [c.name, c.version, c.license, c.url, c.authors, c.files.length]),
      [
        ['app-ui', '1.2.0', 'ISC', 'https://github.com/acme/app-ui', ['Acme'], 1],
        ['helper', '2.0.1', 'MIT', 'https://github.com/acme/helper', [], 0],
      ],
    );
    assert.throws(() => npmComponents(dir, ['missing']), /missing is not installed/);
  });
});

describe('Rust crates', () => {
  it('takes the crates cargo tree lists, described by cargo metadata', () => {
    const dir = tree({ 'serde/Cargo.toml': '', 'serde/LICENSE-MIT': 'MIT', 'syn/Cargo.toml': '' });
    const pkg = (/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ path) => ({
      id,
      name,
      version: '1.0.0',
      license: 'MIT OR Apache-2.0',
      license_file: null,
      repository: `https://github.com/example/${name}`,
      homepage: null,
      authors: ['Example'],
      manifest_path: join(dir, path, 'Cargo.toml'),
    });
    const metadata = {
      packages: [
        pkg('path+file:///repo#reskin@1.0.0', 'reskin', 'reskin'),
        pkg('registry#serde@1.0.0', 'serde', 'serde'),
        // A proc macro and build-script helper: not in the tree.
        pkg('registry#syn@1.0.0', 'syn', 'syn'),
      ],
      workspace_members: ['path+file:///repo#reskin@1.0.0'],
    };
    const crates = linkedCrates(metadata, 'reskin v1.0.0 (/repo/src-tauri)\nserde v1.0.0\nserde v1.0.0 (*)\n');
    assert.deepEqual(
      crates.map((c) => [c.name, c.url, c.files.map((f) => f.slice(dir.length + 1))]),
      [['serde', 'https://github.com/example/serde', [join('serde', 'LICENSE-MIT')]]],
    );
  });
});

describe('native libraries', () => {
  const crates = [
    component({ name: 'webview2-com', version: '0.38.2' }),
    component({ name: 'webview2-com-sys', version: '0.38.2' }),
  ];

  it('adds the WebView2 SDK and its license on msvc, where its loader is linked statically', () => {
    const native = nativeLibraries(crates, 'x86_64-pc-windows-msvc');
    assert.deepEqual(
      native.map((c) => [c.name, c.version, c.license, c.url]),
      [['Microsoft.Web.WebView2', '1.0.3650.58', 'BSD-3-Clause', 'https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3650.58']],
    );
    const [text] = textsOf(/** @type {import('./third-party-notices.mjs').Component} */ (native[0]), new Map());
    assert.match(text ?? '', /^Copyright \(C\) Microsoft Corporation\. All rights reserved\.\n\nRedistribution and use/);
  });

  it('adds nothing where the loader is a DLL or not linked at all', () => {
    assert.deepEqual(nativeLibraries(crates, 'x86_64-pc-windows-gnu'), []);
    assert.deepEqual(nativeLibraries([component({ name: 'serde' })], 'x86_64-pc-windows-msvc'), []);
  });

  it('refuses a webview2-com-sys whose SDK it has not checked', () => {
    assert.throws(
      () => nativeLibraries([component({ name: 'webview2-com-sys', version: '0.39.0' })], 'x86_64-pc-windows-msvc'),
      /webview2-com-sys 0\.39\.0 ships a WebView2 SDK this script doesn't know/,
    );
  });
});

describe('license texts', () => {
  const apacheDir = tree({ 'LICENSE-APACHE': APACHE });
  const withApache = component({ name: 'uses-apache', license: 'Apache-2.0', files: licenseFiles(apacheDir) });
  const shared = sharedTexts([withApache]);

  it('uses the files a component ships', () => {
    assert.deepEqual(textsOf(withApache, shared), [cleanText(APACHE)]);
  });

  it('borrows a shared text, else fills in a standard one, else fails', () => {
    // "MIT/Apache-2.0" without files: the Apache text another crate ships.
    assert.deepEqual(textsOf(component({ license: 'MIT/Apache-2.0' }), shared), [cleanText(APACHE)]);
    // MIT alone: the standard text, its authors as copyright holders.
    const [mit] = textsOf(component({ name: 'webview2-com', authors: ['Bill Avery'] }), shared);
    assert.match(mit ?? '', /^MIT License\n\nCopyright \(c\) Bill Avery\n\nPermission is hereby granted/);
    const [bsd] = textsOf(component({ name: 'alloc', license: 'BSD-3-Clause' }), new Map());
    assert.match(bsd ?? '', /Copyright \(c\) the alloc authors/);
    assert.throws(() => textsOf(component({ name: 'odd', license: 'WTFPL' }), shared), /odd 1\.0\.0 ships no license file/);
    assert.throws(() => textsOf(component({ license: 'MIT AND Unicode-3.0' }), shared), /ships no license file/);
  });

  it('lists every component and prints each distinct text once', () => {
    const mitA = tree({ LICENSE: 'MIT License\n\nCopyright (c) A' });
    const mitAgain = tree({ 'LICENSE.md': 'MIT License\r\n\r\nCopyright   (c) A\r\n' });
    const text = renderNotices(
      '9.9.9',
      [
        { title: 'JavaScript packages in the app pages', components: [component({ name: 'b-lib', files: licenseFiles(mitAgain) })] },
        {
          title: 'Rust crates linked into reskin.exe for x86_64-pc-windows-msvc',
          components: [
            component({ name: 'zeta', version: '0.1.0', license: 'Apache-2.0', files: licenseFiles(apacheDir) }),
            component({ name: 'alpha', url: 'https://example.com/alpha', files: licenseFiles(mitA) }),
          ],
        },
      ],
      shared,
    );
    assert.match(text, /^Reskin 9\.9\.9: third-party notices\n/);
    assert.match(text, /JavaScript packages in the app pages \(1\)\n-+\nb-lib 1\.0\.0 · MIT {2}\[1\]\n/);
    // Sorted by name; the whitespace-only variant of b-lib's text is the same text.
    assert.match(text, /\(2\)\n-+\nalpha 1\.0\.0 · MIT · https:\/\/example\.com\/alpha {2}\[1\]\nzeta 0\.1\.0 · Apache-2\.0 {2}\[2\]\n/);
    assert.match(text, /\[1\] b-lib 1\.0\.0, alpha 1\.0\.0\n-{72}\nMIT License/);
    assert.match(text, /\[2\] zeta 0\.1\.0\n-{72}\nApache License/);
    assert.equal(text.match(/^MIT License$/gm)?.length, 1);
    assert.ok(text.endsWith('TERMS AND CONDITIONS\n'));
  });
});

// Unit tests for release-notes.mjs (node --test; part of `pnpm test`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ASSETS, changelogSection, releaseNotes } from './release-notes.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.1.0] - 2026-10-01',
  '',
  'A summary that wraps',
  'over two lines.',
  '',
  '### Fixed',
  '',
  '- A list item that wraps',
  '  onto a second line.',
  '- Another item.',
  '',
  '```',
  'code stays',
  'as it is',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '',
  '## [1.0.0] - 2026-09-25',
  '',
  'The first release.',
  '',
  '[1.1.0]: https://example.com/1.1.0',
].join('\n');

describe('changelogSection', () => {
  it('takes one version, joining wrapped lines but not code or tables', () => {
    assert.equal(
      changelogSection(CHANGELOG, '1.1.0'),
      [
        'A summary that wraps over two lines.',
        '',
        '### Fixed',
        '',
        '- A list item that wraps onto a second line.',
        '- Another item.',
        '',
        '```',
        'code stays',
        'as it is',
        '```',
        '',
        '| a | b |',
        '| - | - |',
      ].join('\n'),
    );
  });

  it('stops at the link references after the last version', () => {
    assert.equal(changelogSection(CHANGELOG, '1.0.0'), 'The first release.');
  });

  it('refuses a version the changelog does not describe, or an empty one', () => {
    assert.throws(() => changelogSection(CHANGELOG, '2.0.0'), /no "## \[2\.0\.0\]" section/);
    assert.throws(() => changelogSection('## [3.0.0]\n\n## [2.0.0]\n', '3.0.0'), /is empty/);
  });
});

describe('releaseNotes', () => {
  const notes = releaseNotes({ changelog: CHANGELOG, tag: 'v1.1.0', repo: 'https://github.com/o/r' });

  it('leads with the installer of this release', () => {
    const first = notes.split('\n')[0];
    assert.equal(first, '### ⬇️ [Download Reskin for Windows](https://github.com/o/r/releases/download/v1.1.0/Reskin-Setup.exe)');
  });

  it('links every download of this release and explains SmartScreen', () => {
    for (const name of Object.values(ASSETS)) {
      assert.ok(notes.includes(`(https://github.com/o/r/releases/download/v1.1.0/${name})`), name);
    }
    assert.match(notes, /More info\*\*, then \*\*Run anyway/);
  });

  it("follows with the version's changes", () => {
    assert.ok(notes.includes("## What's new in 1.1.0\n\nA summary that wraps over two lines."));
    assert.ok(!notes.includes('The first release.'));
  });

  it('describes the real changelog of the current version', () => {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    assert.ok(releaseNotes({ changelog, tag: `v${version}`, repo: 'https://github.com/o/r' }).length > 0);
  });
});

describe('the release workflow', () => {
  it('attaches the files under the names the notes link to', () => {
    const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    for (const name of Object.values(ASSETS)) {
      assert.ok(workflow.includes(`release-assets\\${name}`), `release.yml stages ${name}`);
      assert.ok(workflow.includes(`release-assets/${name}`), `release.yml publishes ${name}`);
    }
  });
});

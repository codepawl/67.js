import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check-links.mjs');

function runLinkCheck(folder) {
  return spawnSync(process.execPath, [scriptPath], { cwd: folder, encoding: 'utf8' });
}

function makeRepository() {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-check-links-'));
  execFileSync('git', ['init', '-q'], { cwd: folder });
  mkdirSync(join(folder, 'public'));
  writeFileSync(join(folder, '.gitignore'), 'public/*.md\n');
  writeFileSync(join(folder, 'README.md'), 'A [good link](README.md).\n');
  return folder;
}

test('the link check skips git-ignored files that hold a broken link', () => {
  const folder = makeRepository();
  try {
    writeFileSync(join(folder, 'public/guide.md'), 'A [broken link](../missing.md).\n');
    const result = runLinkCheck(folder);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /0 broken links/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the link check still reports a broken link in a file git does not ignore', () => {
  const folder = makeRepository();
  try {
    writeFileSync(join(folder, 'notes.md'), 'A [broken link](missing.md).\n');
    const result = runLinkCheck(folder);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /notes\.md -> missing\.md/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

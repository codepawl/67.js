import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };
import { CrucibleRenderer, Renderer67 } from '../src/index.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function runBin(name, argumentsList) {
  return spawnSync(process.execPath, [`bin/${name}`, ...argumentsList], { cwd: repositoryRoot, encoding: 'utf8' });
}

test('the deprecated Renderer67 export is the same class as CrucibleRenderer', () => {
  assert.equal(Renderer67, CrucibleRenderer);
});

test('package.json lists the new commands and keeps the old names as aliases', () => {
  assert.equal(packageMetadata.name, '@codepawlhq/crucible');
  assert.equal(packageMetadata.bin['crucible-mcp'], './bin/crucible-mcp.mjs');
  assert.equal(packageMetadata.bin['crucible-addon-check'], './bin/crucible-addon-check.mjs');
  assert.equal(packageMetadata.bin['67js-mcp'], './bin/67js-mcp.mjs');
  assert.equal(packageMetadata.bin['67js-addon-check'], './bin/67js-addon-check.mjs');
});

test('67js-mcp prints a one-line rename notice and then behaves like crucible-mcp', () => {
  const oldCommand = runBin('67js-mcp.mjs', ['--version']);
  const newCommand = runBin('crucible-mcp.mjs', ['--version']);
  assert.equal(oldCommand.status, 0);
  assert.equal(oldCommand.stderr, '67js-mcp is now crucible-mcp; the old name goes away in the next release.\n');
  assert.equal(oldCommand.stdout, newCommand.stdout);
  assert.equal(newCommand.stderr, '');
});

test('67js-addon-check prints a one-line rename notice and then behaves like crucible-addon-check', () => {
  const oldCommand = runBin('67js-addon-check.mjs', ['--help']);
  const newCommand = runBin('crucible-addon-check.mjs', ['--help']);
  const [noticeLine, ...otherLines] = oldCommand.stderr.split('\n');
  assert.equal(noticeLine, '67js-addon-check is now crucible-addon-check; the old name goes away in the next release.');
  assert.equal(otherLines.join('\n'), newCommand.stderr);
  assert.equal(oldCommand.stdout, newCommand.stdout);
  assert.equal(oldCommand.status, newCommand.status);
});

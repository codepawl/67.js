import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookOptionalForVite } from '../scripts/vite-cook-optional.mjs';

const STUB_PATH = '/stub/cook-missing.js';
const PACK_INPUT = '@codepawlhq/cook/pack-input';
const JOB_INPUT = '@codepawlhq/cook/job-input';

function createPlugin({ disabled = false, installed = true } = {}) {
  return cookOptionalForVite({
    environment: disabled ? { COOK_DISABLE: '1' } : {},
    isInstalled: () => installed,
    stubPath: STUB_PATH,
  });
}

test('an installed package keeps its own imports', () => {
  const plugin = createPlugin();
  assert.equal(plugin.resolveId(PACK_INPUT), null);
  assert.equal(plugin.resolveId(JOB_INPUT), null);
});

test('a missing package swaps both packers for the stub', () => {
  const plugin = createPlugin({ installed: false });
  assert.equal(plugin.resolveId(PACK_INPUT), STUB_PATH);
  assert.equal(plugin.resolveId(JOB_INPUT), STUB_PATH);
});

test('COOK_DISABLE=1 swaps the packers even when the package is installed', () => {
  const plugin = createPlugin({ disabled: true });
  assert.equal(plugin.resolveId(PACK_INPUT), STUB_PATH);
  assert.equal(plugin.resolveId(JOB_INPUT), STUB_PATH);
});

test('other imports are never touched', () => {
  const plugin = createPlugin({ disabled: true, installed: false });
  assert.equal(plugin.resolveId('three'), null);
  assert.equal(plugin.resolveId('@codepawlhq/cook/engine'), null);
});

test('the default install check returns the real package or the stub', () => {
  const plugin = cookOptionalForVite({ environment: {} });
  const resolved = plugin.resolveId(PACK_INPUT);
  assert.ok(resolved === null || resolved.endsWith('cook-missing.js'));
});

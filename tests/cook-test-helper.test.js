import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cookFile, cookInstalled, cookModule, cookSkipReason } from './support/cook.js';

const SKIP_REASON = 'Cook (@codepawlhq/cook) is not installed';
const helperUrl = new URL('./support/cook.js', import.meta.url).href;

test('the helper agrees with itself about whether Cook is installed', async () => {
  assert.equal(cookSkipReason, cookInstalled ? false : SKIP_REASON);
  const engine = await cookModule('engine');
  if (cookInstalled) {
    assert.equal(typeof engine.describeEngine, 'function');
    assert.equal((await cookModule()).describeEngine, (await cookModule('.')).describeEngine);
    assert.ok(existsSync(cookFile('FORMAT-v2.md')));
  } else {
    assert.equal(engine, null);
    assert.equal(cookFile('FORMAT-v2.md'), null);
  }
});

// The tests in the child process print a marker if their body runs; the line before them reports what the helper saw.
const childScript = `
  import { cookInstalled, cookSkipReason, cookModule, cookFile, cookTest, cookDescribe } from ${JSON.stringify(helperUrl)};
  const outcome = { cookInstalled, cookSkipReason, module: await cookModule('engine'), file: cookFile('FORMAT-v2.md') };
  console.log('OUTCOME ' + JSON.stringify(outcome));
  cookTest('guarded test', { skip: false }, () => { console.log('BODY-RAN'); });
  cookDescribe('guarded group', () => { cookTest('inner', () => { console.log('BODY-RAN'); }); });
`;

test('COOK_DISABLE=1 makes the helper behave as if Cook were absent', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childScript], {
    env: { ...process.env, COOK_DISABLE: '1' },
    encoding: 'utf8',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  assert.equal(child.status, 0, child.stderr);
  const outcomeLine = child.stdout.split('\n').find(line => line.startsWith('OUTCOME '));
  const outcome = JSON.parse(outcomeLine.slice('OUTCOME '.length));
  assert.equal(outcome.cookInstalled, false);
  assert.equal(outcome.cookSkipReason, SKIP_REASON);
  assert.equal(outcome.module, null);
  assert.equal(outcome.file, null);
  assert.ok(!child.stdout.includes('BODY-RAN'), 'skipped tests do not run their bodies, whatever skip option the caller passed');
});

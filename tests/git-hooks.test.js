import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunPreflight } from '../scripts/pre-push.mjs';
import { planHooksInstall } from '../scripts/install-git-hooks.mjs';

const someSha = 'a'.repeat(40);
const deletedSha = '0'.repeat(40);

test('pushing a branch runs the preflight', () => {
  const pushed = `refs/heads/feat/1-x ${someSha} refs/heads/feat/1-x ${deletedSha}\n`;
  assert.deepEqual(shouldRunPreflight(pushed, {}), { run: true, reason: null });
});

test('pushing HEAD to a branch runs the preflight', () => {
  const pushed = `HEAD ${someSha} refs/heads/feat/1-x ${someSha}\n`;
  assert.equal(shouldRunPreflight(pushed, {}).run, true);
});

test('deleting a branch or pushing only a tag skips the preflight', () => {
  const deletion = `(delete) ${deletedSha} refs/heads/old ${someSha}\n`;
  assert.equal(shouldRunPreflight(deletion, {}).run, false);
  const tag = `refs/tags/v1.0.0 ${someSha} refs/tags/v1.0.0 ${deletedSha}\n`;
  assert.match(shouldRunPreflight(tag, {}).reason, /tags or deletions/);
  assert.equal(shouldRunPreflight('', {}).run, false);
});

test('SKIP_PREFLIGHT=1 skips the preflight', () => {
  const pushed = `refs/heads/main ${someSha} refs/heads/main ${someSha}\r\n`;
  assert.deepEqual(shouldRunPreflight(pushed, { SKIP_PREFLIGHT: '1' }), { run: false, reason: 'SKIP_PREFLIGHT=1' });
});

test('hooks install only in a local git checkout without another hooks folder', () => {
  const local = { isCi: false, isGitCheckout: true, currentHooksPath: null };
  assert.equal(planHooksInstall(local).install, true);
  assert.equal(planHooksInstall({ ...local, isCi: true }).reason, 'CI');
  assert.equal(planHooksInstall({ ...local, isGitCheckout: false }).reason, 'not a git checkout');
  assert.equal(planHooksInstall({ ...local, currentHooksPath: '.githooks' }).reason, 'already installed');
  assert.match(planHooksInstall({ ...local, currentHooksPath: '.husky' }).reason, /already \.husky/);
});

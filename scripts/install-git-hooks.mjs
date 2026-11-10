// Points git at .githooks/ so the pre-push preflight runs in every clone and worktree. Runs from the npm `prepare`
// script. Does nothing on CI, outside a git checkout, or when the clone already uses another hooks folder on purpose.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hooksFolder = '.githooks';

// Decides what to do with the current core.hooksPath. Pure, so tests can call it without git.
export function planHooksInstall({ isCi, isGitCheckout, currentHooksPath }) {
  if (isCi) return { install: false, reason: 'CI' };
  if (!isGitCheckout) return { install: false, reason: 'not a git checkout' };
  if (currentHooksPath === hooksFolder) return { install: false, reason: 'already installed' };
  if (currentHooksPath) return { install: false, reason: `core.hooksPath is already ${currentHooksPath}` };
  return { install: true, reason: null };
}

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function main() {
  const currentHooksPath = git(['config', '--get', 'core.hooksPath']).stdout?.trim() || null;
  const plan = planHooksInstall({
    isCi: Boolean(process.env.CI),
    isGitCheckout: existsSync(join(root, '.git')),
    currentHooksPath,
  });
  if (!plan.install) {
    if (plan.reason.startsWith('core.hooksPath')) console.log(`Git hooks not installed: ${plan.reason}.`);
    return;
  }
  const result = git(['config', 'core.hooksPath', hooksFolder]);
  if (result.status === 0) {
    console.log('Git hooks installed: the pre-push hook runs the fast preflight checks.');
  } else {
    console.warn(`Could not install git hooks: ${result.stderr.trim()}`);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main();
}

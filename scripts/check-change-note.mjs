// The cheap, test-free gates of `npm run preflight` that must also run on CI, because `git push --no-verify` skips the
// pre-push hook: the protected files and the change note. Usage: npm run check:change-note
// In CI it compares with the first parent of the merge commit (scripts/ci-base-sha.mjs). Elsewhere pass --base <ref>.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { isVersionBump, planChecks } from './preflight.mjs';
import { readReleaseProblem } from './check-release-changelog.mjs';
import { pullRequestBaseOf } from './size-base.mjs';

const gateNames = new Set(['protected files', 'change note', 'release changelog']);

// Returns the failing gates for a list of changed paths. Pure, so tests can call it without git.
export function failingGatesFor(changedPaths, { release = false, releaseProblem = null } = {}) {
  return planChecks(changedPaths, { skipTests: true, release, releaseProblem })
    .filter(check => gateNames.has(check.name) && check.failure)
    .map(check => ({ name: check.name, failure: check.failure, fix: check.fix }));
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function baseRefFromArguments() {
  const flagIndex = process.argv.indexOf('--base');
  if (flagIndex !== -1) return process.argv[flagIndex + 1];
  return pullRequestBaseOf() ?? git(['rev-parse', 'HEAD^1']);
}

async function main() {
  const baseRef = baseRefFromArguments();
  const changedPaths = git(['diff', '--name-only', '--no-renames', baseRef, 'HEAD']).split('\n').filter(Boolean);
  const release = isVersionBump(git(['show', `${baseRef}:package.json`]), git(['show', 'HEAD:package.json']));
  if (release) console.log('The package version changed, so this is a release: the protected file and change note gates do not apply, the release changelog gate does.');
  const releaseProblem = release ? await readReleaseProblem() : null;
  const failing = failingGatesFor(changedPaths, { release, releaseProblem });
  for (const gate of failing) {
    console.error(`FAIL ${gate.name}: ${gate.failure}\n     Fix: ${gate.fix}`);
  }
  if (failing.length === 0) console.log(`ok: ${changedPaths.length} changed files pass the protected file, change note and release changelog gates.`);
  return failing.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.exit(await main());
}

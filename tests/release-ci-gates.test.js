// The release and CI gates of #1249: a bump needs its changelog section, the site build runs in CI and preflight, size and tool cost
// follow --base, a renamed protected file is still caught, and the browser tests fail instead of skipping on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from '../scripts/preflight.mjs';
import { failingGatesFor } from '../scripts/check-change-note.mjs';
import { releaseProblem } from '../scripts/check-release-changelog.mjs';
import { skipOrThrow } from './helpers/dev-server-browser.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const changelog = '# Changelog\n\n## 0.20.1\n\n- A fix (#1)\n\n## 0.20.0\n\n- Older (#2)\n';

function readText(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function checkNamed(checks, name) {
  return checks.find(check => check.name === name);
}

test('a version bump without a changelog section or with unfolded notes is a release problem', () => {
  assert.equal(releaseProblem({ version: '0.20.1', changelogText: changelog, fragmentNames: [] }), null);
  assert.match(releaseProblem({ version: '0.20.2', changelogText: changelog, fragmentNames: [] }), /no "## 0\.20\.2" section/);
  assert.match(releaseProblem({ version: '0.20.1', changelogText: changelog, fragmentNames: ['700.md', '701.md'] }), /2 unfolded note\(s\): 700\.md, 701\.md/);
});

test('the change note gate fails a release whose changelog is incomplete', () => {
  const problem = releaseProblem({ version: '0.20.2', changelogText: changelog, fragmentNames: [] });
  const failing = failingGatesFor(['package.json'], { release: true, releaseProblem: problem });
  assert.deepEqual(failing.map(gate => gate.name), ['release changelog']);
  assert.deepEqual(failingGatesFor(['package.json'], { release: true }), []);
  assert.deepEqual(failingGatesFor(['package.json'], { release: false, releaseProblem: problem }), []);
});

test('publish waits for the release changelog check', () => {
  const workflow = readText('.github/workflows/publish.yml');
  assert.match(workflow, /release-changelog:[\s\S]*npm run check:release-changelog/);
  assert.match(workflow, /publish:\s+needs: \[checks, release-changelog\]/);
});

test('the site build runs in preflight and in the package job', () => {
  assert.equal(checkNamed(planChecks(['src/home.js', 'changes/1.md']), 'site build').skipped, null);
  assert.equal(checkNamed(planChecks(['index.html']), 'site build').skipped, null);
  assert.match(checkNamed(planChecks(['docs/guide.md']), 'site build').skipped, /no shipped code or page/);
  assert.match(readText('.github/workflows/test.yml'), /npm run check:site-build/);
  assert.match(readText('package.json'), /"check:site-build": "vite build/);
});

test('size and tool cost compare with the --base ref', () => {
  const checks = planChecks(['src/agent-scene.js', 'changes/1.md'], { baseRef: 'abc123' });
  assert.deepEqual(checkNamed(checks, 'size').command, ['npm', 'run', 'size', '--', '--base', 'abc123']);
  assert.deepEqual(checkNamed(checks, 'tool cost').command, ['npm', 'run', 'tool-cost', '--', '--base', 'abc123']);
  assert.deepEqual(checkNamed(planChecks(['src/agent-scene.js']), 'size').command, ['npm', 'run', 'size']);
});

function runGit(folder, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: folder, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('renaming a protected file fails the protected files gate', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rename-gate-'));
  try {
    runGit(folder, 'init', '-q');
    writeFileSync(join(folder, 'package.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(folder, 'CHANGELOG.md'), changelog);
    runGit(folder, 'add', '.');
    runGit(folder, 'commit', '-q', '-m', 'base');
    runGit(folder, 'mv', 'CHANGELOG.md', 'CHANGELOG-old.md');
    runGit(folder, 'commit', '-q', '-m', 'rename');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-change-note.mjs'), '--base', 'HEAD~1'], { cwd: folder, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /protected files: CHANGELOG\.md/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the browser tests fail instead of skipping under CI', () => {
  const skipped = [];
  const testContext = { skip: message => skipped.push(message) };
  const previous = process.env.CI;
  try {
    process.env.CI = 'true';
    assert.throws(() => skipOrThrow(testContext, 'Chrome did not start'), /Chrome did not start/);
    assert.deepEqual(skipped, []);
    delete process.env.CI;
    skipOrThrow(testContext, 'Chrome did not start');
    assert.deepEqual(skipped, ['Chrome did not start']);
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  }
});

const MIGRATED_BROWSER_TESTS = ['agent-motion-look', 'large-bounds', 'light-bake-backends', 'local-volume-blur', 'local-volume-mesh-raster', 'local-volume-noise', 'local-volume-parts-raster', 'local-volume-scatter', 'local-volumes-entry-points', 'local-volumes', 'render-flags', 'vegetation-pop', 'volume-grid-raster'];

test('the 13 browser tests launch through the shared launcher and skip through the CI guard', () => {
  for (const name of MIGRATED_BROWSER_TESTS) {
    const source = readText(`tests/${name}.test.js`);
    assert.doesNotMatch(source, /chromium\.launch\(/, `${name} launches Chromium by itself`);
    assert.doesNotMatch(source, /context\.skip\(/, `${name} skips without the CI guard`);
    assert.match(source, /launchChrome\(chromium\)/, name);
  }
});

test('scripts compare import.meta.url with pathToFileURL, which also holds for POSIX paths', () => {
  const offenders = readdirSync(join(root, 'scripts'))
    .filter(name => name.endsWith('.mjs'))
    .filter(name => readText(`scripts/${name}`).includes('`file:///${'));
  assert.deepEqual(offenders, []);
});

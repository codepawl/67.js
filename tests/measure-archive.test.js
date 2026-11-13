import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RELEASE_VITE_CONFIGS, viteBuildArguments } from '../scripts/measure-archive.mjs';

// The base archive must be built the way a release builds the package, or the same commit measures smaller as the base
// than as the pull request. Publish failed on every push to main while the standalone build was missing here (#1093).
test('the archive measurement runs every Vite build that prepare-release runs, in the same order', () => {
  const releaseScript = readFileSync(new URL('../scripts/prepare-release.mjs', import.meta.url), 'utf8');
  const releaseConfigs = [...releaseScript.matchAll(/'--config', '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(releaseConfigs, RELEASE_VITE_CONFIGS);
});

test('a staging build empties its folder once and writes the standalone module beside the library', () => {
  const builds = viteBuildArguments('build/.archive-1/build', () => true);
  assert.deepEqual(builds, [
    ['node_modules/vite/bin/vite.js', 'build', '--config', 'config/vite.lib.config.js', '--outDir', 'build/.archive-1/build', '--emptyOutDir'],
    ['node_modules/vite/bin/vite.js', 'build', '--config', 'config/vite.browser.config.js', '--outDir', 'build/.archive-1/build'],
  ]);
});

test('an in-place build keeps the output folder of each config', () => {
  const builds = viteBuildArguments(null, () => true);
  assert.deepEqual(builds.map(viteArguments => viteArguments.at(-1)), RELEASE_VITE_CONFIGS);
});

test('a base branch from before the standalone module is measured with the library build alone', () => {
  const builds = viteBuildArguments('staging', config => config === 'config/vite.lib.config.js');
  assert.equal(builds.length, 1);
  assert.equal(builds[0][3], 'config/vite.lib.config.js');
});

test('a base branch from before the configs moved into config/ is built from the repository root', () => {
  const builds = viteBuildArguments('staging', config => !config.includes('/'));
  assert.deepEqual(builds.map(viteArguments => viteArguments[3]), ['vite.lib.config.js', 'vite.browser.config.js']);
});

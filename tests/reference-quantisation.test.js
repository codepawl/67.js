import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const uvAvailable = spawnSync('uv', ['--version']).status === 0;
const scorerSource = readFileSync(new URL('../bench/reference/score.py', import.meta.url), 'utf8');

// The Crucible render is an 8-bit PNG, so the EEVEE array is rounded to 8 bits before FLIP (#258).
test('score.py rounds the EEVEE array to what an 8-bit PNG holds', { skip: !uvAvailable && 'uv is not installed', timeout: 180000 }, () => {
  const run = spawnSync(
    'uv',
    ['run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy', 'python', '-I', 'bench/reference/score.py', '--self-test'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /score self-test ok/);
});

test('every scoring path loads EEVEE through the quantising loader', () => {
  assert.doesNotMatch(scorerSource, /tone_map_like_crucible\(np\.load\([^)]*eevee/);
  const loads = scorerSource.match(/load_eevee\(work_directory/g) ?? [];
  assert.equal(loads.length, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Draws each soft-light feature off and on in Chrome and records the frame time, so it runs only when asked:
//   RENDER_TESTS=1 bash ~/.agents/tools/gpu-lock.sh node --test tests/light-shapes-render.test.js
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);
const PAIRS = [['sun-hard', 'sun-soft'], ['area-lit', 'area-shadow'], ['spot-plain', 'spot-ies']];

test('each soft-light feature changes the picture, and the default stills keep their hashes', { skip: !enabled, timeout: 300000 }, () => {
  const output = execFileSync('node', ['bench/lighting/soft-lights.mjs', '--rounds=1', `--out=${join(tmpdir(), 'soft-lights-test')}`], { encoding: 'utf8' });
  const { summary } = JSON.parse(output);
  for (const [before, after] of PAIRS) {
    assert.notEqual(summary[before].hash, summary[after].hash, `${after} differs from ${before}`);
    assert.ok(summary[after].medianMilliseconds > 0, `${after} has a frame time`);
  }
  // Hashes of the default stills as main drew them before the soft-light code (bench/lighting/soft-lights.mjs on origin/main).
  assert.equal(summary['sun-hard'].hash, 'c2ed7c8f8ff1908a');
  assert.equal(summary['area-lit'].hash, '227c6a488f89da9b');
  assert.equal(summary['spot-plain'].hash, '4846417a8b3711b6');
});

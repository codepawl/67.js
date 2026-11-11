// A noisy local volume takes at least two samples per noise cell along the ray (issue 855, owner report: smoke looks pixelated).
// Fewer steps jump whole cells and the start-offset dither shows as pixel-pitch grain; the rasterizer and the CPU tracer share the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localVolumeStepCount, resolveLocalVolumes, LOCAL_VOLUME_MAXIMUM_STEPS, LOCAL_VOLUME_STEPS_PER_NOISE_CELL } from '../src/local-volumes.js';

const resolve = fields => resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [2, 2, 2], ...fields }])[0];

test('a volume without noise keeps its own step count', () => {
  const volume = resolve({ steps: 8, noiseAmount: 0, noiseScale: 20 });
  assert.equal(localVolumeStepCount(volume, 5), 8);
});

test('a noisy volume gets two steps per noise cell along the ray, never fewer than its steps', () => {
  const volume = resolve({ steps: 8, noiseAmount: 0.5, noiseScale: 2.2 });
  assert.equal(LOCAL_VOLUME_STEPS_PER_NOISE_CELL, 2);
  assert.equal(localVolumeStepCount(volume, 3.2), Math.ceil(3.2 * 2.2 * 2));
  assert.equal(localVolumeStepCount(volume, 0.5), 8, 'a short ray keeps the requested steps');
});

test('the raised count stops at the maximum', () => {
  const volume = resolve({ steps: 16, noiseAmount: 1, noiseScale: 100 });
  assert.equal(localVolumeStepCount(volume, 10), LOCAL_VOLUME_MAXIMUM_STEPS);
});

test('the post shader and the path tracer use the same rule', () => {
  const shader = readFileSync(new URL('../src/fog-shader.js', import.meta.url), 'utf8');
  assert.match(shader, /if \(noiseAmount > 0\.0\) steps = min\(\$\{LOCAL_VOLUME_MAXIMUM_STEPS\}, max\(steps, int\(ceil\(\(exitDistance - entry\) \* localVolumeEmission\[nearest\]\.w \* \$\{LOCAL_VOLUME_STEPS_PER_NOISE_CELL\.toFixed\(1\)\}\)\)\)\);/);
  const tracer = readFileSync(new URL('../src/path-tracer-volume.js', import.meta.url), 'utf8');
  assert.match(tracer, /const stepCount = localVolumeStepCount\(volume, exits\[order\[rank\]\] - entry\);/);
});

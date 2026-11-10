import assert from 'node:assert/strict';
import test from 'node:test';

import { BLUE_NOISE_CHANNELS, BLUE_NOISE_SIZE, createBlueNoiseTile } from '../src/path-tracer-blue-noise.js';
import { normalizePathTracerOptions } from '../src/path-tracer.js';
import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';

function boxBlurVariance(valueAt, boxSize) {
  let sum = 0;
  let sumOfSquares = 0;
  for (let y = 0; y < BLUE_NOISE_SIZE; y++) {
    for (let x = 0; x < BLUE_NOISE_SIZE; x++) {
      let blurred = 0;
      for (let offsetY = 0; offsetY < boxSize; offsetY++) {
        for (let offsetX = 0; offsetX < boxSize; offsetX++) {
          blurred += valueAt((x + offsetX) % BLUE_NOISE_SIZE, (y + offsetY) % BLUE_NOISE_SIZE);
        }
      }
      blurred /= boxSize * boxSize;
      sum += blurred;
      sumOfSquares += blurred * blurred;
    }
  }
  const count = BLUE_NOISE_SIZE * BLUE_NOISE_SIZE;
  return sumOfSquares / count - (sum / count) ** 2;
}

test('the blue noise tile is the same bytes for the same seed and differs for another', () => {
  const first = createBlueNoiseTile(7);
  assert.deepEqual(createBlueNoiseTile(7), first);
  assert.notDeepEqual(createBlueNoiseTile(8), first);
  assert.equal(first.length, BLUE_NOISE_SIZE * BLUE_NOISE_SIZE * BLUE_NOISE_CHANNELS);
});

test('every channel of the tile holds each value equally often, and its blurred variance is far below white noise', () => {
  const tile = createBlueNoiseTile(3);
  const pixelCount = BLUE_NOISE_SIZE * BLUE_NOISE_SIZE;
  for (let channel = 0; channel < BLUE_NOISE_CHANNELS; channel++) {
    const counts = new Array(256).fill(0);
    for (let pixel = 0; pixel < pixelCount; pixel++) counts[tile[pixel * BLUE_NOISE_CHANNELS + channel]]++;
    assert.ok(counts.every(count => count === pixelCount / 256), `channel ${channel} is not uniform`);
    const blueVariance = boxBlurVariance((x, y) => tile[(y * BLUE_NOISE_SIZE + x) * BLUE_NOISE_CHANNELS + channel] / 255, 4);
    // A 4 by 4 box of white noise has a variance of 1/12/16 = 0.0052.
    assert.ok(blueVariance < 0.0026, `channel ${channel} blurred variance ${blueVariance}`);
  }
});

test('the options choose the sampling pattern and the light choice, and the CPU reference keeps its defaults', () => {
  const defaults = normalizePathTracerOptions({});
  assert.equal(defaults.samplingPattern, 'random');
  assert.equal(defaults.lightSelection, 'auto');
  const gpu = normalizePathTracerOptions({ backend: 'gpu', samplingPattern: 'blue-noise-first', lightSelection: 'importance' });
  assert.equal(gpu.samplingPattern, 'blue-noise-first');
  assert.equal(gpu.lightSelection, 'importance');
  assert.throws(() => normalizePathTracerOptions({ samplingPattern: 'blue-noise-first' }), /needs backend "gpu"/);
  assert.throws(() => normalizePathTracerOptions({ lightSelection: 'importance' }), /needs backend "gpu"/);
  assert.throws(() => normalizePathTracerOptions({ backend: 'gpu', lightSelection: 'bogus' }), /lightSelection must be one of/);
  assert.equal(normalizePathTracerOptions({ lightSelection: 'tree' }).lightSelection, 'tree');
  assert.throws(() => normalizePathTracerOptions({ backend: 'webgpu', lightSelection: 'importance' }), /needs backend/);
  assert.equal(normalizePathTracerOptions({ backend: 'webgpu', lightSelection: 'tree' }).lightSelection, 'tree');
});

test('the kernel compiles the new paths only when asked, so the default kernel keeps its pixels', () => {
  const plain = buildFragmentSource();
  assert.ok(plain.includes('const bool BLUE_NOISE_FIRST = false;'));
  assert.ok(plain.includes('const bool IMPORTANT_LIGHTS = false;'));
  const both = buildFragmentSource({ blueNoise: true, lightImportance: true });
  assert.ok(both.includes('const bool BLUE_NOISE_FIRST = true;'));
  assert.ok(both.includes('const bool IMPORTANT_LIGHTS = true;'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { denoiseRadiance } from '../src/path-tracer-denoise.js';

function buildBuffers(width, height, backgroundRows) {
  const pixelCount = width * height;
  const color = new Float32Array(pixelCount * 3);
  const albedo = new Float32Array(pixelCount * 3).fill(0.5);
  const normal = new Float32Array(pixelCount * 3);
  const depth = new Float32Array(pixelCount);
  const variance = new Float32Array(pixelCount).fill(0.01);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const isBackground = Math.floor(pixel / width) < backgroundRows;
    const value = 0.2 + 0.1 * ((pixel * 7) % 5);
    color.fill(value, pixel * 3, pixel * 3 + 3);
    if (isBackground) continue;
    normal[pixel * 3 + 1] = 1;
    depth[pixel] = 5;
  }
  return { width, height, color, albedo, normal, depth, variance };
}

test('wavelet filter keeps every pixel finite when background pixels have zero normal and depth', () => {
  const buffers = buildBuffers(16, 16, 6);
  const result = denoiseRadiance(buffers);
  assert.equal(result.length, buffers.color.length);
  for (let index = 0; index < result.length; index++) {
    assert.ok(Number.isFinite(result[index]), `output ${index} is ${result[index]}`);
  }
});

test('wavelet filter leaves a background pixel at its input colour', () => {
  const buffers = buildBuffers(16, 16, 6);
  const result = denoiseRadiance(buffers);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(result[channel] - buffers.color[channel]) < 1e-5);
  }
});

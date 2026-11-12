import assert from 'node:assert/strict';
import test from 'node:test';
import { denoiseAtrous, findNativeAddon } from '../packages/render-native/index.mjs';
import { validatePackOptions } from '../packages/render-native/pack-input-v2.mjs';
import { denoiseRadiance } from '../src/path-tracer-denoise.js';

const hasAddon = findNativeAddon() !== null;
const skipWithoutAddon = hasAddon ? false : 'the native addon is not built';
const WIDTH = 48;
const HEIGHT = 40;
const EDGE_COLUMN = 24;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A two-material image with a vertical edge, noisy light and the guide buffers a trace would give. */
function buildImage() {
  const random = seededRandom(7);
  const pixelCount = WIDTH * HEIGHT;
  const rgba = new Float32Array(pixelCount * 4);
  const albedo = new Float32Array(pixelCount * 3);
  const normal = new Float32Array(pixelCount * 3);
  const depth = new Float32Array(pixelCount);
  const variance = new Float32Array(pixelCount);
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const pixel = row * WIDTH + column;
      const rightSide = column >= EDGE_COLUMN;
      const surfaceAlbedo = rightSide ? [0.2, 0.6, 0.3] : [0.7, 0.5, 0.4];
      const surfaceLight = rightSide ? 1.5 : 1.0;
      const noise = 0.5 + random();
      for (let channel = 0; channel < 3; channel++) {
        albedo[pixel * 3 + channel] = surfaceAlbedo[channel];
        rgba[pixel * 4 + channel] = surfaceAlbedo[channel] * surfaceLight * noise;
      }
      rgba[pixel * 4 + 3] = 1;
      const surfaceNormal = rightSide ? [0, 0.6, 0.8] : [0, 0, 2];
      normal.set(surfaceNormal, pixel * 3);
      depth[pixel] = rightSide ? 3 + 0.01 * column : 5 + 0.02 * row;
      variance[pixel] = 0.05 * surfaceLight * surfaceLight;
    }
  }
  return { rgba, albedo, normal, depth, variance };
}

function withoutAlpha(rgba) {
  const color = new Float32Array((rgba.length / 4) * 3);
  for (let pixel = 0; pixel < rgba.length / 4; pixel++) {
    color.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  }
  return color;
}

function unitNormals(normal) {
  const unit = new Float32Array(normal);
  for (let pixel = 0; pixel < unit.length / 3; pixel++) {
    const length = Math.hypot(unit[pixel * 3], unit[pixel * 3 + 1], unit[pixel * 3 + 2]);
    for (let channel = 0; channel < 3; channel++) {
      unit[pixel * 3 + channel] /= length;
    }
  }
  return unit;
}

function noiseAround(values, columns, rows, channel) {
  let sum = 0;
  let squareSum = 0;
  let count = 0;
  for (const row of rows) {
    for (const column of columns) {
      const value = values[(row * WIDTH + column) * 4 + channel];
      sum += value;
      squareSum += value * value;
      count++;
    }
  }
  const mean = sum / count;
  return { mean, deviation: Math.sqrt(Math.max(squareSum / count - mean * mean, 0)) };
}

function range(from, to) {
  return Array.from({ length: to - from }, (_, index) => from + index);
}

test('the denoise option accepts none and atrous and names the choices otherwise', () => {
  assert.doesNotThrow(() => validatePackOptions({ denoise: 'none' }, 'test'));
  assert.doesNotThrow(() => validatePackOptions({ denoise: 'atrous' }, 'test'));
  assert.doesNotThrow(() => validatePackOptions({}, 'test'));
  assert.throws(() => validatePackOptions({ denoise: 'oidn' }, 'test'), /"none" \(default\) or "atrous"/);
});

test('denoiseAtrous rejects a plane of the wrong length', { skip: skipWithoutAddon }, () => {
  const image = buildImage();
  assert.throws(
    () => denoiseAtrous({ width: WIDTH, height: HEIGHT, ...image, depth: new Float32Array(3) }),
    /`depth` must be a Float32Array of 1920 floats/,
  );
});

test('the GPU filter matches the CPU wavelet filter it was written from', { skip: skipWithoutAddon }, () => {
  const image = buildImage();
  const gpu = denoiseAtrous({ width: WIDTH, height: HEIGHT, ...image });
  const cpu = denoiseRadiance({
    width: WIDTH,
    height: HEIGHT,
    color: withoutAlpha(image.rgba),
    albedo: image.albedo,
    normal: unitNormals(image.normal),
    depth: image.depth,
    variance: image.variance,
  });
  let largestRelativeDifference = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    assert.equal(gpu.rgba[pixel * 4 + 3], 1);
    for (let channel = 0; channel < 3; channel++) {
      const expected = cpu[pixel * 3 + channel];
      const actual = gpu.rgba[pixel * 4 + channel];
      largestRelativeDifference = Math.max(largestRelativeDifference, Math.abs(actual - expected) / Math.max(Math.abs(expected), 0.05));
    }
  }
  assert.ok(largestRelativeDifference < 2e-3, `largest relative difference ${largestRelativeDifference}`);
});

test('the filter smooths the noise inside a surface and keeps the edge between two surfaces', { skip: skipWithoutAddon }, () => {
  const image = buildImage();
  const gpu = denoiseAtrous({ width: WIDTH, height: HEIGHT, ...image });
  const innerRows = range(10, 30);
  const leftColumns = range(4, 18);
  const before = noiseAround(image.rgba, leftColumns, innerRows, 0);
  const after = noiseAround(gpu.rgba, leftColumns, innerRows, 0);
  assert.ok(after.deviation < before.deviation * 0.5, `deviation ${before.deviation} -> ${after.deviation}`);
  const leftMean = noiseAround(gpu.rgba, range(20, 24), innerRows, 0).mean;
  const rightMean = noiseAround(gpu.rgba, range(24, 28), innerRows, 0).mean;
  assert.ok(rightMean < leftMean * 0.7 || rightMean > leftMean * 1.3, `edge lost: ${leftMean} against ${rightMean}`);
  assert.ok(gpu.gpuSeconds > 0 && gpu.uploadSeconds >= 0 && gpu.readbackSeconds >= 0);
});

test('pixels that hit nothing (zero normal and depth) stay finite', { skip: skipWithoutAddon }, () => {
  const image = buildImage();
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 7) {
    image.normal.fill(0, pixel * 3, pixel * 3 + 3);
    image.depth[pixel] = 0;
  }
  const gpu = denoiseAtrous({ width: WIDTH, height: HEIGHT, ...image });
  assert.ok(gpu.rgba.every(Number.isFinite));
});

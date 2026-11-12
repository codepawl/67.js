import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { buildNativeInput } from '../packages/render-native/pack-input.mjs';
import { createCamera } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import * as pack from '../src/path-tracer-gpu-pack.js';

const skipWithoutAddon = findNativeAddon() === null ? 'the native addon is not built' : false;

const UNIT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

const FLOOR = {
  positions: new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

const IMAGE_OPTIONS = { width: 24, height: 16, samples: 64, bounces: 3, seed: 11 };
const RESULT_PLANES = ['rgba', 'albedo', 'normal', 'depth', 'variance'];

function horizontalQuadMatrix(scale, height, facesUp) {
  const upOrDown = facesUp ? 1 : -1;
  return [scale, 0, 0, 0, 0, 0, -upOrDown * scale, 0, 0, upOrDown * scale, 0, 0, 0, height, 0, 1];
}

// A lit floor with two emissive ceiling quads, so light picking and several bounces take part.
function buildRoomScene() {
  return {
    materials: [{ color: [0.6, 0.6, 0.6], roughness: 0.8 }, { color: [1, 0.95, 0.9], emission: 5, roughness: 1 }],
    instances: [
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(8, 0, true), materialIndex: 0 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(2, 3, false), materialOverride: 1 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 2, false), materialOverride: 1 },
    ],
  };
}

function bytesOf(result, plane) {
  const values = result[plane];
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function assertSameBytes(first, second, message) {
  for (const plane of RESULT_PLANES) {
    assert.ok(bytesOf(first, plane).equals(bytesOf(second, plane)), `${message}: the ${plane} plane differs`);
  }
}

test('the cycles kernel gives the same bytes whatever the samples per dispatch', { skip: skipWithoutAddon }, () => {
  const camera = createCamera({ eye: [0, 2.2, 6], target: [0, 0.5, 0], fov: 45 }, IMAGE_OPTIONS.width, IMAGE_OPTIONS.height);
  const input = buildNativeInputV2(buildRoomScene(), camera, IMAGE_OPTIONS);
  const traceWith = (samplesPerDispatch) => traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles', samplesPerDispatch });
  const oneAtATime = traceWith(1);
  assert.equal(oneAtATime.samplesPerDispatch, 1);
  assert.ok(oneAtATime.rgba.every(Number.isFinite));
  for (const samplesPerDispatch of [5, 16, 64]) {
    const split = traceWith(samplesPerDispatch);
    assert.equal(split.samplesPerDispatch, samplesPerDispatch);
    assertSameBytes(oneAtATime, split, `${samplesPerDispatch} samples per dispatch against 1`);
  }
});

test('the cycles kernel gives the same bytes when adaptive sampling stops pixels early, whatever the split', { skip: skipWithoutAddon }, () => {
  const camera = createCamera({ eye: [0, 2.2, 6], target: [0, 0.5, 0], fov: 45 }, IMAGE_OPTIONS.width, IMAGE_OPTIONS.height);
  const adaptiveOptions = { ...IMAGE_OPTIONS, samples: 128, noiseThreshold: 0.05 };
  const input = buildNativeInputV2(buildRoomScene(), camera, adaptiveOptions);
  const oneAtATime = traceNative(input, { ...adaptiveOptions, kernel: 'cycles', samplesPerDispatch: 1 });
  const split = traceNative(input, { ...adaptiveOptions, kernel: 'cycles', samplesPerDispatch: 37 });
  assertSameBytes(oneAtATime, split, '37 samples per dispatch against 1 with a noise threshold');
});

test('two renders that size their own dispatches from timing give the same bytes', { skip: skipWithoutAddon }, () => {
  const camera = createCamera({ eye: [0, 2.2, 6], target: [0, 0.5, 0], fov: 45 }, IMAGE_OPTIONS.width, IMAGE_OPTIONS.height);
  const input = buildNativeInputV2(buildRoomScene(), camera, IMAGE_OPTIONS);
  const first = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles' });
  const second = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'cycles' });
  assertSameBytes(first, second, 'two untimed-split renders');
});

test('the legacy kernel draws one sample per dispatch, so two renders give the same bytes', { skip: skipWithoutAddon }, () => {
  const camera = createCamera({ eye: [0, 1, 4], target: [0, 1, 0], fov: 50 }, IMAGE_OPTIONS.width, IMAGE_OPTIONS.height);
  const parts = [{ name: 'floor', geometry: FLOOR, material: { color: [0.5, 0.5, 0.5] } }];
  const input = buildNativeInput(buildTraceScene(parts, {}), camera, IMAGE_OPTIONS, pack);
  const first = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'legacy' });
  const second = traceNative(input, { ...IMAGE_OPTIONS, kernel: 'legacy' });
  assertSameBytes(first, second, 'two legacy renders');
});

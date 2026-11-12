import assert from 'node:assert/strict';
import test from 'node:test';
import { loadReferenceScene } from '../bench/cycles-parity/scene-bridge.mjs';
import { buildTraceSceneWithManyLights } from '../bench/cycles-parity/trace-scene-many-lights.mjs';
import { buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { createCamera } from '../src/path-tracer.js';

const hasAddon = findNativeAddon() !== null;
const skipWithoutAddon = hasAddon ? false : 'the native addon is not built';

const WIDTH = 240;
const HEIGHT = 135;
const SAMPLES = 512;

// Means measured from Blender 5.3.0 Cycles (OptiX, 960 x 540, 4096 samples, box filter) on the `transparent-bounces` reference scene
// at Transparent Max Bounces 0, 1 and 2 (docs/cycles-parity.md, "Transparent bounce limits"). Cycles seeds 1 and 2 agree to five
// digits (a relMSE floor below 1e-6). The tolerance is 0.5 percent: Cook sits 0.1 to 0.2 percent above Cycles at 4096 samples with
// every limit, and the failures it has to catch are far larger: before the fix Cook missed
// 3 to 11 percent of the image mean at a limit of 0 and was 1 to 2 percent too bright behind one layer at a limit of 2.
const CYCLES_IMAGE_MEAN_AT_LIMIT_0_AND_1 = [0.54387, 0.19923, 0.16623];
const CYCLES_IMAGE_MEAN_AT_LIMIT_2 = [0.60846, 0.30715, 0.229];
const CYCLES_SKY_BEHIND_ONE_LAYER_AT_LIMIT_0_AND_1 = [0.61574, 0.30679, 0.27764];
const CYCLES_BACKDROP_BEHIND_ONE_LAYER_AT_LIMIT_2 = [0.506, 0.24495, 0.21766];
const RELATIVE_TOLERANCE = 0.005;

const LEFT_STRIP = [0.08, 0.28];
const SKY_ROWS = [0.03, 0.2];
const BACKDROP_ROWS = [0.4, 0.6];

async function traceLimit(transparentBounces) {
  const { traceSource } = await loadReferenceScene('transparent-bounces');
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
  const camera = createCamera(traceSource.camera, WIDTH, HEIGHT);
  const input = buildNativeInputV2(traceScene, camera, {
    width: WIDTH,
    height: HEIGHT,
    samples: SAMPLES,
    bounces: 8,
    transparentBounces,
    seed: 1,
    parts: traceSource.parts,
  });
  return traceNative(input, { width: WIDTH, height: HEIGHT, samples: SAMPLES, bounces: 8, seed: 1, kernel: 'cycles' }).rgba;
}

function meanOfRegion(rgba, columns, rows) {
  const sum = [0, 0, 0];
  const columnStart = Math.floor(WIDTH * columns[0]);
  const columnStop = Math.floor(WIDTH * columns[1]);
  const rowStart = Math.floor(HEIGHT * rows[0]);
  const rowStop = Math.floor(HEIGHT * rows[1]);
  for (let row = rowStart; row < rowStop; row++) {
    for (let column = columnStart; column < columnStop; column++) {
      for (let channel = 0; channel < 3; channel++) {
        sum[channel] += rgba[(row * WIDTH + column) * 4 + channel];
      }
    }
  }
  const pixelCount = (columnStop - columnStart) * (rowStop - rowStart);
  return sum.map(value => value / pixelCount);
}

function assertWithinTolerance(actual, expected, label) {
  actual.forEach((value, channel) => {
    const relativeError = Math.abs(value / expected[channel] - 1);
    assert.ok(
      relativeError <= RELATIVE_TOLERANCE,
      `${label}, channel ${channel}: Cook ${value.toFixed(5)} against Cycles ${expected[channel]} is ${(relativeError * 100).toFixed(2)} percent off`,
    );
  });
}

test('a transparent limit of 0 lets the path through the first layer, as Cycles does', { skip: skipWithoutAddon }, async () => {
  const limitZero = await traceLimit(0);
  assertWithinTolerance(meanOfRegion(limitZero, [0, 1], [0, 1]), CYCLES_IMAGE_MEAN_AT_LIMIT_0_AND_1, 'image mean at limit 0');
  assertWithinTolerance(
    meanOfRegion(limitZero, LEFT_STRIP, SKY_ROWS),
    CYCLES_SKY_BEHIND_ONE_LAYER_AT_LIMIT_0_AND_1,
    'sky seen through one layer at limit 0',
  );
});

test('a transparent limit of 1 matches Cycles and a limit of 0 renders the same picture', { skip: skipWithoutAddon }, async () => {
  const limitZero = await traceLimit(0);
  const limitOne = await traceLimit(1);
  assertWithinTolerance(meanOfRegion(limitOne, [0, 1], [0, 1]), CYCLES_IMAGE_MEAN_AT_LIMIT_0_AND_1, 'image mean at limit 1');
  assertWithinTolerance(
    meanOfRegion(limitZero, [0, 1], [0, 1]),
    meanOfRegion(limitOne, [0, 1], [0, 1]),
    'image mean at limit 0 against limit 1',
  );
});

test('shadow rays spend what is left of the limit after the camera path passed layers', { skip: skipWithoutAddon }, async () => {
  const limitTwo = await traceLimit(2);
  assertWithinTolerance(meanOfRegion(limitTwo, [0, 1], [0, 1]), CYCLES_IMAGE_MEAN_AT_LIMIT_2, 'image mean at limit 2');
  assertWithinTolerance(
    meanOfRegion(limitTwo, LEFT_STRIP, BACKDROP_ROWS),
    CYCLES_BACKDROP_BEHIND_ONE_LAYER_AT_LIMIT_2,
    'backdrop seen through one layer at limit 2',
  );
});

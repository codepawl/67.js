import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { meanRatioRgb, relativeMeanSquaredError, tileMeanRatios } from '../bench/instancing/image-compare.mjs';
import {
  CARD_FIELD_ENVIRONMENT,
  CARD_FIELD_PACK_OPTIONS,
  buildCardField,
  buildCardFieldMerged,
  cardFieldCamera,
} from '../bench/cycles-parity/native-instance-scene.mjs';
import { buildTraceScene, MAX_TRACE_INSTANCES } from '../src/path-tracer-scene.js';

// More instances than the 65,536 of the CPU and WebGL tracers, on the native "cycles" kernel, against the same cards merged into
// two world-space meshes. The cards from index 65,536 on are red, so a picture without those instances has no red in their band.
// Skipped without the built addon or a ray query adapter. The instanced render has a noise stream of its own, so the bound on
// the difference is a multiple of the difference between two seeds of the merged render, measured in the same run.
const CARD_COUNT = MAX_TRACE_INSTANCES + 20_000;
const SAMPLES = 128;
const TILES = 8;
const NOISE_FACTOR = 3;
const { width: WIDTH, height: HEIGHT } = CARD_FIELD_PACK_OPTIONS;

function render(parts, instancing, seed) {
  const scene = buildTraceScene(parts, CARD_FIELD_ENVIRONMENT, instancing ? { instancing: true, maximumInstances: CARD_COUNT + 1 } : {});
  assert.equal(scene.instances !== undefined, instancing);
  const input = buildNativeInputV2(scene, cardFieldCamera(CARD_COUNT), { width: WIDTH, height: HEIGHT, samples: SAMPLES, seed, bounces: CARD_FIELD_PACK_OPTIONS.bounces });
  return traceNative(input, { width: WIDTH, height: HEIGHT, samples: SAMPLES, kernel: 'cycles' }).rgba;
}

// Pixels whose red channel clearly leads: the red cards, which are all past the old instance bound.
function redPixelCount(rgba) {
  let count = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    if (rgba[pixel * 4] > 1.25 * rgba[pixel * 4 + 1] && rgba[pixel * 4] > 0.02) count++;
  }
  return count;
}

const addonSkip = findNativeAddon() ? false : 'the native addon is not built';

test('more than 65,536 instances of one card render the picture of the same cards merged', { skip: addonSkip }, t => {
  const redFrom = MAX_TRACE_INSTANCES;
  let merged;
  try {
    merged = render(buildCardFieldMerged(CARD_COUNT, redFrom), false, 1);
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
    throw error;
  }
  const mergedOtherSeed = render(buildCardFieldMerged(CARD_COUNT, redFrom), false, 2);
  const instanced = render(buildCardField(CARD_COUNT, redFrom), true, 1);
  const pixelCount = WIDTH * HEIGHT;

  const redMerged = redPixelCount(merged);
  assert.ok(redMerged > pixelCount * 0.03, `the merged picture shows the red cards (${redMerged} of ${pixelCount} pixels)`);
  const redInstanced = redPixelCount(instanced);
  assert.ok(redInstanced > 0.9 * redMerged && redInstanced < 1.1 * redMerged, `red pixels: ${redInstanced} instanced against ${redMerged} merged`);

  for (const ratio of meanRatioRgb(instanced, merged, pixelCount)) assert.ok(ratio > 0.98 && ratio < 1.02, `mean ratio ${ratio}`);
  const noiseFloor = relativeMeanSquaredError(mergedOtherSeed, merged, pixelCount);
  const difference = relativeMeanSquaredError(instanced, merged, pixelCount);
  t.diagnostic(`red pixels ${redInstanced} instanced, ${redMerged} merged; relMSE ${difference} instanced against merged, ${noiseFloor} between two merged seeds`);
  assert.ok(difference < NOISE_FACTOR * noiseFloor, `relMSE ${difference} against the merged picture, ${NOISE_FACTOR} times the seed-to-seed ${noiseFloor} is the bound`);
  for (const ratio of tileMeanRatios(instanced, merged, WIDTH, HEIGHT, TILES)) assert.ok(ratio > 0.95 && ratio < 1.05, `tile mean ratio ${ratio}`);
});

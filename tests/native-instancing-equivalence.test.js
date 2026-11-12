import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInputV2, findNativeAddon, traceNative } from '../packages/render-native/index.mjs';
import { buildCopyScene } from '../bench/instancing/copies-scene.mjs';
import { meanRatioRgb, relativeMeanSquaredError, tileMeanRatios } from '../bench/instancing/image-compare.mjs';
import { createCamera } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

// Instanced copies against the same scene flattened, on the native "cycles" kernel. Skipped without the built addon or a
// ray query adapter. The bounds sit well above what Modal's A10 measured at 1024 samples (relMSE under 6e-5, tiles within
// 1.2 percent) and near the seed-to-seed noise of the flattened scene itself (relMSE about 1.5e-4).
const COPIES = 200;
const WIDTH = 128;
const HEIGHT = 96;
const SAMPLES = 1024;
const TILES = 8;

function render(variant, instancing, seed) {
  const { parts, environment } = buildCopyScene(variant, COPIES);
  const camera = createCamera({ eye: [0, 0, 14], target: [0, 0, -3], fov: 50 }, WIDTH, HEIGHT);
  const scene = buildTraceScene(parts, environment, { instancing });
  const input = buildNativeInputV2(scene, camera, { width: WIDTH, height: HEIGHT, samples: SAMPLES, seed });
  return traceNative(input, { width: WIDTH, height: HEIGHT, samples: SAMPLES, kernel: 'cycles' }).rgba;
}

const addonSkip = findNativeAddon() ? false : 'the native addon is not built';

for (const variant of ['translate', 'rotscale', 'emissive', 'emissive-rotscale', 'emissive-degenerate']) {
  test(`instanced ${variant} copies render the flattened image within tolerance`, { skip: addonSkip }, t => {
    let flattened;
    try {
      flattened = render(variant, false, 1);
    } catch (error) {
      if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
      throw error;
    }
    const instanced = render(variant, true, 1);
    for (const ratio of meanRatioRgb(instanced, flattened, WIDTH * HEIGHT)) assert.ok(ratio > 0.98 && ratio < 1.02, `mean ratio ${ratio}`);
    assert.ok(relativeMeanSquaredError(instanced, flattened, WIDTH * HEIGHT) < 5e-4);
    for (const ratio of tileMeanRatios(instanced, flattened, WIDTH, HEIGHT, TILES)) assert.ok(ratio > 0.98 && ratio < 1.02, `tile mean ratio ${ratio}`);
  });
}

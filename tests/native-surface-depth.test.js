import assert from 'node:assert/strict';
import test from 'node:test';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';

// The depth plane is the distance to the first surface along the camera ray, also when a volume scatter comes before that
// surface (#1122). Before, a pixel inside light fog averaged the scatter distance into its depth, which pulled it short.
// The guides the filters read must not change with the fog in the way: the scene without fog is the reference.
const WIDTH = 24;
const HEIGHT = 24;
const camera = createCamera({ eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 30 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 32, bounces: 3, seed: 3, fireflyClamp: 0, noiseThreshold: 0 };
const traceOptions = { width: WIDTH, height: HEIGHT, samples: 32, maxSeconds: 60, kernel: 'cycles', noiseThreshold: 0 };
const cook = await cookModule();
const jobInputModule = await cookModule('job-input');
const { findNativeAddon, prepareCyclesInput, traceNative } = cook ?? {};
const { buildFlattenedJobNativeInput } = jobInputModule ?? {};
const addonSkip = cookInstalled && findNativeAddon() ? false : 'the native addon is not built';

const LIGHT_FOG = { density: 0.6, minimum: [-6, -6, 0.5], maximum: [6, 6, 4.5], color: [0.9, 0.9, 1], anisotropy: 0 };

function sheet(name, halfWidth, z, color) {
  return {
    name,
    geometry: {
      positions: Float32Array.from([-halfWidth, -halfWidth, z, halfWidth, -halfWidth, z, halfWidth, halfWidth, z, -halfWidth, halfWidth, z]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    material: { color, roughness: 1, metallic: 0, specular: 0 },
  };
}

// A wall that fills the picture, and a smaller sheet inside the fog in front of it, so the depth has an edge.
const parts = [sheet('wall', 6, 0, [0.6, 0.5, 0.4]), sheet('card', 0.5, 2, [0.2, 0.5, 0.8])];

function traceScene(volumeFog) {
  const environment = { keyColor: [3, 3, 3], lightDirection: [0.3, 0.5, 1], ...(volumeFog ? { volumeFog } : {}) };
  const input = buildFlattenedJobNativeInput(buildTraceScene(parts, environment), camera, packOptions, pack, resolveTexture);
  return traceNative(prepareCyclesInput(input, traceOptions), { ...traceOptions, denoise: 'atrous' });
}

function meanOf(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

cookTest('the depth plane of a pixel in fog is the depth without fog', { skip: addonSkip }, () => {
  const clear = traceScene(null);
  const foggy = traceScene(LIGHT_FOG);
  const pictureShift = Math.abs(meanOf(foggy.rgba) - meanOf(clear.rgba));
  assert.ok(pictureShift > 0.01, `the fog changes the picture (mean shift ${pictureShift}), so the scatter path ran`);
  assert.ok(Math.min(...clear.depth) > 1, 'every pixel hits a surface in the reference');
  let largestDifference = 0;
  for (let pixel = 0; pixel < clear.depth.length; pixel++) {
    largestDifference = Math.max(largestDifference, Math.abs(foggy.depth[pixel] - clear.depth[pixel]) / clear.depth[pixel]);
  }
  assert.ok(largestDifference < 1e-4, `depth with fog equals depth without fog at every pixel (largest relative difference ${largestDifference})`);
});

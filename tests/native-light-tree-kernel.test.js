import assert from 'node:assert/strict';
import { createCamera } from '../src/path-tracer.js';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const cook = await cookModule();
const packV2 = await cookModule('pack-input-v2');
const { buildNativeInputV2, findNativeAddon, traceNative } = cook ?? {};
const {
  KERNEL_FLAG_USE_LIGHT_TREE,
  LIGHT_TREE_AUTO_MIN_EMITTERS,
  resolveUseLightTree,
  validatePackOptions,
} = packV2 ?? {};

const hasAddon = cookInstalled && findNativeAddon() !== null;
const skipWithoutAddon = hasAddon ? false : 'the native addon is not built';

const UNIT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

// A quad scaled by `scale`, turned to face up (floor) or down (ceiling) and moved to `height`.
function horizontalQuadMatrix(scale, height, facesUp) {
  const upOrDown = facesUp ? 1 : -1;
  return [scale, 0, 0, 0, 0, 0, -upOrDown * scale, 0, 0, upOrDown * scale, 0, 0, 0, height, 0, 1];
}

function buildRoomScene(extraLights) {
  return {
    materials: [{ color: [0.6, 0.6, 0.6], roughness: 0.8 }, { color: [1, 0.95, 0.9], emission: 5, roughness: 1 }],
    instances: [
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(8, 0, true), materialIndex: 0 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(2, 3, false), materialOverride: 1 },
      { geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 2, false), materialOverride: 1 },
    ],
    lights: extraLights,
  };
}

function trace(scene, options) {
  const width = options.width;
  const height = options.height;
  const camera = createCamera({ eye: [0, 2.2, 6], target: [0, 0.5, 0], fov: 45 }, width, height);
  const input = buildNativeInputV2(scene, camera, { ...options, samples: options.samples });
  return traceNative(input, { ...options, kernel: 'cycles' });
}

function meanRgb(rgba) {
  const sum = [0, 0, 0];
  const pixelCount = rgba.length / 4;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      sum[channel] += rgba[pixel * 4 + channel];
    }
  }
  return sum.map((value) => value / pixelCount);
}

cookTest('lightSampling "auto" turns the tree on from two emitters, "tree" from one, "uniform" never', () => {
  assert.equal(LIGHT_TREE_AUTO_MIN_EMITTERS, 1);
  assert.equal(resolveUseLightTree('auto', 1, 1), false);
  assert.equal(resolveUseLightTree(undefined, 2, 3), true);
  assert.equal(resolveUseLightTree('tree', 1, 1), true);
  assert.equal(resolveUseLightTree('tree', 0, 0), false);
  assert.equal(resolveUseLightTree('uniform', 50, 99), false);
  assert.equal(KERNEL_FLAG_USE_LIGHT_TREE, 1);
});

cookTest('traceNative rejects an unknown lightSampling before it reaches the GPU', () => {
  assert.throws(
    () => validatePackOptions({ lightSampling: 'bvh' }, 'test'),
    /`lightSampling` must be "auto" \(default\), "tree" or "uniform", got "bvh"/
  );
  assert.doesNotThrow(() => validatePackOptions({ lightSampling: 'tree' }, 'test'));
});

cookTest('pick probabilities from random shading points sum to 1 over all emitters and match what the sampler returns', { skip: skipWithoutAddon }, () => {
  const scene = buildRoomScene({
    points: [
      { position: [2, 1.5, 1], intensity: 10, radius: 0.1 },
      { position: [-2.5, 0.8, -1], intensity: 4, radius: 0.05 },
    ],
    sun: { color: [1, 1, 1], direction: [0.3, -1, 0.2] },
  });
  const samples = 64;
  const probe = trace(scene, {
    width: 100,
    height: 16,
    samples,
    samplesPerDispatch: samples,
    lightSampling: 'tree',
    lightTreeProbe: true,
  });
  const pointCount = 100 * 16;
  let pointsWithSumOne = 0;
  let transmissivePointsWithSumOne = 0;
  for (let point = 0; point < pointCount; point++) {
    const probabilitySum = probe.rgba[point * 4];
    const foundFraction = probe.rgba[point * 4 + 1];
    const pickGap = probe.rgba[point * 4 + 2];
    assert.ok(probabilitySum <= 1 + 1e-4, `point ${point}: probabilities add up to ${probabilitySum}`);
    assert.ok(pickGap < 1e-4, `point ${point}: sampler and pdf differ by ${pickGap}`);
    assert.ok(Math.abs(foundFraction - probabilitySum) < 0.05, `point ${point}: ${foundFraction} of the picks found an emitter, pdf sum ${probabilitySum}`);
    if (Math.abs(probabilitySum - 1) < 1e-4) {
      pointsWithSumOne += 1;
      if (point % 2 === 1) {
        transmissivePointsWithSumOne += 1;
      }
    }
  }
  assert.equal(transmissivePointsWithSumOne, pointCount / 2, 'every point that sees through the surface sums to 1');
  assert.ok(pointsWithSumOne > pointCount * 0.8, `${pointsWithSumOne} of ${pointCount} points sum to 1`);
});

cookTest('a large emissive quad renders the same mean with NEE only, BSDF only and both', { skip: skipWithoutAddon }, () => {
  const scene = buildRoomScene(undefined);
  const common = { width: 48, height: 32, samples: 256, samplesPerDispatch: 32, lightSampling: 'tree', seed: 3 };
  const both = meanRgb(trace(scene, { ...common, directLighting: 'both' }).rgba);
  const neeOnly = meanRgb(trace(scene, { ...common, directLighting: 'nee-only' }).rgba);
  const bsdfOnly = meanRgb(trace(scene, { ...common, directLighting: 'bsdf-only' }).rgba);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(both[channel] > 0.05, `channel ${channel} is lit`);
    assert.ok(Math.abs(neeOnly[channel] / both[channel] - 1) < 0.02, `NEE only ${neeOnly[channel]} against both ${both[channel]}`);
    assert.ok(Math.abs(bsdfOnly[channel] / both[channel] - 1) < 0.02, `BSDF only ${bsdfOnly[channel]} against both ${both[channel]}`);
  }
});

cookTest('the tree and the flat pick render the same mean', { skip: skipWithoutAddon }, () => {
  const scene = buildRoomScene({ points: [{ position: [2, 1.5, 1], intensity: 10, radius: 0.1 }] });
  const common = { width: 48, height: 32, samples: 256, samplesPerDispatch: 32, seed: 5 };
  const tree = meanRgb(trace(scene, { ...common, lightSampling: 'tree' }).rgba);
  const flat = meanRgb(trace(scene, { ...common, lightSampling: 'uniform' }).rgba);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(tree[channel] / flat[channel] - 1) < 0.02, `tree ${tree[channel]} against flat ${flat[channel]}`);
  }
});

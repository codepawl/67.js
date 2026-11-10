import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { POINT_FIRST_BIT } from '../src/light-link-bits.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { packLightTree } from '../src/path-tracer-gpu-pack.js';
import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';
import {
  buildLightTree, chooseLightFromTree, leftChildProbability, LIGHT_TREE_MINIMUM_SHARE, LIGHT_TREE_NODE_FLOATS, mergeCones, nodeImportance,
} from '../src/path-tracer-light-tree.js';

function pointLight(position, intensity = 1) {
  return { position, color: [1, 1, 1], intensity, radius: 0.1 };
}

function lightRow(count) {
  return { points: Array.from({ length: count }, (_, index) => pointLight([index * 2 - count, 1, 0])), spots: [], areas: [] };
}

function seededDraws(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('the tree has one leaf per light and boxes and energy that cover the children', () => {
  const lights = {
    points: [pointLight([0, 0, 0], 2), pointLight([4, 0, 0], 3)],
    spots: [{ ...pointLight([0, 3, 0], 1), direction: [0, -1, 0], cosineHalfAngle: 0.9 }],
    areas: [{ position: [2, 5, 2], color: [1, 1, 1], intensity: 5, normal: [0, -1, 0], across: [1, 0, 0], along: [0, 0, 1], width: 2, height: 1 }],
  };
  const tree = buildLightTree(lights);
  assert.equal(tree.nodeCount, 7);
  const leafLights = [];
  for (let node = 0; node < tree.nodeCount; node++) {
    const base = node * LIGHT_TREE_NODE_FLOATS;
    const left = tree.data[base + 12];
    if (left < 0) {
      leafLights.push(tree.data[base + 14]);
      continue;
    }
    const right = tree.data[base + 13];
    const leftBase = left * LIGHT_TREE_NODE_FLOATS;
    const rightBase = right * LIGHT_TREE_NODE_FLOATS;
    assert.equal(tree.data[base + 3], tree.data[leftBase + 3] + tree.data[rightBase + 3]);
    for (let axis = 0; axis < 3; axis++) {
      assert.equal(tree.data[base + axis], Math.min(tree.data[leftBase + axis], tree.data[rightBase + axis]));
      assert.equal(tree.data[base + 4 + axis], Math.max(tree.data[leftBase + 4 + axis], tree.data[rightBase + 4 + axis]));
    }
  }
  assert.deepEqual(leafLights.sort(), [0, 1, 2, 3]);
  assert.equal(tree.data[3], 2 + 3 + 1 + 5);
});

test('merging cones keeps both inside the result', () => {
  const up = { axis: [0, 1, 0], thetaO: 0, thetaE: Math.PI / 2 };
  const same = mergeCones(up, up);
  assert.deepEqual(same.axis, [0, 1, 0]);
  assert.equal(same.thetaO, 0);
  const right = { axis: [1, 0, 0], thetaO: 0, thetaE: 0.3 };
  const merged = mergeCones(up, right);
  assert.ok(Math.abs(merged.thetaO - Math.PI / 4) < 1e-9);
  assert.ok(Math.abs(merged.axis[0] - Math.SQRT1_2) < 1e-9 && Math.abs(merged.axis[1] - Math.SQRT1_2) < 1e-9);
  assert.equal(merged.thetaE, Math.PI / 2);
  const opposite = mergeCones(up, { axis: [0, -1, 0], thetaO: 0, thetaE: 0.3 });
  assert.ok(Math.abs(opposite.thetaO - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...opposite.axis) - 1) < 1e-9 && Math.abs(opposite.axis[1]) < 1e-9);
  const wideOpposite = mergeCones({ axis: [0, 1, 0], thetaO: 2, thetaE: 1 }, { axis: [0, -1, 0], thetaO: 2, thetaE: 1 });
  assert.equal(wideOpposite.thetaO, Math.PI);
});

test('a node is worth more when it is near, bright and turned toward the point, and its minimum measure never reaches zero', () => {
  const near = buildLightTree({ points: [pointLight([0, 2, 0])], spots: [], areas: [] });
  const far = buildLightTree({ points: [pointLight([0, 20, 0])], spots: [], areas: [] });
  const bright = buildLightTree({ points: [pointLight([0, 2, 0], 4)], spots: [], areas: [] });
  const nearImportance = { ...nodeImportance(near.data, 0, 0, 0, 0, 0, 1, 0) };
  const farImportance = { ...nodeImportance(far.data, 0, 0, 0, 0, 0, 1, 0) };
  const brightImportance = { ...nodeImportance(bright.data, 0, 0, 0, 0, 0, 1, 0) };
  assert.ok(nearImportance.maximum > farImportance.maximum * 50);
  assert.ok(Math.abs(brightImportance.maximum / nearImportance.maximum - 4) < 1e-6);
  const spotAway = buildLightTree({ points: [], spots: [{ ...pointLight([0, 2, 0]), direction: [0, 1, 0], cosineHalfAngle: 0.9 }], areas: [] });
  const culled = nodeImportance(spotAway.data, 0, 0, 0, 0, 0, 1, 0);
  assert.equal(culled.maximum, 0);
  assert.ok(culled.minimum > 0);
  const belowSurface = nodeImportance(near.data, 0, 0, 4, 0, 0, 1, 0);
  assert.equal(belowSurface.maximum, 0);
});

test('the left chance mixes the two measures and falls back to the minimum measure', () => {
  const minimumShare = LIGHT_TREE_MINIMUM_SHARE;
  assert.ok(Math.abs(leftChildProbability(3, 1, 1, 1) - ((1 - minimumShare) * 0.75 + minimumShare * 0.5)) < 1e-12);
  assert.equal(leftChildProbability(0, 1, 0, 3), 0.25);
  assert.equal(leftChildProbability(0, 0, 0, 0), -1);
});

test('the walk reports the chance it took: frequencies match and the chances add up to one', () => {
  const tree = buildLightTree(lightRow(7));
  const nextRandom = seededDraws(11);
  const counts = new Map();
  const chances = new Map();
  const draws = 40000;
  for (let draw = 0; draw < draws; draw++) {
    const choice = chooseLightFromTree(tree, 0, 0, 0, 0, 1, 0, nextRandom);
    assert.ok(choice.lightIndex >= 0);
    counts.set(choice.lightIndex, (counts.get(choice.lightIndex) ?? 0) + 1);
    chances.set(choice.lightIndex, choice.probability);
  }
  let total = 0;
  for (const [lightIndex, chance] of chances) {
    total += chance;
    assert.ok(Math.abs(counts.get(lightIndex) / draws - chance) < 0.01, `light ${lightIndex}`);
  }
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(chances.size, 7);
  assert.ok(chances.get(3) > chances.get(0), 'the light nearest the point is chosen more often than one 7 units away');
});

test('the light tree packs into a float table and the kernel has the walk only when asked', () => {
  const table = packLightTree(lightRow(5));
  assert.equal(table.data[3], 5);
  assert.ok(buildFragmentSource({ lightTree: true }).includes('chooseEmitterByTree'));
  assert.ok(!buildFragmentSource().includes('chooseEmitterByTree'));
  assert.ok(!buildFragmentSource().includes('uLightTree'));
});

function manyLightScene(lightCount) {
  const positions = Array.from({ length: lightCount }, (_, index) => [(index % 4) * 1.6 - 2.4, 1.2, Math.floor(index / 4) * 1.6 - 1.6]);
  return {
    parts: [{ name: 'floor', geometry: box(0, 1), matrix: new Float32Array([8, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 8, 0, 0, -0.05, 0, 1]), material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.6, 0.6, 0.6] } }],
    environment: { keyColor: [0, 0, 0], lightDirection: [0, 1, 0], pointLights: positions.map(position => pointLight(position, 3)) },
    camera: { eye: [0, 4, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 50 },
  };
}

function meanRadiance(linear) {
  let sum = 0;
  for (const value of linear) sum += value;
  return sum / linear.length;
}

test('the CPU tracer with the light tree keeps the mean radiance of the uniform draw', async () => {
  const options = { width: 24, height: 18, samples: 48, bounces: 3, denoise: false, threads: 1 };
  for (const lightCount of [4, 20]) {
    const uniform = await renderPathTracedImage(manyLightScene(lightCount), options);
    const tree = await renderPathTracedImage(manyLightScene(lightCount), { ...options, lightSelection: 'tree' });
    const ratio = meanRadiance(tree.linear) / meanRadiance(uniform.linear);
    assert.ok(Math.abs(ratio - 1) < 0.03, `${lightCount} lights: ratio ${ratio}`);
  }
});

test('the surface area orientation split keeps two far apart clusters of lights in separate subtrees', () => {
  const near = Array.from({ length: 4 }, (_, index) => pointLight([index * 0.3, 1, 0], 2));
  const far = Array.from({ length: 4 }, (_, index) => pointLight([40 + index * 0.3, 1, 0], 2));
  const tree = buildLightTree({ points: [...near, ...far], spots: [], areas: [] });
  const base = node => node * LIGHT_TREE_NODE_FLOATS;
  const left = tree.data[base(0) + 12];
  const right = tree.data[base(0) + 13];
  const leftMaximumX = tree.data[base(left) + 4];
  const rightMinimumX = tree.data[base(right)];
  assert.ok(leftMaximumX < 10 && rightMinimumX > 30, `children split at ${leftMaximumX} and ${rightMinimumX}`);
});

test('the WebGPU kernels carry the tree walk', async () => {
  const { buildMegakernelSource, WAVEFRONT_SOURCE } = await import('../src/path-tracer-webgpu-kernel.js');
  for (const source of [buildMegakernelSource(), WAVEFRONT_SOURCE]) {
    assert.ok(source.includes('fn chooseEmitter'));
    assert.ok(source.includes('lightsFromEveryEmitter'));
  }
});

// Twenty point lights, only the first of which reaches the floor: the other nineteen hang close above it, so a walk that ignores
// the link set spends nearly every draw on a light the floor cannot see.
function linkedReceiverScene() {
  const farLight = pointLight([0, 4, 0], 40);
  const nearLights = Array.from({ length: 19 }, (_, index) => pointLight([(index % 5) * 1.4 - 2.8, 0.6, Math.floor(index / 5) * 1.4 - 2], 3));
  const scene = manyLightScene(1);
  scene.environment.pointLights = [farLight, ...nearLights];
  scene.parts[0].material.lightMask = 1 << POINT_FIRST_BIT;
  return scene;
}

function rootMeanSquareError(linear, reference) {
  let sum = 0;
  for (let index = 0; index < linear.length; index++) sum += (linear[index] - reference[index]) ** 2;
  return Math.sqrt(sum / linear.length);
}

test('the light tree draws only the lights a linked receiver can see, with the mean of the uniform draw and no more noise', async () => {
  const base = { width: 24, height: 18, bounces: 1, denoise: false, threads: 1 };
  const reference = await renderPathTracedImage(linkedReceiverScene(), { ...base, samples: 256, seed: 99 });
  const uniform = await renderPathTracedImage(linkedReceiverScene(), { ...base, samples: 8, lightSelection: 'uniform' });
  const tree = await renderPathTracedImage(linkedReceiverScene(), { ...base, samples: 8, lightSelection: 'tree' });
  const treeError = rootMeanSquareError(tree.linear, reference.linear);
  const uniformError = rootMeanSquareError(uniform.linear, reference.linear);
  assert.ok(treeError <= uniformError * 1.1, `tree error ${treeError} against uniform error ${uniformError}`);
  const ratio = meanRadiance(tree.linear) / meanRadiance(reference.linear);
  assert.ok(Math.abs(ratio - 1) < 0.05, `mean ratio ${ratio}`);
});

test('the GPU kernels limit the tree walk to the lights the hit part is linked to', async () => {
  assert.ok(buildFragmentSource({ lightTree: true }).includes('linkedCount'));
  const { buildMegakernelSource, WAVEFRONT_SOURCE } = await import('../src/path-tracer-webgpu-kernel.js');
  for (const source of [buildMegakernelSource(), WAVEFRONT_SOURCE]) assert.ok(source.includes('linkedCount'));
});

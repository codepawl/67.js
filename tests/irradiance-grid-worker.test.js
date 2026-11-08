import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { bakeAgentParts, normalizeAgentBake } from '../src/agent-bake.js';
import { traceIrradianceGrid, withMeanRadiance } from '../src/irradiance-grid.js';
import { buildWithKernels, kernelKey } from '../src/kernel-offload.js';
import { answerKernelRequest } from '../src/kernel-registry.js';
import { createInProcessWorker } from './support/kernel-offload-fixture.mjs';

const cube = box(0, 1);

function placed(name, translation, scale, color) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color, metallic: 0, roughness: 0.8, emission: 0 } };
}

function smallRoom() {
  const white = [0.8, 0.8, 0.8];
  return [
    placed('floor', [0, -0.05, 0], [4, 0.1, 4], [0.8, 0.4, 0.1]),
    placed('ceiling', [0, 3.05, 0], [4, 0.1, 4], white),
    placed('back', [0, 1.5, -2.05], [4.2, 3.2, 0.1], white),
    placed('left', [-2.05, 1.5, 0], [0.1, 3.2, 4], white),
  ];
}

const environment = {
  keyColor: [3, 3, 3], lightDirection: [0.2, 1, 0.1], skyTop: [0.2, 0.3, 0.6], skyBottom: [0.4, 0.4, 0.4],
  pointLights: [], spotLights: [], areaLights: [],
};
const settings = normalizeAgentBake({ preset: 'draft', irradianceGrid: 10, bounces: 2, probes: false });

function bakeRoom() {
  const parts = smallRoom();
  return bakeAgentParts(parts, new Map(parts.map(part => [part.name, part.matrix])), environment, settings);
}

function gridOf(bake) {
  return bake.parts[0].material.irradianceGrid;
}

test('the grid trace answers a worker request with the same coefficients as the inline trace', () => {
  const parts = smallRoom();
  const options = { resolution: 10, samples: 8, bounces: 2 };
  const inline = traceIrradianceGrid(parts, environment, { ...options, maxSeconds: 20 });
  const { response, transfer } = answerKernelRequest(structuredClone({ name: 'gridTrace', args: [parts, environment, options] }));
  assert.equal(response.error, undefined);
  assert.deepEqual(Array.from(response.value.data), Array.from(inline.data));
  assert.ok(transfer.includes(response.value.data.buffer), 'the coefficient buffer travels as a transferable, not a copy');
  assert.equal(Object.hasOwn(structuredClone(response.value), 'meanRadiance'), false, 'a cloned grid has no function until withMeanRadiance gives it one');
  const restored = withMeanRadiance(structuredClone(response.value));
  assert.deepEqual(restored.meanRadiance([0, 1.5, 0]), inline.meanRadiance([0, 1.5, 0]));
});

test('a bake inside a worker session gives the same grid as the page thread', async () => {
  const inline = bakeRoom();
  const requested = [];
  const onWorker = await buildWithKernels(bakeRoom, { createWorker: () => createInProcessWorker(requested), available: true });
  assert.deepEqual(requested, ['gridTrace']);
  const inlineData = gridOf(inline).data;
  const workerData = gridOf(onWorker).data;
  let largestDifference = 0;
  inlineData.forEach((value, index) => {
    largestDifference = Math.max(largestDifference, Math.abs(value - workerData[index]));
  });
  assert.equal(largestDifference, 0);
  assert.equal(typeof gridOf(onWorker).meanRadiance, 'function');
  assert.deepEqual(gridOf(onWorker).meanRadiance([0, 1.5, 0]), gridOf(inline).meanRadiance([0, 1.5, 0]));
});

test('the page time limit is not part of the request, so a worker traces under its own limit', () => {
  const keyArguments = [smallRoom(), environment, { resolution: 10, samples: 8, bounces: 2 }];
  assert.ok(kernelKey('gridTrace', keyArguments), 'the request is plain data');
  assert.equal(Object.hasOwn(keyArguments[2], 'maxSeconds'), false);
});

test('without workers the bake runs inline with the same result', async () => {
  const requested = [];
  const withoutWorkers = await buildWithKernels(bakeRoom, { createWorker: () => createInProcessWorker(requested), available: false });
  assert.deepEqual(requested, []);
  assert.deepEqual(Array.from(gridOf(withoutWorkers).data), Array.from(gridOf(bakeRoom()).data));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInput } from '../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../packages/render-native/job-input.mjs';
import { exportNativeSceneTables, NATIVE_JOB_MAXIMUM_INSTANCES } from '../scripts/native-bake-page.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import {
  buildTraceScene,
  MAX_NATIVE_TRACE_INSTANCES,
  MAX_TRACE_INSTANCES,
  refuseLocalVolumes,
  resolveTexture,
} from '../src/path-tracer-scene.js';

// One shared triangle: valid for the builder and cheap to copy many times.
const TRIANGLE = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};
const SHARED_MATERIAL = { color: [0.8, 0.8, 0.8] };
const ENVIRONMENT = { keyColor: [1, 1, 1], lightDirection: [0, 1, 0] };

function copiesOfTriangle(copyCount) {
  return Array.from({ length: copyCount }, (_, index) => ({
    name: `copy-${index}`,
    geometry: TRIANGLE,
    matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 2, 0, 0, 1]),
    material: SHARED_MATERIAL,
  }));
}

test('the CPU and WebGL instance bound is still 65,536 and a build without the option keeps its message', () => {
  assert.equal(MAX_TRACE_INSTANCES, 65_536);
  assert.throws(() => buildTraceScene(copiesOfTriangle(MAX_TRACE_INSTANCES + 1), ENVIRONMENT, { instancing: true }), {
    name: 'RangeError',
    message: 'An instanced path trace takes at most 65536 instances, got 65537. Pass fewer parts, or merge small copies into one mesh.',
  });
});

test('an instanced scene above 65,536 copies builds with maximumInstances and keeps every instance', () => {
  const copyCount = MAX_TRACE_INSTANCES + 1_000;
  const scene = buildTraceScene(copiesOfTriangle(copyCount), ENVIRONMENT, { instancing: true, maximumInstances: copyCount });
  assert.equal(scene.instances.length, copyCount);
  assert.equal(new Set(scene.instances.map(instance => instance.geometry)).size, 1);
  assert.equal(scene.materials.length, copyCount);
});

test('a scene over the instance bound that was asked for is refused with the bound and what to pass', () => {
  assert.equal(buildTraceScene(copiesOfTriangle(10), ENVIRONMENT, { instancing: true, maximumInstances: 10 }).instances.length, 10);
  assert.throws(() => buildTraceScene(copiesOfTriangle(11), ENVIRONMENT, { instancing: true, maximumInstances: 10 }),
    { name: 'RangeError', message: 'An instanced native path trace takes at most 10 instances, got 11. Pass fewer parts, or merge small copies into one mesh.' });
});

test('maximumInstances can lower the bound under 65,536 and leaves the triangle bound alone', () => {
  assert.throws(() => buildTraceScene(copiesOfTriangle(3), ENVIRONMENT, { instancing: true, maximumInstances: 2 }), /at most 2 instances, got 3/);
  assert.throws(() => buildTraceScene(copiesOfTriangle(5), ENVIRONMENT, { instancing: true, maximumInstances: 10, maximumTriangles: 1 }), /at most 4 triangles with every copy counted, got 5/);
});

test('the instance ceiling is MAX_NATIVE_TRACE_INSTANCES and a value outside 1 to the ceiling is refused with the range', () => {
  assert.equal(MAX_NATIVE_TRACE_INSTANCES, 1_000_000);
  const parts = copiesOfTriangle(2);
  for (const value of [0, -5, 1.5, Number.NaN, Infinity, '1000', null, MAX_NATIVE_TRACE_INSTANCES + 1]) {
    assert.throws(() => buildTraceScene(parts, ENVIRONMENT, { instancing: true, maximumInstances: value }),
      { name: 'RangeError', message: /maximumInstances is an integer from 1 to 1000000 for the native path tracer.*65536 instances/ }, `value ${String(value)}`);
  }
});

test('a flattened scene ignores maximumInstances and keeps its part bound', () => {
  const parts = Array.from({ length: 3 }, (_, index) => ({ name: `own-${index}`, geometry: { ...TRIANGLE, positions: Float32Array.from(TRIANGLE.positions) }, material: SHARED_MATERIAL }));
  assert.equal(buildTraceScene(parts, ENVIRONMENT, { maximumInstances: 1 }).indices.length, 9);
});

const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, 8, 8);
const packOptions = { width: 8, height: 8, bounces: 2, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack };

test('a native render job with the cycles kernel exports more than 65,536 instances of one geometry', () => {
  assert.ok(NATIVE_JOB_MAXIMUM_INSTANCES > MAX_TRACE_INSTANCES && NATIVE_JOB_MAXIMUM_INSTANCES <= MAX_NATIVE_TRACE_INSTANCES);
  const copyCount = MAX_TRACE_INSTANCES + 100;
  const exported = exportNativeSceneTables({ parts: copiesOfTriangle(copyCount), environment: ENVIRONMENT, camera, options: packOptions, kernel: 'cycles', instancing: true, modules });
  assert.equal(exported.instances, copyCount);
  assert.equal(exported.instancing, undefined);
  assert.equal(exported.triangleCount, 1);
});

test('a native render job past its instance bound says so and does not hide the refusal', () => {
  const smallBound = (sceneParts, environment, options) => buildTraceScene(sceneParts, environment, { ...options, maximumInstances: 5 });
  assert.throws(() => exportNativeSceneTables({ parts: copiesOfTriangle(6), environment: ENVIRONMENT, camera, options: packOptions, kernel: 'cycles', instancing: true,
    modules: { ...modules, buildTraceScene: smallBound } }), { name: 'RangeError', message: /at most 5 instances, got 6\. Pass fewer parts, or merge small copies into one mesh\./ });
});

test('a native render job with the legacy kernel keeps its flattened bounds, not the instance bound', () => {
  assert.throws(() => exportNativeSceneTables({ parts: copiesOfTriangle(MAX_TRACE_INSTANCES + 1), environment: ENVIRONMENT, camera, options: packOptions, kernel: 'legacy', instancing: true, modules }),
    { name: 'RangeError', message: /1 to 1024 parts/ });
});

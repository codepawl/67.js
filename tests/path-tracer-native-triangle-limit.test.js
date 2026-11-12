import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNativeInput } from '../packages/render-native/pack-input.mjs';
import { buildFlattenedJobNativeInput, buildJobNativeInput } from '../packages/render-native/job-input.mjs';
import { exportNativeSceneTables, NATIVE_JOB_MAXIMUM_TRIANGLES } from '../scripts/native-bake-page.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import {
  buildTraceScene,
  MAX_NATIVE_TRACE_TRIANGLES,
  MAX_TRACE_TRIANGLES,
  NATIVE_INSTANCED_TOTAL_FACTOR,
  refuseLocalVolumes,
  resolveTexture,
} from '../src/path-tracer-scene.js';

// Every triangle reuses the same three vertices: valid for the builder and cheap to allocate.
function triangleStack(triangleCount) {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array(triangleCount * 3).map((_, slot) => slot % 3),
  };
}

function identityShifted(x) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
}

function copiesOf(geometry, copyCount) {
  return Array.from({ length: copyCount }, (_, index) => ({ name: `copy-${index}`, geometry, matrix: identityShifted(index * 2), material: { color: [0.8, 0.8, 0.8] } }));
}

const ENVIRONMENT = { keyColor: [1, 1, 1], lightDirection: [0, 1, 0] };
const OLD_FLATTENED_MESSAGE = 'A path trace takes at most 400000 triangles in total.';

test('the CPU and WebGL bound is still 400,000 and a build without the option keeps the old messages', () => {
  assert.equal(MAX_TRACE_TRIANGLES, 400_000);
  const flattened = copiesOf(triangleStack(MAX_TRACE_TRIANGLES + 1), 1);
  assert.throws(() => buildTraceScene(flattened, ENVIRONMENT), { name: 'RangeError', message: OLD_FLATTENED_MESSAGE });
  const instanced = copiesOf(triangleStack(MAX_TRACE_TRIANGLES + 1), 2);
  assert.throws(() => buildTraceScene(instanced, ENVIRONMENT, { instancing: true }), {
    name: 'RangeError',
    message: 'An instanced path trace takes at most 400000 unique triangles, counted once per shared geometry, got 400001. Share geometry between copies or simplify the meshes.',
  });
});

test('an instanced scene above 400,000 unique triangles builds with the native option and keeps its instances', () => {
  const parts = copiesOf(triangleStack(MAX_TRACE_TRIANGLES + 1), 3);
  const scene = buildTraceScene(parts, ENVIRONMENT, { instancing: true, maximumTriangles: 500_000 });
  assert.equal(scene.instances.length, 3);
  assert.equal(new Set(scene.instances.map(instance => instance.geometry)).size, 1);
});

test('an instanced scene is refused above the unique bound that was asked for, with the bound in the message', () => {
  const parts = copiesOf(triangleStack(11), 2);
  assert.throws(() => buildTraceScene(parts, ENVIRONMENT, { instancing: true, maximumTriangles: 10 }),
    { name: 'RangeError', message: /at most 10 unique triangles, counted once per shared geometry, got 11\. Share geometry between copies or simplify the meshes\./ });
});

test('an instanced scene counts every copy against four times the bound', () => {
  assert.equal(NATIVE_INSTANCED_TOTAL_FACTOR, 4);
  assert.equal(buildTraceScene(copiesOf(triangleStack(10), 4), ENVIRONMENT, { instancing: true, maximumTriangles: 10 }).instances.length, 4);
  assert.throws(() => buildTraceScene(copiesOf(triangleStack(10), 5), ENVIRONMENT, { instancing: true, maximumTriangles: 10 }),
    { name: 'RangeError', message: /at most 40 triangles with every copy counted, got 50\. Pass fewer copies of the large meshes or simplify them\./ });
});

test('without the option copies are not counted in total, as before', () => {
  assert.equal(buildTraceScene(copiesOf(triangleStack(10), 50), ENVIRONMENT, { instancing: true }).instances.length, 50);
});

test('a flattened scene takes the native bound too, and says it is the native one', () => {
  assert.equal(buildTraceScene(copiesOf(triangleStack(12), 1), ENVIRONMENT, { maximumTriangles: 12 }).indices.length, 36);
  assert.throws(() => buildTraceScene(copiesOf(triangleStack(13), 1), ENVIRONMENT, { maximumTriangles: 12 }),
    { name: 'RangeError', message: /A native path trace takes at most 12 triangles in total, got 13\. Share geometry between copies/ });
});

test('the native bound has a hard ceiling, and a scene above it is refused', () => {
  assert.equal(MAX_NATIVE_TRACE_TRIANGLES, 4_000_000);
  const parts = copiesOf(triangleStack(MAX_NATIVE_TRACE_TRIANGLES + 1), 2);
  assert.throws(() => buildTraceScene(parts, ENVIRONMENT, { instancing: true, maximumTriangles: MAX_NATIVE_TRACE_TRIANGLES }),
    { name: 'RangeError', message: /at most 4000000 unique triangles, counted once per shared geometry, got 4000001/ });
});

test('an option value that is not an integer from 1 to the ceiling is refused with the range', () => {
  const parts = copiesOf(triangleStack(3), 2);
  for (const value of [0, -5, 1.5, Number.NaN, Infinity, '1000', null, MAX_NATIVE_TRACE_TRIANGLES + 1]) {
    assert.throws(() => buildTraceScene(parts, ENVIRONMENT, { instancing: true, maximumTriangles: value }),
      { name: 'RangeError', message: /maximumTriangles is an integer from 1 to 4000000 for the native path tracer.*400000/ }, `value ${String(value)}`);
  }
});

const camera = createCamera({ eye: [0, 0, 8], target: [0, 0, 0], fov: 50 }, 8, 8);
const packOptions = { width: 8, height: 8, bounces: 2, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
const modules = { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack };

test('a native render job with the cycles kernel exports an instanced scene above 400,000 unique triangles', () => {
  assert.ok(NATIVE_JOB_MAXIMUM_TRIANGLES > MAX_TRACE_TRIANGLES && NATIVE_JOB_MAXIMUM_TRIANGLES <= MAX_NATIVE_TRACE_TRIANGLES);
  const parts = copiesOf(triangleStack(MAX_TRACE_TRIANGLES + 1), 2);
  const exported = exportNativeSceneTables({ parts, environment: ENVIRONMENT, camera, options: packOptions, kernel: 'cycles', instancing: true, modules });
  assert.equal(exported.instances, 2);
  assert.equal(exported.instancing, undefined);
  assert.equal(exported.triangleCount, MAX_TRACE_TRIANGLES + 1);
});

test('a native render job with the legacy kernel keeps the 400,000 bound', () => {
  const parts = copiesOf(triangleStack(MAX_TRACE_TRIANGLES + 1), 1);
  assert.throws(() => exportNativeSceneTables({ parts, environment: ENVIRONMENT, camera, options: packOptions, kernel: 'legacy', instancing: false, modules }),
    { name: 'RangeError', message: OLD_FLATTENED_MESSAGE });
});

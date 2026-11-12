import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInstancedTraceScene } from '../bench/cycles-parity/instanced-scene.mjs';
import { MAX_TRACE_TRIANGLES } from '../src/path-tracer-scene.js';

const SHARED_GEOMETRY = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};
const ENVIRONMENT = { keyColor: [1, 1, 1], lightDirection: [0, 1, 0] };

function copy(name, x, extra = {}) {
  return { name, geometry: SHARED_GEOMETRY, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]), material: { color: [0.8, 0.8, 0.8] }, ...extra };
}

test('a part that hides from camera and shadow rays loses those visibility bits, the others keep every kind', () => {
  const scene = buildInstancedTraceScene([copy('a', 0), copy('b', 2, { rayVisibility: { camera: false, shadow: false } })], ENVIRONMENT);
  assert.equal(scene.instances.length, 2);
  assert.equal(scene.instances[0].visibilityFlags, undefined);
  assert.equal(scene.instances[1].visibilityFlags, 63 & ~1 & ~16);
});

test('a scene above 400,000 unique triangles builds directly, in the order of its parts', () => {
  const big = { ...SHARED_GEOMETRY, indices: new Uint32Array((MAX_TRACE_TRIANGLES + 1) * 3).map((_, slot) => slot % 3) };
  const parts = [copy('a', 0), copy('b', 2)].map(part => ({ ...part, geometry: big }));
  const scene = buildInstancedTraceScene(parts, ENVIRONMENT);
  assert.deepEqual(scene.instances.map(instance => instance.materialIndex), [0, 1]);
});

test('a scene without shared geometry is refused', () => {
  assert.throws(() => buildInstancedTraceScene([copy('a', 0)], ENVIRONMENT), { name: 'RangeError', message: /no shared geometry/ });
});

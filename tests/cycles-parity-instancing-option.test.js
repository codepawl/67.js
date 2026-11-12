import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTraceSceneWithManyLights } from '../bench/cycles-parity/trace-scene-many-lights.mjs';

const SHARED_TRIANGLE = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};

function translationMatrix(x) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
}

function buildParts() {
  return [0, 2, 4].map((x, index) => ({ name: `copy-${index}`, geometry: SHARED_TRIANGLE, matrix: translationMatrix(x), material: { color: [0.8, 0.8, 0.8] } }));
}

const ENVIRONMENT = { keyColor: [1, 1, 1], lightDirection: [0, 1, 0], pointLights: [], spotLights: [], areaLights: [] };

test('the many-lights wrapper keeps shared geometry as instances when asked, and flattens it otherwise', () => {
  const instanced = buildTraceSceneWithManyLights(buildParts(), ENVIRONMENT, { instancing: true });
  assert.equal(instanced.instances.length, 3);
  assert.equal(new Set(instanced.instances.map((instance) => instance.geometry)).size, 1);
  const flattened = buildTraceSceneWithManyLights(buildParts(), ENVIRONMENT);
  assert.equal(flattened.instances, undefined);
  assert.equal(flattened.indices.length, 9);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TRACE_TRIANGLES } from '../src/path-tracer-scene.js';
import { splitGeometriesIntoBatches } from '../bench/cycles-parity/instanced-scene-in-batches.mjs';

function geometryWithTriangles(triangleCount) {
  return { indices: new Uint32Array(triangleCount * 3) };
}

function groupsFor(entries) {
  return new Map(entries.map(([geometry, useCount]) => [geometry, Array.from({ length: useCount }, () => ({ geometry }))]));
}

test('a scene under the cap stays in one batch', () => {
  const groups = groupsFor([[geometryWithTriangles(1000), 3], [geometryWithTriangles(500), 1]]);
  assert.equal(splitGeometriesIntoBatches(groups).length, 1);
});

test('a scene over the cap splits into two batches that each fit and each hold a shared geometry', () => {
  const big = geometryWithTriangles(300000);
  const shared = geometryWithTriangles(60000);
  const single = geometryWithTriangles(67769);
  const groups = groupsFor([[big, 2], [shared, 4], [single, 1]]);
  const batches = splitGeometriesIntoBatches(groups);
  assert.equal(batches.length, 2);
  for (const batch of batches) {
    const total = batch.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0);
    assert.ok(total <= MAX_TRACE_TRIANGLES);
    assert.ok(batch.some((geometry) => groups.get(geometry).length > 1));
  }
  assert.equal(batches.flat().length, 3);
});

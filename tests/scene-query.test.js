import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneQuery } from '../src/scene-query.js';

function quad(size) {
  return {
    positions: Float32Array.of(-size, 0, -size, size, 0, -size, size, 0, size, -size, 0, size),
    indices: Uint32Array.of(0, 2, 1, 0, 3, 2),
  };
}

function translation(x, y, z) {
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);
}

// A 10 m ground at y = 0.5 and a roof over the x > 0 half at y = 4.
const parts = [
  { id: 'ground', geometry: quad(5), matrix: translation(0, 0.5, 0), material: 'grass' },
  { id: 'roof', geometry: quad(2.5), matrix: translation(2.5, 4, 0), material: 'tile' },
];

test('raycast returns the nearest hit over every part with its world matrix', () => {
  const query = createSceneQuery(parts);
  const hit = query.raycast({ origin: [2, 20, 0], direction: [0, -1, 0] });
  assert.equal(hit.id, 'roof');
  assert.equal(hit.material, 'tile');
  assert.ok(Math.abs(hit.point[1] - 4) < 1e-6);
  assert.ok(Math.abs(hit.distance - 16) < 1e-6);
  assert.ok(Math.abs(hit.normal[1] - 1) < 1e-6);
  assert.equal(query.raycast({ origin: [-2, 20, 0], direction: [0, -1, 0] }).id, 'ground');
  assert.equal(query.raycast({ origin: [20, 20, 0], direction: [0, -1, 0] }), null);
  assert.equal(query.raycast({ origin: [2, 20, 0], direction: [0, -1, 0], maxDistance: 5 }), null);
  query.dispose();
});

test('normals face the ray, also from below', () => {
  const query = createSceneQuery(parts);
  const hit = query.raycast({ origin: [-2, -5, 0], direction: [0, 1, 0] });
  assert.equal(hit.id, 'ground');
  assert.ok(hit.normal[1] < -0.99);
  query.dispose();
});

test('indexes are built lazily and kept', () => {
  const query = createSceneQuery(parts);
  assert.equal(query.info.indexed, 0);
  query.raycast({ origin: [-2, 20, 0], direction: [0, -1, 0] });
  assert.equal(query.info.indexed, 1);
  query.raycast({ origin: [-1, 20, 0], direction: [0, -1, 0] });
  assert.equal(query.info.indexed, 1);
  query.dispose();
});

test('slivers do not stop a part from being queried', () => {
  const geometry = quad(5);
  const withSliver = {
    positions: Float32Array.of(...geometry.positions, 0, 0, 0, 0, 0, 0, 1, 0, 0),
    indices: Uint32Array.of(...geometry.indices, 4, 5, 6),
  };
  const query = createSceneQuery([{ id: 'ground', geometry: withSliver, matrix: translation(0, 0, 0) }]);
  assert.equal(query.raycast({ origin: [1, 5, 1], direction: [0, -1, 0] }).id, 'ground');
  assert.equal(query.skipped.length, 0);
  assert.equal(query.info.droppedTriangles, 1);
  query.dispose();
});

test('walkMap samples ground and headroom and finds the ground under a roof', () => {
  const query = createSceneQuery(parts);
  const map = query.walkMap({ min: [-4, 0], max: [4, 0], cellSize: 2, topY: 20, lowerPass: { fromY: 3, groundBelow: 1, maxDistance: 4 } });
  assert.equal(map.columns, 5);
  assert.equal(map.rows, 1);
  const byX = new Map(map.cells.map(cell => [cell[0], cell]));
  assert.ok(Math.abs(byX.get(-4)[2] - 0.5) < 1e-6);
  assert.equal(byX.get(-4)[3], 99);
  assert.ok(Math.abs(byX.get(2)[2] - 0.5) < 1e-6, 'the roof is skipped for the ground underneath');
  assert.ok(Math.abs(byX.get(2)[3] - 3.5) < 1e-4, 'headroom runs up to the roof');
  query.dispose();
});

test('walkMap refuses a region above maxCells and unknown options', () => {
  const query = createSceneQuery(parts);
  assert.throws(() => query.walkMap({ min: [0, 0], max: [1000, 1000], cellSize: 1 }), /maxCells/);
  assert.throws(() => query.walkMap({ min: [0, 0], max: [1, 1], radius: 1 }), /Unsupported walkMap option/);
  query.dispose();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneQuery, walkableMask } from '../src/scene-query.js';

function quad(halfWidth, halfDepth = halfWidth) {
  return {
    positions: Float32Array.of(-halfWidth, 0, -halfDepth, halfWidth, 0, -halfDepth, halfWidth, 0, halfDepth, -halfWidth, 0, halfDepth),
    indices: Uint32Array.of(0, 2, 1, 0, 3, 2),
  };
}

function translation(x, y, z) {
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);
}

// A 10 m street at y = 0, a flat pole top at 1.2 m over x = 2, a kerb top 0.15 m high over x = 3.5 to 4.5.
const street = [
  { id: 'street', geometry: quad(5), matrix: translation(0, 0, 0) },
  { id: 'pole', geometry: quad(0.2), matrix: translation(2, 1.2, 0) },
  { id: 'kerb', geometry: quad(0.5, 5), matrix: translation(4, 0.15, 0) },
];

function cellAt(map, x, z) {
  return map.cells.find(cell => cell[0] === x && cell[1] === z);
}

function walkableAt(map, mask, x, z) {
  const column = Math.round((x - map.min[0]) / map.cellSize);
  const row = Math.round((z - map.min[1]) / map.cellSize);
  return mask[column * map.rows + row] === 1;
}

test('obstacles marks things over 0.3 m and keeps a kerb walkable', () => {
  const query = createSceneQuery(street);
  const map = query.walkMap({ min: [-4, -4], max: [4, 4], cellSize: 0.5, obstacles: { streetY: 0 } });
  assert.equal(cellAt(map, 2, 0)[4], 1, 'the pole top is an obstacle');
  assert.equal(cellAt(map, 4, 0)[4], 0, 'a 0.15 m kerb is not');
  assert.equal(cellAt(map, 0, 0)[4], 0);
  assert.ok(Math.abs(cellAt(map, 4, 0)[2]) < 1e-6, 'ground is the lowest surface under the kerb top');
  query.dispose();
});

test('the street level defaults to the lowest sampled surface', () => {
  const query = createSceneQuery(street);
  const map = query.walkMap({ min: [-4, -4], max: [4, 4], cellSize: 0.5, obstacles: true });
  assert.equal(cellAt(map, 2, 0)[4], 1);
  query.dispose();
});

test('keepOut clears cells near an obstacle and a wall, and leaves the open street', () => {
  const query = createSceneQuery(street);
  const map = query.walkMap({ min: [-4, -4], max: [4, 4], cellSize: 0.5, obstacles: { streetY: 0 } });
  const mask = walkableMask(map, { clearance: 2, keepOut: 1 });
  assert.equal(walkableAt(map, mask, 2, 0), false);
  assert.equal(walkableAt(map, mask, 2.5, 0), false);
  assert.equal(walkableAt(map, mask, 1.5, 0), false);
  assert.equal(walkableAt(map, mask, 0, 0), true);
  assert.equal(walkableAt(map, mask, 4, 0), true, 'the kerb stays walkable');
  assert.equal(walkableAt(map, mask, 0, 3.5), true);
  const withoutKeepOut = walkableMask(map, { clearance: 2 });
  assert.equal(walkableAt(map, withoutKeepOut, 2.5, 0), true);
  assert.equal(walkableAt(map, withoutKeepOut, 2, 0), false, 'the obstacle cell itself is never open');
  query.dispose();
});

test('a closing step fills a one-cell seam before keepOut is applied', () => {
  const columns = 9;
  const rows = 9;
  const cells = [];
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      if (column === 4 && row === 4) continue;
      cells.push([column * 0.25, row * 0.25, 0, 99, 0]);
    }
  }
  const map = { cellSize: 0.25, min: [0, 0], columns, rows, cells };
  assert.equal(walkableMask(map, { clearance: 2, keepOut: 0.1 })[4 * rows + 4], 1);
  cells.find(cell => cell[0] === 1 && cell[1] === 0.5)[4] = 1;
  const withObstacle = walkableMask({ ...map, cells }, { clearance: 2, keepOut: 0.1 });
  assert.equal(withObstacle[4 * rows + 2], 0, 'an obstacle is cut back out after the closing step');
});

test('walkMap rejects unknown obstacles options', () => {
  const query = createSceneQuery(street);
  assert.throws(() => query.walkMap({ min: [0, 0], max: [1, 1], obstacles: { colour: 1 } }), /Unsupported walkMap obstacles option/);
  query.dispose();
});

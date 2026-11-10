import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeshData, applyMeshEdits } from '../src/mesh.js';
import { vertexGroupWeights } from '../src/mesh-data.js';
import { oceanWaves, oceanSurfaceAt } from '../src/mesh-ocean-modifier.js';
import { MESH_MODIFIER_NOTES } from '../src/agent-scene-capabilities.js';

// A flat square of cells x cells quads in the x-z plane, centred on the origin.
function flatGrid(cells, extent) {
  const columns = cells + 1;
  const positions = new Float32Array(columns * columns * 3);
  for (let row = 0; row < columns; row++) {
    for (let column = 0; column < columns; column++) {
      positions.set([(column / cells - 0.5) * extent, 0, (row / cells - 0.5) * extent], (row * columns + column) * 3);
    }
  }
  const faceOffsets = new Uint32Array(cells * cells + 1);
  const cornerVertices = new Uint32Array(cells * cells * 4);
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const face = row * cells + column;
      const corner = row * columns + column;
      faceOffsets[face + 1] = (face + 1) * 4;
      cornerVertices.set([corner, corner + 1, corner + columns + 1, corner + columns], face * 4);
    }
  }
  return createMeshData({ positions, faceOffsets, cornerVertices });
}

function ocean(overrides = {}) {
  return { op: 'ocean', seed: 7, time: 1.5, ...overrides };
}

test('the same seed and time give identical vertices and foam', () => {
  const grid = flatGrid(24, 60);
  const first = applyMeshEdits(grid, [ocean()]).mesh;
  const second = applyMeshEdits(grid, [ocean()]).mesh;
  assert.deepEqual(Array.from(first.positions), Array.from(second.positions));
  assert.deepEqual(Array.from(vertexGroupWeights(first, 'foam')), Array.from(vertexGroupWeights(second, 'foam')));
  assert.ok(first.positions.some((value, index) => value !== grid.positions[index]), 'the sea moved the vertices');
});

test('another seed or another time gives another sea', () => {
  const grid = flatGrid(12, 60);
  const base = Array.from(applyMeshEdits(grid, [ocean()]).mesh.positions);
  assert.notDeepEqual(Array.from(applyMeshEdits(grid, [ocean({ seed: 8 })]).mesh.positions), base);
  assert.notDeepEqual(Array.from(applyMeshEdits(grid, [ocean({ time: 2.5 })]).mesh.positions), base);
});

test('the surface repeats every size metres and lifts the up axis only without choppiness', () => {
  const waves = oceanWaves({ windSpeed: 12, direction: 30, size: 80, seed: 3, resolution: 6 });
  const here = oceanSurfaceAt(waves, 5, -9, 2, 0);
  const shifted = oceanSurfaceAt(waves, 85, 71, 2, 0);
  assert.ok(Math.abs(here.height - shifted.height) < 1e-9);
  assert.equal(here.moveX, 0);
  assert.equal(here.moveZ, 0);
});

test('the significant wave height follows the wind and foam stays between 0 and 1', () => {
  const grid = flatGrid(40, 100);
  const { mesh } = applyMeshEdits(grid, [ocean({ windSpeed: 12, choppiness: 2, size: 100 })]);
  const heights = Array.from({ length: mesh.vertexCount }, (_, vertex) => mesh.positions[vertex * 3 + 1]);
  const mean = heights.reduce((sum, height) => sum + height, 0) / heights.length;
  const deviation = Math.sqrt(heights.reduce((sum, height) => sum + (height - mean) ** 2, 0) / heights.length);
  const expected = 0.21 * 12 * 12 / 9.81 / 4;
  assert.ok(deviation > expected * 0.3 && deviation < expected * 2.5, `height deviation ${deviation} against ${expected}`);
  const foam = vertexGroupWeights(mesh, 'foam');
  assert.ok(foam.every(weight => weight >= 0 && weight <= 1));
  assert.ok(foam.some(weight => weight > 0), 'strong choppiness folds some crests');
});

test('the up axis can be z, and bad fields are refused with the edit number', () => {
  const grid = flatGrid(4, 20);
  const { mesh } = applyMeshEdits(grid, [ocean({ axis: 'z', choppiness: 0 })]);
  assert.ok(Array.from({ length: mesh.vertexCount }, (_, vertex) => mesh.positions[vertex * 3 + 2]).some(value => value !== 0));
  assert.deepEqual(Array.from({ length: mesh.vertexCount }, (_, vertex) => mesh.positions[vertex * 3 + 1]), Array.from({ length: mesh.vertexCount }, (_, vertex) => grid.positions[vertex * 3 + 1]));
  for (const bad of [{ windSpeed: 0 }, { windSpeed: 61 }, { resolution: 17 }, { seed: -1 }, { size: 0 }, { axis: 'w' }, { choppiness: 5 }]) {
    assert.throws(() => applyMeshEdits(grid, [ocean(bad)]), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => applyMeshEdits(grid, [ocean({ wind: 3 })]), TypeError);
});

test('a sea over too many vertices is refused before it runs', () => {
  const grid = flatGrid(250, 100);
  assert.throws(() => applyMeshEdits(grid, [ocean({ resolution: 16 })]), RangeError);
});

test('the capability notes describe the ocean modifier', () => {
  assert.match(MESH_MODIFIER_NOTES.ocean, /foam/);
});

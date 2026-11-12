import test from 'node:test';
import assert from 'node:assert/strict';
import { oceanMesh } from '../src/mesh-ocean-modifier.js';
import { createMeshData } from '../src/mesh-data.js';
import { normalizeOcean, seaHeightAt } from '../src/physics-buoyancy.js';

const SEA = { windSpeed: 6, direction: 20, size: 30, seed: 5, time: 1.5, resolution: 5 };
const SAMPLE_POINTS = [[5, 2], [2, 5], [-7, 3], [3, -7], [11, -4], [-9, 8]];

function drawnHeights(choppiness) {
  const positions = new Float32Array(SAMPLE_POINTS.flatMap(([x, z]) => [x, 0, z]));
  const faces = { faceOffsets: new Uint32Array([0, 3]), cornerVertices: new Uint32Array([0, 1, 2]) };
  const mesh = oceanMesh(createMeshData({ positions, ...faces }), { axis: 'y', ...SEA, choppiness });
  return SAMPLE_POINTS.map((_, index) => ({ x: mesh.positions[index * 3], height: mesh.positions[index * 3 + 1], z: mesh.positions[index * 3 + 2] }));
}

test('a body floats on the wave the ocean mesh draws at the same place, not on its mirror', () => {
  const ocean = normalizeOcean({ ...SEA, choppiness: 0 });
  for (const { x, z, height } of drawnHeights(0)) {
    assert.ok(Math.abs(seaHeightAt(ocean, x, z, 0) - height) < 1e-4, `at ${x}, ${z}: physics ${seaHeightAt(ocean, x, z, 0)}, drawn ${height}`);
  }
});

test('with choppy waves the sea under a body is the drawn height at the drawn, pulled position', () => {
  const ocean = normalizeOcean({ ...SEA, choppiness: 0.6 });
  for (const { x, z, height } of drawnHeights(0.6)) {
    assert.ok(Math.abs(seaHeightAt(ocean, x, z, 0) - height) < 0.02, `at ${x}, ${z}: physics ${seaHeightAt(ocean, x, z, 0)}, drawn ${height}`);
  }
});

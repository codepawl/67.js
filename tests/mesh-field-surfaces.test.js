import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { grid as gridGeometry } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { vertexGroupWeights } from '../src/mesh-data.js';
import { expandInstancedNodes } from '../src/mesh-instances.js';
import { validateField } from '../src/mesh-fields.js';

// A quad on a slope, y = 0.5 x, from x -10 to 10 and z -halfDepth to halfDepth. The terrain is wide, the path a strip of it.
function slopedQuad(halfDepth) {
  const heightAt = coordinate => coordinate * 0.5;
  const positions = new Float32Array([
    -10, heightAt(-10), -halfDepth, 10, heightAt(10), -halfDepth, 10, heightAt(10), halfDepth, -10, heightAt(-10), halfDepth,
  ]);
  const normals = new Float32Array([-0.4472, 0.8944, 0, -0.4472, 0.8944, 0, -0.4472, 0.8944, 0, -0.4472, 0.8944, 0]);
  return { positions, normals, indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
}

const terrain = slopedQuad(10);
const surfaces = { terrain, path: slopedQuad(1) };
const options = { maxNodes: 4096, resolveSurface: id => surfaces[id] };
const grass = { id: 'grass', geometry: 'blade', material: 'green' };
const AWAY_FROM_PATH = { gt: [{ nearest: { surface: 'path', read: 'distance' } }, 2] };

function placements(spec) {
  return expandInstancedNodes([{ ...grass, instances: spec }], options).filter(node => node.parent === 'grass').map(node => node.translation);
}

test('scatter on terrain avoids a path mesh and follows the terrain height', () => {
  const kept = placements({ surface: { geometry: 'terrain', count: 400 }, seed: 4, where: AWAY_FROM_PATH });
  assert.ok(kept.length > 100 && kept.length < 400, `kept ${kept.length} of 400`);
  for (const [x, y, z] of kept) {
    assert.ok(Math.abs(z) > 2 - 1e-6, `point at z ${z} is on the path`);
    assert.ok(Math.abs(y - x * 0.5) < 1e-4, 'point is off the terrain slope');
  }
});

test('results repeat for the same seed and change with another', () => {
  const spec = { surface: { geometry: 'terrain', count: 100 }, seed: 9, where: AWAY_FROM_PATH };
  assert.deepEqual(placements(spec), placements(spec));
  assert.notDeepEqual(placements(spec), placements({ ...spec, seed: 10 }));
});

test('a raycast keeps a box scatter that has terrain below it and drops the rest', () => {
  const hits = placements({
    scatter: { count: 300, min: [-20, 0, -5], max: [20, 0, 5] }, seed: 2,
    where: { raycast: { surface: 'terrain', at: { add: [{ attr: 'position' }, [0, 50, 0]] }, direction: [0, -1, 0], read: 'hit' } },
  });
  assert.ok(hits.length > 50 && hits.length < 300);
  for (const [x] of hits) assert.ok(Math.abs(x) <= 10 + 1e-6);
});

test('a mesh edit snaps a flat grid to terrain height and stores proximity as a named group', () => {
  const sheet = meshFromGeometry(gridGeometry(4));
  const terrainRecord = { type: 'terrain-stand-in' };
  const resolveCutter = record => {
    assert.deepEqual(record, terrainRecord);
    return meshFromGeometry(terrain);
  };
  const above = { add: [{ attr: 'position' }, [0, 50, 0]] };
  const result = applyMeshEdits(sheet, [
    { op: 'set_position', position: { raycast: { surface: terrainRecord, at: above, direction: [0, -1, 0], read: 'point' } } },
    { op: 'vertex_group', name: 'nearby', field: { saturate: { sub: [1, { nearest: { surface: terrainRecord, at: { add: [{ attr: 'position' }, [0, 1, 0]] }, read: 'distance' } }] } } },
    { op: 'vertex_group', name: 'copy', field: { attr: 'group', name: 'nearby' } },
  ], { resolveCutter });
  for (let vertex = 0; vertex < result.mesh.vertexCount; vertex++) {
    const x = result.mesh.positions[vertex * 3];
    assert.ok(Math.abs(result.mesh.positions[vertex * 3 + 1] - x * 0.5) < 1e-4);
  }
  assert.deepEqual(vertexGroupWeights(result.mesh, 'copy'), vertexGroupWeights(result.mesh, 'nearby'));
});

test('surface inputs are validated without a surface and reject bad records', () => {
  assert.equal(validateField({ nearest: { surface: 'path' } }), 'scalar');
  assert.equal(validateField({ nearest: { surface: 'path', read: 'normal' } }), 'vector');
  assert.throws(() => validateField({ nearest: { read: 'distance' } }), /needs a surface/);
  assert.throws(() => validateField({ nearest: { surface: 'path', read: 'height' } }), /read must be one of/);
  assert.throws(() => validateField({ raycast: { surface: 'path' } }), /direction/);
  assert.throws(() => validateField({ raycast: { surface: 'path', direction: [0, 0, 0] } }), /direction/);
  assert.throws(() => validateField({ nearest: { surface: 'path', code: 'x' } }), /does not take/);
  const sheet = meshFromGeometry(gridGeometry(2));
  assert.throws(() => applyMeshEdits(sheet, [{ op: 'vertex_group', name: 'a', field: { nearest: { surface: 'path' } } }]), /geometry record/);
});

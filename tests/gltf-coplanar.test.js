import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { findCoplanarFaces } from '../src/gltf-coplanar.js';

// One square (two triangles) drawn twice, and a smaller square lying inside it, all in the plane z = 0.
const POSITIONS = new Float32Array([
  0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,
  0.5, 0.5, 0, 1.5, 0.5, 0, 1.5, 1.5, 0, 0.5, 1.5, 0,
]);

function meshDocument(indices, { doubleSided = false } = {}) {
  const positionBytes = new Uint8Array(POSITIONS.buffer);
  const indexBytes = new Uint8Array(new Uint16Array(indices).buffer);
  const buffer = new Uint8Array(positionBytes.length + indexBytes.length);
  buffer.set(positionBytes, 0);
  buffer.set(indexBytes, positionBytes.length);
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Wall', mesh: 0 }],
    meshes: [{ name: 'Wall', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ doubleSided, pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 0] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length },
    ],
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}` }],
  });
}

const BIG_SQUARE = [0, 1, 2, 0, 2, 3];
const DUPLICATE_SAME_WINDING = [2, 0, 1, 3, 0, 2];
const DUPLICATE_OPPOSITE_WINDING = [0, 2, 1, 0, 3, 2];
const SMALL_SQUARE = [4, 5, 6, 4, 6, 7];

test('an exact duplicate face is dropped and the warning names the mesh and the count', async () => {
  const asset = await parseGltf(meshDocument([...BIG_SQUARE, ...DUPLICATE_SAME_WINDING]));
  assert.equal(asset.parts[0].geometry.indices.length, 6);
  assert.ok(asset.warnings.some(warning => warning.includes('Mesh Wall') && warning.includes('dropped 2 duplicate face(s)')), asset.warnings.join('\n'));
});

test('a duplicate with the opposite winding is kept on a single-sided material and dropped on a double-sided one', async () => {
  const single = await parseGltf(meshDocument([...BIG_SQUARE, ...DUPLICATE_OPPOSITE_WINDING]));
  assert.equal(single.parts[0].geometry.indices.length, 12);
  const double = await parseGltf(meshDocument([...BIG_SQUARE, ...DUPLICATE_OPPOSITE_WINDING], { doubleSided: true }));
  assert.equal(double.parts[0].geometry.indices.length, 6);
});

test('a smaller face lying inside a bigger one in the same plane is moved off the plane, the bigger one stays', async () => {
  const asset = await parseGltf(meshDocument([...BIG_SQUARE, ...SMALL_SQUARE]));
  const { positions, indices } = asset.parts[0].geometry;
  const heightOf = triangle => positions[indices[triangle * 3] * 3 + 2];
  assert.equal(heightOf(0), 0);
  assert.equal(heightOf(1), 0);
  assert.ok(heightOf(2) > 0.0015 && heightOf(2) < 0.0025, `moved by ${heightOf(2)} m`);
  assert.ok(asset.warnings.some(warning => warning.includes('Mesh Wall') && warning.includes('moved 2 overlapping coplanar face(s)')), asset.warnings.join('\n'));
  assert.equal(positions.length, (8 + 6) * 3);
});

test('a mesh without coplanar faces loads with its geometry and warnings untouched', async () => {
  const asset = await parseGltf(meshDocument(BIG_SQUARE));
  assert.equal(asset.parts[0].geometry.indices.length, 6);
  assert.equal(asset.parts[0].geometry.positions.length, 24);
  assert.deepEqual(asset.warnings, []);
});

test('resolveCoplanarFaces false leaves the faces as authored', async () => {
  const asset = await parseGltf(meshDocument([...BIG_SQUARE, ...DUPLICATE_SAME_WINDING, ...SMALL_SQUARE]), { resolveCoplanarFaces: false });
  assert.equal(asset.parts[0].geometry.indices.length, 18);
  assert.deepEqual(asset.warnings, []);
});

test('the search is bounded by its work budget', () => {
  const found = findCoplanarFaces({ positions: POSITIONS, indices: Uint16Array.from([...BIG_SQUARE, ...SMALL_SQUARE]) }, { workBudget: 0 });
  assert.equal(found.truncated, true);
});

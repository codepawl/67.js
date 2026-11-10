import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';

const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const ZERO_NORMALS = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const FACE_NORMALS = [0, 0, 1, 0, 0, 1, 0, 0, 1];
const MORPH_DELTA = [0, 0, 0.5, 0, 0, 0.5, 0, 0, 0.5];

/** One triangle (accessor 0), its normals (1), a morph position delta (2) and a morph normal delta (3). */
function documentWith(normals, edit) {
  const floats = new Float32Array([...TRIANGLE, ...normals, ...MORPH_DELTA, ...FACE_NORMALS]);
  const bytes = new Uint8Array(floats.buffer);
  const vec3 = byteOffset => ({ bufferView: 0, byteOffset, componentType: 5126, count: 3, type: 'VEC3' });
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Good', mesh: 0 }, { name: 'Other', mesh: 0, translation: [2, 0, 0] }],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    accessors: [
      { ...vec3(0), min: [0, 0, 0], max: [1, 1, 0] },
      vec3(36),
      { ...vec3(72), min: [0, 0, 0.5], max: [0, 0, 0.5] },
      vec3(108),
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
  };
  edit?.(document);
  return JSON.stringify(document);
}

test('authored vertex normals of zero length are rebuilt from the triangles with a warning', async () => {
  const asset = await parseGltf(documentWith(ZERO_NORMALS));
  assert.equal(asset.parts.length, 2);
  assert.deepEqual(Array.from(asset.parts[0].geometry.normals), FACE_NORMALS);
  assert.deepEqual(asset.warnings, ['Repaired primitive 0 of mesh "Tri": 3 vertex normal(s) had zero length and were rebuilt from the triangles.']);
});

test('valid normals load with no warning', async () => {
  const asset = await parseGltf(documentWith(FACE_NORMALS));
  assert.deepEqual(asset.warnings, []);
  assert.deepEqual(Array.from(asset.parts[0].geometry.normals), FACE_NORMALS);
});

test('a node with a zero scale is skipped with a warning and the rest of the file loads', async () => {
  const asset = await parseGltf(documentWith(FACE_NORMALS, document => { document.nodes[0].scale = [0, 0, 0]; }));
  assert.equal(asset.parts.length, 1);
  assert.deepEqual(asset.warnings, ['Skipped node "Good": its world transform is singular or non-finite.']);
});

test('a singular group node skips the meshes under it', async () => {
  const asset = await parseGltf(documentWith(FACE_NORMALS, document => {
    document.nodes = [{ name: 'Group', scale: [0, 1, 1], children: [1] }, { name: 'Child', mesh: 0 }, { name: 'Free', mesh: 0 }];
    document.scenes[0].nodes = [0, 2];
  }));
  assert.equal(asset.parts.length, 1);
  assert.match(asset.warnings[0], /Skipped node "Child"/);
});

test('morph targets without a base NORMAL load: normals are generated and the morph normal deltas are recomputed', async () => {
  const asset = await parseGltf(documentWith(FACE_NORMALS, document => {
    const primitive = document.meshes[0].primitives[0];
    delete primitive.attributes.NORMAL;
    primitive.targets = [{ POSITION: 2, NORMAL: 3 }, { POSITION: 2 }];
  }));
  assert.equal(asset.parts.length, 2);
  assert.deepEqual(Array.from(asset.parts[0].geometry.normals), FACE_NORMALS);
  assert.equal(asset.parts[0].geometry.morphTargets.length, 2);
  assert.equal(asset.parts[0].geometry.morphTargets[0].normals.length, 9);
  assert.match(asset.warnings[0], /^Repaired primitive 0 of mesh "Tri": it has morph targets but no base NORMAL/);
});

test('a primitive without NORMAL falls back to a touching face normal or up when generated normals cancel out', async () => {
  const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 1, 3, 3, 3, 0, 1, 2]);
  const bytes = new Uint8Array(floats.byteLength + indices.byteLength);
  bytes.set(new Uint8Array(floats.buffer), 0);
  bytes.set(new Uint8Array(indices.buffer), floats.byteLength);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Tile', mesh: 0 }],
    meshes: [{ name: 'Tile', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [5, 5, 5] },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: 12, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: floats.byteLength },
      { buffer: 0, byteOffset: floats.byteLength, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
  };
  const asset = await parseGltf(JSON.stringify(document));
  assert.equal(asset.parts.length, 1);
  assert.deepEqual(Array.from(asset.parts[0].geometry.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0]);
  assert.deepEqual(asset.warnings, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

/** One triangle in the XY plane (accessor 0) and a morph that lifts its third corner out of the plane (accessor 1). */
function morphDocument(edit) {
  const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const bytes = new Uint8Array(floats.buffer);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Tri', mesh: 0 }],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }] }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 1] },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
  };
  edit?.(document, floats);
  const edited = new Uint8Array(floats.buffer);
  document.buffers[0].uri = `data:application/octet-stream;base64,${Buffer.from(edited).toString('base64')}`;
  return JSON.stringify(document);
}

test('morph targets without a base NORMAL get per-target normals that follow the morphed triangles', async () => {
  const asset = await parseGltf(morphDocument());
  const { geometry } = asset.parts[0];
  assert.deepEqual(Array.from(geometry.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const deltas = geometry.morphTargets[0].normals;
  assert.equal(deltas.length, 9);
  // The morphed triangle (0,0,0), (1,0,0), (0,1,1) leans toward -Y/+Z: normal (0, -1, 1) / sqrt(2) at every vertex.
  const morphedNormal = [0, -Math.SQRT1_2, Math.SQRT1_2];
  for (let vertex = 0; vertex < 3; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(geometry.normals[vertex * 3 + axis] + deltas[vertex * 3 + axis] - morphedNormal[axis]) < 1e-6);
    }
  }
  assert.match(asset.warnings[0], /no base NORMAL; base and per-target normals are generated/);
  asset.dispose();
});

test('a NaN vertex position becomes 0 with a warning and the bounds stay finite', async () => {
  const asset = await parseGltf(morphDocument((document, floats) => {
    floats[5] = Number.NaN;
    floats[10] = Number.POSITIVE_INFINITY;
  }));
  assert.ok(Array.from(asset.parts[0].geometry.positions).every(Number.isFinite));
  assert.ok(Array.from(asset.parts[0].geometry.morphTargets[0].positions).every(Number.isFinite));
  assert.ok(asset.warnings.some(warning => /1 non-finite POSITION value\(s\) were set to 0/.test(warning)));
  assert.ok(asset.warnings.some(warning => /1 non-finite morph POSITION value\(s\) were set to 0/.test(warning)));
  assert.ok(Object.values(asset.bounds ?? { box: 0 }).flat(Infinity).every(value => typeof value !== 'number' || Number.isFinite(value)));
  asset.dispose();
});

test('a non-finite inverse bind matrix is replaced with the identity and the pose stays finite', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append, chunks) => {
    const inverseBindMatrices = chunks[document.skins[0].inverseBindMatrices];
    inverseBindMatrices[16 + 5] = Number.NaN;
  }));
  assert.ok(asset.warnings.some(warning => /1 non-finite inverse bind matrix\(es\); they were replaced with the identity/.test(warning)));
  assert.ok(Array.from(asset.parts[0].skin.jointMatrices).every(Number.isFinite));
  assert.ok(Array.from(asset.parts[0].skin.inverseBindMatrices).every(Number.isFinite));
  asset.dispose();
});

test('a NaN joint transform loads with a warning and a finite palette', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append, chunks) => {
    document.nodes[3].scale = [Number.NaN, 1, 1];
  }));
  assert.ok(Array.from(asset.parts[0].skin.jointMatrices).every(Number.isFinite));
  asset.dispose();
});

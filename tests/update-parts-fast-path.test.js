import test from 'node:test';
import assert from 'node:assert/strict';
import { mat3, mat4 } from 'gl-matrix';
import { Renderer67 } from '../src/renderer.js';
import { MATERIAL_LAYER_FIELDS, materialLayerState } from '../src/material-layers.js';
import { SNAPSHOT_REFERENCE_FIELDS, SNAPSHOT_VALUE_FIELDS, MaterialSnapshot } from '../src/material-snapshot.js';

const GEOMETRY = {};

function createPart(name, material = {}) {
  return { name, geometry: GEOMETRY, matrix: mat4.create(), material: { color: [0.1, 0.2, 0.3], metallic: 0.5, roughness: 0.3, emission: 0, ...material } };
}

function createRenderer(parts) {
  const renderer = Object.create(Renderer67.prototype);
  const batch = { instanceBuffer: {}, instanceData: new Float32Array(parts.length * 42), castShadow: true, alphaMode: 'opaque', alphaCutoff: 0, opacity: 1, doubleSided: false, pass: 'opaque' };
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData() {} };
  renderer.partLocations = new Map(parts.map((part, index) => [part, {
    batch, index, geometry: GEOMETRY, map: null, normalMatrix: mat3.create(), layerState: materialLayerState({}), skin: null,
    mapState: [null, null, null, null, null, 1, 1, 1, 0, 0.05, 0.085, 0.02],
  }]));
  renderer.updateBatches = new Set();
  renderer.updateSkins = new Set();
  renderer.shadowsDirty = false;
  return { renderer, batch };
}

test('the snapshot lists cover every material map and layer field the batch compares', () => {
  const covered = new Set([...SNAPSHOT_VALUE_FIELDS, ...SNAPSHOT_REFERENCE_FIELDS]);
  for (const field of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'alphaMode', 'alphaCutoff', 'opacity', 'doubleSided', 'tag', 'lightMask', ...MATERIAL_LAYER_FIELDS]) {
    assert.ok(covered.has(field), `${field} is missing from the material snapshot`);
  }
});

test('a snapshot matches only a material whose compared fields are unchanged', () => {
  const material = { color: [1, 1, 1], metallic: 0, roughness: 1 };
  const snapshot = MaterialSnapshot.of(material);
  material.color = [0, 0, 0];
  material.roughness = 0.2;
  assert.equal(snapshot.matches(material), true);
  for (const field of SNAPSHOT_VALUE_FIELDS) {
    const changed = { ...material, [field]: {} };
    assert.equal(snapshot.matches(changed), false, `${field} change went unnoticed`);
  }
  for (const field of SNAPSHOT_REFERENCE_FIELDS) {
    assert.equal(MaterialSnapshot.of({ ...material, [field]: [1, 1] }), null, `${field} must not be snapshotted`);
  }
});

test('matrix, colour, emission and roughness changes update through the fast path', () => {
  const parts = [createPart('first'), createPart('second')];
  const { renderer, batch } = createRenderer(parts);
  assert.equal(renderer.updateParts(parts), 2);
  parts[1].matrix[12] = 5;
  parts[1].material.color = [0.9, 0.8, 0.7];
  parts[1].material.roughness = 0.6;
  parts[1].material.emission = 2;
  assert.equal(renderer.updateParts(parts), 2);
  assert.equal(batch.instanceData[42 + 12], 5);
  assert.deepEqual(Array.from(batch.instanceData.subarray(42 + 25, 42 + 28)).map(value => Math.round(value * 10)), [9, 8, 7]);
  assert.equal(Math.round(batch.instanceData[42 + 29] * 10), 6);
  assert.equal(batch.instanceData[42 + 30], 2);
});

test('rejections still throw after the fast path has been taken', () => {
  const rejected = [
    [material => { material.alphaMode = 'blend'; }, /Shadow casting|Alpha mode/],
    [material => { material.alphaMode = 'mask'; }, /Alpha mode/],
    [material => { material.doubleSided = true; }, /double-sided/],
    [material => { material.map = { name: 'other' }; }, /Texture map/],
    [material => { material.normalMap = {}; }, /new renderer|standard PBR/],
    [material => { material.transmission = 0.5; }, /liquid or foam pass/],
    [material => { material.tag = 'liquid'; }, /liquid or foam pass/],
    [material => { material.clearcoat = 0.5; }, /Material map or scale/],
    [material => { material.moss = 0.5; }, /Material map or scale/],
    [material => { material.normalScale = [2, 2]; }, /Material map or scale/],
    [material => { material.lightMask = 1; }, /Material map or scale/],
  ];
  for (const [change, expected] of rejected) {
    const parts = [createPart('mover')];
    const { renderer } = createRenderer(parts);
    renderer.updateParts(parts);
    renderer.updateParts(parts);
    change(parts[0].material);
    assert.throws(() => renderer.updateParts(parts), expected);
  }
});

test('geometry changes and bad numbers still throw after the fast path has been taken', () => {
  const parts = [createPart('mover')];
  const { renderer } = createRenderer(parts);
  renderer.updateParts(parts);
  parts[0].geometry = {};
  assert.throws(() => renderer.updateParts(parts), /Geometry changes/);
  parts[0].geometry = GEOMETRY;
  parts[0].matrix[0] = NaN;
  assert.throws(() => renderer.updateParts(parts), /Invalid transform/);
  parts[0].matrix[0] = 1;
  parts[0].material.color = [0, NaN, 0];
  assert.throws(() => renderer.updateParts(parts), /Invalid instance vector/);
  parts[0].material.color = [0, 0, 0];
  parts[0].material.emissiveColor = [0, Infinity, 0];
  assert.throws(() => renderer.updateParts(parts), /Invalid instance vector/);
  delete parts[0].material.emissiveColor;
  parts[0].material.roughness = 1e39;
  assert.throws(() => renderer.updateParts(parts), /Invalid material/);
});

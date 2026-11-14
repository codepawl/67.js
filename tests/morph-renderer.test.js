import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, mat3 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { Renderer67, groupParts } from '../src/renderer.js';
import { createMorphPose, validateMorphGeometry } from '../src/morph.js';
import { materialLayerState } from '../src/material-layers.js';

function makePart(name, geometry, morph) {
  return { name, geometry, morph, matrix: mat4.create(), material: { color: [0.4, 0.5, 0.6], metallic: 0, roughness: 0.7, emission: 0 } };
}

function makeGeometry(delta = 0.5) {
  const geometry = box();
  const positions = new Float32Array(geometry.positions.length).fill(delta);
  geometry.morphTargets = [{ positions }];
  return geometry;
}

function retainedRenderer(parts) {
  const renderer = Object.create(Renderer67.prototype);
  const writes = [];
  renderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData() { writes.push(true); } };
  renderer.updateSkins = new Set();
  renderer.updateBatches = new Set();
  renderer.partLocations = new Map();
  renderer.batches = groupParts(parts).map(group => {
    const first = group[0];
    const batch = {
      morph: first.morph,
      morphTexture: { info: validateMorphGeometry(first.geometry, first.morph) },
      morphWeights: new Float32Array(first.morph.weights),
      instanceBuffer: {},
      instanceData: new Float32Array(group.length * 42),
      castShadow: true, receivesShadow: true, compositeMode: 0,
      alphaMode: 'opaque',
      alphaCutoff: 0,
      opacity: 1,
      doubleSided: false,
    };
    group.forEach((part, index) => renderer.partLocations.set(part, {
      batch, index, geometry: part.geometry, morph: part.morph,
      morphWeights: part.morph.weights, morphTargets: part.geometry.morphTargets,
      skin: null, map: null, layerState: materialLayerState({}), mapState: [null, null, null, null, null, 1, 1, 1, 0, 0.05, 0.085, 0.02],
      normalMatrix: mat3.create(),
    }));
    return batch;
  });
  renderer.updateParts(parts);
  writes.length = 0;
  return { renderer, writes };
}

test('morph pose identity partitions batches while shared geometry and pose retain instancing', () => {
  const geometry = makeGeometry();
  const pose = createMorphPose(1);
  const first = makePart('first', geometry, pose);
  const second = makePart('second', geometry, pose);
  assert.equal(groupParts([first, second]).length, 1);
  second.morph = createMorphPose(1);
  assert.equal(groupParts([first, second]).length, 2);
});

test('shared morph consumers outside update list reject unsafe weights before any committed changes', () => {
  const pose = createMorphPose(1);
  const first = makePart('small delta', makeGeometry(), pose);
  const second = makePart('large delta', makeGeometry(2e38), pose);
  const { renderer, writes } = retainedRenderer([first, second]);
  const snapshots = renderer.batches.map(batch => new Float32Array(batch.instanceData));
  const weights = renderer.batches.map(batch => batch.morphWeights);
  pose.weights[0] = 2;
  first.matrix[12] = 9;
  assert.throws(() => renderer.updateParts([first]), /Float32/);
  assert.equal(writes.length, 0);
  renderer.batches.forEach((batch, index) => {
    assert.deepEqual(batch.instanceData, snapshots[index]);
    assert.equal(batch.morphWeights, weights[index]);
    assert.equal(batch.morphWeights[0], 0);
  });
  pose.weights[0] = 0.5;
  renderer.updateParts([first]);
  assert.equal(writes.length, 1);
  renderer.batches.forEach(batch => assert.equal(batch.morphWeights[0], 0.5));
  first.morph.weights = new Float32Array([0]);
  assert.throws(() => renderer.updateParts([first]), /Morph identity/);
  assert.equal(writes.length, 1);
});

test('main and shadow draws upload the retained morph weights and disable morphs for rigid batches', () => {
  const renderer = Object.create(Renderer67.prototype);
  renderer.hasMorphs = true;
  renderer.benchmark = true;
  renderer.uniforms = { morphEnabled: 'color enabled', morphVertexCount: 'vertices', morphTargetCount: 'targets', 'morphWeights[0]': 'color weights' };
  renderer.depthMorphUniforms = { morphEnabled: 'shadow enabled', morphVertexCount: 'vertices', morphTargetCount: 'targets', 'morphWeights[0]': 'shadow weights' };
  const uploads = [];
  renderer.context = {
    TEXTURE0: 33984, activeTexture() {}, bindTexture() {}, bindVertexArray() {}, drawElementsInstanced() {},
    uniform1f(name, value) { uploads.push([name, value]); }, uniform1i() {}, uniform1fv(name, values) { uploads.push([name, values]); },
  };
  const batch = { morph: {}, morphTexture: { info: { vertexCount: 3, targetCount: 1 }, texture: {} }, morphWeights: new Float32Array([0.5]) };
  renderer.drawBatch(batch, true);
  renderer.drawBatch(batch);
  renderer.drawBatch({});
  assert.ok(uploads.some(([name, value]) => name === 'color weights' && value === batch.morphWeights));
  assert.ok(uploads.some(([name, value]) => name === 'shadow weights' && value === batch.morphWeights));
  assert.deepEqual(uploads.at(-1), ['shadow enabled', 0]);
});

test('a batch with more than 64 targets uploads its 64 largest weights with their target indices', () => {
  const renderer = Object.create(Renderer67.prototype);
  renderer.hasMorphs = true;
  renderer.benchmark = true;
  renderer.uniforms = { morphEnabled: 'enabled', morphVertexCount: 'vertices', morphTargetCount: 'count', 'morphWeights[0]': 'weights', 'morphSlotTargets[0]': 'targets' };
  const uploads = {};
  renderer.context = {
    TEXTURE0: 33984, activeTexture() {}, bindTexture() {}, bindVertexArray() {}, drawElementsInstanced() {},
    uniform1f() {}, uniform1i(name, value) { uploads[name] = value; }, uniform1fv(name, values) { uploads[name] = [...values]; },
  };
  const morphWeights = new Float32Array(175);
  morphWeights[170] = 0.25;
  morphWeights[7] = 1;
  const batch = { morph: {}, morphTexture: { info: { vertexCount: 3, targetCount: 175 }, texture: {} }, morphWeights };
  renderer.drawBatch(batch, true);
  assert.equal(uploads.count, 2);
  assert.deepEqual(uploads.targets.slice(0, 2), [7, 170]);
  assert.deepEqual(uploads.weights.slice(0, 2), [1, 0.25]);
  assert.equal(uploads.weights.length, 64);
});

test('world scale overflow and shared unsent consumer transforms reject before publishing morph weights', () => {
  const geometry = makeGeometry(2e38);
  const pose = createMorphPose(1);
  const first = makePart('ordinary scale', geometry, pose);
  const second = makePart('doubled scale', geometry, pose);
  mat4.fromScaling(second.matrix, [2, 1, 1]);
  const { renderer, writes } = retainedRenderer([first, second]);
  pose.weights[0] = 1;
  assert.throws(() => groupParts([second]), /Morph world position/);
  assert.throws(() => renderer.updateParts([first]), /Morph world position/);
  second.morph = undefined;
  assert.throws(() => renderer.updateParts([first]), /Morph world position/);
  assert.equal(writes.length, 0);
  renderer.batches.forEach(batch => assert.equal(batch.morphWeights[0], 0));
});

test('morph world bounds use the same Float32 coefficients as instance upload', () => {
  const delta = Math.fround(1e38);
  const maximum = 3.4028234663852886e38;
  const geometry = makeGeometry(0);
  for (let offset = 0; offset < geometry.positions.length; offset += 3) geometry.morphTargets[0].positions[offset] = delta;
  const pose = createMorphPose(1);
  pose.weights[0] = 1;
  const item = makePart('Float64 transform rounds upward', geometry, pose);
  item.matrix = Float64Array.from(mat4.create());
  item.matrix[0] = maximum / delta;
  assert.equal(Math.fround(Math.fround(item.matrix[0]) * delta), Infinity);
  assert.throws(() => groupParts([item]), /Morph world position/);
});

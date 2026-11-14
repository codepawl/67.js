import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box, sphere } from '../src/geometry.js';
import { CrucibleRenderer } from '../src/renderer.js';
import '../src/replace-textured-parts.js';

function part(name, geometry) {
  return { name, geometry, matrix: mat4.create(), material: { tag: 'surface', color: [0.5, 0.6, 0.7], metallic: 0, roughness: 0.5 } };
}

function allocationRenderer() {
  const renderer = Object.create(CrucibleRenderer.prototype);
  const liveBuffers = new Set();
  const liveArrays = new Set();
  const uploads = [];
  const liveTextures = new Set();
  let driverError = 0;
  let throwingUpload = false;
  renderer.context = {
    ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, STATIC_DRAW: 35044, DYNAMIC_DRAW: 35048, FLOAT: 5126,
    createBuffer() {
      const buffer = {};
      liveBuffers.add(buffer);
      return buffer;
    },
    deleteBuffer(buffer) { liveBuffers.delete(buffer); },
    createVertexArray() {
      const array = {};
      liveArrays.add(array);
      return array;
    },
    deleteVertexArray(array) { liveArrays.delete(array); },
    deleteTexture(texture) { liveTextures.delete(texture); },
    getParameter() { return 4096; },
    bindBuffer() {}, bindVertexArray() {}, enableVertexAttribArray() {}, disableVertexAttribArray() {},
    vertexAttribPointer() {}, vertexAttribDivisor() {}, vertexAttrib2f() {}, vertexAttrib3f() {},
    bufferData(target, data, usage) {
      if (throwingUpload) throw new Error('Injected upload exception');
      uploads.push({ target, data, usage });
    },
    bufferSubData() {},
    getError() {
      const error = driverError;
      driverError = 0;
      return error;
    },
  };
  renderer.canvas = { width: 64, height: 64 };
  renderer.multisampleSamples = 0;
  renderer.memoryBudgetMiB = 64;
  renderer.textureBytes = 4;
  renderer.geometryBytes = 0;
  renderer.geometryBuffers = new Map();
  renderer.batching = true;
  renderer.groundPart = null;
  renderer.buffers = [];
  renderer.batches = [];
  renderer.partLocations = new Map();
  renderer.updateBatches = new Set();
  renderer.updateSkins = new Set();
  renderer.updateMorphs = new Set();
  renderer.textures = new Map();
  renderer.createTexture = descriptor => {
    if (!renderer.textures.has(descriptor)) {
      const texture = { descriptor };
      liveTextures.add(texture);
      renderer.textures.set(descriptor, texture);
    }
    return renderer.textures.get(descriptor);
  };
  return { renderer, liveBuffers, liveArrays, liveTextures, uploads,
    failDriver() { driverError = 1285; },
    failUpload(value) { throwingUpload = value; },
  };
}

test('topology reconciliation reuses geometry uploads and unchanged batches, and releases removed geometry', () => {
  const state = allocationRenderer();
  const geometry = box();
  const first = part('first', geometry);
  state.renderer.replaceParts([first]);
  const originalBuffers = [...state.renderer.geometryBuffers.get(geometry).values()];
  assert.equal(state.uploads.length, 4);
  const unchangedBatch = state.renderer.batches[0];
  state.renderer.replaceParts([first]);
  assert.equal(state.renderer.batches[0], unchangedBatch);
  assert.equal(state.uploads.length, 4);
  first.matrix[12] = 5;
  first.material.color[0] = 0.9;
  first.material.tag = 'unlit';
  state.renderer.replaceParts([first]);
  assert.equal(state.renderer.batches[0], unchangedBatch);
  assert.equal(unchangedBatch.instanceData[12], 5);
  assert.ok(Math.abs(unchangedBatch.instanceData[25] - 0.9) < 1e-6);
  assert.equal(unchangedBatch.instanceData[31], 10);
  assert.equal(state.uploads.length, 4);
  const second = part('second', geometry);
  state.renderer.replaceParts([first, second]);
  assert.equal(state.uploads.length, 5, 'Only the resized instance array is uploaded');
  assert.deepEqual([...state.renderer.geometryBuffers.get(geometry).values()], originalBuffers);
  assert.equal(state.liveBuffers.size, 4);
  assert.equal(state.liveArrays.size, 1);
  const third = part('third', sphere(12, 8));
  const retainedBatch = state.renderer.batches[0];
  state.renderer.replaceParts([first, second, third]);
  assert.equal(state.renderer.batches[0], retainedBatch);
  state.renderer.replaceParts([third]);
  assert.equal(state.renderer.geometryBuffers.has(geometry), false);
  for (const buffer of originalBuffers) assert.equal(state.liveBuffers.has(buffer), false);
  assert.equal(state.renderer.partLocations.has(first), false);
  assert.equal(state.renderer.partCount, 1);
  state.renderer.replaceParts([]);
  assert.equal(state.liveBuffers.size, 0);
  assert.equal(state.liveArrays.size, 0);
  assert.equal(state.renderer.geometryBytes, 0);
});

test('invalid geometry and peak staging budgets reject before allocation and preserve the previous scene', () => {
  const state = allocationRenderer();
  const first = part('first', box());
  state.renderer.replaceParts([first]);
  const batch = state.renderer.batches[0];
  const allocations = state.uploads.length;
  const invalid = part('invalid', box());
  invalid.geometry.indices[0] = invalid.geometry.positions.length;
  assert.throws(() => state.renderer.replaceParts([first, invalid]), /indices/);
  assert.equal(state.uploads.length, allocations);
  state.renderer.memoryBudgetMiB = 16;
  assert.throws(() => state.renderer.replaceParts([first, part('new', sphere(24, 16))]), /cannot hold geometry .* over memoryBudgetMiB 16\. Fix: pass [{] memoryBudgetMiB: 17 [}]/);
  assert.equal(state.renderer.batches[0], batch);
  assert.equal(state.uploads.length, allocations);
});

test('driver errors and throwing uploads clean staged resources without retiring the working renderer', () => {
  const state = allocationRenderer();
  const first = part('first', box());
  state.renderer.replaceParts([first]);
  const batch = state.renderer.batches[0];
  const buffers = [...state.liveBuffers];
  const candidate = part('candidate', sphere(12, 8));
  state.failDriver();
  assert.throws(() => state.renderer.replaceParts([first, candidate]), /1285/);
  assert.equal(state.renderer.batches[0], batch);
  assert.deepEqual([...state.liveBuffers], buffers);
  assert.equal(state.liveArrays.size, 1);
  assert.equal(state.renderer.geometryBuffers.has(candidate.geometry), false);
  state.failUpload(true);
  assert.throws(() => state.renderer.replaceParts([first, candidate]), /Injected/);
  assert.deepEqual([...state.liveBuffers], buffers);
  assert.equal(state.liveArrays.size, 1);
  state.failUpload(false);
  state.renderer.replaceParts([first, candidate]);
  assert.equal(state.renderer.partCount, 2);
  assert.equal(state.renderer.batches[0], batch);
});

test('retained textured batches survive while streamed rigid parts change around them', () => {
  const state = allocationRenderer();
  const textured = part('textured', box());
  textured.material.map = { image: { width: 1, height: 1 }, colorSpace: 'srgb' };
  textured.geometry.uvs = new Float32Array(textured.geometry.positions.length / 3 * 2);
  state.renderer.batches.push(state.renderer.uploadBatch([textured]));
  const texturedBatch = state.renderer.batches[0];
  const firstFrame = part('liquid frame 0', sphere(12, 8));
  state.renderer.replaceParts([textured, firstFrame]);
  assert.equal(state.renderer.batches[0], texturedBatch);
  const secondFrame = part('liquid frame 1', sphere(10, 6));
  state.renderer.replaceParts([textured, secondFrame]);
  assert.equal(state.renderer.batches[0], texturedBatch, 'the textured batch is retained, not reuploaded');
  assert.equal(state.renderer.partCount, 2);
  const addedTexture = part('new textured', box());
  addedTexture.material.map = textured.material.map;
  addedTexture.geometry.uvs = new Float32Array(addedTexture.geometry.positions.length / 3 * 2);
  state.renderer.replaceParts([textured, secondFrame, addedTexture]);
  assert.equal(state.renderer.partCount, 3);
  state.renderer.replaceParts([secondFrame]);
  assert.equal(state.renderer.partLocations.has(textured), false);
});

test('committed uploaded resource ownership rejects replacement even when callers mutate live handles', () => {
  const state = allocationRenderer();
  const first = part('first', box());
  state.renderer.replaceParts([first]);
  const location = state.renderer.partLocations.get(first);
  const originalBatch = state.renderer.batches[0];
  location.skin = { jointMatrices: new Float32Array(16) };
  first.skin = undefined;
  assert.throws(() => state.renderer.replaceParts([]), /existing rigid/);
  assert.equal(state.renderer.partCount, 1);
});

function texturedPart(name, geometry, map) {
  const textured = part(name, { ...geometry, uvs: new Float32Array(geometry.positions.length / 3 * 2) });
  textured.material.map = map;
  return textured;
}

function descriptor(size = 8) {
  return { image: { width: size, height: size }, colorSpace: 'srgb' };
}

test('replaceParts adds a textured part and uploads its texture once', () => {
  const state = allocationRenderer();
  const plain = part('plain', box());
  state.renderer.replaceParts([plain]);
  const bytesBefore = state.renderer.textureBytes;
  const map = descriptor();
  const textured = texturedPart('textured', sphere(12, 8), map);
  state.renderer.replaceParts([plain, textured]);
  const batch = state.renderer.partLocations.get(textured).batch;
  assert.equal(batch.textures[0], state.renderer.textures.get(map));
  assert.equal(batch.textures[0].descriptor, map);
  assert.ok(state.renderer.textureBytes > bytesBefore);
});

test('replaceParts removes a textured part and deletes its batch, buffers and texture', () => {
  const state = allocationRenderer();
  const plain = part('plain', box());
  const map = descriptor();
  const textured = texturedPart('textured', sphere(12, 8), map);
  state.renderer.replaceParts([plain, textured]);
  const texture = state.renderer.textures.get(map);
  assert.ok(state.liveTextures.has(texture));
  const bytesWithTexture = state.renderer.textureBytes;
  state.renderer.replaceParts([plain]);
  assert.equal(state.renderer.batches.length, 1);
  assert.equal(state.renderer.partLocations.has(textured), false);
  assert.equal(state.liveTextures.has(texture), false);
  assert.equal(state.renderer.textures.has(map), false);
  assert.equal(state.liveArrays.size, 1);
  assert.equal(state.liveBuffers.size, 4);
  assert.ok(state.renderer.textureBytes < bytesWithTexture);
  assert.equal(state.renderer.textureBytes, 4);
});

test('a texture shared by two parts survives removing one of them', () => {
  const state = allocationRenderer();
  const map = descriptor();
  const cube = texturedPart('cube', box(), map);
  const ball = texturedPart('ball', sphere(12, 8), map);
  state.renderer.replaceParts([cube, ball]);
  const texture = state.renderer.textures.get(map);
  const bytes = state.renderer.textureBytes;
  state.renderer.replaceParts([cube]);
  assert.equal(state.liveTextures.has(texture), true);
  assert.equal(state.renderer.textures.get(map), texture);
  assert.equal(state.renderer.textureBytes, bytes);
  state.renderer.replaceParts([]);
  assert.equal(state.liveTextures.has(texture), false);
  assert.equal(state.renderer.textureBytes, 4);
});

test('replaceParts no longer rejects textured parts', () => {
  const state = allocationRenderer();
  const textured = texturedPart('textured', box(), descriptor());
  assert.doesNotThrow(() => state.renderer.replaceParts([textured]));
  assert.doesNotThrow(() => state.renderer.replaceParts([]));
});

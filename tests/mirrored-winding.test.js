import assert from 'node:assert/strict';
import test from 'node:test';
import { groupParts, isMirroredMatrix, Renderer67 } from '../src/renderer.js';

const quad = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

function quadPart(name, scaleX, material = {}) {
  return {
    name,
    geometry: quad,
    matrix: new Float32Array([scaleX, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    material: { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.5, emission: 1, ...material },
  };
}

test('a matrix is mirrored when the determinant of its upper 3x3 is negative', () => {
  assert.equal(isMirroredMatrix(quadPart('plain', 1).matrix), false);
  assert.equal(isMirroredMatrix(quadPart('flipped x', -1).matrix), true);
  const flippedTwice = quadPart('flipped x and y', -1).matrix;
  flippedTwice[5] = -1;
  assert.equal(isMirroredMatrix(flippedTwice), false);
  assert.equal(isMirroredMatrix(new Float32Array(16)), false);
});

test('parts that share a geometry and material batch apart by the sign of their determinant', () => {
  const parts = [quadPart('plain', 1), quadPart('flipped', -1), quadPart('plain again', 2), quadPart('flipped again', -3)];
  const groups = groupParts(parts);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.map(part => part.name)), [['plain', 'plain again'], ['flipped', 'flipped again']]);
});

test('a mirrored batch draws with clockwise front faces and restores the default winding', () => {
  const renderer = Object.create(Renderer67.prototype);
  renderer.benchmark = true;
  const calls = [];
  renderer.context = {
    CW: 'cw', CCW: 'ccw', TRIANGLES: 'triangles', UNSIGNED_INT: 'uint',
    TEXTURE0: 33984, activeTexture() {}, bindTexture() {}, bindVertexArray() {},
    frontFace(mode) { calls.push(`frontFace ${mode}`); },
    drawElementsInstanced() { calls.push('draw'); },
  };
  renderer.drawBatch({ mirrored: true, indexCount: 6, instanceCount: 1 });
  renderer.drawBatch({ mirrored: false, indexCount: 6, instanceCount: 1 });
  assert.deepEqual(calls, ['frontFace cw', 'draw', 'frontFace ccw', 'draw']);
});

test('updateParts rejects a part whose matrix changes sign after batching', () => {
  const renderer = Object.create(Renderer67.prototype);
  const part = quadPart('sprite', 1);
  const batch = { mirrored: false, castShadow: true, receivesShadow: true, compositeMode: 0, alphaMode: 'opaque', alphaCutoff: 0, opacity: 1, doubleSided: false };
  renderer.partLocations = new Map([[part, { batch, geometry: quad, skin: null, morph: null }]]);
  renderer.updateSkins = new Set();
  renderer.updateBatches = new Set();
  part.matrix[0] = -1;
  assert.throws(() => renderer.updateParts([part]), /Mirroring changes.*replaceParts: sprite/);
});

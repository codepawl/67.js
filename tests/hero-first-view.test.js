import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { parseArguments, removeEmptyPrimitives } from '../scripts/build-hero-first-view.mjs';

function primitiveWithVertexCount(document, vertexCount) {
  const position = document.createAccessor().setType('VEC3').setArray(new Float32Array(vertexCount * 3));
  const indices = document.createAccessor().setType('SCALAR').setArray(new Uint16Array(vertexCount));
  return document.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
}

test('removeEmptyPrimitives drops primitives without vertices and detaches meshes left empty', () => {
  const document = new Document();
  const keptMesh = document.createMesh('kept').addPrimitive(primitiveWithVertexCount(document, 3));
  const emptyMesh = document.createMesh('empty').addPrimitive(primitiveWithVertexCount(document, 0));
  const keptNode = document.createNode('kept').setMesh(keptMesh);
  const emptyNode = document.createNode('empty').setMesh(emptyMesh);

  removeEmptyPrimitives(document);

  assert.equal(keptMesh.listPrimitives().length, 1);
  assert.equal(emptyMesh.listPrimitives().length, 0);
  assert.equal(keptNode.getMesh(), keptMesh);
  assert.equal(emptyNode.getMesh(), null);
});

test('parseArguments defaults to a metre-scale world error with texture coordinates kept in place', () => {
  const options = parseArguments([]);
  assert.equal(options.worldError, 1.1);
  assert.equal(options.uvWeight, 1);
  assert.throws(() => parseArguments(['--world-error', '0']), /positive number/);
});

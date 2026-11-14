import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeGltf } from '../src/gltf-decode.js';
import { GLTF_CAPABILITIES, parseGltf } from '../src/gltf.js';

const PRIMITIVE_COUNT = 5;
const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];

function jsonOfManyPrimitives() {
  const accessorBytes = new Float32Array(TRIANGLE).byteLength;
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const binary = new Float32Array(TRIANGLE.length * PRIMITIVE_COUNT);
  for (let primitive = 0; primitive < PRIMITIVE_COUNT; primitive++) {
    binary.set(TRIANGLE.map(value => value + primitive), primitive * TRIANGLE.length);
    bufferViews.push({ buffer: 0, byteOffset: primitive * accessorBytes, byteLength: accessorBytes });
    accessors.push({ bufferView: primitive, componentType: 5126, count: 3, type: 'VEC3', min: [primitive, primitive, primitive], max: [primitive + 1, primitive + 1, primitive] });
    meshes.push({ primitives: [{ attributes: { POSITION: primitive } }] });
  }
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: meshes.map((mesh, index) => index) }],
    nodes: meshes.map((mesh, index) => ({ mesh: index })),
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(binary.buffer).toString('base64')}` }],
  };
  return JSON.stringify(document);
}

async function decodeWithoutConverting() {
  const document = JSON.parse(jsonOfManyPrimitives());
  const bytes = Uint8Array.from(Buffer.from(document.buffers[0].uri.split(',')[1], 'base64'));
  return decodeGltf({ document, glbBinary: null, resourceBytes: new Map([[document.buffers[0].uri, bytes]]), decoders: {}, limits: { maxInstances: 65_536 } });
}

test('decodeGltf reads no accessor until a primitive is loaded, and a loaded primitive is the same data as before', async () => {
  const decoded = await decodeWithoutConverting();
  const geometries = [];
  decoded.scene.traverse(node => {
    if (node.isMesh) geometries.push(node.geometry);
  });
  assert.equal(geometries.length, PRIMITIVE_COUNT);
  for (const geometry of geometries) assert.equal(geometry.attributes, null);
  await geometries[2].load();
  assert.deepEqual(Array.from(geometries[2].attributes.position.array), TRIANGLE.map(value => value + 2));
  assert.equal(geometries[3].attributes, null);
  assert.equal(await geometries[2].load(), await geometries[2].load());
});

test('parseGltf converts lazily decoded primitives to the same parts in order', async () => {
  const asset = await parseGltf(jsonOfManyPrimitives());
  assert.equal(asset.parts.length, PRIMITIVE_COUNT);
  asset.parts.forEach((part, index) => {
    assert.deepEqual(Array.from(part.geometry.positions.slice(0, 3)), [index, index, index]);
  });
});

test('decoded bytes over maxDecodedBytes fail before decoding and name the estimate, the budget and the option', async () => {
  // Five VEC3 accessors of three floats, plus 24 bytes a vertex for the normals the converter generates.
  const expected = PRIMITIVE_COUNT * (3 * 3 * 4 + 3 * 24);
  await assert.rejects(
    parseGltf(jsonOfManyPrimitives(), { maxDecodedBytes: expected - 1 }),
    error => error instanceof RangeError
      && error.message.includes(`decoded accessor bytes ${expected}, over maxDecodedBytes ${expected - 1}`)
      && error.message.includes(`Fix: pass { maxDecodedBytes: ${expected} }`),
  );
  const asset = await parseGltf(jsonOfManyPrimitives(), { maxDecodedBytes: expected });
  assert.equal(asset.parts.length, PRIMITIVE_COUNT);
});

test('the decoded bytes budget is one GiB by default and must be a positive integer', async () => {
  assert.equal(GLTF_CAPABILITIES.limits.maxDecodedBytes, 1024 * 1024 * 1024);
  await assert.rejects(parseGltf(jsonOfManyPrimitives(), { maxDecodedBytes: 0 }), /maxDecodedBytes must be a positive safe integer/);
});

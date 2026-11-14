import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { semverSatisfies } from '../src/pack-manifest.js';

const FLOAT = 5126;
const triangleBytes = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);

function dataUri(bytes) {
  return `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
}

/** A one-triangle glTF; `change(document)` edits the JSON before it is serialized. */
function triangleJson(change = () => {}, bytes = triangleBytes) {
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    materials: [{}],
    accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: bytes.length, uri: dataUri(bytes) }],
  };
  change(document);
  return JSON.stringify(document);
}

test('a meshopt view that no accessor uses still counts against maxDecodedBytes', async () => {
  const requestedLengths = [];
  const stubDecoder = {
    ready: Promise.resolve(),
    decodeGltfBuffer(target) {
      requestedLengths.push(target.length);
    },
  };
  const text = triangleJson(document => {
    document.extensionsUsed = ['EXT_meshopt_compression'];
    document.bufferViews.push({
      buffer: 0,
      byteLength: 4.8e9,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteLength: 16, byteStride: 12, count: 4e8, mode: 'ATTRIBUTES' } },
    });
  });
  await assert.rejects(() => parseGltf(text, { decoders: { meshopt: stubDecoder } }), /maxDecodedBytes/);
  assert.deepEqual(requestedLengths, []);
});

test('a negative meshopt view length cannot cancel a large one and no decoder runs', async () => {
  let decoderCalls = 0;
  const stubDecoder = {
    ready: Promise.resolve(),
    decodeGltfBuffer() {
      decoderCalls += 1;
    },
  };
  const meshoptView = byteLength => ({
    buffer: 0,
    byteLength,
    extensions: { EXT_meshopt_compression: { buffer: 0, byteLength: 16, byteStride: 12, count: byteLength / 12, mode: 'ATTRIBUTES' } },
  });
  const text = triangleJson(document => {
    document.extensionsUsed = ['EXT_meshopt_compression'];
    document.bufferViews.push(meshoptView(960000000), meshoptView(960000000), meshoptView(-1920000000));
  });
  await assert.rejects(() => parseGltf(text, { decoders: { meshopt: stubDecoder } }), /bufferViews\[3\]\.byteLength.*non-negative/);
  assert.equal(decoderCalls, 0);
});

test('meshopt views and accessors share one decoded budget', async () => {
  const text = triangleJson(document => {
    document.extensionsUsed = ['EXT_meshopt_compression'];
    document.bufferViews.push({
      buffer: 0,
      byteLength: 120,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteLength: 16, byteStride: 12, count: 10, mode: 'ATTRIBUTES' } },
    });
  });
  await assert.rejects(() => parseGltf(text, { maxDecodedBytes: 150, decoders: { meshopt: { ready: Promise.resolve(), decodeGltfBuffer() {} } } }), /decoded accessor bytes.*maxDecodedBytes/);
});

const danglingCases = [
  ['primitive.material out of range', document => { document.meshes[0].primitives[0].material = 5; }, /primitive\.material.*5.*0 to 0/s],
  ['primitive.material without materials', document => { document.meshes[0].primitives[0].material = 0; delete document.materials; }, /primitive\.material.*no materials/s],
  ['scene without nodes array', document => { delete document.nodes; }, /scenes\[0\]\.nodes\[0\].*no nodes/s],
  ['scene node out of range', document => { document.scenes[0].nodes = [7]; }, /scenes\[0\]\.nodes\[0\].*7/s],
  ['mesh without primitives', document => { delete document.meshes[0].primitives; }, /meshes\[0\]\.primitives/],
  ['accessor bufferView out of range', document => { document.accessors[0].bufferView = 9; }, /accessors\[0\]\.bufferView.*9/s],
  ['scene nodes not an array', document => { document.scenes[0].nodes = 5; }, /scenes\[0\]\.nodes.*array/],
  ['node null', document => { document.nodes = [null]; }, /nodes\[0\].*object/],
  ['accessor bufferView null', document => { document.accessors[0].bufferView = null; }, /accessors\[0\]\.bufferView/],
];
for (const [name, change, expected] of danglingCases) {
  test(`dangling reference is named: ${name}`, async () => {
    await assert.rejects(() => parseGltf(triangleJson(change)), error => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /Cannot read properties/);
      return true;
    });
  });
}

test('a JSON null document is rejected with a plain message', async () => {
  await assert.rejects(() => parseGltf('null'), error => /glTF JSON must be an object/.test(error.message));
});

test('a sparse accessor with float indices throws', async () => {
  const bytes = new Uint8Array(36 + 4 + 12);
  bytes.set(triangleBytes, 0);
  new Float32Array(bytes.buffer, 36, 1)[0] = 2;
  new Float32Array(bytes.buffer, 40, 3).set([9, 9, 9]);
  const text = triangleJson(document => {
    document.bufferViews.push({ buffer: 0, byteOffset: 36, byteLength: 4 }, { buffer: 0, byteOffset: 40, byteLength: 12 });
    document.accessors[0].sparse = { count: 1, indices: { bufferView: 1, componentType: FLOAT }, values: { bufferView: 2 } };
  }, bytes);
  await assert.rejects(() => parseGltf(text), /sparse.*5121, 5123 or 5125/is);
});

test('a byteStride below the element size throws', async () => {
  const text = triangleJson(document => { document.bufferViews[0].byteStride = 4; });
  await assert.rejects(() => parseGltf(text), /byteStride.*12/s);
});

test('a byteStride that is not a multiple of 4 throws', async () => {
  const bytes = new Uint8Array(64);
  const text = triangleJson(document => {
    document.bufferViews[0].byteStride = 14;
    document.bufferViews[0].byteLength = 64;
  }, bytes);
  await assert.rejects(() => parseGltf(text), /byteStride.*multiple of 4/s);
});

function texturedPart(material, geometryExtras = {}) {
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    ...geometryExtras,
  };
  return { name: 'plate', geometry, matrix: mat4.create(), material: { color: [1, 1, 1], metallic: 0, roughness: 1, ...material } };
}

const texture = { image: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) } };

test('exportGlb throws for a uvChannel 1 map without geometry.lightUvs', () => {
  assert.throws(() => exportGlb([texturedPart({ map: { ...texture, uvChannel: 1 } })]), error => error instanceof RangeError && /geometry\.lightUvs/.test(error.message));
});

test('exportGlb throws for a lightMap without geometry.lightUvs', () => {
  assert.throws(() => exportGlb([texturedPart({ lightMap: texture })]), error => error instanceof RangeError && /geometry\.lightUvs/.test(error.message));
});

test('exportGlb accepts a lightMap when geometry.lightUvs is set', () => {
  const lightUvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  assert.ok(exportGlb([texturedPart({ lightMap: texture }, { lightUvs })]).byteLength > 0);
});

test('semverSatisfies ignores prerelease and build metadata of the running version', () => {
  assert.equal(semverSatisfies('0.21.0-rc.1', '>=0.19.0'), true);
  assert.equal(semverSatisfies('0.21.0+build.5', '>=0.21.0'), true);
  assert.equal(semverSatisfies('0.21.0-rc.1+abc', '<0.21.0'), false);
  assert.equal(semverSatisfies('not-a-version', '>=0.19.0'), null);
});

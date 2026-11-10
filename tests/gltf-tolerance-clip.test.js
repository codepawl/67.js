import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

/** One triangle with normals (accessors 0 and 1) and a clip keying node 0's scale at 0 s and 1 s (accessors 2 and 3). */
function documentWithScaleClip(firstScale, lastScale, edit) {
  const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, ...firstScale, ...lastScale]);
  const bytes = new Uint8Array(floats.buffer);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Keyed', mesh: 0 }],
    meshes: [{ name: 'Tri', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 0, byteOffset: 72, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 0, byteOffset: 80, componentType: 5126, count: 2, type: 'VEC3' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
    animations: [{ samplers: [{ input: 2, output: 3, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'scale' } }] }],
  };
  edit?.(document);
  return JSON.stringify(document);
}

function partScaleAt(asset, time) {
  asset.stagePose({ animation: { clip: 0, time } }).commit();
  return asset.parts[0].matrix[0];
}

test('a node keyed to zero scale draws a speck at that pose instead of refusing the file', async () => {
  const asset = await parseGltf(documentWithScaleClip([1, 1, 1], [0, 0, 0]));
  assert.equal(partScaleAt(asset, 0), 1);
  assert.ok(partScaleAt(asset, 1) < 1e-3);
  assert.ok(partScaleAt(asset, 0.5) > 0.4);
});

test('a node that starts at zero scale shows again when a clip scales it up', async () => {
  const asset = await parseGltf(documentWithScaleClip([0, 0, 0], [1, 1, 1], document => {
    document.nodes[0].scale = [0, 0, 0];
  }));
  assert.equal(asset.parts.length, 1);
  assert.match(asset.warnings[0], /draws nothing while its scale is zero/);
  assert.ok(partScaleAt(asset, 0) < 1e-3);
  assert.equal(partScaleAt(asset, 1), 1);
});

test('a morph target with normalized int16 POSITION deltas loads and is scaled into floats', async () => {
  const asset = await parseGltf(documentWithScaleClip([1, 1, 1], [1, 1, 1], document => {
    const quantized = new Int16Array([0, 0, 32767, 0, 0, 16384, 0, 0, 0]);
    const buffer = document.buffers[0];
    const previous = Buffer.from(buffer.uri.split(',')[1], 'base64');
    const combined = Buffer.concat([previous, Buffer.from(quantized.buffer)]);
    buffer.byteLength = combined.length;
    buffer.uri = `data:application/octet-stream;base64,${combined.toString('base64')}`;
    document.bufferViews.push({ buffer: 0, byteOffset: previous.length, byteLength: 18 });
    document.accessors.push({ bufferView: 1, componentType: 5122, normalized: true, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 32767] });
    document.meshes[0].primitives[0].targets = [{ POSITION: 4 }];
  }));
  const deltas = asset.parts[0].geometry.morphTargets[0].positions;
  assert.equal(deltas[2], 1);
  assert.ok(Math.abs(deltas[5] - 16384 / 32767) < 1e-6);
});

test('a skin joint at zero scale loads with a warning and the skinned vertices collapse instead of refusing the file', async () => {
  const asset = await parseGltf(skinnedStripAsset(document => {
    document.nodes[3].scale = [0, 0, 0];
  }));
  assert.equal(asset.parts.length, 1);
  assert.ok(asset.warnings.some(warning => /joint with zero or non-finite scale/.test(warning)));
  assert.ok(asset.parts[0].skin.jointMatrices.every(Number.isFinite));
});

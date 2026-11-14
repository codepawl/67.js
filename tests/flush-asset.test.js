import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene } from '../src/agent-scene.js';
import { agentSceneModulesNeeded, loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { flushOrderOf } from '../src/depth-layer.js';

const ASSET_ID = 'ef'.repeat(32);
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;

// An upward-facing square of `size` metres at height `height`, as glTF vertex data.
function squareData(size, height) {
  const half = size / 2;
  return {
    positions: new Float32Array([-half, height, -half, -half, height, half, half, height, half, half, height, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

// A glb with one mesh node per square, so a floor and a plaque `gap` metres above it become two parts of one asset.
function glbOfSquares(squares) {
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: squares.map((_, index) => index) }],
    nodes: squares.map((_, index) => ({ name: `Square${index}`, mesh: index })),
    meshes: [], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
    accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  };
  const chunks = [];
  let length = 0;
  function append(data, componentType, type) {
    document.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength });
    document.accessors.push({ bufferView: document.bufferViews.length - 1, componentType, count: data.length / (type === 'VEC3' ? 3 : 1), type });
    chunks.push([length, new Uint8Array(data.buffer)]);
    length += Math.ceil(data.byteLength / 4) * 4;
    return document.accessors.length - 1;
  }
  for (const { positions, normals, indices } of squares) {
    document.meshes.push({ primitives: [{ attributes: { POSITION: append(positions, FLOAT, 'VEC3'), NORMAL: append(normals, FLOAT, 'VEC3') }, indices: append(indices, UNSIGNED_SHORT, 'SCALAR'), material: 0 }] });
  }
  document.buffers[0].byteLength = length;
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const glb = new ArrayBuffer(28 + jsonLength + length);
  const header = new DataView(glb);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, glb.byteLength, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(glb);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  header.setUint32(20 + jsonLength, length, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  for (const [start, chunk] of chunks) bytes.set(chunk, 28 + jsonLength + start);
  return glb;
}

function facadeAsset(gap) {
  return glbOfSquares([squareData(2, 0), squareData(0.5, gap)]);
}

function recipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [], materials: [],
    nodes: [{ id: 'building', asset: { id: ASSET_ID } }],
  };
}

async function sceneWith(gap, environment) {
  const assets = new Map([[assetCopyKey(ASSET_ID, 0), await parseGltf(facadeAsset(gap))]]);
  const source = recipe();
  if (environment) source.environment = environment;
  await loadAgentSceneModules(source);
  return createAgentScene(source, {}, { assets });
}

import { resolveFlushParts } from "../src/coplanar-overlap.js";
function partWithOrder(scene) {
  return scene.parts.find(part => flushOrderOf(part));
}

test('a recipe that places an asset loads the flush code, one of plain primitives does not', () => {
  assert.ok(agentSceneModulesNeeded(recipe()).includes('coplanar'));
  assert.deepEqual(agentSceneModulesNeeded({ geometries: [{ id: 'cube', type: 'box' }], nodes: [{ id: 'part', geometry: 'cube' }] }), []);
});

test('a glTF plaque half a millimetre above its floor has the floor cut under it', async () => {
  const scene = await sceneWith(0.0005);
  const floor = partWithOrder(scene);
  assert.ok(floor, 'the flush pass handles an asset part');
  assert.equal(floor.name, 'building/0');
  assert.ok(flushOrderOf(floor).geometry, 'the hidden floor draws a cut copy');
  assert.equal(scene.parts[1].geometry.indices.length, 6, 'the plaque keeps its geometry');
});

test('a glTF plaque 1.5 mm above its floor is ranked above it and not cut', async () => {
  const scene = await sceneWith(0.0015);
  const plaque = partWithOrder(scene);
  assert.ok(plaque, 'the flush pass handles an asset part');
  assert.equal(plaque.name, 'building/1');
  const order = flushOrderOf(plaque);
  assert.equal(order.geometry, undefined);
  assert.equal(Math.max(...order.ranges.map(range => range.rank)), 1);
});

test('resolveCoplanar false leaves an asset alone and reports the pair instead', async () => {
  const scene = await sceneWith(0.0005, { resolveCoplanar: false });
  assert.equal(partWithOrder(scene), undefined);
  const kinds = (scene.inspect().diagnostics ?? []).map(entry => entry.kind);
  assert.ok(kinds.includes('coplanar-overlap'));
});

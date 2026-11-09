import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey, recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { groupParts } from '../src/renderer.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

const ASSET_ID = 'ab'.repeat(32);
const OTHER_ID = 'cd'.repeat(32);

await loadAllAgentSceneModules();

async function strip(withName = true) {
  return parseGltf(skinnedStripAsset(document => {
    if (withName) document.materials[0].name = 'Skin';
  }));
}

async function loadedAssets(copies = 1) {
  const assets = new Map();
  for (const id of [ASSET_ID, OTHER_ID]) {
    for (let copy = 0; copy < copies; copy++) assets.set(assetCopyKey(id, copy), await strip());
  }
  return assets;
}

function recipe(nodes) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [{ id: 'floor', geometry: 'ground', material: 'grass', scale: [20, 0.1, 20] }, ...nodes],
  };
}

test('ten placements of one asset share geometry, material and a draw batch', async () => {
  const nodes = Array.from({ length: 10 }, (_, index) => ({ id: `tree-${index}`, translation: [index * 2, 0, 0], asset: { id: ASSET_ID } }));
  nodes.push({ id: 'other', asset: { id: OTHER_ID } });
  const scene = createAgentScene(recipe(nodes), {}, { assets: await loadedAssets() });
  const placed = scene.parts.filter(part => part.name.startsWith('tree-'));
  assert.equal(placed.length, 10);
  assert.equal(new Set(placed.map(part => part.geometry)).size, 1);
  assert.equal(new Set(placed.map(part => part.material)).size, 1);
  assert.equal(new Set(placed.map(part => part.skin)).size, 1);
  assert.equal(placed[3].matrix[12], 6 + 1, 'the placement translation composes with the asset part matrix');
  const batches = groupParts(scene.parts);
  assert.equal(batches.length, 3, 'ground, ten copies, and the other asset');
  assert.equal(batches.find(batch => batch.length === 10).length, 10);
  const report = scene.inspect({ includeBounds: true });
  assert.equal(report.assets.length, 11);
  assert.equal(report.assets[0].assetId, ASSET_ID);
  assert.deepEqual(report.assets[0].clips.map(clip => clip.name), ['Bend', 'Move']);
  assert.deepEqual(report.assets[0].materials, ['Skin']);
  assert.ok(report.assets[0].bounds.max[1] > report.assets[0].bounds.min[1]);
  assert.equal(report.nodes.length, 12, 'generated part nodes stay out of the node list');
  assert.equal(scene.exportRecipe().nodes.length, 12);
  assert.equal(scene.exportRecipe().geometries.length, 1);
});

test('material overrides name the source material and stay shared between placements', async () => {
  const nodes = [
    { id: 'red-a', asset: { id: ASSET_ID, materials: [{ name: 'Skin', color: [1, 0, 0] }] } },
    { id: 'red-b', asset: { id: ASSET_ID, materials: [{ name: 'Skin', color: [1, 0, 0] }] } },
    { id: 'plain', asset: { id: ASSET_ID } },
  ];
  const scene = createAgentScene(recipe(nodes), {}, { assets: await loadedAssets() });
  const material = id => scene.parts.find(part => part.name === `${id}/0`).material;
  assert.deepEqual(Array.from(material('red-a').color), [1, 0, 0]);
  assert.equal(material('red-a'), material('red-b'));
  assert.notEqual(material('red-a'), material('plain'));
  assert.throws(() => createAgentScene(recipe([{ id: 'bad', asset: { id: ASSET_ID, materials: [{ name: 'Nope', color: [1, 0, 0] }] } }]), {}, { assets: new Map([[assetCopyKey(ASSET_ID, 0), null]]) }), /not loaded/);
  await assert.rejects(async () => createAgentScene(recipe([{ id: 'bad', asset: { id: ASSET_ID, materials: [{ name: 'Nope', color: [1, 0, 0] }] } }]), {}, { assets: await loadedAssets() }), /^RangeError: nodes\[1\]\.asset\.materials\[0\]\.name: got "Nope"; expected one of "Skin"/);
});

test('a placed clip plays on its own time offset and a seek gives the same frame', async () => {
  const nodes = [
    { id: 'walker', translation: [3, 0, 0], asset: { id: ASSET_ID, clip: { index: 0, start: 0.5 } } },
    { id: 'late', asset: { id: ASSET_ID, clip: { index: 0, start: 2 } } },
    { id: 'still', asset: { id: ASSET_ID } },
  ];
  const needs = recipeAssetNeeds(recipe(nodes));
  assert.deepEqual(needs, [{ id: ASSET_ID, copies: 3 }]);
  const scene = createAgentScene(recipe(nodes), {}, { assets: await loadedAssets(3) });
  const joints = id => Array.from(scene.parts.find(part => part.name === `${id}/0`).skin.jointMatrices);
  const restJoints = joints('still');
  assert.deepEqual(joints('walker'), restJoints, 'before its start the clip holds its first frame');
  scene.sampleMotion(1);
  const walkerAtOne = joints('walker');
  assert.notDeepEqual(walkerAtOne, restJoints);
  assert.deepEqual(joints('late'), restJoints, 'the later placement has not started');
  assert.deepEqual(joints('still'), restJoints);
  scene.sampleMotion(0);
  scene.sampleMotion(1);
  assert.deepEqual(joints('walker'), walkerAtOne);
  assert.equal(scene.parts.find(part => part.name === 'walker/0').matrix[12], 3 + 1);
});

test('placements are bounded and need their assets', async () => {
  const many = Array.from({ length: 513 }, (_, index) => ({ id: `n${index}`, asset: { id: ASSET_ID } }));
  assert.throws(() => createAgentScene(recipe(many), {}, { assets: new Map() }), /at most 512/);
  assert.throws(() => createAgentScene(recipe([{ id: 'x', asset: { id: ASSET_ID } }])), /places catalog assets/);
  assert.throws(() => createAgentScene(recipe([{ id: 'x', geometry: 'ground', material: 'grass', asset: { id: ASSET_ID } }]), {}, { assets: new Map() }), /group/);
  assert.throws(() => createAgentScene(recipe([{ id: 'x', asset: { id: 'short' } }]), {}, { assets: new Map() }), /64 hexadecimal/);
});

test('apply can add and remove placed assets', async () => {
  const scene = createAgentScene(recipe([]), {}, { assets: await loadedAssets() });
  scene.apply([{ type: 'add-node', node: { id: 'late-tree', translation: [2, 0, 0], asset: { id: ASSET_ID } } }], { expectedRevision: 0 });
  assert.equal(scene.parts.filter(part => part.name.startsWith('late-tree')).length, 1);
  scene.apply([{ type: 'set-node', id: 'late-tree', translation: [5, 0, 0] }], { expectedRevision: 1 });
  assert.equal(scene.parts.find(part => part.name === 'late-tree/0').matrix[12], 6);
  scene.apply([{ type: 'remove-node', id: 'late-tree' }], { expectedRevision: 2 });
  assert.equal(scene.parts.filter(part => part.name.startsWith('late-tree')).length, 0);
});

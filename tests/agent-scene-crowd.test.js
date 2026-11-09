import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules, agentSceneModulesNeeded } from '../src/agent-scene.js';
import { assetCopyKey, recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { groupParts } from '../src/renderer.js';

await loadAllAgentSceneModules();

const ASSET_ID = 'ef'.repeat(32);
const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));

async function loadRobot() {
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
}

function recipe(crowd, nodes = []) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    camera: { eye: [0, 3, 14], target: [0, 1, 0] },
    nodes: [
      { id: 'floor', geometry: 'ground', material: 'grass', scale: [40, 0.1, 40] },
      { id: 'people', asset: { id: ASSET_ID, crowd } },
      ...nodes,
    ],
  };
}

async function crowdScene(crowd, nodes) {
  const robot = await loadRobot();
  const walking = robot.animations.findIndex(animation => animation.name === 'Walking');
  const settings = { clip: walking, count: 40, seed: 5, spacing: 2, ...crowd };
  const assets = new Map([[assetCopyKey(ASSET_ID, 0), await loadRobot()], [assetCopyKey(ASSET_ID, 1), robot]]);
  return createAgentScene(recipe(settings, nodes), {}, { assets });
}

const crowdBlends = scene => scene.parts.filter(part => part.crowd).map(part => Array.from(part.assembly.offset));

test('a crowd field loads on the crowd marker and reserves one decoded copy', () => {
  const placed = recipe({ clip: 0, count: 3 });
  assert.ok(agentSceneModulesNeeded(placed).includes('crowd'));
  assert.deepEqual(recipeAssetNeeds(placed), [{ id: ASSET_ID, copies: 2 }]);
});

test('a crowd draws as one batch per material however many people it has, and scene_inspect reports it', async () => {
  const scene = await crowdScene({ count: 40 });
  const report = scene.inspect();
  const crowd = report.assets.find(entry => entry.kind === 'crowd');
  assert.equal(crowd.instances, 40);
  assert.equal(crowd.parts, 40 * crowd.batches);
  assert.equal(groupParts(scene.parts).length, crowd.batches + 1, 'the crowd batches and the ground');
  assert.ok(crowd.paletteBytes > 0 && crowd.boundsRadius > 0 && crowd.frames > 2);
  assert.equal(report.nodes.length, 2, 'generated part nodes stay out of the node list');
  assert.equal(scene.exportRecipe().nodes.length, 2);
  assert.equal(scene.exportRecipe().nodes[1].asset.crowd.count, 40);
});

test('a crowd frame reached by seeking equals the one reached by playing, near and far', async () => {
  const scene = await crowdScene({ count: 30, farDistance: 6, farRate: 4 });
  scene.sampleMotion(1.7);
  const sought = crowdBlends(scene);
  scene.sampleMotion(0);
  for (let step = 1; step <= 17; step++) scene.sampleMotion(step * 0.1);
  assert.deepEqual(crowdBlends(scene), sought);
  scene.sampleMotion(4);
  scene.sampleMotion(1.7);
  assert.deepEqual(crowdBlends(scene), sought, 'seeking backwards gives the same frame');
});

test('far instances change pose only farRate times a second while near ones change every frame', async () => {
  const scene = await crowdScene({ count: 60, spacing: 2, farDistance: 8, farRate: 2, rateJitter: 0 });
  const crowdParts = scene.parts.filter(part => part.crowd);
  const perInstance = crowdParts.length / 60;
  const distinctPoses = Array.from({ length: 60 }, () => new Set());
  for (let step = 0; step <= 20; step++) {
    scene.sampleMotion(1 + step * 0.05);
    for (let index = 0; index < 60; index++) distinctPoses[index].add(crowdParts[index * perInstance].assembly.offset.join());
  }
  let farCount = 0;
  let nearCount = 0;
  for (let index = 0; index < 60; index++) {
    const matrix = crowdParts[index * perInstance].matrix;
    const far = Math.hypot(matrix[12], matrix[13] - 3, matrix[14] - 14) > 8;
    if (far) {
      farCount++;
      assert.ok(distinctPoses[index].size <= 3, `a far person shows at most 3 poses in one second, not ${distinctPoses[index].size}`);
    } else {
      nearCount++;
      assert.ok(distinctPoses[index].size >= 15, 'a near person changes pose nearly every step');
    }
  }
  assert.ok(farCount > 0 && nearCount > 0, 'the field has near and far people');
});

test('crowd settings are validated and the clip must exist', async () => {
  await assert.rejects(crowdScene({ count: 0 }), /count/);
  await assert.rejects(crowdScene({ bogus: 1 }), /crowd\.bogus: got 1; expected a known field/);
  await assert.rejects(crowdScene({ farDistance: 5 }), /crowd\.farRate: got undefined; expected both farDistance and farRate, or neither/);
  await assert.rejects(crowdScene({ clip: 99 }), /nodes\.people\.asset\.crowd\.clip: got 99; expected a clip index from 0 to 13/);
});

test('a crowd keeps its baked parts across an edit that does not touch it', async () => {
  const scene = await crowdScene({ count: 10 });
  const before = scene.parts.filter(part => part.crowd);
  scene.apply([{ type: 'add-node', node: { id: 'marker', translation: [0, 1, 0] } }], { expectedRevision: 0 });
  const after = scene.parts.filter(part => part.crowd);
  assert.equal(after.length, before.length);
  assert.ok(after.every((part, index) => part === before[index]));
});

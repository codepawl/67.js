import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene, loadPhysicsEngine, needsPhysics } from '../src/agent-scene.js';
import { loadAllAgentSceneModules } from '../src/agent-scene-modules.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { parseGltf } from '../src/gltf.js';
import { walkerRecipe } from '../bench/agent-modeling/walker.mjs';

await loadPhysicsEngine();
await loadAllAgentSceneModules();

const ASSET_ID = 'ab'.repeat(32);
const FLOOR_NODE = { id: 'floor', geometry: 'slab', material: 'cloth', translation: [0, -0.25, 0], scale: [8, 0.5, 8] };

function ragdollWalker(physics = {}) {
  const recipe = walkerRecipe();
  delete recipe.motion;
  recipe.geometries.push({ id: 'slab', type: 'box' });
  recipe.nodes.push(FLOOR_NODE);
  recipe.armatures[0].translation = [0, 1, 0];
  recipe.physics = { duration: 4, bodies: [{ node: 'floor', type: 'fixed' }], ragdoll: { armature: 'rig' }, ...physics };
  return recipe;
}

function snapshot(scene) {
  return scene.parts.map(part => [Array.from(part.matrix), part.skin ? Array.from(part.skin.jointMatrices) : null]);
}

function lowestJointHeight(scene) {
  const heights = scene.parts.filter(part => part.skin).flatMap(part => Array.from({ length: part.skin.jointWorldMatrices.length / 16 }, (unused, joint) => part.skin.jointWorldMatrices[joint * 16 + 13]));
  return Math.min(...heights);
}

test('a ragdoll on a preset armature falls, lies on the floor and reports numbers', () => {
  const scene = createAgentScene(ragdollWalker());
  const standing = snapshot(scene);
  scene.sampleMotion(4);
  const collapsed = snapshot(scene);
  assert.notDeepEqual(collapsed, standing);
  const report = scene.inspect({}).physics.ragdoll;
  assert.ok(report.bones >= 15, `bones ${report.bones}`);
  assert.ok(report.lowestY > -0.05 && report.lowestY < 0.2, `lowest ${report.lowestY}`);
  assert.ok(report.highestY < 1.2, `a 1.8 m figure lying down stays below 1.2 m, got ${report.highestY}`);
  assert.ok(report.restsAtTime !== null && report.restsAtTime < 4, `rests at ${report.restsAtTime}`);
  assert.ok(lowestJointHeight(scene) > -0.8, `no joint falls through the floor, lowest ${lowestJointHeight(scene)}`);
});

test('a seek to the same time gives the same bytes in any order', () => {
  const scene = createAgentScene(ragdollWalker());
  scene.sampleMotion(1.5);
  const first = snapshot(scene);
  scene.sampleMotion(4);
  scene.sampleMotion(0.2);
  scene.sampleMotion(1.5);
  assert.deepEqual(snapshot(scene), first);
  const again = createAgentScene(ragdollWalker());
  again.sampleMotion(1.5);
  assert.deepEqual(snapshot(again), first, 'a second bake of the same recipe matches');
  scene.sampleMotion(0);
  assert.deepEqual(snapshot(scene), snapshot(createAgentScene(ragdollWalker())), 'time zero is the authored pose');
});

test('the ragdoll bake is reused until the rig changes', () => {
  const scene = createAgentScene(ragdollWalker());
  const before = scene.inspect({}).physics;
  scene.apply([{ type: 'set-node', id: 'floor', translation: [0, -0.25, 0] }], { expectedRevision: 0 });
  assert.deepEqual(scene.inspect({}).physics, before);
});

test('a scene without physics never loads the ragdoll code path', () => {
  assert.equal(needsPhysics(walkerRecipe()), false);
  assert.equal(needsPhysics(ragdollWalker()), true);
});

test('bad ragdoll sections fail with a message that names the fix', () => {
  const cases = [
    [{ ragdoll: { armature: 'missing' } }, /^RangeError: physics\.ragdoll\.armature: got "missing"; expected the ID of a recipe armature, one of rig/],
    [{ ragdoll: {} }, /^RangeError: physics\.ragdoll\.armature: got undefined; expected the ID of a recipe armature, one of rig/],
    [{ ragdoll: { armature: 'rig', color: 1 } }, /^TypeError: physics\.ragdoll\.color: got 1; expected no such field; use one of armature, density/],
    [{ ragdoll: { armature: 'rig', density: 0 } }, /density/],
    [{ ragdoll: { armature: 'rig', layer: 16 } }, /layer/],
    [{ ragdoll: { armature: 'rig', friction: -1 } }, /friction/],
    [{ ragdoll: 'rig' }, /plain object/],
    [{ ragdoll: null }, /plain object/],
    [{ ragdoll: { armature: 'rig' }, bodies: 3 }, /array/],
  ];
  for (const [physics, message] of cases) {
    assert.throws(() => createAgentScene(ragdollWalker(physics)), message);
  }
});

test('a bone cannot have both a ragdoll and a pose track', () => {
  const recipe = ragdollWalker();
  recipe.motion = { duration: 1, tracks: [{ kind: 'node', id: 'leftUpperLeg', property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 1, value: [0, 0, 0, 1] }] }] };
  assert.throws(() => createAgentScene(recipe), /^RangeError: physics\.ragdoll\.armature: got "rig"; expected an armature whose bones have no motion translation or rotation track, but leftUpperLeg has one; pick the track or the ragdoll/);
});

test('an armature larger than the bone limit is refused before the solver runs', () => {
  const recipe = ragdollWalker();
  const bones = Array.from({ length: 60 }, (unused, index) => ({ name: `b${index}`, parent: index === 0 ? null : `b${index - 1}`, head: [0, index * 0.05, 0] }));
  recipe.armatures = [{ id: 'rig', bones }];
  recipe.nodes = recipe.nodes.filter(node => !node.skin);
  assert.throws(() => createAgentScene(recipe), /1 to 48 bones/);
});

test('a bone with no length is refused', () => {
  const recipe = ragdollWalker();
  recipe.armatures = [{ id: 'rig', bones: [{ name: 'root', parent: null, head: [0, 0, 0], tail: [0, 0, 0] }] }];
  recipe.nodes = recipe.nodes.filter(node => !node.skin);
  assert.throws(() => createAgentScene(recipe), /no length/);
});

const robotBytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));

async function robotScene(physics, root = { translation: [0, 2, 0] }) {
  const asset = await parseGltf(robotBytes.buffer.slice(robotBytes.byteOffset, robotBytes.byteOffset + robotBytes.byteLength), { maxVertices: 500000 });
  return createAgentAssetScene(asset, { format: '67js.asset', schemaVersion: 1, assetId: ASSET_ID, root, physics });
}

test('an imported robot ragdolls onto the floor and seeks to the same pose', async () => {
  const scene = await robotScene({ duration: 4, ragdoll: {} });
  scene.sampleMotion(0);
  const standing = snapshot(scene);
  scene.sampleMotion(1.2);
  const falling = snapshot(scene);
  scene.sampleMotion(4);
  const collapsed = snapshot(scene);
  assert.notDeepEqual(collapsed, standing);
  scene.sampleMotion(1.2);
  assert.deepEqual(snapshot(scene), falling);
  const report = scene.inspect({}).physics;
  assert.ok(report.ragdoll.lowestY > -0.05, `lowest ${report.ragdoll.lowestY}`);
  assert.ok(report.ragdoll.highestY < 2, `highest ${report.ragdoll.highestY}`);
  assert.equal(scene.exportRecipe().physics.ragdoll.constructor, Object);
});

test('asset physics refuses unknown fields and a missing ragdoll', async () => {
  for (const physics of [{ duration: 2 }, { duration: 2, ragdoll: { color: 1 } }, { duration: 0, ragdoll: {} }, { duration: 2, bodies: [], ragdoll: {} }]) {
    await assert.rejects(robotScene(physics));
  }
});

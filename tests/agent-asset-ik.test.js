import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { clipFromGltfAnimation, createAssetPose } from '../src/skeleton-pose.js';

const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
const ASSET_ID = 'ab'.repeat(32);
const ARM_TARGET = [-1.3, 2.1, 0.8];

function loadRobot() {
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
}

function nodeId(asset, name) {
  const node = asset.nodes.find(candidate => candidate.name === name);
  assert.ok(node, `no node ${name}`);
  return node.id;
}

function armSolver(asset, target = ARM_TARGET) {
  return {
    type: 'two-bone', root: nodeId(asset, 'UpperArmR'), middle: nodeId(asset, 'LowerArmR'), end: nodeId(asset, 'Palm2R'),
    target, keepEndRotation: false,
  };
}

function assetScene(asset, motion, extra = {}) {
  return createAgentAssetScene(asset, { format: '67js.asset', schemaVersion: 1, assetId: ASSET_ID, motion, ...extra });
}

const partIndex = (asset, name) => asset.parts.findIndex(part => part.name === name);
const matrixOf = (scene, index) => Array.from(scene.parts[index].matrix);
const matrixDistance = (first, second) => Math.max(...first.map((value, index) => Math.abs(value - second[index])));

/** The same solve through the code API, as an independent reference for the part matrices. */
async function referenceAsset(layers, solverFor) {
  const asset = await loadRobot();
  const pose = createAssetPose(asset, { layers: layers(asset), ik: [solverFor(asset)] });
  return { asset, pose };
}

test('an imported character reaches a point, and every part agrees with the code API', async () => {
  const asset = await loadRobot();
  const scene = assetScene(asset, { duration: 1, tracks: [], ik: [armSolver(asset)] });
  scene.sampleMotion(0);
  const reference = await referenceAsset(() => [], candidate => ({
    type: 'two-bone', root: 'UpperArmR', middle: 'LowerArmR', end: 'Palm2R', target: ARM_TARGET, keepEndRotation: false,
  }));
  reference.pose.apply(0);
  assert.equal(reference.pose.ikResults[0].reached, true);
  asset.parts.forEach((part, index) => {
    const distance = matrixDistance(matrixOf(scene, index), Array.from(reference.asset.parts[index].matrix));
    assert.ok(distance < 1e-3, `${part.name}: ${distance}`);
  });
  const [report] = scene.inspect({ kind: 'hierarchy', limit: 1 }).motionIk;
  assert.equal(report.reached, true);
  assert.ok(report.worstError < 1e-3);
});

test('IK runs on top of the selected clip, which still drives the rest of the body', async () => {
  const asset = await loadRobot();
  const idle = asset.animations.findIndex(animation => animation.name === 'Idle');
  const scene = assetScene(asset, { duration: 1, tracks: [], ik: [armSolver(asset)] }, { animation: { clip: idle, time: 0.5 } });
  scene.sampleMotion(0);
  const reference = await loadRobot();
  reference.applyAnimation(0.5, idle);
  const leg = partIndex(reference, 'LegL');
  assert.ok(matrixDistance(matrixOf(scene, leg), Array.from(reference.parts[leg].matrix)) < 1e-3, 'the leg stays on the clip');
  const arm = partIndex(reference, 'ArmR');
  assert.ok(matrixDistance(matrixOf(scene, arm), Array.from(reference.parts[arm].matrix)) > 1e-2, 'the arm left the clip');
});

test('a changed clip time moves the base pose under IK, with the arm still on target', async () => {
  const asset = await loadRobot();
  const walking = asset.animations.findIndex(animation => animation.name === 'Walking');
  const scene = assetScene(asset, { duration: 1, tracks: [], ik: [armSolver(asset)] }, { animation: { clip: walking, time: 0 } });
  const leg = partIndex(asset, 'LegL');
  scene.sampleFrame({ animation: { clip: walking, time: 0.2 }, motionTime: 0 });
  const early = matrixOf(scene, leg);
  scene.sampleFrame({ animation: { clip: walking, time: 0.7 }, motionTime: 0 });
  assert.ok(matrixDistance(early, matrixOf(scene, leg)) > 1e-3, 'the walk still moves the legs');
  const reference = await referenceAsset(candidate => [{ clip: clipFromGltfAnimation(candidate.animations[walking]) }], () => ({
    type: 'two-bone', root: 'UpperArmR', middle: 'LowerArmR', end: 'Palm2R', target: ARM_TARGET, keepEndRotation: false,
  }));
  reference.pose.apply(0.7);
  assert.equal(reference.pose.ikResults[0].reached, true);
  const hand = partIndex(asset, 'ArmR');
  assert.ok(matrixDistance(matrixOf(scene, hand), Array.from(reference.asset.parts[hand].matrix)) < 1e-2);
});

test('keyframed targets seek both ways, and clearing motion restores the base pose', async () => {
  const asset = await loadRobot();
  const arm = partIndex(asset, 'ArmR');
  const before = assetScene(await loadRobot(), null);
  const baseMatrix = matrixOf(before, arm);
  const scene = assetScene(asset, {
    duration: 2, tracks: [],
    ik: [armSolver(asset, { keyframes: [{ time: 0, value: [-1.3, 2.1, 0.8] }, { time: 2, value: [-1.2, 1.7, 1] }] })],
  });
  scene.sampleMotion(1);
  const middle = matrixOf(scene, arm);
  scene.sampleMotion(2);
  assert.ok(matrixDistance(middle, matrixOf(scene, arm)) > 1e-2, 'the arm follows the target');
  scene.sampleMotion(1);
  assert.ok(matrixDistance(middle, matrixOf(scene, arm)) < 1e-5);
  scene.sampleMotion(null);
  assert.ok(matrixDistance(baseMatrix, matrixOf(scene, arm)) < 1e-5);
});

test('inspecting does not disturb the published pose', async () => {
  const asset = await loadRobot();
  const scene = assetScene(asset, { duration: 2, tracks: [], ik: [armSolver(asset)] });
  scene.sampleMotion(1);
  const before = scene.parts.map(part => Array.from(part.matrix));
  const report = scene.inspect({ kind: 'hierarchy', limit: 1 }).motionIk;
  assert.equal(report.length, 1);
  scene.parts.forEach((part, index) => assert.deepEqual(Array.from(part.matrix), before[index]));
});

test('an unreachable target is reported, with when it is worst', async () => {
  const asset = await loadRobot();
  const scene = assetScene(asset, {
    duration: 2, tracks: [],
    ik: [armSolver(asset, { keyframes: [{ time: 0, value: ARM_TARGET }, { time: 2, value: [-20, 2, 0] }] })],
  });
  const [report] = scene.inspect({ kind: 'hierarchy', limit: 1 }).motionIk;
  assert.equal(report.reached, false);
  assert.equal(report.atTime, 2);
  assert.ok(report.worstError > 10);
});

test('targets are in world space, under the asset root', async () => {
  const shift = [5, 0, 0];
  const asset = await loadRobot();
  const moved = ARM_TARGET.map((value, axis) => value + shift[axis]);
  const scene = assetScene(asset, { duration: 1, tracks: [], ik: [armSolver(asset, moved)] }, { root: { translation: shift } });
  const [report] = scene.inspect({ kind: 'hierarchy', limit: 1 }).motionIk;
  assert.equal(report.reached, true, `error ${report.worstError}`);
});

test('a target can follow a node of the character, and aim takes worldForward', async () => {
  const asset = await loadRobot();
  const scene = assetScene(asset, {
    duration: 1, tracks: [],
    ik: [{ type: 'aim', joint: nodeId(asset, 'Head'), worldForward: [0, 0, 1], target: [2, 3, 4] }],
  });
  const headPart = partIndex(asset, 'Head_2');
  const rest = await loadRobot();
  const restPose = createAssetPose(rest);
  restPose.apply(0);
  const [report] = scene.inspect({ kind: 'hierarchy', limit: 1 }).motionIk;
  assert.equal(report.reached, true);
  scene.sampleMotion(0);
  assert.ok(matrixDistance(matrixOf(scene, headPart), Array.from(rest.parts[headPart].matrix)) > 1e-2, 'the head turned');
  const following = assetScene(await loadRobot(), {
    duration: 1, tracks: [],
    ik: [armSolver(asset, { node: nodeId(asset, 'Head') })],
  });
  assert.ok(following.inspect({ kind: 'hierarchy', limit: 1 }).motionIk[0].worstError < 2);
});

test('asset IK mistakes say what to pass', async () => {
  const asset = await loadRobot();
  const motion = ik => ({ duration: 1, tracks: [], ik });
  assert.throws(() => assetScene(asset, motion([{ ...armSolver(asset), root: 'node-99999' }])), /root: got "node-99999"; expected a node ID in this recipe/);
  const feet = { type: 'two-bone', root: nodeId(asset, 'UpperLegL'), middle: nodeId(asset, 'LowerLegL'), end: nodeId(asset, 'FootL'), target: [0, 0, 0] };
  assert.throws(() => assetScene(asset, motion([feet])), /end must descend from middle/);
  assert.throws(() => assetScene(asset, motion([armSolver(asset)]), { root: { scale: [1, 2, 1] } }), /uniform asset root scale/);
});

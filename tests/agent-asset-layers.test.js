import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { InterpolateDiscrete, NumberKeyframeTrack } from 'three';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { clipFromGltfAnimation, createAssetPose, morphClipFromGltfAnimation } from '../src/skeleton-pose.js';

// A real character: CC0 RobotExpressive. Its clips Walking and Wave move different limbs, and every clip also animates
// the face through morph weights on three head meshes.
const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
const ASSET_ID = 'cd'.repeat(32);

function loadRobot() {
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
}

function clipIndex(asset, name) {
  const index = asset.animations.findIndex(animation => animation.name === name);
  assert.ok(index >= 0, `no clip ${name}`);
  return index;
}

function assetScene(asset, motion) {
  return createAgentAssetScene(asset, { format: 'crucible.asset', schemaVersion: 1, assetId: ASSET_ID, motion });
}

function walkAndWave(asset, extraWave = {}) {
  return {
    duration: 2,
    loop: true,
    layers: [
      { clip: clipIndex(asset, 'Walking') },
      { clip: clipIndex(asset, 'Wave'), mask: { joints: ['UpperArmR'] }, morph: false, ...extraWave },
    ],
  };
}

const matrices = scene => scene.parts.map(part => Array.from(part.matrix));
const matrixDistance = (first, second) => Math.max(...first.map((value, index) => Math.abs(value - second[index])));

function changedParts(before, after) {
  return before.map((matrix, index) => index).filter(index => matrixDistance(before[index], after[index]) > 1e-4);
}

async function sampledMatrices(motion, time) {
  const asset = await loadRobot();
  const scene = assetScene(asset, motion);
  scene.sampleMotion(time);
  return matrices(scene);
}

test('a wave layer masked to the right arm leaves every other part walking', async () => {
  const asset = await loadRobot();
  const time = 0.4;
  const walkOnly = await sampledMatrices({ duration: 2, loop: true, layers: [{ clip: clipIndex(asset, 'Walking') }] }, time);
  const both = await sampledMatrices(walkAndWave(asset), time);
  const names = asset.parts.map(part => part.name);
  const changed = changedParts(walkOnly, both).map(index => names[index]);
  assert.deepEqual(changed, ['ArmR']);
  assert.ok(matrixDistance(walkOnly[names.indexOf('ArmR')], both[names.indexOf('ArmR')]) > 1, 'the arm waves instead of swinging');
  const walkingLegs = ['LegL', 'LegR', 'LowerLegL_1', 'LowerLegR_1', 'FootL_1', 'FootR_1'].map(name => names.indexOf(name));
  const restPose = await sampledMatrices({ duration: 2, loop: true, layers: [{ clip: clipIndex(asset, 'Walking'), weight: 0 }] }, time);
  assert.ok(walkingLegs.every(index => matrixDistance(restPose[index], both[index]) > 0.1), 'the legs are walking');
});

test('the layered pose matches the code API for every part', async () => {
  const asset = await loadRobot();
  const time = 0.7;
  const scene = assetScene(asset, walkAndWave(asset));
  scene.sampleMotion(time);
  const reference = await loadRobot();
  const pose = createAssetPose(reference, {
    layers: [
      { clip: clipFromGltfAnimation(reference.animations[clipIndex(reference, 'Walking')], { loop: true }), morphs: morphClipFromGltfAnimation(reference.animations[clipIndex(reference, 'Walking')], { loop: true }) },
      { clip: clipFromGltfAnimation(reference.animations[clipIndex(reference, 'Wave')], { loop: true }), mask: { joints: ['UpperArmR'] } },
    ],
  });
  pose.apply(time);
  scene.parts.forEach((part, index) => {
    const distance = matrixDistance(Array.from(part.matrix), Array.from(reference.parts[index].matrix));
    assert.ok(distance < 1e-3, `${asset.parts[index].name}: ${distance}`);
  });
});

test('seeking gives the same pose as playing: the same time twice is identical', async () => {
  const asset = await loadRobot();
  const scene = assetScene(asset, walkAndWave(asset));
  scene.sampleMotion(0.4);
  const first = matrices(scene);
  const firstWeights = scene.parts.map(part => part.morph && Array.from(part.morph.weights));
  scene.sampleMotion(1.3);
  scene.sampleMotion(0.1);
  scene.sampleMotion(0.4);
  assert.deepEqual(matrices(scene), first);
  assert.deepEqual(scene.parts.map(part => part.morph && Array.from(part.morph.weights)), firstWeights);
});

test('a layer with bones retargets the clip onto other nodes by name', async () => {
  const asset = await loadRobot();
  const time = 0.5;
  const waveId = clipIndex(asset, 'Wave');
  const leftArm = asset.nodes.find(node => node.name === 'UpperArmL').id;
  const rest = await sampledMatrices({ duration: 2, layers: [{ clip: waveId, mask: { joints: ['UpperLegR'] }, morph: false }] }, time);
  const waveRight = await sampledMatrices({ duration: 2, layers: [{ clip: waveId, mask: { joints: ['UpperArmR'] }, morph: false }] }, time);
  const waveLeft = await sampledMatrices({
    duration: 2, layers: [{ clip: waveId, mask: { joints: ['UpperArmL'] }, bones: { UpperArmR: leftArm }, morph: false }],
  }, time);
  const rightChanged = changedParts(rest, waveRight);
  const leftChanged = changedParts(rest, waveLeft);
  assert.ok(rightChanged.length > 0 && leftChanged.length > 0);
  assert.notDeepEqual(rightChanged, leftChanged);
});

/** The robot's own morph tracks are all zero, so a real track with values goes through the decoder's own track class. */
function faceAnimation(asset) {
  const dance = asset.animations[clipIndex(asset, 'Dance')];
  const smile = new NumberKeyframeTrack('Head_2.morphTargetInfluences', [0, 1], [0, 0, 0, 1, 0.5, 0.25]);
  const frown = new NumberKeyframeTrack('Head_3.morphTargetInfluences', [0, 1], [0.8, 0, 0, 0.8, 0, 0], InterpolateDiscrete);
  return { name: 'Face', duration: dance.duration, tracks: [...dance.tracks.filter(track => !track.name.includes('morph')), smile, frown] };
}

function faceWeights(asset, name) {
  return Array.from(asset.parts.find(part => part.name === name).morph.weights, weight => Number(weight.toFixed(5)));
}

test('morph clips drive face weights as authored, and a mask can leave the face alone', async () => {
  const asset = await loadRobot();
  const face = faceAnimation(asset);
  const morphs = morphClipFromGltfAnimation(face, { loop: false });
  assert.equal(morphs.tracks.length, 2);
  const pose = createAssetPose(asset, { layers: [{ clip: clipFromGltfAnimation(face), morphs }] });
  pose.apply(0.5);
  assert.deepEqual(faceWeights(asset, 'Head_2'), [0.5, 0.25, 0.125]);
  assert.deepEqual(faceWeights(asset, 'Head_3'), [0.8, 0, 0]);
  assert.deepEqual(faceWeights(asset, 'Head_4'), [0, 0, 0]);
  pose.apply(2);
  assert.deepEqual(faceWeights(asset, 'Head_2'), [1, 0.5, 0.25], 'a clip that does not loop holds its last key');

  const halfWeight = createAssetPose(asset, { layers: [{ clip: clipFromGltfAnimation(face), morphs, weight: 0.5 }] });
  halfWeight.apply(1);
  assert.deepEqual(faceWeights(asset, 'Head_2'), [0.5, 0.25, 0.125]);

  const additive = createAssetPose(asset, { layers: [{ clip: clipFromGltfAnimation(face), morphs, additive: true, reference: 0 }] });
  additive.apply(1);
  assert.deepEqual(faceWeights(asset, 'Head_2'), [1, 0.5, 0.25]);

  const legsOnly = createAssetPose(asset, { layers: [{ clip: clipFromGltfAnimation(face), morphs, mask: { joints: ['UpperLegL'] } }] });
  legsOnly.apply(1);
  assert.deepEqual(faceWeights(asset, 'Head_2'), [0, 0, 0]);
  const headOnly = createAssetPose(asset, { layers: [{ clip: clipFromGltfAnimation(face), morphs, mask: { joints: ['Head'] } }] });
  headOnly.apply(1);
  assert.deepEqual(faceWeights(asset, 'Head_2'), [1, 0.5, 0.25]);
});

test('the real clips load their zero morph tracks and keep the face at rest', async () => {
  const asset = await loadRobot();
  const dance = asset.animations[clipIndex(asset, 'Dance')];
  const morphs = morphClipFromGltfAnimation(dance, { loop: true });
  assert.deepEqual(morphs.tracks.map(track => [track.part, track.count]), [['Head_2', 3], ['Head_3', 3], ['Head_4', 3]]);
  const pose = createAssetPose(asset, { layers: [{ clip: clipFromGltfAnimation(dance, { loop: true }), morphs }] });
  pose.apply(1.2);
  assert.deepEqual(faceWeights(asset, 'Head_2'), [0, 0, 0]);
});

test('layer input that is not bounded plain data is refused', async () => {
  const asset = await loadRobot();
  const walking = clipIndex(asset, 'Walking');
  const hostile = {
    'not an array': { a: 1 },
    'too many layers': Array.from({ length: 9 }, () => ({ clip: walking })),
    'no layers': [],
    'unknown field': [{ clip: walking, script: 'alert(1)' }],
    'clip out of range': [{ clip: 999 }],
    'negative clip': [{ clip: -1 }],
    'fractional clip': [{ clip: 1.5 }],
    'weight above one': [{ clip: walking, weight: 2 }],
    'weight NaN': [{ clip: walking, weight: Number.NaN }],
    'zero speed': [{ clip: walking, speed: 0 }],
    'huge speed': [{ clip: walking, speed: 1e9 }],
    'huge offset': [{ clip: walking, offset: 1e9 }],
    'reference beyond the clip': [{ clip: walking, additive: true, reference: 1e6 }],
    'loop as a string': [{ clip: walking, loop: 'yes' }],
    'empty mask': [{ clip: walking, mask: { joints: [] } }],
    'mask joint that does not exist': [{ clip: walking, mask: { joints: ['NoSuchBone'] } }],
    'mask joint as an object': [{ clip: walking, mask: { joints: [{ name: 'Head' }] } }],
    'mask with too many joints': [{ clip: walking, mask: { joints: Array.from({ length: 33 }, () => 'Head') } }],
    'mask unknown field': [{ clip: walking, mask: { joints: ['Head'], deep: true } }],
    'bones key the clip does not have': [{ clip: walking, bones: { NoSuchTrack: 'Head' } }],
    'bones to a node that does not exist': [{ clip: walking, bones: { Head: 'NoSuchBone' } }],
    'bones that collide': [{ clip: walking, bones: { Head: 'Torso_3', Neck: 'Torso_3' } }],
    'bones empty': [{ clip: walking, bones: {} }],
    'bones as an array': [{ clip: walking, bones: ['Head'] }],
    'a url as a clip': [{ clip: 'https://example.com/walk.glb' }],
    'a null layer': [null],
  };
  for (const [label, layers] of Object.entries(hostile)) {
    assert.throws(() => assetScene(asset, { duration: 2, layers }), Error, label);
  }
  const accessor = { clip: walking };
  Object.defineProperty(accessor, 'weight', { enumerable: true, get() { return 1; } });
  assert.throws(() => assetScene(asset, { duration: 2, layers: [accessor] }), Error, 'accessor');
  const pollutedBones = JSON.parse('{"__proto__": "Head"}');
  assert.throws(() => assetScene(asset, { duration: 2, layers: [{ clip: walking, bones: pollutedBones }] }), Error, '__proto__ key');
  assert.equal(({}).polluted, undefined);
});

test('a recipe without an imported asset refuses layers', async () => {
  const { createAgentScene } = await import('../src/agent-scene.js');
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'box', type: 'box', bevel: 0 }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'cube', geometry: 'box', material: 'paint' }], motion: { duration: 1, layers: [{ clip: 0 }] },
  };
  assert.throws(() => createAgentScene(recipe), /imported asset|asset recipe/);
});

test('stagePose refuses morph weights that are not bounded', async () => {
  const asset = await loadRobot();
  const morphPart = asset.parts.findIndex(part => part.morph);
  const plainPart = asset.parts.findIndex(part => !part.morph);
  const count = asset.parts[morphPart].morph.weights.length;
  const zeros = Array.from({ length: count }, () => 0);
  const attempts = {
    'part without morph': [{ part: plainPart, weights: zeros }],
    'part out of range': [{ part: 9999, weights: zeros }],
    'duplicate part': [{ part: morphPart, weights: zeros }, { part: morphPart, weights: zeros }],
    'wrong length': [{ part: morphPart, weights: [0] }],
    'weight above one': [{ part: morphPart, weights: zeros.map(() => 2) }],
    'weight NaN': [{ part: morphPart, weights: zeros.map(() => Number.NaN) }],
    'extra field': [{ part: morphPart, weights: zeros, evil: true }],
    'not an array': { part: morphPart },
  };
  for (const [label, morphWeights] of Object.entries(attempts)) {
    assert.throws(() => asset.stagePose({ animation: null, nodeOverrides: [], morphWeights }), Error, label);
  }
  const staged = asset.stagePose({ animation: null, nodeOverrides: [], morphWeights: [{ part: morphPart, weights: zeros.map(() => 0.5) }] });
  staged.commit();
  assert.deepEqual(Array.from(asset.parts[morphPart].morph.weights), zeros.map(() => 0.5));
  asset.stagePose({ animation: null, nodeOverrides: [] }).commit();
  assert.deepEqual(Array.from(asset.parts[morphPart].morph.weights), zeros);
});

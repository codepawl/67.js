import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, vec3 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

const SEGMENT_MATERIALS = [{ id: 'paint', color: [0.6, 0.6, 0.6] }];

/** A planar arm: shoulder at (0, 1, 0), 0.5 m to the elbow, 0.4 m to the tip, plus a ball and a head. */
function armRecipe(motion, nodeOverrides = {}) {
  const nodes = [
    { id: 'base', translation: [0, 1, 0] },
    { id: 'shoulder', parent: 'base' },
    { id: 'upper-mesh', parent: 'shoulder', geometry: 'box', material: 'paint', translation: [0.25, 0, 0], scale: [0.5, 0.05, 0.05] },
    { id: 'elbow', parent: 'shoulder', translation: [0.5, 0, 0] },
    { id: 'lower-mesh', parent: 'elbow', geometry: 'box', material: 'paint', translation: [0.2, 0, 0], scale: [0.4, 0.04, 0.04] },
    { id: 'tip', parent: 'elbow', translation: [0.4, 0, 0], geometry: 'box', material: 'paint', scale: [0.03, 0.03, 0.03] },
    { id: 'ball', geometry: 'box', material: 'paint', translation: [0.3, 1.5, 0.3], scale: [0.05, 0.05, 0.05] },
    { id: 'lamp', geometry: 'box', material: 'paint', translation: [-1, 1, 0], scale: [0.1, 0.1, 0.1] },
  ].map(node => ({ ...node, ...nodeOverrides[node.id] }));
  return { format: '67js.scene', schemaVersion: 1, geometries: [{ id: 'box', type: 'box', bevel: 0 }], materials: SEGMENT_MATERIALS, nodes, ...(motion ? { motion } : {}) };
}

function worldPosition(scene, name) {
  const part = scene.parts.find(candidate => candidate.name === name);
  return Array.from(mat4.getTranslation(new Float64Array(3), part.matrix));
}

function assertClose(actual, expected, tolerance = 1e-3, label = '') {
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance, `${label} ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
  }
}

const armIk = (target, extra = {}) => ({ type: 'two-bone', root: 'shoulder', middle: 'elbow', end: 'tip', target, pole: [0, 3, 0], ...extra });

test('a recipe arm reaches a fixed point with no rotation tracks, and bone lengths hold', () => {
  const target = [0.4, 1.5, 0.3];
  const scene = createAgentScene(armRecipe({ duration: 1, tracks: [], ik: [armIk(target)] }));
  scene.sampleMotion(0);
  assertClose(worldPosition(scene, 'tip'), target);
  const elbow = worldPosition(scene, 'lower-mesh');
  const shoulder = worldPosition(scene, 'upper-mesh');
  assert.ok(Math.abs(vec3.distance(shoulder, [0, 1, 0]) - 0.25) < 1e-3);
  assert.ok(Math.abs(vec3.distance(elbow, worldPosition(scene, 'tip')) - 0.2) < 1e-3);
});

test('a keyframed target moves through time, and seeking back gives the same pose', () => {
  const start = [0.4, 1.5, 0.3];
  const end = [0.2, 1.2, -0.5];
  const scene = createAgentScene(armRecipe({
    duration: 2, tracks: [],
    ik: [armIk({ keyframes: [{ time: 0, value: start }, { time: 2, value: end }] })],
  }));
  scene.sampleMotion(0);
  assertClose(worldPosition(scene, 'tip'), start);
  scene.sampleMotion(2);
  assertClose(worldPosition(scene, 'tip'), end);
  scene.sampleMotion(1);
  const middle = worldPosition(scene, 'tip');
  assertClose(middle, [0.3, 1.35, -0.1]);
  scene.sampleMotion(2);
  scene.sampleMotion(1);
  assertClose(worldPosition(scene, 'tip'), middle, 1e-9);
});

test('a target can follow another node, including one moved by a track', () => {
  const scene = createAgentScene(armRecipe({
    duration: 2,
    tracks: [{ kind: 'node', id: 'ball', property: 'translation', keyframes: [{ time: 0, value: [0.3, 1.5, 0.3] }, { time: 2, value: [0.5, 1.2, 0] }] }],
    ik: [armIk({ node: 'ball' })],
  }));
  scene.sampleMotion(0);
  assertClose(worldPosition(scene, 'tip'), [0.3, 1.5, 0.3]);
  scene.sampleMotion(2);
  assertClose(worldPosition(scene, 'tip'), [0.5, 1.2, 0]);
});

test('IK runs on top of tracks: a moving base carries the shoulder and the tip still reaches', () => {
  const scene = createAgentScene(armRecipe({
    duration: 1,
    tracks: [{ kind: 'node', id: 'base', property: 'translation', keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 1, value: [0.2, 1, 0] }] }],
    ik: [armIk([0.5, 1.4, 0])],
  }));
  scene.sampleMotion(1);
  assertClose(worldPosition(scene, 'tip'), [0.5, 1.4, 0]);
  assertClose(worldPosition(scene, 'upper-mesh').slice(0, 1), [0.2], 0.3);
});

test('the pole picks the side the elbow bends to', () => {
  const elbowZ = pole => {
    const scene = createAgentScene(armRecipe({ duration: 1, tracks: [], ik: [armIk([0.6, 1, 0], { pole })] }));
    scene.sampleMotion(0);
    return worldPosition(scene, 'lower-mesh')[2];
  };
  assert.ok(elbowZ([0.3, 1, 2]) > 0.05);
  assert.ok(elbowZ([0.3, 1, -2]) < -0.05);
});

test('keyframed weight fades IK in, with tracks showing through', () => {
  const scene = createAgentScene(armRecipe({
    duration: 2, tracks: [],
    ik: [armIk([0.4, 1.5, 0.3], { weight: { keyframes: [{ time: 0, value: 0 }, { time: 2, value: 1 }] } })],
  }));
  scene.sampleMotion(0);
  assertClose(worldPosition(scene, 'tip'), [0.9, 1, 0]);
  scene.sampleMotion(2);
  assertClose(worldPosition(scene, 'tip'), [0.4, 1.5, 0.3]);
});

test('aim points a node at a target and honours maxAngle', () => {
  const forwardOf = scene => {
    const part = scene.parts.find(candidate => candidate.name === 'lamp');
    const rotated = vec3.transformMat4(new Float64Array(3), [0, 0, 1], part.matrix);
    return vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), rotated, mat4.getTranslation(new Float64Array(3), part.matrix)));
  };
  const scene = createAgentScene(armRecipe({ duration: 1, tracks: [], ik: [{ type: 'aim', joint: 'lamp', target: { node: 'ball' } }] }));
  scene.sampleMotion(0);
  const toBall = vec3.normalize(new Float64Array(3), [1.3, 0.5, 0.3]);
  assertClose(Array.from(forwardOf(scene)), Array.from(toBall));
  const limited = createAgentScene(armRecipe({ duration: 1, tracks: [], ik: [{ type: 'aim', joint: 'lamp', target: [5, 1, 0], maxAngle: 20 }] }));
  limited.sampleMotion(0);
  assert.ok(Math.abs(vec3.angle(forwardOf(limited), [0, 0, 1]) - 20 * Math.PI / 180) < 1e-3);
});

test('scene_inspect reports where IK falls short across the clip', () => {
  const reachable = createAgentScene(armRecipe({ duration: 2, tracks: [], ik: [armIk([0.4, 1.5, 0.3])] }));
  assert.deepEqual(reachable.inspect().motionIk.map(result => [result.type, result.reached]), [['two-bone', true]]);
  const tooFar = createAgentScene(armRecipe({
    duration: 2, tracks: [],
    ik: [armIk({ keyframes: [{ time: 0, value: [0.4, 1.5, 0.3] }, { time: 2, value: [5, 1, 0] }] })],
  }));
  const [result] = tooFar.inspect().motionIk;
  assert.equal(result.reached, false);
  assert.equal(result.atTime, 2);
  assert.ok(Math.abs(result.worstError - 4.1) < 0.01, `${result.worstError}`);
  assert.equal(createAgentScene(armRecipe()).inspect().motionIk, undefined);
});

test('inspecting does not disturb the sampled pose', () => {
  const scene = createAgentScene(armRecipe({ duration: 2, tracks: [], ik: [armIk({ keyframes: [{ time: 0, value: [0.4, 1.5, 0.3] }, { time: 2, value: [0.2, 1.2, -0.5] }] })] }));
  scene.sampleMotion(1);
  const before = worldPosition(scene, 'tip');
  scene.inspect();
  assertClose(worldPosition(scene, 'tip'), before, 1e-12);
});

test('recipes export and reload with their ik', () => {
  const scene = createAgentScene(armRecipe({ duration: 1, tracks: [], ik: [armIk([0.4, 1.5, 0.3])] }));
  const exported = scene.exportRecipe();
  assert.equal(exported.motion.ik[0].type, 'two-bone');
  const reloaded = createAgentScene(exported);
  reloaded.sampleMotion(0);
  assertClose(worldPosition(reloaded, 'tip'), [0.4, 1.5, 0.3]);
  const plain = createAgentScene(armRecipe({ duration: 1, tracks: [{ kind: 'node', id: 'ball', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }] }));
  assert.equal(plain.exportRecipe().motion.ik, undefined);
});

test('mistakes say what to pass', () => {
  const create = (ik, overrides) => createAgentScene(armRecipe({ duration: 1, tracks: [], ik }, overrides));
  assert.throws(() => createAgentScene(armRecipe({ duration: 1, tracks: [] })), /at least one track, IK solver, constraint or driver/);
  assert.throws(() => create([{ type: 'fabrik', target: [0, 0, 0] }]), /type must be two-bone or aim/);
  assert.throws(() => create([armIk([0, 0, 0], { root: 'nope' })]), /root must be a node ID/);
  assert.throws(() => create([armIk({ node: 'nope' })]), /target node must be a node ID/);
  assert.throws(() => create([armIk('here')]), /target must be \[x, y, z\]/);
  assert.throws(() => create([armIk([0, 0, 0], { end: 'ball' })]), /end must descend from middle/);
  assert.throws(() => create([armIk([0, 0, 0], { weight: 3 })]), /weight: got 3; expected a number from/);
  assert.throws(() => create([{ type: 'aim', target: [0, 0, 0] }]), /needs joint, or joints/);
  assert.throws(() => create([armIk([0, 0, 0])], { elbow: { scale: [1, 2, 1] } }), /non-uniform scale.*child node/);
  assert.doesNotThrow(() => create([armIk([0.4, 1.5, 0.3])], { tip: { scale: [0.1, 0.2, 0.3] } }));
  assert.doesNotThrow(() => create([{ type: 'aim', joint: 'lamp', target: [0, 0, 0] }], { lamp: { scale: [0.2, 0.2, 0.3] } }));
  assert.throws(() => createAgentScene(armRecipe({
    duration: 1,
    tracks: [{ kind: 'node', id: 'elbow', property: 'scale', keyframes: [{ time: 0, value: [1, 1, 1] }] }],
    ik: [armIk([0, 0, 0])],
  })), /cannot have a scale track/);
  assert.throws(() => create([{ type: 'aim', joint: 'lamp', target: [0, 0, 0], forward: [0, 0, 1], worldForward: [0, 0, 1] }]), /forward or worldForward, not both/);
  assert.deepEqual([...AGENT_SCENE_CAPABILITIES.motionIk], ['two-bone', 'aim']);
});

test('a node named like a humanoid bone is not mapped to another node', () => {
  const recipe = armRecipe({ duration: 1, tracks: [], ik: [{ type: 'two-bone', root: 'hips', middle: 'elbow', end: 'tip', target: [0.4, 1.5, 0.3], pole: [0, 3, 0] }] }, { shoulder: { id: 'hips' } });
  recipe.nodes.forEach(node => {
    if (node.parent === 'shoulder') node.parent = 'hips';
  });
  const scene = createAgentScene(recipe);
  scene.sampleMotion(0);
  assertClose(worldPosition(scene, 'tip'), [0.4, 1.5, 0.3]);
});

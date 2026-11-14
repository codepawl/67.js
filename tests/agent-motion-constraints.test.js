import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4, quat, vec3 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { CONSTRAINT_TYPES } from '../src/node-constraints.js';
import { eulerFromQuaternion, quaternionFromEuler } from '../src/rotation-euler.js';

const DEGREES = Math.PI / 180;

function nodeRecipe(nodes, motion, materials = []) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }, ...materials],
    nodes: nodes.map(node => ({ geometry: 'box', material: 'paint', ...node })),
    ...(motion ? { motion } : {}),
  };
}

function part(scene, name) {
  return scene.parts.find(candidate => candidate.name === name);
}

function worldPosition(scene, name) {
  return Array.from(mat4.getTranslation(new Float64Array(3), part(scene, name).matrix));
}

function worldEulerDegrees(scene, name) {
  return eulerFromQuaternion(mat4.getRotation(new Float64Array(4), part(scene, name).matrix)).map(radians => radians / DEGREES);
}

function rotationOf(x, y, z) {
  return Array.from(quaternionFromEuler(new Float64Array(4), x * DEGREES, y * DEGREES, z * DEGREES));
}

function assertClose(actual, expected, tolerance = 1e-4, label = '') {
  expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= tolerance, `${label} ${JSON.stringify(Array.from(actual))} vs ${JSON.stringify(expected)}`));
}

function sampledAt(recipe, time) {
  const scene = createAgentScene(recipe);
  scene.sampleMotion(time);
  return scene;
}

const SOURCE = { id: 'source', translation: [1, 2, 3], rotation: rotationOf(20, 30, 40), scale: [2, 3, 4] };
const OWNER = { id: 'owner', translation: [0, 0, 0], scale: [1, 1, 1] };
const motionWith = (constraints, extra = {}) => ({ duration: 1, tracks: [], constraints, ...extra });

test('copy_location copies chosen axes, inverts, and can offset', () => {
  const run = options => worldPosition(sampledAt(nodeRecipe([SOURCE, { ...OWNER, translation: [5, 5, 5] }], motionWith([{ type: 'copy_location', node: 'owner', target: 'source', ...options }])), 0), 'owner');
  assertClose(run({}), [1, 2, 3]);
  assertClose(run({ axes: ['x', 'z'] }), [1, 5, 3]);
  assertClose(run({ invert: ['y'] }), [1, -2, 3]);
  assertClose(run({ offset: true }), [6, 7, 8]);
});

test('copy_rotation replaces chosen Euler axes in world space and adds on request', () => {
  const owner = { ...OWNER, rotation: rotationOf(10, 0, 0) };
  const run = options => worldEulerDegrees(sampledAt(nodeRecipe([SOURCE, owner], motionWith([{ type: 'copy_rotation', node: 'owner', target: 'source', ...options }])), 0), 'owner');
  assertClose(run({}), [20, 30, 40], 1e-3);
  assertClose(run({ axes: ['z'] }), [10, 0, 40], 1e-3);
  assertClose(run({ axes: ['x'], mix: 'add' }), [30, 0, 0], 1e-3);
});

test('copy_scale copies and multiplies', () => {
  const owner = { ...OWNER, scale: [2, 2, 2] };
  const scaleOf = options => {
    const scene = sampledAt(nodeRecipe([{ ...SOURCE, rotation: [0, 0, 0, 1] }, owner], motionWith([{ type: 'copy_scale', node: 'owner', target: 'source', ...options }])), 0);
    return Array.from(mat4.getScaling(new Float64Array(3), part(scene, 'owner').matrix));
  };
  assertClose(scaleOf({}), [2, 3, 4]);
  assertClose(scaleOf({ axes: ['y'] }), [2, 3, 2]);
  assertClose(scaleOf({ offset: true }), [4, 6, 8]);
});

test('limit_location and limit_rotation clamp, in world or local space', () => {
  const owner = { ...OWNER, translation: [5, -5, 0.5], rotation: rotationOf(80, -70, 10) };
  const scene = sampledAt(nodeRecipe([owner], motionWith([
    { type: 'limit_location', node: 'owner', x: [-1, 1], y: [-1, 1] },
    { type: 'limit_rotation', node: 'owner', x: [-45, 45], y: [-30, 30] },
  ])), 0);
  assertClose(worldPosition(scene, 'owner'), [1, -1, 0.5]);
  assertClose(worldEulerDegrees(scene, 'owner'), [45, -30, 10], 1e-3);
  const underParent = sampledAt(nodeRecipe([{ id: 'holder', translation: [10, 0, 0] }, { ...OWNER, parent: 'holder', translation: [5, 0, 0] }],
    motionWith([{ type: 'limit_location', node: 'owner', x: [0, 2], space: 'local' }])), 0);
  assertClose(worldPosition(underParent, 'owner'), [12, 0, 0]);
});

test('track_to points the track axis at the target with the up axis toward worldUp', () => {
  const recipe = nodeRecipe([{ id: 'lamp', translation: [-1, 1, 0], scale: [0.1, 0.1, 0.1] }, { id: 'ball', translation: [0.3, 1.5, 0.3], scale: [0.05, 0.05, 0.05] }],
    motionWith([{ type: 'track_to', node: 'lamp', target: 'ball' }]));
  const matrix = part(sampledAt(recipe, 0), 'lamp').matrix;
  const trackAxis = vec3.normalize(new Float64Array(3), [-matrix[8], -matrix[9], -matrix[10]]);
  const toBall = vec3.normalize(new Float64Array(3), [1.3, 0.5, 0.3]);
  assertClose(trackAxis, Array.from(toBall), 1e-5);
  assert.ok(matrix[5] > 0, 'the up axis leans toward world up');
  const plusZ = nodeRecipe(recipe.nodes, motionWith([{ type: 'track_to', node: 'lamp', target: 'ball', trackAxis: '+z', upAxis: 'x', worldUp: [0, 0, 1] }]));
  const turned = part(sampledAt(plusZ, 0), 'lamp').matrix;
  assertClose(vec3.normalize(new Float64Array(3), [turned[8], turned[9], turned[10]]), Array.from(toBall), 1e-5);
  assert.ok(turned[2] > 0, 'the x axis leans toward the given up');
});

test('child_of keeps the owner in place at rest and carries it with the target; influence blends', () => {
  const nodes = [{ id: 'platform', translation: [1, 0, 0] }, { id: 'cargo', translation: [0, 1, 0], scale: [0.2, 0.2, 0.2] }];
  const move = { kind: 'node', id: 'platform', property: 'translation', keyframes: [{ time: 0, value: [1, 0, 0] }, { time: 1, value: [3, 0, 0] }] };
  const run = (options, time) => worldPosition(sampledAt(nodeRecipe(nodes, { duration: 1, tracks: [move], constraints: [{ type: 'child_of', node: 'cargo', target: 'platform', ...options }] }), time), 'cargo');
  assertClose(run({}, 0), [0, 1, 0]);
  assertClose(run({}, 1), [2, 1, 0]);
  assertClose(run({ influence: 0.5 }, 1), [1, 1, 0]);
  assertClose(run({ inverse: 'none' }, 0), [1, 1, 0]);
});

test('floor keeps a node above the target plane along the chosen axis', () => {
  const run = (y, options = {}) => worldPosition(sampledAt(nodeRecipe([{ id: 'ground', translation: [0, 0.5, 0] }, { id: 'ball', translation: [0, y, 0] }],
    motionWith([{ type: 'floor', node: 'ball', target: 'ground', ...options }])), 0), 'ball');
  assertClose(run(-1), [0, 0.5, 0]);
  assertClose(run(2), [0, 2, 0]);
  assertClose(run(0, { offset: 0.25 }), [0, 0.75, 0]);
});

test('constraints run in order on the result of the one before', () => {
  const recipe = nodeRecipe([SOURCE, { ...OWNER, translation: [9, 9, 9] }], motionWith([
    { type: 'copy_location', node: 'owner', target: 'source' },
    { type: 'limit_location', node: 'owner', y: [0, 1] },
  ]));
  assertClose(worldPosition(sampledAt(recipe, 0), 'owner'), [1, 1, 3]);
});

test('constraints follow a target moved by a track and a seek equals playing', () => {
  const recipe = nodeRecipe([{ id: 'lead', translation: [0, 0, 0] }, { id: 'follower', translation: [0, 0, 0] }, { id: 'ground', translation: [0, 0.2, 0] }], {
    duration: 2,
    tracks: [{ kind: 'node', id: 'lead', property: 'translation', keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 2, value: [4, -1, 2] }] }],
    constraints: [
      { type: 'copy_location', node: 'follower', target: 'lead', influence: { clamp: [{ mul: ['time', 0.5] }, 0, 1] } },
      { type: 'floor', node: 'follower', target: 'ground' },
    ],
  });
  const played = createAgentScene(recipe);
  [0, 0.4, 0.8, 1.2, 1.6, 2, 1.2, 0.5].forEach(time => played.sampleMotion(time));
  const sought = createAgentScene(recipe);
  sought.sampleMotion(1.4);
  played.sampleMotion(1.4);
  assert.deepEqual(worldPosition(sought, 'follower'), worldPosition(played, 'follower'));
  assertClose(worldPosition(sought, 'follower'), [0.7 * 2.8, 0.2, 0.7 * 1.4], 1e-5, 'a 70 percent blend toward the lead, floored at the ground');
  sought.sampleMotion(0);
  assertClose(worldPosition(sought, 'follower'), [0, 0.2, 0], 1e-6);
});

test('drivers set a node component and a material property from time and other nodes', () => {
  const recipe = nodeRecipe([{ id: 'wheel', translation: [0, 1, 0] }, { id: 'lamp', translation: [0, 0, 0] }, { id: 'bulb', material: 'glow' }], {
    duration: 2,
    tracks: [{ kind: 'node', id: 'wheel', property: 'translation', keyframes: [{ time: 0, value: [0, 1, 0] }, { time: 2, value: [4, 1, 0] }] }],
    drivers: [
      { target: { kind: 'node', id: 'lamp', property: 'rotation', component: 'z' }, expression: { mul: [{ node: 'wheel', property: 'translation', component: 'x' }, 10] } },
      { target: { kind: 'node', id: 'lamp', property: 'translation', component: 'y' }, expression: { add: [1, { mul: [0.5, { sin: [{ mul: ['time', 3.14159265] }] }] }] } },
      { target: { kind: 'material', id: 'glow', property: 'roughness' }, expression: { clamp: [{ div: ['time', 2] }, 0, 1] } },
      { target: { kind: 'material', id: 'glow', property: 'color', component: 'x' }, expression: { saturate: [{ node: 'wheel', property: 'translation', component: 'x' }] } },
    ],
  }, [{ id: 'glow', color: [0.1, 0.2, 0.3], roughness: 0.9 }]);
  const scene = sampledAt(recipe, 0.5);
  assertClose(worldEulerDegrees(scene, 'lamp'), [0, 0, 10], 1e-3);
  assertClose(worldPosition(scene, 'lamp'), [0, 1.5, 0], 1e-4);
  const glow = part(scene, 'bulb').material;
  assert.ok(Math.abs(glow.roughness - 0.25) < 1e-6, `roughness ${glow.roughness}`);
  assertClose(glow.color, [1, 0.2, 0.3], 1e-6);
  const resampled = sampledAt(recipe, 0.5);
  assert.deepEqual(worldPosition(resampled, 'lamp'), worldPosition(scene, 'lamp'));
});

test('a seek equals play for drivers too', () => {
  const recipe = nodeRecipe([{ id: 'lamp' }], { duration: 3, tracks: [], drivers: [{ target: { kind: 'node', id: 'lamp', property: 'translation', component: 'x' }, expression: { mul: ['time', 2] } }] });
  const played = createAgentScene(recipe);
  [0, 1, 2.5, 0.5].forEach(time => played.sampleMotion(time));
  const sought = sampledAt(recipe, 0.5);
  assert.deepEqual(worldPosition(played, 'lamp'), worldPosition(sought, 'lamp'));
});

test('drivers and constraints reject anything that is not bounded data', () => {
  const driver = expression => nodeRecipe([{ id: 'lamp' }], { duration: 1, tracks: [], drivers: [{ target: { kind: 'node', id: 'lamp', property: 'translation', component: 'x' }, expression }] });
  assert.throws(() => createAgentScene(driver('process.exit(1)')), /use a number, "time"/);
  assert.throws(() => createAgentScene(driver({ constructor: [1, 2] })), /unknown operator/);
  assert.throws(() => createAgentScene(driver({ add: [1] })), /2 to 8 operands/);
  assert.throws(() => createAgentScene(driver({ node: 'missing', property: 'translation', component: 'x' })), /not in this scene/);
  assert.throws(() => createAgentScene(driver({ div: [1, 0] })).sampleMotion(0), /finite/);
  let deep = 1;
  for (let level = 0; level < 10; level++) deep = { neg: [deep] };
  assert.throws(() => createAgentScene(driver(deep)), /nests deeper/);
  const clash = nodeRecipe([{ id: 'lamp' }], {
    duration: 1, tracks: [{ kind: 'node', id: 'lamp', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }],
    drivers: [{ target: { kind: 'node', id: 'lamp', property: 'translation', component: 'x' }, expression: 1 }],
  });
  assert.throws(() => createAgentScene(clash), /a track on .* already moves/);
  const constraint = fields => nodeRecipe([{ id: 'lamp' }, { id: 'ball' }], motionWith([{ type: 'copy_location', node: 'lamp', target: 'ball', ...fields }]));
  assert.throws(() => createAgentScene(constraint({ target: 'lamp' })), /itself/);
  assert.throws(() => createAgentScene(constraint({ axes: ['w'] })), /distinct axes/);
  assert.throws(() => createAgentScene(constraint({ influence: 2 })), /influence/);
  assert.throws(() => createAgentScene(constraint({ extra: 1 })), /Unknown or unsupported/);
  assert.throws(() => createAgentScene(nodeRecipe([{ id: 'lamp' }], motionWith([{ type: 'wiggle', node: 'lamp' }]))), /type must be one of/);
  assert.throws(() => createAgentScene(nodeRecipe([{ id: 'lamp' }], motionWith([{ type: 'limit_rotation', node: 'lamp', x: [-200, 10] }]))), /within -180 and 180/);
});

test('the capabilities list every constraint type', () => {
  assert.deepEqual([...AGENT_SCENE_CAPABILITIES.motionConstraints], [...CONSTRAINT_TYPES]);
  assert.ok(quat.length(rotationOf(1, 2, 3)) > 0);
});

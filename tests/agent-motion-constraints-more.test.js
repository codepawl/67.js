import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { createAgentScene } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { CONSTRAINT_TYPES } from '../src/node-constraints.js';
import { eulerFromQuaternion, quaternionFromEuler } from '../src/rotation-euler.js';

// Each case builds an owner and a target, then compares the owner's world matrix with a pose worked out by hand.

const DEGREES = Math.PI / 180;

function sampled(nodes, constraint) {
  const scene = createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.6, 0.6, 0.6] }],
    nodes: nodes.map(node => ({ geometry: 'box', material: 'paint', ...node })),
    motion: { duration: 1, tracks: [], constraints: [{ node: 'owner', ...constraint }] },
  });
  scene.sampleMotion(0);
  return scene.parts.find(part => part.name === 'owner').matrix;
}

function assertClose(actual, expected, label, tolerance = 1e-4) {
  expected.forEach((value, index) => {
    assert.ok(Math.abs(actual[index] - value) <= tolerance, `${label}: ${JSON.stringify(Array.from(actual))} vs ${JSON.stringify(expected)}`);
  });
}

const translationOf = matrix => Array.from(mat4.getTranslation(new Float64Array(3), matrix));
const column = (matrix, index) => Array.from(matrix.slice(index * 4, index * 4 + 3));
const eulerDegrees = matrix => eulerFromQuaternion(mat4.getRotation(new Float64Array(4), matrix)).map(radians => radians / DEGREES);
const owner = { id: 'owner' };
const targetAt = translation => ({ id: 'target', translation });

test('copy_transforms gives the owner the target world matrix', () => {
  const rotation = Array.from(quaternionFromEuler(new Float64Array(4), 20 * DEGREES, 30 * DEGREES, 40 * DEGREES));
  const target = { id: 'target', translation: [1, 2, 3], rotation, scale: [2, 3, 4] };
  const matrix = sampled([owner, target], { type: 'copy_transforms', target: 'target' });
  const expected = mat4.fromRotationTranslationScale(new Float64Array(16), rotation, [1, 2, 3], [2, 3, 4]);
  assertClose(matrix, Array.from(expected), 'copy_transforms');
});

test('limit_distance pulls a far owner onto the sphere, keeping its direction', () => {
  const matrix = sampled([{ ...owner, translation: [6, 8, 0] }, targetAt([0, 0, 0])], { type: 'limit_distance', target: 'target', distance: 5 });
  assertClose(translationOf(matrix), [3, 4, 0], 'inside, far owner');
});

test('limit_distance inside leaves a near owner, outside pushes it out and surface does both', () => {
  const near = [{ ...owner, translation: [0.6, 0.8, 0] }, targetAt([0, 0, 0])];
  assertClose(translationOf(sampled(near, { type: 'limit_distance', target: 'target', distance: 5 })), [0.6, 0.8, 0], 'inside, near owner');
  assertClose(translationOf(sampled(near, { type: 'limit_distance', target: 'target', distance: 5, mode: 'outside' })), [3, 4, 0], 'outside');
  assertClose(translationOf(sampled(near, { type: 'limit_distance', target: 'target', distance: 5, mode: 'surface' })), [3, 4, 0], 'surface');
});

test('limit_scale clamps each ranged axis and leaves the others', () => {
  const matrix = sampled([{ ...owner, scale: [5, 0.1, 2] }], { type: 'limit_scale', x: [1, 3], y: [0.5, 2] });
  assertClose([column(matrix, 0)[0], column(matrix, 1)[1], column(matrix, 2)[2]], [3, 0.5, 2], 'scale');
});

test('stretch_to aims +y at the target and keeps volume with x and z', () => {
  const matrix = sampled([owner, targetAt([0, 0, 4])], { type: 'stretch_to', target: 'target', restLength: 2 });
  const thin = Math.sqrt(0.5);
  assertClose(column(matrix, 0), [-thin, 0, 0], 'x column');
  assertClose(column(matrix, 1), [0, 0, 2], 'y column stretched to 4 over rest 2');
  assertClose(column(matrix, 2), [0, thin, 0], 'z column');
});

test('stretch_to takes its rest length from the rest pose, and volume none leaves x and z alone', () => {
  const matrix = sampled([owner, targetAt([0, 0, 2])], { type: 'stretch_to', target: 'target', volume: 'none' });
  assertClose(column(matrix, 1), [0, 0, 1], 'unstretched at rest');
  assertClose(column(matrix, 0), [-1, 0, 0], 'x column');
});

test('locked_track turns only about the lock axis', () => {
  const matrix = sampled([owner, targetAt([3, 0, 5])], { type: 'locked_track', target: 'target' });
  assertClose(column(matrix, 1), [1, 0, 0], 'track axis y points along x, the target seen from the lock plane');
  assertClose(column(matrix, 2), [0, 0, 1], 'lock axis z does not move');
  assertClose(eulerDegrees(matrix), [0, 0, -90], 'euler');
});

test('transformation maps a clamped target channel range onto the owner', () => {
  const asRotation = sampled([owner, targetAt([5, 0, 0])], {
    type: 'transformation', target: 'target', destination: 'rotation', map: ['x', 'y', 'x'], fromMax: [10, 10, 10], toMax: [90, 90, 180],
  });
  assertClose(eulerDegrees(asRotation), [45, 0, 90], 'half way along x');
  const clamped = sampled([owner, targetAt([20, 0, 0])], {
    type: 'transformation', target: 'target', fromMax: [10, 10, 10], toMax: [1, 2, 3], map: ['x', 'y', 'x'],
  });
  assertClose(translationOf(clamped), [1, 0, 3], 'clamped to the top of the range');
});

test('action reads a keyed curve at the target channel position', () => {
  const action = { type: 'action', target: 'target', max: 10, min: 0, keys: [{ at: 0, value: [0, 0, 0] }, { at: 0.5, value: [0, 2, 0] }, { at: 1, value: [0, 2, 10] }] };
  assertClose(translationOf(sampled([owner, targetAt([2.5, 0, 0])], action)), [0, 1, 0], 'first segment');
  assertClose(translationOf(sampled([owner, targetAt([7.5, 0, 0])], action)), [0, 2, 5], 'second segment');
  assertClose(translationOf(sampled([owner, targetAt([99, 0, 0])], action)), [0, 2, 10], 'past the end');
});

test('the new constraints refuse bad fields', () => {
  const pair = [owner, targetAt([1, 0, 0])];
  const refuses = (constraint, pattern) => assert.throws(() => sampled(pair, constraint), pattern);
  refuses({ type: 'limit_scale', x: [0, 2] }, /minimum must be above 0/);
  refuses({ type: 'limit_distance', target: 'target', distance: -1 }, /distance/);
  refuses({ type: 'locked_track', target: 'target', trackAxis: '+z', lockAxis: 'z' }, /different axes/);
  refuses({ type: 'stretch_to', target: 'target', volume: 'all' }, /volume/);
  refuses({ type: 'transformation', target: 'target', fromMax: [0, 1, 1] }, /fromMax must differ/);
  refuses({ type: 'transformation', target: 'target', map: ['x', 'y'] }, /map/);
  refuses({ type: 'action', target: 'target', min: 1, max: 1, keys: [] }, /min must be below max/);
  refuses({ type: 'action', target: 'target', min: 0, max: 1, keys: [{ at: 0, value: [0, 0, 0] }] }, /at least 2/);
  refuses({ type: 'action', target: 'target', min: 0, max: 1, keys: [{ at: 0.5, value: [0, 0, 0] }, { at: 0.5, value: [1, 0, 0] }] }, /rising/);
  refuses({ type: 'copy_transforms' }, /target/);
});

test('scene_capabilities lists every constraint type', () => {
  assert.deepEqual([...AGENT_SCENE_CAPABILITIES.motionConstraints].sort(), [...CONSTRAINT_TYPES].sort());
});

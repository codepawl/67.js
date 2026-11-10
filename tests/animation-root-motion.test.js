import assert from 'node:assert/strict';
import test from 'node:test';
import { quat, vec3 } from 'gl-matrix';
import { createAnimationClip, sampleAnimationClip } from '../src/animation.js';
import { createAnimationGraph, createFootPlacement, createLookAt, extractRootMotion } from '../src/animation-graph.js';
import { createCharacterController } from '../src/player.js';
import { parseGltf } from '../src/gltf.js';
import { createAssetPose, createSkeletonPose } from '../src/skeleton-pose.js';
import { carAsset } from './fixtures/car-glb.js';

const STEP = 1 / 60;
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);

function rotation(axis, degrees) {
  return Array.from(quat.setAxisAngle(new Float64Array(4), axis, degrees * Math.PI / 180));
}

// A clip whose root bone travels `meters` straight along +z (the way glTF rigs face) and bobs 0.1 up in the middle.
function travelClip(bone, meters, { duration = 1, loop = true, extraTracks = [] } = {}) {
  return createAnimationClip({
    duration,
    loop,
    tracks: [
      {
        target: bone,
        property: 'translation',
        keyframes: [
          { time: 0, value: [0.5, 1, 0.25] },
          { time: duration / 2, value: [0.5, 1.1, 0.25 + meters / 2] },
          { time: duration, value: [0.5, 1, 0.25 + meters] },
        ],
      },
      ...extraTracks,
    ],
  });
}

function bendClip(target, degrees, duration = 1) {
  return createAnimationClip({
    duration,
    loop: true,
    tracks: [{ target, property: 'rotation', keyframes: [{ time: 0, value: rotation([1, 0, 0], 0) }, { time: duration, value: rotation([1, 0, 0], degrees) }] }],
  });
}

function stillClip(target, duration = 2) {
  return createAnimationClip({ duration, loop: true, tracks: [{ target, property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: duration, value: [0, 0, 0, 1] }] }] });
}

function locomotion(overrides = {}) {
  return {
    rootMotion: { bone: 'Root' },
    clips: { idle: stillClip('Root'), walk: travelClip('Root', 2) },
    parameters: { speed: { type: 'number' } },
    layers: [{
      name: 'base',
      states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: 2.2 }] } }],
    }],
    ...overrides,
  };
}

function runGraph(graph, seconds) {
  const total = [0, 0];
  for (let step = 0; step < Math.round(seconds / STEP); step++) {
    graph.advance(STEP);
    total[0] += graph.rootMotion.delta[0];
    total[1] += graph.rootMotion.delta[1];
  }
  return total;
}

test('extractRootMotion returns the travel in the player convention and an in-place clip', () => {
  const clip = travelClip('Root', 2);
  const extracted = extractRootMotion(clip, { bone: 'Root', facing: '+z', scale: 1 });
  assert.equal(extracted.hasMotion, true);
  const half = Array.from(extracted.displacement(0.5));
  close(half[0], 0);
  close(half[1], -1); // A rig that faces +z travels toward negative z in the player's convention.
  const loops = Array.from(extracted.displacement(2.5));
  close(loops[1], -5);
  const stopped = Array.from(extracted.displacement(2.5, false));
  close(stopped[1], -2);

  const sampled = sampleAnimationClip(extracted.clip, 0.5)[0].value;
  close(sampled[0], 0.5);
  close(sampled[2], 0.25);
  close(sampled[1], 1.1);
  assert.equal(extractRootMotion(clip, { bone: 'Root', facing: '-z', scale: 0.5 }).displacement(1)[1], 1);
});

test('a clip without a translation track on the bone comes back unchanged', () => {
  const clip = stillClip('Root');
  const extracted = extractRootMotion(clip, { bone: 'Root', facing: '+z', scale: 1 });
  assert.equal(extracted.hasMotion, false);
  assert.equal(extracted.clip, clip);
  assert.deepEqual(Array.from(extracted.displacement(3)), [0, 0]);
});

test('the graph reports the root travel of each step, blended by the motion weights', () => {
  const graph = createAnimationGraph(locomotion());
  graph.set('speed', 1.1);
  // Half walk (2 m per cycle) and half idle: the blended duration is 1.5 s, so 3 s plays two cycles.
  const total = runGraph(graph, 3);
  close(total[0], 0, 1e-9);
  close(total[1], -2, 1e-6);
  const last = graph.rootMotion;
  assert.ok(last.distance > 0 && last.speed > 0);
  graph.reset();
  assert.equal(graph.rootMotion.distance, 0);
});

test('the pose reads the in-place clips, so the root bone does not slide', () => {
  const graph = createAnimationGraph(locomotion({ clips: { idle: stillClip('Root'), walk: travelClip('Root', 2) } }));
  const rig = { joints: [{ name: 'Root', parent: -1, translation: [0.5, 1, 0.25], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }] };
  const pose = createSkeletonPose({ rig, layers: graph.poseLayers() });
  graph.set('speed', 2.2);
  runGraph(graph, 0.75);
  pose.apply(graph.time);
  const position = pose.jointWorld('Root').position;
  close(position[0], 0.5, 1e-6);
  close(position[2], 0.25, 1e-6);
});

test('rootMotion mistakes name the field and the fix', () => {
  assert.throws(() => createAnimationGraph(locomotion({ rootMotion: { bone: 'Hips' } })), /rootMotion\.bone "Hips" has no translation track/);
  assert.throws(() => createAnimationGraph(locomotion({ rootMotion: {} })), /rootMotion\.bone must be the name of the root bone/);
  assert.throws(() => createAnimationGraph(locomotion({ rootMotion: { bone: 'Root', facing: 'up' } })), /rootMotion\.facing must be "\+z" or "-z"/);
  assert.throws(() => createAnimationGraph(locomotion({ rootMotion: { bone: 'Root', scale: 0 } })), /rootMotion\.scale must be a number from/);
  assert.throws(() => createAnimationGraph(locomotion({ rootMotion: { bone: 'Root', layer: 'nope' } })), /rootMotion\.layer names "nope", which is not a layer\. Layers: base/);
  const plain = createAnimationGraph({ ...locomotion(), rootMotion: undefined });
  assert.throws(() => plain.rootMotion, /graph\.rootMotion needs the rootMotion option/);
});

function fakeInput(forward) {
  return { getAxis: name => (name === 'moveForward' ? forward.value : 0), isHeld: () => false, wasPressed: () => false };
}

test('the controller moves by the root motion of the graph instead of its own speed', () => {
  const graph = createAnimationGraph(locomotion());
  const forward = { value: 1 };
  const controller = createCharacterController({ input: fakeInput(forward), walkSpeed: 3, rootMotion: () => graph.rootMotion.delta });
  for (let step = 0; step < 30; step++) controller.fixedUpdate(STEP);
  assert.equal(controller.state.grounded, true);
  const startZ = controller.state.position[2];
  let travelled = 0;
  for (let step = 0; step < 120; step++) {
    controller.fixedUpdate(STEP);
    graph.set('speed', controller.state.intentSpeed * 2.2 / 3);
    graph.advance(STEP);
    travelled += graph.rootMotion.distance;
  }
  // Intent is the full walk speed (3), mapped to the walk threshold; the walk clip travels 2 m per second, not 3.
  const moved = startZ - controller.state.position[2];
  close(moved, travelled, 0.05);
  assert.ok(moved > 3.5 && moved < 4.3, `moved ${moved}`);
  close(controller.state.position[0], 0, 1e-9);

  forward.value = 0;
  for (let step = 0; step < 30; step++) {
    controller.fixedUpdate(STEP);
    graph.set('speed', controller.state.intentSpeed);
    graph.advance(STEP);
  }
  const resting = controller.state.position[2];
  for (let step = 0; step < 30; step++) {
    controller.fixedUpdate(STEP);
    graph.set('speed', controller.state.intentSpeed);
    graph.advance(STEP);
  }
  close(controller.state.position[2], resting, 1e-9);
});

test('root motion follows the body yaw, and bad input is rejected', () => {
  const sideways = { rootMotion: () => [1, 0] };
  const controller = createCharacterController({ input: fakeInput({ value: 0 }), yaw: Math.PI / 2, ...sideways });
  for (let step = 0; step < 10; step++) controller.fixedUpdate(STEP);
  // Facing +X, the body's right is +Z.
  assert.ok(controller.state.position[2] > 0.1);
  close(controller.state.position[0], 0, 1e-6);
  assert.throws(() => createCharacterController({ input: fakeInput({ value: 0 }), rootMotion: 5 }), /rootMotion must be a function/);
  const broken = createCharacterController({ input: fakeInput({ value: 0 }), rootMotion: () => [NaN, 0] });
  for (let step = 0; step < 30; step++) {
    try { broken.fixedUpdate(STEP); } catch (error) {
      assert.match(error.message, /rootMotion must return \[x, z\] as finite numbers/);
      return;
    }
  }
  assert.fail('a non-finite root motion must throw once the body is grounded');
});

function crossfadeGraph(extraTransitions = {}) {
  return createAnimationGraph({
    clips: { idle: stillClip('spine'), walk: bendClip('spine', 30), run: bendClip('spine', 60, 0.5) },
    parameters: { toWalk: { type: 'trigger' }, toRun: { type: 'trigger' } },
    layers: [{
      name: 'base',
      states: [{ name: 'idle', clip: 'idle' }, { name: 'walk', clip: 'walk' }, { name: 'run', clip: 'run' }],
      transitions: [
        { from: 'idle', to: 'walk', when: [{ parameter: 'toWalk' }], duration: 1 },
        { from: 'walk', to: 'run', when: [{ parameter: 'toRun' }], duration: 0.5, ...extraTransitions },
      ],
    }],
  });
}

function weightsOf(graph) {
  return Object.fromEntries(graph.layerState('base').clips.map(entry => [entry.clip, entry.weight]));
}

test('an interrupting transition starts during a crossfade from the pose it had reached', () => {
  const graph = crossfadeGraph({ interrupt: true });
  graph.trigger('toWalk');
  for (let step = 0; step < 4; step++) graph.advance(0.1);
  graph.trigger('toRun');
  graph.advance(0);
  assert.equal(graph.layerState('base').state, 'run');
  assert.equal(graph.layerState('base').previousState, 'walk');
  const start = weightsOf(graph);
  close(start.idle, 0.6, 1e-9);
  close(start.walk, 0.4, 1e-9);
  assert.equal(start.run, undefined);
  graph.advance(0.1);
  const later = weightsOf(graph);
  close(later.idle, 0.48, 1e-9);
  close(later.walk, 0.32, 1e-9);
  close(later.run, 0.2, 1e-9);
  for (let step = 0; step < 5; step++) graph.advance(0.1);
  assert.deepEqual(Object.keys(weightsOf(graph)), ['run']);
  assert.equal(graph.layerState('base').fade, null);
});

test('without interrupt a transition still waits for the crossfade to end', () => {
  const graph = crossfadeGraph();
  graph.trigger('toWalk');
  for (let step = 0; step < 4; step++) graph.advance(0.1);
  graph.trigger('toRun');
  graph.advance(0.1);
  assert.equal(graph.layerState('base').state, 'walk');
  for (let step = 0; step < 6; step++) graph.advance(0.1);
  graph.advance(0.1);
  assert.equal(graph.layerState('base').state, 'run');
});

test('a chain of interruptions keeps the weights summing to 1 and the fading states bounded', () => {
  const states = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const graph = createAnimationGraph({
    clips: { idle: stillClip('spine'), walk: bendClip('spine', 30) },
    parameters: { next: { type: 'number' } },
    layers: [{
      name: 'base',
      states: states.map((name, index) => ({ name, clip: index % 2 ? 'walk' : 'idle' })),
      transitions: states.slice(1).map((name, index) => ({ to: name, when: [{ parameter: 'next', equals: index + 1 }], duration: 1, interrupt: true })),
    }],
  });
  for (let index = 1; index < states.length; index++) {
    graph.set('next', index);
    graph.advance(0.1);
    const total = graph.layerState('base').clips.reduce((sum, entry) => sum + entry.weight, 0);
    close(total, 1, 1e-9);
  }
  assert.equal(graph.layerState('base').state, 'g');
  assert.throws(() => createAnimationGraph({
    clips: { idle: stillClip('spine') },
    layers: [{ name: 'base', states: [{ name: 'a', clip: 'idle' }, { name: 'b', clip: 'idle' }], transitions: [{ to: 'b', exitPhase: 1, interrupt: 'yes' }] }],
  }), /transitions\[0\]\.interrupt must be true or false/);
});

// A quadruped: body and head over four legs of hip, knee and paw, with a root bone on the ground.
function quadrupedRig() {
  const joints = [];
  const add = (name, parent, translation) => {
    joints.push({ name, parent, translation, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    return joints.length - 1;
  };
  const root = add('Root', -1, [0, 0, 0]);
  const body = add('Body', root, [0, 0.9, 0]);
  const neck = add('Neck', body, [0, 0.2, 0.5]);
  add('Head', neck, [0, 0.2, 0.2]);
  for (const [leg, x, z] of [['FL', 0.2, 0.4], ['FR', -0.2, 0.4], ['BL', 0.2, -0.4], ['BR', -0.2, -0.4]]) {
    const hip = add(`Hip${leg}`, body, [x, 0, z]);
    const knee = add(`Knee${leg}`, hip, [0, -0.45, 0.02]);
    add(`Paw${leg}`, knee, [0, -0.45, -0.02]);
  }
  return { joints };
}

function quadrupedGraph() {
  const gait = createAnimationClip({
    duration: 0.8,
    loop: true,
    tracks: [
      { target: 'Root', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 0.8, value: [0, 0, 1.6] }] },
      { target: 'HipFL', property: 'rotation', keyframes: [{ time: 0, value: rotation([1, 0, 0], -20) }, { time: 0.4, value: rotation([1, 0, 0], 20) }, { time: 0.8, value: rotation([1, 0, 0], -20) }] },
    ],
  });
  return createAnimationGraph({
    rootMotion: { bone: 'Root' },
    clips: { stand: stillClip('Body'), trot: gait },
    parameters: { speed: { type: 'number' } },
    layers: [{ name: 'gait', states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'stand', threshold: 0 }, { clip: 'trot', threshold: 2 }] } }] }],
  });
}

test('a quadruped rig runs its own graph with root motion, foot placement and look-at', () => {
  const graph = quadrupedGraph();
  const rig = quadrupedRig();
  const lookTarget = [1.5, 1.4, 2];
  const foot = createFootPlacement({ root: 'HipBL', middle: 'KneeBL', end: 'PawBL', groundOffset: () => 0.15, ankleHeight: 0 });
  const look = createLookAt({ joints: ['Neck', 'Head'], forward: [0, 0, 1], target: lookTarget, maxAngle: 40 });
  const pose = createSkeletonPose({ rig, layers: graph.poseLayers(), ik: [foot, look] });
  graph.set('speed', 2);
  const total = runGraph(graph, 0.8);
  close(total[1], -1.6, 1e-6);
  pose.apply(graph.time);
  assert.equal(pose.jointWorld('Root').position[2], 0);
  assert.ok(pose.ikResults.every(result => Number.isFinite(result.error)));
  // The planted back-left paw is lifted onto the higher ground.
  close(pose.jointWorld('PawBL').position[1], 0.15, 1e-3);
  const headForward = vec3.transformQuat(new Float64Array(3), [0, 0, 1], pose.jointWorld('Head').rotation);
  assert.ok(headForward[0] > 0.2, `the head turned toward +x: ${headForward}`);
  const turned = Math.acos(Math.min(1, headForward[2])) * 180 / Math.PI;
  assert.ok(turned <= 40 + 1e-3, `the turn stays within maxAngle: ${turned}`);
});

test('foot placement lifts a planted foot, leaves a swinging foot and stays inside maxAdjust', () => {
  const solver = createFootPlacement({ root: 'a', middle: 'b', end: 'c', groundOffset: () => 1, ankleHeight: 0.1, liftHeight: 0.2, maxAdjust: 0.3, smoothSeconds: 0 });
  const planted = solver.target(0, [0, 0.1, 0]);
  close(planted[1], 0.4);
  const swinging = solver.target(1 / 60, [0, 0.5, 0]);
  close(swinging[1], 0.5, 1e-9);
  const eased = createFootPlacement({ root: 'a', middle: 'b', end: 'c', groundOffset: () => 0.2, smoothSeconds: 0.1 });
  close(eased.target(0, [0, 0, 0])[1], 0.2);
  const lowered = createFootPlacement({ root: 'a', middle: 'b', end: 'c', groundOffset: foot => (foot[0] > 0 ? 0.2 : 0), smoothSeconds: 0.1 });
  lowered.target(0, [0, 0, 0]);
  const partway = lowered.target(0.1, [1, 0, 0])[1];
  assert.ok(partway > 0.1 && partway < 0.2, `eased partway: ${partway}`);
});

test('IK hook mistakes name the field and the fix', () => {
  assert.throws(() => createFootPlacement({ root: 'a', middle: 'b', end: 'c' }), /groundOffset must be a function/);
  assert.throws(() => createFootPlacement({ middle: 'b', end: 'c', groundOffset: () => 0 }), /needs root: the joint name of the leg's hip/);
  assert.throws(() => createFootPlacement({ root: 'a', middle: 'b', end: 'c', groundOffset: () => 0, maxAdjust: -1 }), /maxAdjust must be a number from 0 to/);
  assert.throws(() => createFootPlacement({ root: 'a', middle: 'b', end: 'c', groundOffset: () => NaN }).target(0, [0, 0, 0]), /groundOffset must return a finite number/);
  assert.throws(() => createLookAt({ target: [0, 0, 0] }), /needs joints/);
  assert.throws(() => createLookAt({ joints: ['Head'], target: 'camera' }), /target must be a point/);
  assert.throws(() => createLookAt({ joints: ['Head'], target: [0, 0, 0], maxAngle: 200 }), /maxAngle must be a number from/);
  assert.throws(() => createLookAt({ joints: ['Head'], target: () => [1, 2] }).target(0, [0, 0, 0]), /target must return three finite numbers/);
});

test('the same step sequence gives the same IK pose', () => {
  function runOnce() {
    const graph = quadrupedGraph();
    const foot = createFootPlacement({ root: 'HipBL', middle: 'KneeBL', end: 'PawBL', groundOffset: paw => 0.1 * Math.sin(paw[2] * 5) + 0.1 });
    const pose = createSkeletonPose({ rig: quadrupedRig(), layers: graph.poseLayers(), ik: [foot] });
    graph.set('speed', 2);
    const positions = [];
    for (let step = 0; step < 30; step++) {
      graph.advance(STEP);
      pose.apply(graph.time);
      positions.push(...pose.jointWorld('PawBL').position);
    }
    return positions;
  }
  assert.deepEqual(runOnce(), runOnce());
});

test('a machine from the repo assets (the car) runs through the same graph', async () => {
  const asset = await parseGltf(carAsset());
  const wheelSpin = (name) => ({ target: name, property: 'rotation', keyframes: [{ time: 0, value: rotation([1, 0, 0], 0) }, { time: 0.5, value: rotation([1, 0, 0], 180) }, { time: 1, value: rotation([1, 0, 0], 359) }] });
  const drive = createAnimationClip({
    duration: 1,
    loop: true,
    tracks: [
      { target: 'Car', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 6] }] },
      wheelSpin('Wheel_FL'),
      wheelSpin('Wheel_FR'),
    ],
  });
  const graph = createAnimationGraph({
    rootMotion: { bone: 'Car' },
    clips: { park: stillClip('Car'), drive },
    parameters: { throttle: { type: 'number' } },
    layers: [{ name: 'drive', states: [{ name: 'go', blend: { parameter: 'throttle', motions: [{ clip: 'park', threshold: 0 }, { clip: 'drive', threshold: 1 }] } }] }],
  });
  const pose = createAssetPose(asset, { layers: graph.poseLayers() });
  graph.set('throttle', 1);
  const total = runGraph(graph, 0.5);
  close(total[1], -3, 1e-6);
  pose.apply(graph.time);
  const wheel = Array.from(pose.jointWorld('Wheel_FL').rotation);
  assert.ok(Math.abs(wheel[0]) > 0.5, `the wheel turned: ${wheel}`);
  close(pose.jointWorld('Car').position[2], 0, 1e-6);
});

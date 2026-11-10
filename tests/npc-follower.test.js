import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnimationClip } from '../src/animation.js';
import { createAnimationGraph, createPathFollower, NPC_FOLLOWER_LIMITS } from '../src/animation-graph.js';
import { createNavmesh } from '../src/navmesh.js';
import { createTerrain } from '../src/terrain.js';

const STEP = 1 / 60;
const CRUISE = 2;
const MAXIMUM_STEPS = 60 * 40;

function flatGround(size) {
  const terrain = createTerrain({ size, chunks: 1, levels: 1, resolution: 64, height: () => 0 });
  const { positions, indices } = terrain.parts[0].geometry;
  return { positions, indices };
}

// A 24 m square with a wall in the middle that the straight line from west to east would cross.
function wallNavmesh() {
  return createNavmesh({ ...flatGround(24), agentRadius: 0.4, obstacles: [{ min: [-1, -5], max: [1, 3] }] });
}

function stillClip(bone, duration) {
  return createAnimationClip({ duration, loop: true, tracks: [{ target: bone, property: 'rotation', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: duration, value: [0, 0, 0, 1] }] }] });
}

function travelClip(bone, metersPerSecond) {
  return createAnimationClip({
    duration: 1,
    loop: true,
    tracks: [{ target: bone, property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, metersPerSecond] }] }],
  });
}

// Idle and a walk that travels 2 m per second at parameter 2: the root travel is linear in the speed parameter.
function humanGraph() {
  return createAnimationGraph({
    rootMotion: { bone: 'Root' },
    clips: { idle: stillClip('Root', 1), walk: travelClip('Root', CRUISE) },
    parameters: { speed: { type: 'number' } },
    layers: [{ name: 'base', states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'walk', threshold: CRUISE }] } }] }],
  });
}

// The hand-built quadruped of tests/animation-root-motion.test.js: a trot that travels 2 m/s, with a leg swing.
function quadrupedGraph() {
  const gait = createAnimationClip({
    duration: 0.8,
    loop: true,
    tracks: [
      { target: 'Root', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 0.8, value: [0, 0, 1.6] }] },
      { target: 'HipFL', property: 'rotation', keyframes: [{ time: 0, value: [-0.17, 0, 0, 0.98] }, { time: 0.4, value: [0.17, 0, 0, 0.98] }, { time: 0.8, value: [-0.17, 0, 0, 0.98] }] },
    ],
  });
  return createAnimationGraph({
    rootMotion: { bone: 'Root' },
    clips: { stand: stillClip('Body', 0.8), trot: gait },
    parameters: { speed: { type: 'number' } },
    layers: [{ name: 'gait', states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'stand', threshold: 0 }, { clip: 'trot', threshold: 2 }] } }] }],
  });
}

// Walks the route and records, per step, the NPC's speed parameter, the distance it moved and the root motion it was given.
function walk(graph, navmesh, from, goal, options = {}) {
  const follower = createPathFollower({ graph, navmesh, position: [from[0], 0, from[1]], cruiseSpeed: CRUISE, ...options });
  follower.goTo(goal);
  const route = navmesh.findPath(from, goal, { spacing: 1e6 }).points;
  const samples = [];
  let previousRootDistance = 0;
  let steps = 0;
  while (follower.state.status === 'moving' && steps < MAXIMUM_STEPS) {
    follower.step(STEP);
    samples.push({
      position: [...follower.state.position],
      speed: follower.state.speed,
      moved: follower.state.lastMove,
      rootDistance: previousRootDistance,
      parameter: graph.get('speed'),
    });
    graph.advance(STEP);
    previousRootDistance = graph.rootMotion.distance;
    steps += 1;
  }
  return { follower, route, samples, steps };
}

test('an NPC walks around an obstacle to the goal, on the navmesh, within a time bound', () => {
  const navmesh = wallNavmesh();
  const { follower, route, samples, steps } = walk(humanGraph(), navmesh, [-9, 0], [9, 0]);
  assert.equal(route.length > 2, true, 'the route bends around the wall');
  assert.equal(follower.state.status, 'arrived');
  const goalError = Math.hypot(follower.state.position[0] - 9, follower.state.position[2] - 0);
  assert.ok(goalError <= 0.15, `stopped ${goalError} m from the goal`);
  const routeLength = route.slice(1).reduce((total, point, index) => total + Math.hypot(point[0] - route[index][0], point[2] - route[index][2]), 0);
  assert.ok(steps * STEP <= routeLength / (CRUISE * 0.5) + 4, `took ${steps * STEP} s for ${routeLength} m`);
  for (const sample of samples) assert.ok(navmesh.isWalkable(sample.position[0], sample.position[2]), `left the navmesh at ${sample.position}`);
  assert.equal(follower.state.blockedSteps, 0);
});

test('the speed parameter slows into corners and into the arrival, and reaches cruise on the straights', () => {
  const navmesh = wallNavmesh();
  const { route, samples, follower } = walk(humanGraph(), navmesh, [-9, 0], [9, 0]);
  const peak = Math.max(...samples.map(sample => sample.speed));
  assert.ok(peak >= CRUISE * 0.95, `cruise reached: ${peak}`);
  for (const sample of samples) assert.equal(sample.parameter, sample.speed);
  const corners = route.slice(1, -1);
  assert.ok(corners.length >= 2);
  for (const [index, corner] of corners.entries()) {
    const before = route[index];
    const after = route[index + 2];
    const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(after[0] - corner[0], after[2] - corner[2]) - Math.atan2(corner[0] - before[0], corner[2] - before[2])), Math.cos(Math.atan2(after[0] - corner[0], after[2] - corner[2]) - Math.atan2(corner[0] - before[0], corner[2] - before[2]))));
    const near = samples.filter(sample => Math.hypot(sample.position[0] - corner[0], sample.position[2] - corner[2]) < 0.6);
    assert.ok(near.length > 0);
    const slowest = Math.min(...near.map(sample => sample.speed));
    assert.ok(turn > 0.3, `corner ${index} turns ${turn} rad`);
    assert.ok(slowest < CRUISE * (1 - 0.5 * turn / Math.PI) + 0.01, `corner ${corner} turning ${turn} rad passed at ${slowest}`);
  }
  const lastSecond = samples.slice(-15);
  assert.ok(Math.max(...lastSecond.map(sample => sample.speed)) < CRUISE * 0.5, 'eases in to the goal');
  assert.equal(follower.state.speed, 0);
  assert.equal(follower.state.status, 'arrived');
});

test('the distance moved each step matches the root motion of the graph, so the feet do not slide', () => {
  const { samples } = walk(humanGraph(), wallNavmesh(), [-9, 0], [9, 0]);
  let largestError = 0;
  let movedTotal = 0;
  let rootTotal = 0;
  for (const sample of samples) {
    largestError = Math.max(largestError, Math.abs(sample.moved - sample.rootDistance));
    movedTotal += sample.moved;
    rootTotal += sample.rootDistance;
  }
  assert.ok(largestError < 1e-9, `per-step difference ${largestError}`);
  assert.ok(Math.abs(movedTotal - rootTotal) < 1e-6);
  assert.ok(movedTotal > 18, `moved ${movedTotal} m`);
});

test('the same steps give the same walk, and a start that is inside the wall is refused with a reason', () => {
  const navmesh = wallNavmesh();
  const first = walk(humanGraph(), navmesh, [-9, 0], [9, 0]);
  const second = walk(humanGraph(), navmesh, [-9, 0], [9, 0]);
  assert.deepEqual(first.samples, second.samples);
  const follower = createPathFollower({ graph: humanGraph(), navmesh, position: [0, 0, 0] });
  assert.throws(() => follower.goTo([9, 0]), /Start .* not walkable/);
});

test('a quadruped follows the same path through its own graph', () => {
  const navmesh = wallNavmesh();
  const { follower, samples } = walk(quadrupedGraph(), navmesh, [-9, 6], [9, -6]);
  assert.equal(follower.state.status, 'arrived');
  for (const sample of samples) {
    assert.ok(navmesh.isWalkable(sample.position[0], sample.position[2]));
    assert.ok(Math.abs(sample.moved - sample.rootDistance) < 1e-9, `${sample.moved} vs ${sample.rootDistance} at ${sample.position}`);
  }
});

test('a blocked step slides along the edge of the navmesh instead of leaving it', () => {
  const navmesh = wallNavmesh();
  const graph = humanGraph();
  const follower = createPathFollower({ graph, navmesh, position: [-9, 0, 0], cruiseSpeed: CRUISE });
  follower.follow([[-9, 0], [-0.5, 0]]); // A route straight at the wall, which the navmesh would never give.
  for (let step = 0; step < 600; step++) {
    follower.step(STEP);
    graph.advance(STEP);
    assert.ok(navmesh.isWalkable(follower.state.position[0], follower.state.position[2]));
  }
  assert.ok(follower.state.blockedSteps > 0);
});

test('stop returns the NPC to idle and a path that is not a list is refused', () => {
  const graph = humanGraph();
  const follower = createPathFollower({ graph, position: [0, 0, 0] });
  follower.follow([[0, 0], [10, 0]]);
  follower.step(STEP);
  graph.advance(STEP);
  assert.ok(graph.get('speed') > 0);
  follower.stop();
  assert.equal(graph.get('speed'), 0);
  assert.equal(follower.state.status, 'idle');
  assert.throws(() => follower.follow('north'), /needs a list of 1 to 256 points/);
  assert.throws(() => follower.follow([[0, 'a']]), /path point 0 must be \[x, z\]/);
  assert.throws(() => follower.follow(new Array(NPC_FOLLOWER_LIMITS.maximumWaypoints + 1).fill([0, 0])), /1 to 256 points/);
  assert.throws(() => follower.goTo([1, 1]), /goTo needs the navmesh option/);
});

test('option mistakes name the option and the fix', () => {
  const graph = humanGraph();
  assert.throws(() => createPathFollower({}), /graph must be an animation graph/);
  assert.throws(() => createPathFollower({ graph, parameter: 'pace' }), /pace/);
  assert.throws(() => createPathFollower({ graph, cruiseSpeed: -1 }), /cruiseSpeed must be a number above 0/);
  assert.throws(() => createPathFollower({ graph, cruiseSpeed: 1, minimumSpeed: 2 }), /minimumSpeed must not exceed cruiseSpeed/);
  assert.throws(() => createPathFollower({ graph, position: [0, 0] }), /position must be \[x, y, z\]/);
  assert.throws(() => createPathFollower({ graph, navmesh: {} }), /navmesh must come from createNavmesh/);
  const withoutRootMotion = createAnimationGraph({ clips: { idle: stillClip('Root', 1) }, parameters: { speed: { type: 'number' } }, layers: [{ name: 'base', states: [{ name: 'a', clip: 'idle' }] }] });
  assert.throws(() => createPathFollower({ graph: withoutRootMotion }), /rootMotion option/);
});

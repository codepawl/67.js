import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bakePhysicsScene, loadPhysicsEngine } from '../src/physics.js';
import { createPhysicsSystem } from '../src/physics-runtime.js';

const SEA = { windSpeed: 4.5, choppiness: 0.4, size: 30, seed: 5, resolution: 5 };
const FRAMES_PER_SECOND = 60;
const HULL_HALF_EXTENTS = [0.9, 0.35, 1.9];

function boatDefinition(boat = {}, ocean = SEA) {
  const points = [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]];
  return {
    ocean,
    bodies: [{ name: 'boat', translation: [0, 0.2, 0], float: { drag: 1.5, angularDrag: 3, points, boat } }],
    colliders: [{ name: 'boat', body: 'boat', shape: 'cuboid', halfExtents: HULL_HALF_EXTENTS, density: 300 }],
  };
}

function bake(boat, seconds, ocean) {
  return bakePhysicsScene(boatDefinition(boat, ocean), { frameCount: Math.round(seconds * FRAMES_PER_SECOND) + 1 });
}

// The bow points to -z in body space; yaw 0 faces -z and grows toward +x, as for the player controllers.
function headingOf(pose) {
  const [x, y, z, w] = [pose[3], pose[4], pose[5], pose[6]];
  const forwardX = -2 * (x * z + w * y);
  const forwardZ = -(1 - 2 * (x * x + y * y));
  return Math.atan2(forwardX, -forwardZ);
}

function rollOf(pose) {
  const [x, y, z, w] = [pose[3], pose[4], pose[5], pose[6]];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
}

function digest(scene, seconds) {
  const hash = createHash('sha256');
  for (let frame = 0; frame <= seconds * FRAMES_PER_SECOND; frame++) {
    hash.update(Buffer.from(scene.sample(frame / FRAMES_PER_SECOND).buffer.slice(0)));
  }
  return hash.digest('hex');
}

test.before(() => loadPhysicsEngine({ buoyancy: true }));

test('throttle drives the hull forward along its bow and reverse drives it back', () => {
  const ahead = bake({ controls: [{ time: 0, throttle: 1 }] }, 6);
  const aheadPose = ahead.sample(6);
  assert.ok(aheadPose[2] < -6, `moved ${aheadPose[2]} m along -z in 6 s`);
  assert.ok(Math.abs(aheadPose[0]) < 0.5, `drifted ${aheadPose[0]} m sideways`);
  const astern = bake({ controls: [{ time: 0, throttle: -1 }] }, 6);
  assert.ok(astern.sample(6)[2] > 2, 'reverse moves toward +z');
  const idle = bake({}, 6).sample(6);
  assert.ok(Math.hypot(idle[0], idle[2]) < 0.5, 'no throttle leaves the hull where it floats');
});

test('rudder turns the hull: positive to the right, negative to the left, none keeps the heading', () => {
  const headingAfter = rudder => headingOf(bake({ controls: [{ time: 0, throttle: 1, rudder }] }, 2.5).sample(2.5));
  assert.ok(headingAfter(1) > 0.5, 'right rudder turns toward +x');
  assert.ok(headingAfter(-1) < -0.5, 'left rudder turns toward -x');
  assert.ok(Math.abs(headingAfter(0)) < 0.15, 'no rudder holds the heading');
});

test('the hull still bobs and rolls on the waves while it drives and turns', () => {
  const scene = bake({ controls: [{ time: 0, throttle: 1, rudder: 0.5 }] }, 8);
  const heights = [];
  const rolls = [];
  for (let time = 2; time <= 8; time += 1 / 30) {
    const pose = scene.sample(time);
    heights.push(pose[1]);
    rolls.push(rollOf(pose));
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.05, 'the hull rises and falls with the sea');
  assert.ok(Math.max(...rolls) - Math.min(...rolls) > 0.01, 'the hull rolls with the sea');
});

test('the bake is identical across runs and keyframes are interpolated', () => {
  const boat = { controls: [{ time: 0, throttle: 0 }, { time: 1, throttle: 1, rudder: 0 }, { time: 3, throttle: 1, rudder: 0.7 }] };
  assert.equal(digest(bake(boat, 5), 5), digest(bake(boat, 5), 5));
  const other = { controls: [{ time: 0, throttle: 0 }, { time: 1, throttle: 1, rudder: 0 }, { time: 3, throttle: 1, rudder: -0.7 }] };
  assert.notEqual(digest(bake(boat, 5), 5), digest(bake(other, 5), 5));
});

test('a live system takes throttle and rudder from setBoatControls and turns like the bake', async () => {
  const system = await createPhysicsSystem(boatDefinition());
  system.setBoatControls('boat', { throttle: 1, rudder: 1 });
  for (let step = 0; step < 2.5 * FRAMES_PER_SECOND; step++) system.fixedUpdate(1 / FRAMES_PER_SECOND, { mode: 'fixed' });
  const { translation, rotation } = system.getPose('boat');
  assert.ok(translation[2] < -3, `moved ${translation[2]} m forward`);
  assert.ok(headingOf([...translation, ...rotation]) > 0.5, 'right rudder turns the live hull to the right');
  system.dispose();
});

test('boat fields fail with the field name and what to pass', () => {
  const field = boat => () => bake(boat, 0.1);
  assert.throws(field({ thrust: -1 }), /body boat\.float\.boat\.thrust must be a number from 0 to 100, such as 4/);
  assert.throws(field({ forward: 'up' }), /float\.boat\.forward must be one of \+x, -x, \+z, -z/);
  assert.throws(field({ stern: [0, 1] }), /float\.boat\.stern must be \[x, y, z\]/);
  assert.throws(field({ speed: 3 }), /float\.boat\.speed is unsupported; use one of thrust/);
  assert.throws(field({ controls: [{ time: 1, throttle: 2 }] }), /controls\[0\]\.throttle must be a number from -1 to 1/);
  assert.throws(field({ controls: [{ time: 1 }, { time: 1 }] }), /controls\[1\]\.time must be above the previous keyframe time 1/);
  assert.throws(field({ controls: Array.from({ length: 257 }, (_, index) => ({ time: index })) }), /at most 256 keyframes/);
  assert.throws(field({ wake: { width: 0 } }), /boat\.wake\.width must be a number from 0\.05 to 100/);
});

test('setBoatControls names the body and the range when it cannot apply', async () => {
  const plain = await createPhysicsSystem({ ocean: SEA, bodies: [{ name: 'crate', translation: [0, 1, 0], float: {} }], colliders: [{ name: 'crate', body: 'crate', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], density: 400 }] });
  assert.throws(() => plain.setBoatControls('crate', { throttle: 1 }), /"crate" has none\. Add float: \{ boat: \{\} \}/);
  plain.dispose();
  const system = await createPhysicsSystem(boatDefinition());
  assert.throws(() => system.setBoatControls('boat', { throttle: 2 }), /setBoatControls\("boat"\) throttle must be a number from -1 to 1/);
  assert.throws(() => system.setBoatControls('ship', {}), /names no body: "ship"/);
  system.dispose();
});

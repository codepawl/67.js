import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkeletonPose } from '../src/skeleton-pose.js';
import {
  MAX_SPRING_CHAINS, SPRING_STEP_SECONDS, normalizeSpringBones, springChainSolver,
} from '../src/spring-bones.js';

const FRAME = 1 / 30;

// A hips joint with a tail of four bones along -Z, 0.3 long each, plus a body joint for colliders to ride on.
function tailRig() {
  const joint = (name, parent, translation) => ({ name, parent, translation, rotation: [0, 0, 0, 1] });
  return {
    mapping: {},
    joints: [
      joint('hips', -1, [0, 1, 0]),
      joint('tail1', 0, [0, 0, -0.3]),
      joint('tail2', 1, [0, 0, -0.3]),
      joint('tail3', 2, [0, 0, -0.3]),
      joint('tailEnd', 3, [0, 0, -0.3]),
      joint('body', 0, [0, 0, 0]),
    ],
  };
}

const NODES = ['hips', 'tail1', 'tail2', 'tail3', 'tailEnd', 'body'];
const RIG = tailRig();
const HIERARCHY = RIG.joints.map(entry => ({ id: entry.name, parent: entry.parent < 0 ? null : RIG.joints[entry.parent].name }));
const OPTIONS = { movable: new Set(NODES), visible: new Set(NODES), hierarchy: HIERARCHY };

function springs(overrides = {}, colliders = []) {
  return normalizeSpringBones({ chains: [{ bones: ['tail1', 'tail2', 'tail3'], ...overrides }], colliders }, OPTIONS);
}

function poseWith(normalized) {
  return createSkeletonPose({
    rig: tailRig(),
    ik: normalized.chains.map(chain => ({ type: 'custom', create: springChainSolver(chain, normalized.colliders) })),
  });
}

// The hips slide 1 m along +X between 0.5 s and 0.75 s, then stand still.
function hipsX(time) {
  return Math.min(1, Math.max(0, (time - 0.5) / 0.25));
}

function playTail(normalized, seconds, hipPath = hipsX) {
  const pose = poseWith(normalized);
  const frames = [];
  for (let frame = 0; frame * FRAME <= seconds + 1e-9; frame++) {
    const time = frame * FRAME;
    pose.apply(time, (rotations, translations) => {
      translations[0][0] = hipPath(time);
    });
    frames.push({
      time,
      hips: pose.jointWorld('hips').position,
      tip: pose.jointWorld('tailEnd').position,
      points: ['tail2', 'tail3', 'tailEnd'].map(name => pose.jointWorld(name).position),
    });
  }
  return frames;
}

test('a tail lags the hips, overshoots, then settles on the animated pose', () => {
  const frames = playTail(springs({ stiffness: 2, dragForce: 0.05 }), 8);
  const lagging = frames.find(frame => frame.time > 0.6 && frame.time < 0.8);
  assert.ok(lagging.tip[0] < lagging.hips[0] - 0.05, `tip at ${lagging.tip[0]} should trail the hips at ${lagging.hips[0]}`);
  const overshoot = Math.max(...frames.map(frame => frame.tip[0] - frame.hips[0]));
  assert.ok(overshoot > 0.02, `tip should swing past the hips, got ${overshoot}`);
  const last = frames[frames.length - 1];
  assert.ok(Math.abs(last.tip[0] - last.hips[0]) < 0.01, `tip should settle under the hips, off by ${last.tip[0] - last.hips[0]}`);
  assert.ok(Math.abs(last.tip[2] + 1.2) < 0.01, 'the tail keeps its length');
});

test('the same times give the same pose, bit for bit', () => {
  const first = playTail(springs({ stiffness: 1.5, dragForce: 0.2, gravityPower: 0.5 }), 3);
  const second = playTail(springs({ stiffness: 1.5, dragForce: 0.2, gravityPower: 0.5 }), 3);
  assert.deepEqual(second, first);
});

test('a still root does not make the tail drift', () => {
  const frames = playTail(springs({ stiffness: 1, dragForce: 0.4 }), 4, () => 0);
  for (const frame of frames) {
    assert.ok(Math.abs(frame.tip[0]) < 1e-12 && Math.abs(frame.tip[1] - 1) < 1e-12 && Math.abs(frame.tip[2] + 1.2) < 1e-9, `drifted to ${frame.tip}`);
  }
});

test('gravity bends the tail down and the bones keep their length', () => {
  const frames = playTail(springs({ stiffness: 0.5, gravityPower: 1 }), 4, () => 0);
  const last = frames[frames.length - 1];
  assert.ok(last.tip[1] < 0.9, `gravity should lower the tip, got y ${last.tip[1]}`);
  const [second, third, tip] = last.points;
  const gap = (from, to) => Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  assert.ok(Math.abs(gap(second, third) - 0.3) < 1e-9 && Math.abs(gap(third, tip) - 0.3) < 1e-9, 'each bone keeps its length');
});

test('a sphere collider keeps the sagging tail outside it', () => {
  const colliders = [{ id: 'ball', bone: 'body', type: 'sphere', offset: [0, -0.55, -0.3], radius: 0.4 }];
  const free = playTail(springs({ stiffness: 0.2, gravityPower: 1.5 }), 4, () => 0);
  const blocked = playTail(springs({ stiffness: 0.2, gravityPower: 1.5, hitRadius: 0.05, colliders: ['ball'] }, colliders), 4, () => 0);
  const clearance = point => Math.hypot(point[0], point[1] - 0.45, point[2] + 0.3);
  assert.ok(free[free.length - 1].points.every(point => clearance(point) < 0.4), 'without the collider the tail hangs through the ball');
  for (const frame of blocked.slice(10)) {
    for (const point of frame.points) assert.ok(clearance(point) >= 0.45 - 0.02, `point ${point} is inside the collider`);
  }
});

test('a capsule collider keeps the tail outside along its whole length', () => {
  const colliders = [{ id: 'log', bone: 'body', type: 'capsule', offset: [-0.5, -0.6, -0.3], tail: [0.5, -0.6, -0.3], radius: 0.15 }];
  const blocked = playTail(springs({ stiffness: 0.2, gravityPower: 1.5, hitRadius: 0, colliders: ['log'] }, colliders), 4, () => 0);
  for (const frame of blocked.slice(10)) {
    for (const point of frame.points) {
      assert.ok(Math.hypot(point[1] - 0.4, point[2] + 0.3) >= 0.15 - 0.01, `point ${point} is inside the capsule`);
    }
  }
});

test('going back in time or a long gap restarts from the animated pose', () => {
  const pose = poseWith(springs({ stiffness: 2, dragForce: 0.05 }));
  const tipAt = time => {
    pose.apply(time, (rotations, translations) => {
      translations[0][0] = hipsX(time);
    });
    return pose.jointWorld('tailEnd').position;
  };
  for (let frame = 0; frame * FRAME < 0.7; frame++) tipAt(frame * FRAME);
  assert.ok(tipAt(0.7)[0] < 0.65, 'the tip trails the hips');
  assert.ok(Math.abs(tipAt(0.2)[0]) < 1e-12, 'a step back restarts at the animated pose');
  assert.ok(Math.abs(tipAt(5)[0] - 1) < 1e-12, 'a gap over half a second restarts at the animated pose');
});

test('the step is fixed at 1/60 s', () => {
  assert.equal(SPRING_STEP_SECONDS, 1 / 60);
});

test('a chain must list its bones from root to tip', () => {
  assert.throws(() => springs({ bones: ['tail1', 'tail3'] }), /motion\.springs\.chains\[0\]\.bones\[1\]: got "tail3"; expected the child of tail1/);
  assert.throws(() => springs({ bones: ['tail2', 'tail1'] }), /expected the child of tail2/);
});

test('fields are bounded and errors name the field and what to pass', () => {
  assert.throws(() => springs({ stiffness: 9 }), /motion\.springs\.chains\[0\]\.stiffness: got 9; expected a number from 0 to 4/);
  assert.throws(() => springs({ dragForce: -1 }), /dragForce: got -1; expected a number from 0 to 1/);
  assert.throws(() => springs({ gravityDir: [0, 0, 0] }), /gravityDir: got \[0,0,0\]; expected a direction that is not zero/);
  assert.throws(() => springs({ bones: [] }), /bones: got \[\]; expected one to 16 node IDs/);
  assert.throws(() => springs({ bones: ['nowhere'] }), /bones\[0\]: got "nowhere"; expected a node ID in this recipe/);
  assert.throws(() => springs({ colliders: ['missing'] }), /colliders: got "missing"; expected an ID listed in motion\.springs\.colliders/);
  assert.throws(() => springs({ speed: 1 }), /Unknown or unsupported motion\.springs\.chains\[0\] field: speed/);
  assert.throws(() => springs({}, [{ id: 'a b', bone: 'body', radius: 1 }]), /colliders\[0\]\.id: got "a b"/);
  assert.throws(() => springs({}, [{ id: 'cap', bone: 'body', type: 'capsule', radius: 1 }]), /colliders\[0\]\.tail: got undefined; expected the capsule's second end/);
  assert.throws(() => springs({}, [{ id: 'ball', bone: 'body', radius: 0 }]), /colliders\[0\]\.radius: got 0; expected a number from 0\.0001 to 100/);
});

test('chain counts, bones in total and duplicate bones are bounded', () => {
  const chains = Array.from({ length: MAX_SPRING_CHAINS + 1 }, () => ({ bones: ['tail1'] }));
  assert.throws(() => normalizeSpringBones({ chains }, OPTIONS), /motion\.springs\.chains must be a bounded dense array/);
  assert.throws(() => normalizeSpringBones({ chains: [{ bones: ['tail1'] }, { bones: ['tail1'] }] }, OPTIONS), /chains\[1\]\.bones\[0\]: got "tail1"; expected a bone that no other chain uses/);
  assert.throws(() => normalizeSpringBones({ chains: [] }, OPTIONS), /chains: got \[\]; expected one to 16 chains/);
  const longChain = { bones: Array.from({ length: 17 }, (_, index) => `bone${index}`) };
  assert.throws(() => normalizeSpringBones({ chains: [longChain] }, OPTIONS), /bones must be a bounded dense array/);
});

test('a bone with no child uses a virtual tip of tipLength and stays still at rest', () => {
  const frames = playTail(springs({ bones: ['tailEnd'], tipLength: 0.5, stiffness: 1 }), 1, () => 0);
  assert.deepEqual(frames[frames.length - 1].tip, frames[0].tip);
});

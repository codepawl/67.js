import test from 'node:test';
import assert from 'node:assert/strict';
import { quat, vec3 } from 'gl-matrix';
import { SETTLE_LIMITS, normalizeSettle, settleInstances, settleProps } from '../src/settle.js';

await settleProps({ colliders: [{ shape: 'box', halfExtents: [1, 1, 1] }], area: { min: [-0.5, -0.5], max: [0.5, 0.5] }, count: 1 });

const BIN_WALLS = [
  { shape: 'box', translation: [0, -0.1, 0], halfExtents: [1.2, 0.1, 1.2] },
  { shape: 'box', translation: [-1.1, 0.5, 0], halfExtents: [0.1, 0.6, 1.2] },
  { shape: 'box', translation: [1.1, 0.5, 0], halfExtents: [0.1, 0.6, 1.2] },
  { shape: 'box', translation: [0, 0.5, -1.1], halfExtents: [1.2, 0.6, 0.1] },
  { shape: 'box', translation: [0, 0.5, 1.1], halfExtents: [1.2, 0.6, 0.1] },
];

function corners(instance, shift = [0, 0, 0]) {
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => vec3.transformQuat(vec3.create(), axis, instance.rotation));
  return { center: vec3.add(vec3.create(), instance.translation, shift), axes, half: instance.size.map(edge => edge / 2) };
}

function oriented(collider) {
  return { center: collider.translation, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(axis => vec3.transformQuat(vec3.create(), axis, collider.rotation ?? quat.create())), half: collider.halfExtents };
}

/** Largest penetration depth of two oriented boxes by the separating axis test; zero or less means they do not overlap. */
function penetration(first, second) {
  const axes = [...first.axes, ...second.axes];
  for (const a of first.axes) for (const b of second.axes) axes.push(vec3.cross(vec3.create(), a, b));
  const between = vec3.sub(vec3.create(), second.center, first.center);
  let shallowest = Infinity;
  for (const axis of axes) {
    const length = vec3.length(axis);
    if (length < 1e-6) continue;
    const direction = vec3.scale(vec3.create(), axis, 1 / length);
    const radius = box => box.axes.reduce((sum, boxAxis, index) => sum + Math.abs(vec3.dot(boxAxis, direction)) * box.half[index], 0);
    shallowest = Math.min(shallowest, radius(first) + radius(second) - Math.abs(vec3.dot(between, direction)));
  }
  return shallowest;
}

const bin = settings => ({ colliders: BIN_WALLS, area: { min: [-1, -1], max: [1, 1] }, size: [0.1, 0.2], seed: 1, ...settings });

test('200 boxes settle into a bin without overlap or floating', () => {
  const { instances, report } = settleInstances(bin({ count: 200, duration: 5 }));
  assert.equal(instances.length, 200, JSON.stringify(report));
  assert.equal(report.fellOff, 0);
  assert.equal(report.unsettled, 0);
  const boxes = instances.map(instance => corners({ ...instance, rotation: instance.rotation }));
  const walls = BIN_WALLS.map(oriented);
  boxes.forEach((box, index) => {
    for (let other = index + 1; other < boxes.length; other++) {
      assert.ok(penetration(box, boxes[other]) < 0.02, `boxes ${index} and ${other} overlap`);
    }
    for (const wall of walls) assert.ok(penetration(box, wall) < 0.02, `box ${index} sinks into a wall`);
    // Resting under gravity means touching something: moved down a little, the box must meet a neighbour or the floor.
    const lowered = corners(instances[index], [0, -0.03, 0]);
    const supported = walls.some(wall => penetration(lowered, wall) > 0) || boxes.some((other, otherIndex) => otherIndex !== index && penetration(lowered, other) > 0);
    assert.ok(supported, `box ${index} floats`);
  });
});

test('the same seed gives the same transforms byte for byte, another seed does not', () => {
  const first = settleInstances(bin({ count: 40 }));
  const second = settleInstances(bin({ count: 40 }));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const other = settleInstances(bin({ count: 40, seed: 8 }));
  assert.notEqual(JSON.stringify(first.instances), JSON.stringify(other.instances));
});

test('props never start inside each other or the colliders', () => {
  const { report } = settleInstances(bin({ count: 60, spacing: 0.05 }));
  assert.equal(report.placed + report.fellOff, 60);
});

test('max slope keeps props off steep ground and density sets the count', () => {
  const ramp = { shape: 'box', translation: [0, 0, 0], rotation: Array.from(quat.fromEuler(quat.create(), 0, 0, 40)), halfExtents: [3, 0.1, 3] };
  const gentle = { ...ramp, rotation: Array.from(quat.fromEuler(quat.create(), 0, 0, 15)) };
  const steep = settleInstances({ colliders: [ramp], area: { min: [-1, -1], max: [1, 1] }, count: 10, maxSlope: 30 });
  assert.equal(steep.instances.length, 0);
  assert.ok(steep.report.skipped.tooSteep > 0);
  const allowed = settleInstances({ colliders: [gentle], area: { min: [-1, -1], max: [1, 1] }, count: 5, maxSlope: 30, friction: 2 });
  assert.equal(allowed.instances.length, 5);
  const dense = normalizeSettle({ colliders: BIN_WALLS, area: { min: [0, 0], max: [2, 2] }, density: 10 });
  assert.equal(dense.count, 40);
});

test('props stack on earlier settled props listed as colliders', () => {
  const first = settleInstances({ colliders: [BIN_WALLS[0]], area: { min: [-0.3, -0.3], max: [0.3, 0.3] }, count: 6, size: [0.2, 0.25], seed: 3 });
  const earlier = first.instances.map(instance => ({ shape: 'box', translation: instance.translation, rotation: instance.rotation, halfExtents: instance.size.map(edge => edge / 2) }));
  const second = settleInstances({ colliders: [BIN_WALLS[0], ...earlier], area: { min: [-0.3, -0.3], max: [0.3, 0.3] }, count: 6, size: [0.2, 0.25], seed: 4 });
  const topOfFirst = Math.max(...first.instances.map(instance => instance.translation[1]));
  assert.ok(second.instances.some(instance => instance.translation[1] > topOfFirst), 'some props rest on the earlier layer');
});

test('listed instances skip the ones that start overlapping and balls settle too', () => {
  const result = settleInstances({
    colliders: [BIN_WALLS[0]], shape: 'ball',
    instances: [{ translation: [0, 0.5, 0], size: 0.2 }, { translation: [0, 0.55, 0], size: 0.2 }, { translation: [0.5, 0.5, 0.5], size: 0.2 }],
  });
  assert.equal(result.report.skipped.overlap, 1);
  assert.equal(result.instances.length, 2);
  for (const instance of result.instances) assert.ok(Math.abs(instance.translation[1] - 0.1) < 0.02, `ball rests on the floor top, got ${instance.translation[1]}`);
});

test('bad settings fail with the field and what to pass', () => {
  assert.throws(() => normalizeSettle({ colliders: [], area: { min: [0, 0], max: [1, 1] }, count: 1 }), /settle\.colliders/);
  assert.throws(() => normalizeSettle({ colliders: BIN_WALLS, area: { min: [0, 0], max: [1, 1] }, count: SETTLE_LIMITS.maxProps + 1 }), /settle\.count.*256/);
  assert.throws(() => normalizeSettle({ colliders: BIN_WALLS, area: { min: [0, 0], max: [1, 1] } }), /count \(props\) or density/);
  assert.throws(() => normalizeSettle({ colliders: BIN_WALLS, area: { min: [0, 0], max: [1, 1] }, count: 3, duration: 60 }), /settle\.duration/);
  assert.throws(() => normalizeSettle({ colliders: BIN_WALLS, area: { min: [0, 0], max: [1, 1] }, count: 3, bounce: 1 }), /settle\.bounce/);
  assert.throws(() => normalizeSettle({ colliders: BIN_WALLS, instances: [{ translation: [0, 1, 0], size: [1, 1, 1] }], count: 3 }), /settle\.count/);
});

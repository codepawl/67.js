import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { box, sphere } from '../src/geometry.js';
import { fractureMesh, fragmentPhysics } from '../src/fracture.js';
import { createPhysicsScene } from '../src/physics.js';

const wall = () => {
  const source = box(0);
  for (let index = 0; index < source.positions.length; index += 3) {
    source.positions[index] *= 3;
    source.positions[index + 1] *= 2;
    source.positions[index + 2] *= 0.4;
  }
  return source;
};

function fingerprint(fracture) {
  const hash = createHash('sha256');
  for (const fragment of fracture.fragments) {
    hash.update(Buffer.from(fragment.positions.buffer));
    hash.update(Buffer.from(fragment.indices.buffer));
    hash.update(JSON.stringify(fragment.groups));
  }
  return hash.digest('hex');
}

test('the same seed gives the same fragments byte for byte and a new seed gives others', () => {
  const first = fractureMesh(wall(), { seed: 7, cells: 12 });
  const second = fractureMesh(wall(), { seed: 7, cells: 12 });
  const other = fractureMesh(wall(), { seed: 8, cells: 12 });
  assert.equal(first.fragments.length, 12);
  assert.equal(fingerprint(first), fingerprint(second));
  assert.notEqual(fingerprint(first), fingerprint(other));
});

test('fragment volumes sum to the source volume within 1 percent', () => {
  for (const source of [wall(), box(), sphere(24, 16)]) {
    const fracture = fractureMesh(source, { seed: 3, cells: 16 });
    const total = fracture.fragments.reduce((sum, fragment) => sum + fragment.volume, 0);
    assert.ok(Math.abs(total - fracture.volume) / fracture.volume < 0.01, `${total} against ${fracture.volume}`);
    assert.ok(fracture.fragments.every(fragment => fragment.volume > 0));
  }
});

test('inside faces sit on their own material slot after the outside faces', () => {
  const fracture = fractureMesh(wall(), { seed: 1, cells: 6 });
  for (const fragment of fracture.fragments) {
    assert.deepEqual(fragment.groups.map(group => group.slot), [0, 1]);
    const [outside, inside] = fragment.groups;
    assert.equal(outside.start, 0);
    assert.equal(inside.start, outside.count);
    assert.equal(outside.count + inside.count, fragment.indices.length);
  }
});

test('an impact point packs smaller cells near it', () => {
  const impact = [1.2, 0.5, 0];
  const spread = fractureMesh(wall(), { seed: 5, cells: 24 });
  const packed = fractureMesh(wall(), { seed: 5, cells: 24, impact, impactRadius: 0.6 });
  const near = fracture => fracture.fragments.filter(fragment => Math.hypot(fragment.center[0] - impact[0], fragment.center[1] - impact[1]) < 0.8).length;
  assert.ok(near(packed) > near(spread));
});

test('glue joins neighbours and the errors say what to pass', () => {
  const fracture = fractureMesh(wall(), { seed: 2, cells: 10 });
  assert.ok(fracture.glue.length >= fracture.fragments.length - 1);
  assert.ok(fracture.glue.every(({ a, b }) => a < b));
  assert.throws(() => fractureMesh(wall(), { cells: 1 }), /fracture cells is 1; use an integer from 2 to 64/);
  assert.throws(() => fractureMesh(wall(), { cells: 65 }), /cells/);
  assert.throws(() => fractureMesh(wall(), { cells: 4, seed: -1 }), /seed/);
  assert.throws(() => fractureMesh(wall(), { cells: 4, impact: [1] }), /impact/);
  assert.throws(() => fragmentPhysics(fracture, { strength: 0 }), /glue strength/);
  const open = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  assert.throws(() => fractureMesh(open, { cells: 2 }), /closed mesh/);
});

async function wallScene(strength, ballSpeed) {
  const fracture = fractureMesh(wall(), { seed: 11, cells: 12 });
  const parts = fragmentPhysics(fracture, { translation: [0, 2, 0], strength, density: 100 });
  const definition = {
    bodies: [
      { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
      { name: 'ball', translation: [0, 2, 5], linearVelocity: [0, 0, -ballSpeed] },
      ...parts.bodies,
    ],
    colliders: [
      { name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [20, 0.5, 20] },
      { name: 'ball', body: 'ball', shape: 'ball', radius: 0.4, mass: 20 },
      ...parts.colliders,
    ],
    joints: parts.joints,
  };
  return { fracture, scene: await createPhysicsScene(definition, { frameCount: 181 }) };
}

function spreadOf(scene, fracture, time) {
  const pose = scene.sample(time);
  let widest = 0;
  for (const { a, b } of fracture.glue) {
    const first = scene.bodyIndex(`fragment-${a}`) * 7;
    const second = scene.bodyIndex(`fragment-${b}`) * 7;
    widest = Math.max(widest, Math.hypot(pose[first] - pose[second], pose[first + 1] - pose[second + 1], pose[first + 2] - pose[second + 2]));
  }
  return widest;
}

test('glued fragments hold under gravity and break when a body hits above the strength', async () => {
  const gentle = await wallScene(1e6, 0);
  assert.equal(gentle.scene.jointBreaks.length, 0);
  const restSpread = spreadOf(gentle.scene, gentle.fracture, 0);
  assert.ok(Math.abs(spreadOf(gentle.scene, gentle.fracture, 3) - restSpread) < 0.05);

  const held = await wallScene(1e6, 15);
  assert.equal(held.scene.jointBreaks.length, 0, 'a hit below the strength leaves the glue alone');
  assert.ok(Math.abs(spreadOf(held.scene, held.fracture, 3) - spreadOf(held.scene, held.fracture, 0)) < 0.2);

  const smashed = await wallScene(20, 15);
  assert.ok(smashed.scene.jointBreaks.length > 0);
  assert.ok(smashed.scene.jointBreaks.every(entry => entry.impulse >= 20 && entry.frame > 0));
  assert.ok(spreadOf(smashed.scene, smashed.fracture, 3) > 1);
});

test('breakImpulse is only for fixed joints and must be positive', async () => {
  const definition = {
    bodies: [{ name: 'a', type: 'fixed' }, { name: 'b' }],
    colliders: [{ name: 'a', body: 'a', shape: 'ball', radius: 1 }, { name: 'b', body: 'b', shape: 'ball', radius: 1, mass: 1 }],
    joints: [{ name: 'j', type: 'spherical', bodyA: 'a', bodyB: 'b', breakImpulse: 5 }],
  };
  await assert.rejects(createPhysicsScene(definition, { frameCount: 2 }), /breakImpulse requires a fixed joint/);
  definition.joints[0] = { name: 'j', type: 'fixed', bodyA: 'a', bodyB: 'b', breakImpulse: -1 };
  await assert.rejects(createPhysicsScene(definition, { frameCount: 2 }), /breakImpulse/);
});

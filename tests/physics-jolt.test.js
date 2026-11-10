import assert from 'node:assert/strict';
import test from 'node:test';
import { joltAdapter, loadJoltEngine } from '../src/physics-jolt.js';
import { createPhysicsSystem, rapierAdapter } from '../src/physics-runtime.js';

const STEP = 1 / 60;
// Two engines solve contacts differently, so a contact may start a step or two apart; poses agree to a few centimetres.
const EVENT_STEP_TOLERANCE = 3;
const POSE_TOLERANCE = 0.05;

function worldDefinition() {
  return {
    bodies: [
      { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
      { name: 'box', translation: [0, 2, 0] },
      { name: 'zone', type: 'fixed', translation: [4, 1, 0] },
      { name: 'platform', type: 'kinematic', translation: [-4, 1, 0] },
    ],
    colliders: [
      { name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [10, 0.5, 10] },
      { name: 'crate', body: 'box', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 },
      { name: 'trigger', body: 'zone', shape: 'cuboid', halfExtents: [1, 1, 1], sensor: true },
      { name: 'lift', body: 'platform', shape: 'cuboid', halfExtents: [1, 0.1, 1] },
    ],
  };
}

function stepMany(system, count) {
  for (let step = 0; step < count; step++) system.fixedUpdate(STEP, { mode: 'fixed' });
}

function boxFieldDefinition(boxCount) {
  const bodies = [{ name: 'floor', type: 'fixed', translation: [0, -0.5, 0] }];
  const colliders = [{ name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [20, 0.5, 20] }];
  for (let index = 0; index < boxCount; index++) {
    const name = `box${index}`;
    const column = index % 10;
    const row = Math.floor(index / 10) % 10;
    const layer = Math.floor(index / 100);
    bodies.push({ name, translation: [(column - 4.5) * 1.2, 0.5 + layer * 1.1, (row - 4.5) * 1.2] });
    colliders.push({ name, body: name, shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 });
  }
  return { bodies, colliders };
}

// The scripted run both engines replay: drop a box, push it into the trigger, then pull it back out.
async function replayScene(adapter) {
  const physics = await createPhysicsSystem(worldDefinition(), { adapter });
  const heard = [];
  physics.on('contact', event => heard.push({ kind: event.kind, started: event.started, bodyA: event.bodyA, bodyB: event.bodyB, step: event.step }));
  physics.on('sensor', event => heard.push({ kind: event.kind, started: event.started, bodyA: event.bodyA, bodyB: event.bodyB, step: event.step }));
  stepMany(physics, 60);
  physics.applyImpulse('box', [8, 0, 0]);
  stepMany(physics, 120);
  const pose = physics.getPose('box');
  physics.dispose();
  return { heard, pose };
}

test('a box falls onto the floor and rests under jolt', async () => {
  const physics = await createPhysicsSystem(worldDefinition(), { adapter: joltAdapter });
  assert.equal(physics.adapter, 'jolt');
  stepMany(physics, 120);
  const { translation } = physics.getPose('box');
  assert.ok(Math.abs(translation[1] - 0.5) < POSE_TOLERANCE, `box rests on the floor, y = ${translation[1]}`);
  physics.dispose();
});

test('contact events fire once on start, sorted, with body names, and a sleeping body does not end its contact', async () => {
  const physics = await createPhysicsSystem(worldDefinition(), { adapter: joltAdapter });
  const heard = [];
  physics.on('contact', event => heard.push(event));
  stepMany(physics, 240);
  assert.equal(heard.length, 1, `only the start of the floor contact, got ${JSON.stringify(heard.map(({ started, bodyA, bodyB }) => ({ started, bodyA, bodyB })))}`);
  assert.deepEqual([heard[0].started, heard[0].bodyA, heard[0].bodyB, heard[0].kind], [true, 'floor', 'box', 'contact']);
  physics.dispose();
});

test('a kinematic body parks at the pose from setKinematicPose', async () => {
  const physics = await createPhysicsSystem(worldDefinition(), { adapter: joltAdapter });
  physics.setKinematicPose('platform', { translation: [-4, 3, 0] });
  stepMany(physics, 2);
  assert.ok(Math.abs(physics.getPose('platform').translation[1] - 3) < 1e-3);
  physics.dispose();
});

test('ray, shape cast and overlap queries read the jolt world', async () => {
  const physics = await createPhysicsSystem(worldDefinition(), { adapter: joltAdapter });
  stepMany(physics, 120);
  const ray = physics.raycast([0, 5, 0], [0, -1, 0]);
  assert.equal(ray.body, 'box');
  assert.equal(ray.collider, 'crate');
  assert.ok(Math.abs(ray.distance - 4) < POSE_TOLERANCE, `distance ${ray.distance}`);
  assert.ok(Math.abs(ray.normal[1] - 1) < 1e-3);
  assert.equal(physics.raycast([0, 5, 0], [0, -1, 0], { excludeBody: 'box' }).body, 'floor');
  assert.equal(physics.raycast([0, 5, 0], [0, 1, 0]), null);
  assert.equal(physics.raycast([0, 5, 0], [0, -1, 0], { maxDistance: 1 }), null);
  assert.equal(physics.raycast([4, 5, 0], [0, -1, 0]).body, 'floor', 'a ray ignores sensors by default');
  assert.equal(physics.raycast([4, 5, 0], [0, -1, 0], { includeSensors: true }).body, 'zone');
  assert.equal(physics.raycast([0, 5, 0], [0, -1, 0], { mask: 0 }), null);

  const sweep = physics.shapeCast({ type: 'ball', radius: 0.25 }, [0, 5, 0], [0, -1, 0]);
  assert.equal(sweep.body, 'box');
  assert.ok(Math.abs(sweep.distance - 3.75) < POSE_TOLERANCE, `sweep ${sweep.distance}`);
  assert.ok(Math.abs(sweep.normal[1] - 1) < 1e-3, `sweep normal ${sweep.normal}`);

  assert.deepEqual(physics.overlap({ type: 'ball', radius: 1 }, [0, 0.5, 0]), ['box', 'floor']);
  assert.deepEqual(physics.overlap({ type: 'cuboid', halfExtents: [0.2, 0.2, 0.2] }, [0, 8, 0]), []);
  assert.deepEqual(physics.overlap({ type: 'ball', radius: 0.5 }, [-9, 0, 0]), ['floor']);
  physics.dispose();
});

test('collision groups and masks decide which colliders touch', async () => {
  const definition = {
    bodies: [
      { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
      { name: 'ghost', translation: [0, 2, 0] },
      { name: 'solid', translation: [3, 2, 0] },
    ],
    colliders: [
      { name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [10, 0.5, 10], groups: 1, mask: 1 },
      { name: 'ghost', body: 'ghost', shape: 'ball', radius: 0.5, groups: 2, mask: 2 },
      { name: 'solid', body: 'solid', shape: 'ball', radius: 0.5, groups: 1, mask: 1 },
    ],
  };
  const physics = await createPhysicsSystem(definition, { adapter: joltAdapter });
  stepMany(physics, 120);
  assert.ok(physics.getPose('ghost').translation[1] < -2, 'a collider whose mask misses the floor falls through it');
  assert.ok(Math.abs(physics.getPose('solid').translation[1] - 0.5) < POSE_TOLERANCE);
  physics.dispose();
});

test('unsupported scenes fail with a message that names the fix', async () => {
  const jointed = {
    bodies: [{ name: 'a', type: 'fixed' }, { name: 'b', translation: [0, 1, 0] }],
    colliders: [{ name: 'a', body: 'a', shape: 'ball', radius: 0.5 }, { name: 'b', body: 'b', shape: 'ball', radius: 0.5, mass: 1 }],
    joints: [{ name: 'hinge', type: 'spherical', bodyA: 'a', bodyB: 'b' }],
  };
  await assert.rejects(createPhysicsSystem(jointed, { adapter: joltAdapter }), /does not build joints yet.*rapierAdapter/);
  const cone = {
    bodies: [{ name: 'a', type: 'fixed' }],
    colliders: [{ name: 'tip', body: 'a', shape: 'cone', halfHeight: 1, radius: 0.5 }],
  };
  await assert.rejects(createPhysicsSystem(cone, { adapter: joltAdapter }), /collider "tip" is cone/);
  const pair = {
    bodies: [{ name: 'a' }],
    colliders: [{ name: 'one', body: 'a', shape: 'ball', radius: 0.5, mass: 1 }, { name: 'two', body: 'a', shape: 'ball', radius: 0.5, translation: [1, 0, 0] }],
  };
  await assert.rejects(createPhysicsSystem(pair, { adapter: joltAdapter }), /one collider per body; body "a" has 2/);
});

test('force fields push dynamic bodies under jolt', async () => {
  const definition = {
    bodies: [{ name: 'ball', translation: [0, 0, 0] }],
    colliders: [{ name: 'ball', body: 'ball', shape: 'ball', radius: 0.5, mass: 2 }],
    gravity: [0, 0, 0],
    fields: [{ type: 'wind', strength: 3, direction: [1, 0, 0] }],
  };
  const physics = await createPhysicsSystem(definition, { adapter: joltAdapter });
  stepMany(physics, 60);
  assert.ok(Math.abs(physics.getPose('ball').translation[0] - 1.5) < 0.1, `x = ${physics.getPose('ball').translation[0]}`);
  physics.dispose();
});

test('rapier and jolt agree on contact and sensor events for the same scene', async () => {
  const rapier = await replayScene(rapierAdapter);
  const jolt = await replayScene(joltAdapter);
  const summarize = events => events.map(({ kind, started, bodyA, bodyB }) => `${kind} ${started ? 'start' : 'stop'} ${bodyA}/${bodyB}`);
  assert.ok(rapier.heard.length >= 3, `the scene should produce a floor contact, a sensor enter and a sensor exit: ${summarize(rapier.heard)}`);
  assert.deepEqual(summarize(jolt.heard), summarize(rapier.heard), 'the same events fire in the same order');
  jolt.heard.forEach((event, index) => {
    const difference = Math.abs(event.step - rapier.heard[index].step);
    assert.ok(difference <= EVENT_STEP_TOLERANCE, `event ${index} (${summarize([event])[0]}) fired at step ${event.step} on jolt and ${rapier.heard[index].step} on rapier`);
  });
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(jolt.pose.translation[axis] - rapier.pose.translation[axis]) < POSE_TOLERANCE * 4, `axis ${axis}: jolt ${jolt.pose.translation[axis]}, rapier ${rapier.pose.translation[axis]}`);
  }
});

test('the same 500-box scene runs live on both engines and records the step time', async () => {
  const timings = {};
  for (const adapter of [rapierAdapter, joltAdapter]) {
    const physics = await createPhysicsSystem(boxFieldDefinition(500), { adapter, maxBodies: 512, maxColliders: 512 });
    stepMany(physics, 10);
    const steps = 120;
    const start = performance.now();
    stepMany(physics, steps);
    timings[adapter.name] = (performance.now() - start) / steps;
    assert.equal(physics.bodyNames.length, 501);
    assert.ok(Math.abs(physics.getPose('box0').translation[1] - 0.5) < 0.1, `${adapter.name} box0 y = ${physics.getPose('box0').translation[1]}`);
    physics.dispose();
  }
  console.log(`physics 500 boxes, ms per step: ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([name, value]) => [name, Number(value.toFixed(3))])))}`);
  assert.ok(Object.values(timings).every(value => Number.isFinite(value) && value > 0));
});

test('loadJoltEngine resolves once', async () => {
  assert.equal(await loadJoltEngine(), await loadJoltEngine());
});

const TETRAHEDRON_POINTS = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0, 0, 0.5, 0, 0.8, 0];
const COLLINEAR_POINTS = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3];

function hullDefinition(points, translation = [0, 0, 0], mass = 1) {
  return {
    bodies: [
      { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
      { name: 'rock', translation: [0, 0.3, 0] },
    ],
    colliders: [
      { name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [10, 0.5, 10] },
      { name: 'hull', body: 'rock', shape: 'convexHull', points, mass, translation },
    ],
  };
}

test('a convex hull rests on the floor under jolt, with and without a collider offset', async () => {
  for (const offset of [[0, 0, 0], [0, 0.1, 0]]) {
    const physics = await createPhysicsSystem(hullDefinition(TETRAHEDRON_POINTS, offset), { adapter: joltAdapter });
    stepMany(physics, 180);
    const pose = physics.getPose('rock');
    const height = pose.translation[1];
    assert.ok(Number.isFinite(height) && height < 0.3 && height > -0.2, `the hull settled on the floor, got y ${height}`);
    physics.dispose();
  }
});

test('a collinear convex hull fails with a RangeError that names the collider', async () => {
  await assert.rejects(createPhysicsSystem(hullDefinition(COLLINEAR_POINTS, [0, 0, 0], undefined), { adapter: joltAdapter }), error => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /Collider "hull" could not be built by jolt.*span a volume/);
    return true;
  });
});

test('a setup that throws destroys the jolt interface and every owned object', async () => {
  const Jolt = await loadJoltEngine();
  const originalDestroy = Jolt.destroy;
  const destroyed = [];
  Jolt.destroy = object => {
    destroyed.push(object);
    return originalDestroy.call(Jolt, object);
  };
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      destroyed.length = 0;
      await assert.rejects(createPhysicsSystem(hullDefinition(COLLINEAR_POINTS, [0, 0, 0], undefined), { adapter: joltAdapter }), /span a volume/);
      assert.ok(destroyed.some(object => object instanceof Jolt.JoltInterface), 'the interface is destroyed');
      assert.ok(destroyed.length > 10, `owned objects are destroyed, got ${destroyed.length}`);
    }
  } finally {
    Jolt.destroy = originalDestroy;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhysicsSystem, rapierAdapter } from '../src/physics-runtime.js';
import { createRuntime } from '../src/runtime.js';

const STEP = 1 / 60;

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

test('a live world steps in fixedUpdate and a box falls onto the floor', async () => {
  const physics = await createPhysicsSystem(worldDefinition());
  assert.equal(physics.adapter, 'rapier');
  stepMany(physics, 120);
  const { translation } = physics.getPose('box');
  assert.ok(Math.abs(translation[1] - 0.5) < 0.05, `box rests on the floor, y = ${translation[1]}`);
  assert.equal(physics.stepCount, 120);
  physics.dispose();
});

test('contact events fire once on start, sorted, with body names', async () => {
  const physics = await createPhysicsSystem(worldDefinition());
  const heard = [];
  physics.on('contact', event => heard.push(event));
  stepMany(physics, 120);
  const started = heard.filter(event => event.started);
  assert.equal(started.length, 1);
  assert.deepEqual([started[0].bodyA, started[0].bodyB], ['floor', 'box']);
  assert.equal(started[0].kind, 'contact');
  assert.ok(started[0].step > 0 && started[0].step < 60);
  physics.dispose();
});

test('sensor events report a body entering and leaving a trigger', async () => {
  const physics = await createPhysicsSystem(worldDefinition());
  const heard = [];
  physics.on('sensor', event => heard.push(`${event.started ? 'enter' : 'exit'} ${event.bodyA}/${event.bodyB}`));
  physics.applyImpulse('box', [4, 0, 0]);
  stepMany(physics, 60);
  assert.ok(heard.includes('enter box/zone') || heard.includes('enter zone/box'), heard.join(', '));
  physics.setLinearVelocity('box', [-6, 0, 0]);
  stepMany(physics, 60);
  assert.ok(heard.some(entry => entry.startsWith('exit')), heard.join(', '));
  physics.dispose();
});

test('a kinematic body follows setKinematicPose and carries the world', async () => {
  const physics = await createPhysicsSystem(worldDefinition());
  physics.setKinematicPose('platform', { translation: [-4, 3, 0] });
  stepMany(physics, 2);
  assert.ok(Math.abs(physics.getPose('platform').translation[1] - 3) < 1e-4);
  assert.throws(() => physics.setKinematicPose('box', { translation: [0, 0, 0] }), /needs a kinematic body; "box" is dynamic/);
  physics.dispose();
});

test('raycast, shapeCast and overlap read the world', async () => {
  const physics = await createPhysicsSystem(worldDefinition());
  stepMany(physics, 120);
  const ray = physics.raycast([0, 5, 0], [0, -1, 0]);
  assert.equal(ray.body, 'box');
  assert.equal(ray.collider, 'crate');
  assert.ok(Math.abs(ray.distance - 4) < 0.05, `distance ${ray.distance}`);
  assert.ok(Math.abs(ray.normal[1] - 1) < 1e-4);
  assert.ok(Math.abs(ray.point[1] - 1) < 0.05);
  assert.equal(physics.raycast([0, 5, 0], [0, -1, 0], { excludeBody: 'box' }).body, 'floor');
  assert.equal(physics.raycast([0, 5, 0], [0, 1, 0]), null);
  assert.equal(physics.raycast([0, 5, 0], [0, -1, 0], { maxDistance: 1 }), null);
  assert.equal(physics.raycast([4, 5, 0], [0, -1, 0]).body, 'floor', 'a ray ignores sensors by default');
  assert.equal(physics.raycast([4, 5, 0], [0, -1, 0], { includeSensors: true }).body, 'zone');
  assert.equal(physics.raycast([0, 5, 0], [0, -1, 0], { mask: 0 }), null);

  const sweep = physics.shapeCast({ type: 'ball', radius: 0.25 }, [0, 5, 0], [0, -1, 0]);
  assert.equal(sweep.body, 'box');
  assert.ok(Math.abs(sweep.distance - 3.75) < 0.05, `sweep ${sweep.distance}`);

  assert.deepEqual(physics.overlap({ type: 'ball', radius: 1 }, [0, 0.5, 0]), ['box', 'floor']);
  assert.deepEqual(physics.overlap({ type: 'cuboid', halfExtents: [0.2, 0.2, 0.2] }, [0, 8, 0]), []);
  assert.deepEqual(physics.overlap({ type: 'ball', radius: 0.5 }, [-9, 0, 0]), ['floor']);
  physics.dispose();
});

test('errors name the field and what to pass', async () => {
  const physics = await createPhysicsSystem(worldDefinition());
  assert.throws(() => physics.raycast([0, 0], [0, -1, 0]), /raycast origin must be an array of 3 finite numbers/);
  assert.throws(() => physics.raycast([0, 0, 0], [0, 0, 0]), /raycast direction must not be the zero vector/);
  assert.throws(() => physics.raycast([0, 0, 0], [0, -1, 0], { maxDistance: -1 }), /raycast maxDistance must be a number above 0/);
  assert.throws(() => physics.raycast([0, 0, 0], [0, -1, 0], { excludeBody: 'nope' }), /excludeBody names no body: "nope"/);
  assert.throws(() => physics.overlap({ type: 'sphere' }, [0, 0, 0]), /overlap shape must be \{ type: "ball"/);
  assert.throws(() => physics.applyImpulse('floor', [0, 1, 0]), /needs a dynamic body; "floor" is fixed/);
  assert.throws(() => physics.getPose('ghost'), /getPose names no body: "ghost"\. Present: floor, box/);
  assert.throws(() => physics.on('bump', () => {}), /kind must be "contact" or "sensor"/);
  assert.throws(() => physics.fixedUpdate(1 / 30, { mode: 'fixed' }), /fixedStepSeconds: physics\.timestep/);
  physics.dispose();
  assert.throws(() => physics.getPose('box'), /disposed/);
  await assert.rejects(createPhysicsSystem({ ...worldDefinition(), events: [{ tick: 0, type: 'impulse', body: 'box', impulse: [1, 0, 0] }] }), /takes no events/);
  await assert.rejects(createPhysicsSystem(worldDefinition(), { adapter: {} }), /adapter must be an object/);
});

test('the system runs inside the runtime and writes interpolated part matrices', async () => {
  const physics = await createPhysicsSystem(worldDefinition());
  const part = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  physics.bind('box', part);
  const runtime = createRuntime({ render() {} }, {
    systems: [physics],
    fixedStepSeconds: physics.timestep,
    mode: 'both',
    scheduler: { request: () => 1, cancel() {} },
    clock: () => 0,
    visibility: { hidden: false, subscribe: () => () => {} },
  });
  runtime.step(1000 / 60 * 0.5);
  assert.equal(physics.stepCount, 0);
  for (let frame = 0; frame < 10; frame++) runtime.step(100);
  assert.ok(physics.stepCount >= 59);
  assert.ok(part.matrix[13] < 2 && part.matrix[13] > 0.4, `box y ${part.matrix[13]}`);
  runtime.dispose();
  assert.throws(() => physics.getPose('box'), /disposed/);
});

test('a 500-box scene runs live and records the step time', async () => {
  const bodies = [{ name: 'floor', type: 'fixed', translation: [0, -0.5, 0] }];
  const colliders = [{ name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [20, 0.5, 20] }];
  for (let index = 0; index < 500; index++) {
    const name = `box${index}`;
    const column = index % 10;
    const row = Math.floor(index / 10) % 10;
    const layer = Math.floor(index / 100);
    bodies.push({ name, translation: [(column - 4.5) * 1.2, 0.5 + layer * 1.1, (row - 4.5) * 1.2] });
    colliders.push({ name, body: name, shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 });
  }
  const physics = await createPhysicsSystem({ bodies, colliders }, { maxBodies: 512, maxColliders: 512 });
  stepMany(physics, 10);
  const steps = 120;
  const start = performance.now();
  stepMany(physics, steps);
  const millisecondsPerStep = (performance.now() - start) / steps;
  console.log(`physics-runtime 500 boxes (${physics.adapter}): ${millisecondsPerStep.toFixed(2)} ms per step`);
  assert.equal(physics.bodyNames.length, 501);
  assert.ok(Math.abs(physics.getPose('box0').translation[1] - 0.5) < 0.1);
  physics.dispose();
});

// A scripted engine with no physics: it proves the system reads only the adapter interface.
test('another adapter plugs in and its events are normalised the same way', async () => {
  const calls = [];
  const scripted = {
    name: 'scripted',
    createWorld(prepared) {
      assert.equal(prepared.bodies.length, 4);
      return {
        step(stepSeconds, elapsedSeconds) { calls.push(['step', stepSeconds, elapsedSeconds]); },
        readPose(index, output) { output.set([index, 0, 0, 0, 0, 0, 1]); },
        drainEvents(callback) { callback(3, 1, true); callback(2, 1, false); callback(0, 1, true); },
        raycast: () => ({ collider: 1, distance: 2, normal: [0, 1, 0] }),
        free() { calls.push(['free']); },
      };
    },
  };
  const physics = await createPhysicsSystem(worldDefinition(), { adapter: scripted });
  assert.equal(physics.adapter, 'scripted');
  physics.fixedUpdate(STEP, { mode: 'fixed' });
  assert.deepEqual(physics.events.map(event => [event.kind, event.started, event.bodyA, event.bodyB]), [
    ['contact', true, 'floor', 'box'],
    ['sensor', false, 'box', 'zone'],
    ['contact', true, 'box', 'platform'],
  ]);
  assert.deepEqual(physics.getPose('zone').translation, [2, 0, 0]);
  assert.equal(physics.raycast([0, 0, 0], [0, 1, 0]).body, 'box');
  physics.dispose();
  assert.deepEqual(calls.at(-1), ['free']);
});

test('the rapier adapter is frozen and named', () => {
  assert.equal(rapierAdapter.name, 'rapier');
  assert.ok(Object.isFrozen(rapierAdapter));
});

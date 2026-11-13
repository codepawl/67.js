import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPhysicsEngine } from '../src/physics.js';
import { createPhysicsSystem } from '../src/physics-runtime.js';
import { createBoatController, createController, listControllerKinds } from '../src/player.js';

const SEA = { windSpeed: 4.5, choppiness: 0.4, size: 30, seed: 5, resolution: 5 };
const STEP = 1 / 60;

function boatDefinition() {
  const points = [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]];
  return {
    ocean: SEA,
    bodies: [{ name: 'boat', translation: [0, 0.2, 0], float: { drag: 1.5, angularDrag: 3, points, boat: {} } }],
    colliders: [{ name: 'boat', body: 'boat', shape: 'cuboid', halfExtents: [0.9, 0.35, 1.9], density: 300 }],
  };
}

function holdAxes(axes) {
  return { getAxis: name => axes[name] ?? 0, isHeld: () => false, wasPressed: () => false };
}

test.before(() => loadPhysicsEngine({ buoyancy: true }));

test('the boat controller is registered like the vehicle and turns its axes into throttle and rudder', async () => {
  assert.ok(listControllerKinds().includes('boat'));
  const system = await createPhysicsSystem(boatDefinition());
  const node = { position: [0, 0, 0], rotationY: 0 };
  const controller = createController('boat', { input: holdAxes({ moveForward: 1, moveX: 1 }), physics: system, body: 'boat', node });
  for (let step = 0; step < 150; step++) {
    controller.fixedUpdate(STEP, { mode: 'fixed' });
    system.fixedUpdate(STEP, { mode: 'fixed' });
  }
  assert.equal(controller.kind, 'boat');
  assert.ok(controller.state.yaw > 0.5, `yaw ${controller.state.yaw}`);
  assert.ok(controller.state.forwardSpeed > 2, `forward speed ${controller.state.forwardSpeed}`);
  assert.equal(controller.state.throttle, 1);
  assert.deepEqual(node.position, controller.state.position);
  system.dispose();
});

test('the boat controller names what to pass when its physics or body is wrong', async () => {
  const input = holdAxes({});
  assert.throws(() => createBoatController({ input }), /physics must be a physics system from createPhysicsSystem/);
  const system = await createPhysicsSystem(boatDefinition());
  assert.throws(() => createBoatController({ input, physics: system }), /body must be the name of the boat body.*such as "boat"/);
  assert.throws(() => createBoatController({ input, physics: system, body: 'ship' }), /names no body: "ship"/);
  const controller = createBoatController({ input, physics: system, body: 'boat' });
  assert.throws(() => controller.teleport([0, 0, 0]), /cannot teleport/);
  system.dispose();
});

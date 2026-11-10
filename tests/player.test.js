import assert from 'node:assert/strict';
import test from 'node:test';
import { createInput } from '../src/input.js';
import {
  createCharacterController, createFirstPersonCamera, createFollowCamera, createKinematicMover, createTopDownCamera, PLAYER_LIMITS,
} from '../src/player.js';
import { createRuntime } from '../src/runtime.js';

const STEP_MILLISECONDS = 1000 / 60;
const fakeRenderer = { render: () => {} };
const scheduler = { request: () => 1, cancel: () => {} };

function createScriptedInput() {
  return createInput({
    actions: { jump: ['script/jump'], run: ['script/run'] },
    axes: {
      moveX: ['script/right', { control: 'script/left', scale: -1 }],
      moveForward: ['script/forward', { control: 'script/back', scale: -1 }],
      lookX: ['script/lookRight', { control: 'script/lookLeft', scale: -1 }],
      lookY: ['script/lookUp', { control: 'script/lookDown', scale: -1 }],
    },
  });
}

function createGame(options = {}) {
  const input = createScriptedInput();
  const player = createCharacterController({ input, ...options.controller });
  const systems = [input, player];
  if (options.rig) systems.push(options.rig(player, input));
  const runtime = createRuntime(fakeRenderer, { mode: 'fixed', fixedStepSeconds: 1 / 60, systems, scheduler });
  return { input, player, runtime };
}

function run(runtime, steps) {
  for (let index = 0; index < steps; index += 1) runtime.step(STEP_MILLISECONDS);
}

function approximately(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test('walking forward moves along -Z at walk speed and run speed', () => {
  const { input, player, runtime } = createGame();
  input.press('script/forward');
  run(runtime, 60);
  approximately(player.state.speed, 3);
  assert.ok(player.state.position[2] < -2.4 && player.state.position[2] > -3, `z was ${player.state.position[2]}`);
  assert.equal(player.state.grounded, true);
  input.press('script/run');
  run(runtime, 60);
  approximately(player.state.speed, 6);
  assert.equal(player.state.running, true);
});

test('the same input sequence gives the same positions', () => {
  const finalPositions = [0, 1].map(() => {
    const { input, player, runtime } = createGame({ controller: { ground: (x, z) => 0.1 * Math.sin(x) * Math.cos(z) } });
    input.press('script/forward');
    input.press('script/right');
    run(runtime, 30);
    input.press('script/jump');
    run(runtime, 2);
    input.release('script/jump');
    run(runtime, 60);
    return player.state.position;
  });
  assert.deepEqual(finalPositions[0], finalPositions[1]);
});

test('a jump leaves the ground, peaks near the expected height and lands', () => {
  const { input, player, runtime } = createGame();
  run(runtime, 2);
  assert.equal(player.state.grounded, true);
  input.press('script/jump');
  run(runtime, 1);
  input.release('script/jump');
  assert.equal(player.state.airborne, true);
  let peak = 0;
  for (let step = 0; step < 120 && player.state.airborne; step += 1) {
    run(runtime, 1);
    peak = Math.max(peak, player.state.position[1]);
  }
  assert.ok(peak > 1.1 && peak < 1.3, `peak was ${peak}`); // 7^2 / (2 * 20) = 1.225
  assert.equal(player.state.grounded, true);
  assert.equal(player.state.position[1], 0);
});

test('a jump pressed in the air does not restart the jump', () => {
  const { input, player, runtime } = createGame();
  run(runtime, 2);
  input.press('script/jump');
  run(runtime, 30);
  input.release('script/jump');
  input.press('script/jump');
  run(runtime, 1);
  assert.ok(player.state.velocity[1] < 0, `vertical speed was ${player.state.velocity[1]}`);
});

test('the character follows a heightfield', () => {
  const { input, player, runtime } = createGame({ controller: { ground: (x, z) => Math.max(0, -z) * 0.2 } });
  input.press('script/forward');
  run(runtime, 60);
  approximately(player.state.position[1], Math.max(0, -player.state.position[2]) * 0.2, 1e-9);
  assert.ok(player.state.position[1] > 0.3);
  assert.equal(player.state.grounded, true);
  input.release('script/forward');
  input.press('script/back');
  run(runtime, 200);
  assert.equal(player.state.grounded, true);
  assert.equal(player.state.position[1], 0);
});

test('walls block and slide, and stairs are climbed', () => {
  const wall = { min: [-50, 0, -4], max: [50, 3, -3] };
  const { input, player, runtime } = createGame({ controller: { obstacles: [wall] } });
  input.press('script/forward');
  input.press('script/right');
  run(runtime, 240);
  assert.ok(player.state.position[2] >= -3 + 0.4 - 1e-6, `stopped at z ${player.state.position[2]}`);
  assert.ok(player.state.position[0] > 3, `slid along the wall to x ${player.state.position[0]}`);

  const stairs = [0.3, 0.6, 0.9].map((top, index) => ({ min: [-2, 0, -2 - index], max: [2, top, -1 - index] }));
  const climber = createGame({ controller: { obstacles: stairs, stepHeight: 0.35 } });
  climber.input.press('script/forward');
  run(climber.runtime, 80);
  approximately(climber.player.state.position[1], 0.9, 1e-9);
});

test('a fast character does not tunnel through a thin wall', () => {
  const wall = { min: [-5, 0, -5.05], max: [5, 3, -5] };
  const { input, player, runtime } = createGame({ controller: { obstacles: [wall], runSpeed: 90, acceleration: 1000 } });
  input.press('script/forward');
  input.press('script/run');
  run(runtime, 60);
  assert.ok(player.state.position[2] > -5, `ended at z ${player.state.position[2]}`);
});

test('state exposes grounded, airborne, speed, yaw and velocity for animation and audio', () => {
  const { player } = createGame();
  for (const key of ['grounded', 'airborne', 'speed', 'yaw', 'velocity', 'running']) assert.ok(key in player.state, key);
});

test('movement is relative to the camera yaw and the body turns toward it', () => {
  const { input, player, runtime } = createGame({ controller: { cameraYaw: Math.PI / 2 } });
  input.press('script/forward');
  run(runtime, 30);
  assert.ok(player.state.position[0] > 1, `x was ${player.state.position[0]}`);
  approximately(player.state.position[2], 0, 1e-9);
  approximately(player.state.yaw, Math.PI / 2);
});

test('a controller writes its node and can be teleported', () => {
  const node = { position: [9, 9, 9], rotationY: 0 };
  const { input, player, runtime } = createGame({ controller: { node } });
  input.press('script/forward');
  run(runtime, 10);
  assert.deepEqual(node.position, player.state.position);
  player.teleport([4, 5, 6]);
  assert.deepEqual(node.position, [4, 5, 6]);
  assert.deepEqual(player.state.previousPosition, [4, 5, 6]);
});

test('a physics engine plugs in through options.mover', () => {
  const calls = [];
  const mover = {
    move(body, displacement, stepSeconds) {
      calls.push({ body, displacement, stepSeconds });
      return { position: [body.position[0] + displacement[0], 0, body.position[2] + displacement[2]], grounded: true };
    },
  };
  const { input, player, runtime } = createGame({ controller: { mover } });
  input.press('script/forward');
  run(runtime, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].body.radius, 0.4);
  assert.ok(player.state.position[2] < 0);
  const broken = createCharacterController({ input, mover: { move: () => ({ position: [0, 0], grounded: true }) } });
  assert.throws(() => broken.fixedUpdate(1 / 60), /mover\.move must return/);
});

test('swapping the controller at runtime keeps the world and the position', () => {
  const { input, player, runtime } = createGame();
  input.press('script/forward');
  run(runtime, 60);
  const handedOver = [...player.state.position];
  const sprinter = createCharacterController({ input, position: handedOver, walkSpeed: 6 });
  runtime.replaceSystem('player', sprinter);
  assert.equal(runtime.getSystem('player'), sprinter);
  run(runtime, 60);
  approximately(sprinter.state.speed, 6);
  assert.ok(sprinter.state.position[2] < handedOver[2] - 4);
});

test('camera rigs place the camera and swap while the game runs', () => {
  const { input, player, runtime } = createGame({
    rig: (controller, inputLayer) => createFollowCamera({ subject: controller.state, input: inputLayer, distance: 5, pitch: 0.35 }),
  });
  run(runtime, 120);
  const follow = runtime.getSystem('camera').pose({ alpha: 1 });
  approximately(follow.eye[2], 5 * Math.cos(0.35), 1e-9);
  approximately(follow.target[1], 1.5, 1e-9);
  assert.ok(follow.eye[1] > follow.target[1]);
  input.press('script/forward');
  run(runtime, 120);
  const moving = runtime.getSystem('camera').pose({ alpha: 1 });
  assert.ok(moving.eye[2] < follow.eye[2] - 4, 'the camera trails the moving subject');
  assert.ok(moving.eye[2] > player.state.position[2], 'and stays behind it');

  runtime.replaceSystem('camera', createFirstPersonCamera({ subject: player.state, input }));
  run(runtime, 1);
  const first = runtime.getSystem('camera').pose({ alpha: 1 });
  approximately(first.eye[1], 1.6, 1e-9);
  approximately(first.eye[0], player.state.position[0], 1e-9);
  assert.ok(first.target[2] < first.eye[2], 'looks toward -Z at yaw 0');

  runtime.replaceSystem('camera', createTopDownCamera({ subject: player.state }));
  run(runtime, 120);
  const top = runtime.getSystem('camera').pose({ alpha: 1 });
  assert.ok(top.eye[1] > 10, `top-down eye height ${top.eye[1]}`);
  assert.ok(Math.abs(top.target[0] - player.state.position[0]) < 1e-3);
});

test('look axes turn the camera and clamp its pitch', () => {
  const input = createScriptedInput();
  const rig = createFirstPersonCamera({ subject: { position: [0, 0, 0], yaw: 0 }, input });
  rig.init();
  input.press('script/lookRight');
  input.press('script/lookUp');
  input.sample();
  for (let step = 0; step < 60; step += 1) rig.fixedUpdate(1 / 60);
  approximately(rig.yaw, 2.5);
  approximately(rig.pitch, 1.4, 1e-9);
});

test('a first-person rig can drive the body heading through cameraYaw', () => {
  const input = createScriptedInput();
  const rig = createFirstPersonCamera({ subject: { position: [0, 0, 0], yaw: 0 }, input });
  const player = createCharacterController({ input, faceCamera: true, cameraYaw: () => rig.yaw });
  rig.yaw = 1;
  input.press('script/forward');
  input.sample();
  for (let step = 0; step < 30; step += 1) player.fixedUpdate(1 / 60);
  approximately(player.state.yaw, 1);
});

test('the pose interpolates between fixed steps', () => {
  const subject = { position: [0, 0, 0], yaw: 0 };
  const rig = createTopDownCamera({ subject, followSeconds: 0 });
  rig.init();
  subject.position = [10, 0, 0];
  rig.fixedUpdate(1 / 60);
  const half = rig.pose({ alpha: 0.5 });
  const full = rig.pose({ alpha: 1 });
  approximately(full.target[0] - half.target[0], 5, 1e-9);
});

test('clipEye can pull the camera in', () => {
  const subject = { position: [0, 0, 0], yaw: 0 };
  const rig = createFollowCamera({ subject, input: createScriptedInput(), clipEye: (target, eye) => [eye[0], Math.max(eye[1], 3), eye[2]], pitch: 0, lookHeight: 0 });
  rig.init();
  assert.equal(rig.pose().eye[1], 3);
});

test('mistakes name the field and the fix', () => {
  const input = createScriptedInput();
  const subject = { position: [0, 0, 0] };
  assert.throws(() => createCharacterController({}), /options\.input.*createInput/);
  assert.throws(() => createCharacterController({ input, walkSpeed: -1 }), /walkSpeed must be a number from 0 to 100/);
  assert.throws(() => createCharacterController({ input, position: [0, 'x', 0] }), /position must be an array of 3 finite numbers/);
  assert.throws(() => createCharacterController({ input, cameraYaw: 'north' }), /cameraYaw must be a yaw/);
  assert.throws(() => createCharacterController({ input, mover: {} }), /mover must be an object with move/);
  assert.throws(() => createFollowCamera({}), /options\.subject/);
  assert.throws(() => createFollowCamera({ subject }), /options\.input/);
  assert.throws(() => createFollowCamera({ subject, input, clipEye: 4 }), /clipEye must be a function/);
  assert.throws(() => createFollowCamera({ subject, input, minimumPitch: 1, maximumPitch: 0 }), /maximumPitch/);
  assert.throws(() => createKinematicMover({ ground: 'flat' }), /ground must be a height number/);
  assert.throws(() => createKinematicMover({ obstacles: [{ min: [1, 0, 0], max: [0, 1, 1] }] }), /min must not exceed max/);
  assert.throws(() => createKinematicMover({ obstacles: new Array(PLAYER_LIMITS.maximumObstacles + 1).fill({ min: [0, 0, 0], max: [1, 1, 1] }) }), /at most 256 boxes/);
  assert.throws(() => createKinematicMover({ ground: () => NaN }).groundHeight(0, 0), /finite height/);
});

test('variable mode advances the controller and rig from update', () => {
  const input = createScriptedInput();
  const player = createCharacterController({ input });
  const rig = createFollowCamera({ subject: player.state, input });
  const runtime = createRuntime(fakeRenderer, { mode: 'variable', systems: [input, player, rig], scheduler });
  input.press('script/forward');
  run(runtime, 30);
  assert.ok(player.state.position[2] < -1);
  assert.ok(rig.focus[2] < 0);
});

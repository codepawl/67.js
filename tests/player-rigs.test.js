import assert from 'node:assert/strict';
import test from 'node:test';
import { createInput } from '../src/input.js';
import {
  createCameraClip, createCameraRigOfKind, createChaseCamera, createCharacterController, createController, createFlightController,
  createFollowCamera, createOrbitCamera, createSideScrollerCamera, createVehicleController, listCameraRigKinds, listControllerKinds,
  registerCameraRig, registerController, replaceCameraRig, replaceController,
} from '../src/player.js';
import { createRuntime } from '../src/runtime.js';

const STEP_MILLISECONDS = 1000 / 60;
const fakeRenderer = { render: () => {} };
const scheduler = { request: () => 1, cancel: () => {} };

// Test course along -Z: stairs (z -4 to -6, 0.3 per step), a platform (z -6 to -9, 1.2 high), a gap (z -9 to -11), a ramp
// (z -11 to -16 rising to 1.5) and a wall at z -20 (5 high, 6 wide).
const STAIRS = [0, 1, 2, 3].map(index => ({
  min: [-2, 0, -4 - 0.5 * (index + 1)],
  max: [2, 0.3 * (index + 1), -4 - 0.5 * index],
}));
const PLATFORM = { min: [-2, 0, -9], max: [2, 1.2, -6] };
const WALL = { min: [-3, 0, -21], max: [3, 5, -20] };
const OBSTACLES = [...STAIRS, PLATFORM, WALL];

function courseGround(x, z) {
  if (z < -9 && z >= -11) return -50;
  if (z < -11 && z >= -16) return (-11 - z) * 0.3;
  if (z < -16) return 1.5;
  return 0;
}

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

function createGame(makeController, makeRig) {
  const input = createScriptedInput();
  const controller = makeController(input);
  const systems = [input, controller];
  const rig = makeRig ? makeRig(controller, input) : null;
  if (rig) systems.push(rig);
  const runtime = createRuntime(fakeRenderer, { mode: 'fixed', fixedStepSeconds: 1 / 60, systems, scheduler });
  return { input, controller, rig, runtime };
}

function stepOnce(game, beforeStep) {
  beforeStep?.();
  game.runtime.step(STEP_MILLISECONDS);
}

function insideAnyBox(point, boxes) {
  return boxes.some(({ min, max }) => point.every((value, axis) => value > min[axis] && value < max[axis]));
}

test('the character clears stairs, a gap and a ramp, stops at the wall, and the camera never enters it', () => {
  const clip = createCameraClip({ obstacles: OBSTACLES, ground: courseGround });
  const game = createGame(
    input => createCharacterController({ input, position: [0, 0, -1], ground: courseGround, obstacles: OBSTACLES, runSpeed: 6 }),
    (controller, input) => createFollowCamera({ subject: controller.state, input, yaw: Math.PI, clipEye: clip, followSeconds: 0 }),
  );
  const { input, controller, rig } = game;
  input.press('script/forward');
  input.press('script/run');
  let jumpedAcrossGap = false;
  let reachedPlatform = false;
  let landedBeyondGap = false;
  let lowestY = Infinity;
  for (let index = 0; index < 600; index += 1) {
    stepOnce(game, () => {
      if (controller.state.position[2] < -8.4 && controller.state.grounded && !jumpedAcrossGap) {
        jumpedAcrossGap = true;
        input.press('script/jump');
      } else {
        input.release('script/jump');
      }
    });
    const [x, y, z] = controller.state.position;
    lowestY = Math.min(lowestY, y);
    if (y >= 1.19 && z < -6.5) reachedPlatform = true;
    if (z < -11.5 && controller.state.grounded) landedBeyondGap = true;
    assert.ok(z > -20 + 0.4 - 1e-6, `tunnelled into the wall: z ${z} at step ${index}`);
    const { eye } = rig.pose({ alpha: 1 });
    assert.equal(insideAnyBox(eye, OBSTACLES), false, `camera inside a box at step ${index}: ${eye}`);
    assert.ok(eye[1] >= courseGround(eye[0], eye[2]), `camera under the ground at step ${index}`);
    assert.ok(Number.isFinite(x));
  }
  assert.ok(rig.pose({ alpha: 1 }).eye[2] > -20, 'the camera should be pulled in front of the wall, not left behind it');
  assert.ok(reachedPlatform, 'never stood on the platform');
  assert.ok(landedBeyondGap, 'never landed beyond the gap');
  assert.ok(lowestY > -1, `fell into the gap (lowest y ${lowestY})`);
  assert.ok(controller.state.position[2] > -19.7 && controller.state.position[2] < -19.5, `ended at z ${controller.state.position[2]}`);
});

test('the clip pulls the camera in front of a wall it would sit behind', () => {
  const clip = createCameraClip({ obstacles: [WALL], padding: 0.25 });
  const eye = clip([0, 1.5, -19.5], [0, 2, -24.5]);
  assert.ok(eye[2] > -20 && eye[2] < -19.5, `eye z was ${eye[2]}`);
  assert.deepEqual(clip([0, 1.5, -10], [0, 2, -5]), [0, 2, -5]);
});

test('the clip keeps the camera above sloped ground', () => {
  const clip = createCameraClip({ ground: (x, z) => 3 + 0 * x * z, padding: 0.5 });
  const eye = clip([0, 5, 0], [0, 0, 6]);
  assert.ok(eye[1] >= 3.5 - 0.05, `eye y was ${eye[1]}`);
});

test('the car drives the course on its own controller and chase camera and stops at the wall', () => {
  const clip = createCameraClip({ obstacles: OBSTACLES, ground: courseGround });
  const game = createGame(
    input => createVehicleController({ input, position: [0, 0, 6], ground: courseGround, obstacles: OBSTACLES }),
    (controller, input) => createChaseCamera({ subject: controller.state, input, clipEye: clip }),
  );
  const { input, controller, rig } = game;
  input.press('script/forward');
  let topSpeed = 0;
  let crossedGap = false;
  for (let index = 0; index < 900; index += 1) {
    stepOnce(game);
    topSpeed = Math.max(topSpeed, controller.state.speed);
    if (controller.state.position[2] < -11.5) crossedGap = true;
    assert.ok(controller.state.position[1] > -1, `car fell into the gap at step ${index}`);
    assert.equal(insideAnyBox(rig.pose({ alpha: 1 }).eye, OBSTACLES), false, `camera inside a box at step ${index}`);
  }
  assert.ok(topSpeed > 15, `top speed was ${topSpeed}`);
  assert.ok(crossedGap, 'the car never crossed the gap');
  assert.ok(controller.state.position[2] > -20 + 1 - 1e-6, `car went into the wall: z ${controller.state.position[2]}`);
  assert.ok(controller.state.speed < 0.5, `car still moving at ${controller.state.speed}`);
});

test('the car steers with a bicycle model, reverses and brakes', () => {
  const game = createGame(input => createVehicleController({ input }));
  const { input, controller } = game;
  input.press('script/forward');
  for (let index = 0; index < 120; index += 1) stepOnce(game);
  assert.ok(controller.state.forwardSpeed > 19);
  const yawBefore = controller.state.yaw;
  input.press('script/right');
  for (let index = 0; index < 30; index += 1) stepOnce(game);
  assert.ok(controller.state.yaw > yawBefore + 0.2, 'right steer should turn toward +X');
  assert.ok(controller.state.steer > 0.9);
  input.release('script/right');
  input.release('script/forward');
  input.press('script/jump');
  for (let index = 0; index < 60; index += 1) stepOnce(game);
  assert.equal(controller.state.braking, true);
  assert.ok(Math.abs(controller.state.forwardSpeed) < 1e-6);
  input.release('script/jump');
  input.press('script/back');
  for (let index = 0; index < 120; index += 1) stepOnce(game);
  assert.ok(controller.state.forwardSpeed < -5.9);
});

test('the flyer climbs over the wall with its own controller and chase camera', () => {
  const clip = createCameraClip({ obstacles: OBSTACLES, ground: courseGround });
  const game = createGame(
    input => createFlightController({ input, position: [0, 3, 4], ground: courseGround, obstacles: OBSTACLES }),
    (controller, input) => createChaseCamera({ subject: controller.state, input, clipEye: clip }),
  );
  const { input, controller, rig } = game;
  let highestY = 0;
  for (let index = 0; index < 330; index += 1) {
    stepOnce(game, () => {
      if (index < 40) input.press('script/forward');
      else input.release('script/forward');
    });
    highestY = Math.max(highestY, controller.state.position[1]);
    assert.equal(insideAnyBox(rig.pose({ alpha: 1 }).eye, OBSTACLES), false, `camera inside a box at step ${index}`);
  }
  assert.ok(highestY > 6, `highest y was ${highestY}`);
  assert.ok(controller.state.position[2] < -25, `flyer stopped at z ${controller.state.position[2]}`);
  assert.equal(controller.state.airborne, true);
});

test('the flyer stops at the wall when it flies into it low, and skims the ground', () => {
  const game = createGame(input => createFlightController({ input, position: [0, 2, 0], ground: (x, z) => (z < -9 ? 0 : 0), obstacles: [WALL], cruiseSpeed: 10 }));
  const { controller } = game;
  for (let index = 0; index < 480; index += 1) stepOnce(game);
  assert.ok(controller.state.position[2] > -20 + 0.8 - 1e-6, `flew through the wall: z ${controller.state.position[2]}`);
  assert.ok(controller.state.velocity[2] > -0.01, 'still moving into the wall');
  controller.teleport([0, 2, 5], 0);
  game.input.press('script/back');
  for (let index = 0; index < 90; index += 1) stepOnce(game);
  assert.equal(controller.state.grounded, true);
  assert.equal(controller.state.pitch, 0);
  assert.ok(controller.state.position[1] >= 0);
});

test('flight and driving are deterministic for the same inputs', () => {
  const finalStates = [0, 1].map(() => {
    const game = createGame(input => createFlightController({ input }));
    game.input.press('script/right');
    game.input.press('script/forward');
    for (let index = 0; index < 100; index += 1) stepOnce(game);
    return JSON.stringify(game.controller.state);
  });
  assert.equal(finalStates[0], finalStates[1]);
});

test('the orbit camera turns with look and zooms inside its limits', () => {
  const input = createInput({ axes: { lookX: ['script/lookRight'], lookY: ['script/lookUp'], zoom: ['script/zoomIn'] } });
  const subject = { position: [0, 0, 0], yaw: 0 };
  const rig = createOrbitCamera({ subject, input, zoom: 'zoom', minimumDistance: 2, maximumDistance: 9, distance: 6 });
  const runtime = createRuntime(fakeRenderer, { mode: 'fixed', fixedStepSeconds: 1 / 60, systems: [input, rig], scheduler });
  input.press('script/lookRight');
  input.press('script/zoomIn');
  for (let index = 0; index < 40; index += 1) runtime.step(STEP_MILLISECONDS);
  assert.ok(rig.yaw > 1, `yaw was ${rig.yaw}`);
  assert.equal(rig.distance, 2);
  const { eye, target } = rig.pose({ alpha: 1 });
  approximately(Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]), 2);
});

test('the chase camera swings round to the subject yaw', () => {
  const subject = { position: [0, 0, 0], yaw: 2 };
  const rig = createChaseCamera({ subject, yaw: 0 });
  const runtime = createRuntime(fakeRenderer, { mode: 'fixed', fixedStepSeconds: 1 / 60, systems: [rig], scheduler });
  for (let index = 0; index < 120; index += 1) runtime.step(STEP_MILLISECONDS);
  approximately(rig.yaw, 2, 0.01);
});

test('the side-scroller camera looks along -Z and leads the subject by its velocity', () => {
  const subject = { position: [0, 1, 0], velocity: [5, 0, 0], yaw: 0 };
  const rig = createSideScrollerCamera({ subject, distance: 8, lookAhead: 3, followSeconds: 0 });
  const runtime = createRuntime(fakeRenderer, { mode: 'fixed', fixedStepSeconds: 1 / 60, systems: [rig], scheduler });
  runtime.step(STEP_MILLISECONDS);
  const { eye, target } = rig.pose({ alpha: 1 });
  approximately(target[0], 3);
  approximately(eye[0], 3);
  approximately(eye[2] - target[2], 8);
  approximately(eye[1], target[1]);
});

test('custom controller and rig kinds register, build and swap at runtime', () => {
  registerController('test-boat', options => ({
    name: options.name ?? 'boat',
    state: { position: [...(options.position ?? [0, 0, 0])], yaw: options.yaw ?? 0 },
    fixedUpdate() {},
  }));
  registerCameraRig('test-fixed', options => ({
    name: options.name ?? 'camera',
    subject: options.subject,
    yaw: options.yaw ?? 0,
    pose: () => ({ eye: [0, 10, 10], target: options.subject.position, up: [0, 1, 0] }),
    fixedUpdate() {},
  }));
  assert.ok(listControllerKinds().includes('test-boat'));
  assert.ok(listCameraRigKinds().includes('test-fixed'));
  const game = createGame(
    input => createController('character', { input, name: 'player', position: [1, 0, 2] }),
    (controller, input) => createCameraRigOfKind('follow', { subject: controller.state, input, name: 'camera' }),
  );
  game.runtime.step(STEP_MILLISECONDS);
  const boat = replaceController(game.runtime, 'player', 'test-boat');
  assert.deepEqual(boat.state.position, game.controller.state.position);
  assert.equal(game.runtime.getSystem('player'), boat);
  const car = replaceController(game.runtime, 'player', 'vehicle', { input: game.input });
  assert.deepEqual(car.state.position, game.controller.state.position);
  const rig = replaceCameraRig(game.runtime, 'camera', 'test-fixed', { subject: car.state });
  assert.equal(game.runtime.getSystem('camera'), rig);
  assert.deepEqual(rig.pose().eye, [0, 10, 10]);
  game.runtime.step(STEP_MILLISECONDS);
});

test('errors name the option and what to pass', () => {
  const input = createScriptedInput();
  assert.throws(() => createVehicleController({ input, maximumSpeed: -1 }), /createVehicleController maximumSpeed must be a number from 0 to 100, got -1/);
  assert.throws(() => createFlightController({ input, cruiseSpeed: 1000 }), /createFlightController cruiseSpeed must be a number/);
  assert.throws(() => createVehicleController({}), /needs options.input/);
  assert.throws(() => createCameraClip({ padding: -1 }), /createCameraClip padding/);
  assert.throws(() => createCameraClip({ obstacles: [{ min: [1, 1, 1], max: [0, 0, 0] }] }), /min must not exceed max/);
  assert.throws(() => createController('missing'), /no kind "missing". Registered kinds: character/);
  assert.throws(() => registerController('vehicle', () => ({})), /already registered/);
  assert.throws(() => registerController('', () => ({})), /non-empty string/);
  assert.throws(() => registerCameraRig('x-rig', null), /must be a function/);
  registerController('test-broken', () => ({}));
  assert.throws(() => createController('test-broken'), /must return a runtime system with state.position/);
  assert.throws(() => createOrbitCamera({ subject: { position: [0, 0, 0] }, zoom: 'zoom' }), /needs options.input/);
});

function approximately(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import {
  applyVehicleLightsToParts,
  computeVehicleLightEmissions,
  createVehicleRig,
  driveAlongLegs,
  driveAlongPath,
} from '../src/vehicle.js';

const WHEEL_RADIUS = 0.35;
const HALF_TRACK = 0.8;
const WHEELBASE = 2.4;
const WHEEL_CORNERS = [
  { id: 'FL', x: HALF_TRACK, z: WHEELBASE / 2 },
  { id: 'FR', x: -HALF_TRACK, z: WHEELBASE / 2 },
  { id: 'RL', x: HALF_TRACK, z: -WHEELBASE / 2 },
  { id: 'RR', x: -HALF_TRACK, z: -WHEELBASE / 2 },
];
const HEADLIGHT_POSITION = [0.5, 0.7, 1.8];

function boxGeometry(center, size) {
  const positions = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        positions.push(center[0] + sx * size[0] / 2, center[1] + sy * size[1] / 2, center[2] + sz * size[2] / 2);
      }
    }
  }
  return { positions: new Float32Array(positions) };
}

function wheelGeometry(center) {
  const positions = [];
  for (let step = 0; step < 24; step++) {
    const angle = step / 24 * Math.PI * 2;
    for (const side of [-1, 1]) {
      positions.push(center[0] + side * 0.1, center[1] + Math.sin(angle) * WHEEL_RADIUS, center[2] + Math.cos(angle) * WHEEL_RADIUS);
    }
  }
  return { positions: new Float32Array(positions) };
}

function createLitRig(steeringOptions = {}) {
  const body = { name: 'Body', geometry: boxGeometry([0, 0.8, 0], [1.6, 0.5, 3.4]), matrix: mat4.create() };
  const brakeLamp = { name: 'BrakeLamp', geometry: boxGeometry([0, 0.9, -1.7], [0.4, 0.1, 0.05]), matrix: mat4.create(), material: { emission: 0 } };
  const reverseLamp = { name: 'ReverseLamp', geometry: boxGeometry([0.5, 0.9, -1.7], [0.1, 0.1, 0.05]), matrix: mat4.create(), material: { emission: 0 } };
  const wheels = WHEEL_CORNERS.map(corner => ({
    name: `Wheel_${corner.id}`,
    geometry: wheelGeometry([corner.x, WHEEL_RADIUS, corner.z]),
    matrix: mat4.create(),
  }));
  const rig = createVehicleRig({
    parts: [body, brakeLamp, reverseLamp, ...wheels],
    body: [body, brakeLamp, reverseLamp],
    wheels: wheels.map((part, index) => ({ id: WHEEL_CORNERS[index].id, part })),
    lights: {
      headlights: [{ id: 'left', position: HEADLIGHT_POSITION }],
      tailLights: [
        { part: brakeLamp, signal: 'brake', off: 0.2, on: 5 },
        { part: reverseLamp, signal: 'reverse', on: 2 },
      ],
    },
    ...steeringOptions,
  });
  return { rig, brakeLamp, reverseLamp };
}

function tightArc(direction) {
  const points = [];
  for (let step = 0; step <= 16; step++) {
    const angle = step / 16 * Math.PI / 2;
    points.push([direction * 3 * (1 - Math.cos(angle)), 0, 3 * Math.sin(angle)]);
  }
  return points;
}

const REVERSING_LEGS = [
  { path: [[0, 0, 0], [0, 0, 5], [0, 0, 10]] },
  { path: [[0, 0, 10], [0, 0, 7], [0, 0, 4]], direction: 'reverse', pause: 0.5 },
];
const DRIVE_OPTIONS = { cruiseSpeed: 4, acceleration: 2, braking: 2 };

test('full lock turns the inner front wheel by the Ackermann angle for the measured wheelbase and track', () => {
  const { rig } = createLitRig();
  assert.ok(Math.abs(rig.trackWidth - 2 * HALF_TRACK) < 1e-6);
  const turningRadius = rig.wheelbase / Math.tan(rig.maxSteerAngle);
  for (const direction of [1, -1]) {
    const pose = driveAlongPath(rig, tightArc(direction), { speed: 2 }).sample(1.5);
    assert.ok(Math.abs(Math.abs(pose.steerAngle) - rig.maxSteerAngle) < 1e-9, 'the path is tight enough to reach full lock');
    const [frontLeft, frontRight] = pose.wheels;
    const inner = direction > 0 ? frontLeft : frontRight;
    const outer = direction > 0 ? frontRight : frontLeft;
    assert.ok(Math.abs(inner.steerAngle) > Math.abs(outer.steerAngle));
    assert.ok(Math.abs(Math.abs(inner.steerAngle) - Math.atan(rig.wheelbase / (turningRadius - rig.trackWidth / 2))) < 1e-6);
    assert.ok(Math.abs(Math.abs(outer.steerAngle) - Math.atan(rig.wheelbase / (turningRadius + rig.trackWidth / 2))) < 1e-6);
    assert.equal(pose.wheels[2].steerAngle, 0);
  }
});

test('a reverse leg backs the car along its path with the heading kept and the wheels spinning backwards', () => {
  const { rig } = createLitRig();
  const drive = driveAlongLegs(rig, REVERSING_LEGS, DRIVE_OPTIONS);
  const forwardLeg = driveAlongPath(rig, REVERSING_LEGS[0].path, DRIVE_OPTIONS);
  const turnaround = drive.sample(forwardLeg.duration);
  assert.equal(turnaround.speed, 0);
  assert.equal(turnaround.lights.reverse, 0);
  const earlier = drive.sample(forwardLeg.duration + 0.5 + 1.5);
  const later = drive.sample(forwardLeg.duration + 0.5 + 2.5);
  assert.ok(later.position[2] < earlier.position[2]);
  assert.ok(earlier.position[2] < 10);
  assert.ok(later.speed < 0);
  assert.equal(later.lights.reverse, 1);
  assert.ok(Math.abs(Math.sin(later.heading)) < 1e-6 && Math.cos(later.heading) > 0, 'still facing +z');
  assert.ok(later.heading === earlier.heading);
  for (let index = 0; index < 4; index++) {
    assert.ok(later.wheels[index].spinAngle < earlier.wheels[index].spinAngle);
  }
  const end = drive.sample(drive.duration + 1);
  assert.ok(Math.abs(end.position[2] - 4) < 1e-6);
  assert.ok(Math.abs(end.distance - 4) < 1e-6);
});

test('a reversing car steers the opposite way for the same path curvature', () => {
  const { rig } = createLitRig();
  const bend = [[0, 0, 0], [0, 0, 5], [2, 0, 10]];
  const forward = driveAlongLegs(rig, [{ path: bend }], { speed: 2 }).sample(2.5);
  const reverse = driveAlongLegs(rig, [{ path: bend, direction: 'reverse' }], { speed: 2 }).sample(2.5);
  assert.ok(forward.steerAngle * reverse.steerAngle < 0);
  assert.ok(Math.abs(Math.abs(reverse.heading - forward.heading) - Math.PI) < 1e-9);
});

test('wheel spin times radius equals the distance driven, forwards and backwards', () => {
  const { rig } = createLitRig();
  const drive = driveAlongLegs(rig, REVERSING_LEGS, DRIVE_OPTIONS);
  for (let time = 0.5; time < drive.duration; time += 0.37) {
    const pose = drive.sample(time);
    for (const wheel of pose.wheels) {
      const rolled = wheel.spinAngle * WHEEL_RADIUS;
      assert.ok(Math.abs(rolled - pose.distance) <= 0.02 * Math.max(Math.abs(pose.distance), 1e-9) + 1e-9, `t=${time}`);
    }
  }
});

test('the brake signal is on exactly while the car slows down', () => {
  const { rig } = createLitRig();
  const drive = driveAlongLegs(rig, REVERSING_LEGS, DRIVE_OPTIONS);
  let slowing = 0;
  let notSlowing = 0;
  for (let time = 0.05; time < drive.duration; time += 0.05) {
    const rate = (Math.abs(drive.sample(time + 0.01).speed) - Math.abs(drive.sample(time - 0.01).speed)) / 0.02;
    const brake = drive.sample(time).lights.brake;
    assert.ok(brake >= 0 && brake <= 1);
    if (rate < -0.5) {
      slowing++;
      assert.ok(brake > 0, `t=${time}`);
    } else if (rate > -0.01) {
      notSlowing++;
      assert.equal(brake, 0, `t=${time}`);
    }
  }
  assert.ok(slowing > 10 && notSlowing > 10);
});

test('headlights follow the body position and heading', () => {
  const { rig } = createLitRig();
  const drive = driveAlongPath(rig, [[0, 0, 0], [0, 0, 8], [6, 0, 14]], { speed: 3 });
  const straight = driveAlongPath(rig, [[0, 0, 0], [0, 0, 8]], { speed: 3 });
  const start = straight.sample(0).lights.headlights[0];
  start.position.forEach((value, axis) => assert.ok(Math.abs(value - HEADLIGHT_POSITION[axis]) < 0.02));
  assert.ok(Math.abs(start.direction[2] - 1) < 0.02);
  assert.ok(Math.abs(straight.sample(1).lights.headlights[0].position[2] - (HEADLIGHT_POSITION[2] + 3)) < 0.02);
  const pose = drive.sample(3.5);
  const light = pose.lights.headlights[0];
  assert.ok(Math.abs(light.direction[0] - Math.sin(pose.heading)) < 0.05);
  assert.ok(Math.abs(light.direction[2] - Math.cos(pose.heading)) < 0.05);
  const offsetX = light.position[0] - pose.position[0];
  const offsetZ = light.position[2] - pose.position[2];
  assert.ok(Math.abs(Math.hypot(offsetX, offsetZ) - Math.hypot(HEADLIGHT_POSITION[0], HEADLIGHT_POSITION[2])) < 0.05);
});

test('tail-light emission follows the brake and reverse signals and can be applied to parts', () => {
  const { rig, brakeLamp, reverseLamp } = createLitRig();
  const drive = driveAlongLegs(rig, REVERSING_LEGS, DRIVE_OPTIONS);
  const cruising = drive.sample(1.8);
  assert.equal(cruising.lights.brake, 0);
  assert.equal(applyVehicleLightsToParts(rig, cruising).length, 2);
  assert.equal(brakeLamp.material.emission, 0.2);
  assert.equal(reverseLamp.material.emission, 0);
  let brakingTime = 0;
  while (drive.sample(brakingTime).lights.brake === 0) brakingTime += 0.05;
  const braking = drive.sample(brakingTime);
  applyVehicleLightsToParts(rig, braking);
  assert.ok(brakeLamp.material.emission > 0.2);
  const reversing = drive.sample(drive.duration - 1.5);
  const emissions = computeVehicleLightEmissions(rig, reversing);
  assert.equal(emissions.find(item => item.id === 'ReverseLamp').emission, 2);
});

test('legs and lights sample the same pose whatever order they are read in', () => {
  const { rig } = createLitRig();
  const drive = driveAlongLegs(rig, REVERSING_LEGS, DRIVE_OPTIONS);
  const times = [0, 1.1, 2.4, 3.3, 4.6, 6, 9, 20];
  const inOrder = times.map(time => drive.sample(time));
  const shuffled = [...times].reverse().map(time => drive.sample(time)).reverse();
  assert.deepEqual(shuffled, inOrder);
  const again = driveAlongLegs(rig, REVERSING_LEGS, DRIVE_OPTIONS);
  assert.deepEqual(again.sample(4.6), inOrder[4]);
});

test('bad steering, light and leg input produces specific errors', () => {
  const { rig } = createLitRig();
  assert.throws(() => driveAlongPath(rig, [[0, 0, 0], [0, 0, 5]], { speed: 1, steering: 'both' }), /^RangeError: steering: got "both"; expected one of ackermann, shared/);
  assert.throws(() => driveAlongLegs(rig, [], { speed: 1 }), /non-empty array of/);
  assert.throws(() => driveAlongLegs(rig, [{ path: REVERSING_LEGS[0].path, direction: 'sideways' }], { speed: 1 }), /^RangeError: legs\[0\]\.direction: got "sideways"; expected one of forward, reverse/);
  assert.throws(() => createVehicleRig({ parts: [{ name: 'Wheel_FL', matrix: mat4.create() }], lights: { tailLights: [{ part: 0, signal: 'fog' }] } }), /wheels: got 1; expected at least 2 wheels|signal/);
});

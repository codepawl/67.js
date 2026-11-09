import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { createSceneGraph } from '../src/scene-graph.js';
import {
  applyVehiclePoseToAsset,
  applyVehiclePoseToParts,
  applyVehiclePoseToSceneGraph,
  createVehicleNodeOverrides,
  createVehicleRig,
  driveAlongPath,
  findWheelCandidates,
} from '../src/vehicle.js';

const WHEEL_RADIUS = 0.35;
const WHEEL_CORNERS = [
  { id: 'FL', x: 0.8, z: 1.2 },
  { id: 'FR', x: -0.8, z: 1.2 },
  { id: 'RL', x: 0.8, z: -1.2 },
  { id: 'RR', x: -0.8, z: -1.2 },
];

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

function wheelGeometry(center, radius, width) {
  const positions = [];
  for (let step = 0; step < 24; step++) {
    const angle = step / 24 * Math.PI * 2;
    for (const side of [-1, 1]) {
      positions.push(center[0] + side * width / 2, center[1] + Math.sin(angle) * radius, center[2] + Math.cos(angle) * radius);
    }
  }
  return { positions: new Float32Array(positions) };
}

function createTestVehicleParts() {
  const body = { name: 'Body', geometry: boxGeometry([0, 0.8, 0], [1.6, 0.5, 3.4]), matrix: mat4.create() };
  const wheels = WHEEL_CORNERS.map(corner => ({
    name: `Wheel_${corner.id}`,
    geometry: wheelGeometry([corner.x, WHEEL_RADIUS, corner.z], WHEEL_RADIUS, 0.2),
    matrix: mat4.create(),
  }));
  return { body, wheels, parts: [body, ...wheels] };
}

function createTestRig(options = {}) {
  const { body, wheels, parts } = createTestVehicleParts();
  const rig = createVehicleRig({
    parts,
    body: [body],
    wheels: wheels.map((part, index) => ({ id: WHEEL_CORNERS[index].id, part })),
    ...options,
  });
  return { rig, body, wheels, parts };
}

const STRAIGHT_PATH = [[0, 0, 0], [0, 0, 10], [0, 0, 20]];

function arcPath(radius, direction) {
  const points = [];
  for (let step = 0; step <= 12; step++) {
    const angle = step / 12 * Math.PI / 2;
    points.push([direction * radius * (1 - Math.cos(angle)), 0, radius * Math.sin(angle)]);
  }
  return points;
}

function transformPoint(matrix, point) {
  return Array.from(vec3.transformMat4(vec3.create(), point, matrix));
}

test('wheel spin equals distance over radius and rolls the top of the tire forward', () => {
  const { rig, wheels } = createTestRig();
  const drive = driveAlongPath(rig, STRAIGHT_PATH, { speed: 5 });
  const pose = drive.sample(2);
  assert.ok(Math.abs(pose.distance - 10) < 1e-6);
  for (const wheelPose of pose.wheels) {
    assert.ok(Math.abs(wheelPose.spinAngle - 10 / WHEEL_RADIUS) < 1e-6);
    assert.equal(wheelPose.steerAngle, 0);
  }
  applyVehiclePoseToParts(rig, pose);
  const center = [0.8, WHEEL_RADIUS, 1.2];
  const top = [0.8, 2 * WHEEL_RADIUS, 1.2];
  const movedCenter = transformPoint(wheels[0].matrix, center);
  const movedTop = transformPoint(wheels[0].matrix, top);
  const spin = 10 / WHEEL_RADIUS;
  assert.ok(Math.abs(movedTop[2] - movedCenter[2] - WHEEL_RADIUS * Math.sin(spin)) < 1e-4);
  assert.ok(Math.abs(movedCenter[2] - (1.2 + 10)) < 1e-4);
});

test('spinSign flips a wheel whose model axis is mirrored', () => {
  const { body, wheels, parts } = createTestVehicleParts();
  const rig = createVehicleRig({
    parts,
    body: [body],
    wheels: wheels.map((part, index) => ({ id: WHEEL_CORNERS[index].id, part, spinSign: index === 1 ? -1 : 1 })),
  });
  const pose = driveAlongPath(rig, STRAIGHT_PATH, { speed: 5 }).sample(1);
  assert.ok(pose.wheels[0].spinAngle > 0);
  assert.ok(pose.wheels[1].spinAngle < 0);
});

test('inner wheels turn slower than outer wheels in a corner', () => {
  const { rig } = createTestRig();
  const pose = driveAlongPath(rig, arcPath(10, 1), { speed: 5 }).sample(2);
  const [frontLeft, frontRight] = pose.wheels;
  assert.ok(frontLeft.spinAngle < frontRight.spinAngle);
});

test('steering turns the front wheels toward the turn and leaves the rear straight', () => {
  const { rig } = createTestRig();
  const leftPose = driveAlongPath(rig, arcPath(10, 1), { speed: 5 }).sample(1.5);
  const rightPose = driveAlongPath(rig, arcPath(10, -1), { speed: 5 }).sample(1.5);
  const expected = Math.atan(rig.wheelbase / 10);
  assert.ok(Math.abs(rig.wheelbase - 2.4) < 1e-6);
  assert.ok(Math.abs(leftPose.steerAngle - expected) < 0.02);
  assert.ok(Math.abs(rightPose.steerAngle + expected) < 0.02);
  assert.ok(leftPose.heading > 0.1);
  assert.ok(rightPose.heading < -0.1);
  assert.equal(leftPose.wheels[2].steerAngle, 0);
  assert.ok(leftPose.wheels[0].steerAngle > leftPose.steerAngle);
  const sharedPose = driveAlongPath(rig, arcPath(10, 1), { speed: 5, steering: 'shared' }).sample(1.5);
  assert.equal(sharedPose.wheels[0].steerAngle, sharedPose.steerAngle);
  assert.equal(sharedPose.wheels[1].steerAngle, sharedPose.steerAngle);
});

test('front wheel matrices yaw toward the turn relative to the body', () => {
  const { rig, wheels } = createTestRig();
  const pose = driveAlongPath(rig, arcPath(10, 1), { speed: 5 }).sample(1.5);
  applyVehiclePoseToParts(rig, pose);
  const wheelForward = vec3.transformMat4(vec3.create(), [0, 0, 1], mat4.fromValues(...wheels[0].matrix.slice(0, 12), 0, 0, 0, 1));
  const wheelYaw = Math.atan2(wheelForward[0], wheelForward[2]);
  assert.ok(wheelYaw > pose.heading);
});

test('body leans outward in a turn and stays level on a straight path', () => {
  const { rig } = createTestRig();
  const straight = driveAlongPath(rig, STRAIGHT_PATH, { speed: 5 });
  for (let time = 0; time <= 4; time += 0.25) {
    assert.ok(Math.abs(straight.sample(time).roll) < 1e-9, `roll at ${time}`);
  }
  const leftTurn = driveAlongPath(rig, arcPath(10, 1), { speed: 5 }).sample(2);
  const rightTurn = driveAlongPath(rig, arcPath(10, -1), { speed: 5 }).sample(2);
  assert.ok(leftTurn.roll > 0.01);
  assert.ok(rightTurn.roll < -0.01);
});

test('braking pitches the nose down and accelerating pitches it up', () => {
  const { rig } = createTestRig();
  const drive = driveAlongPath(rig, [[0, 0, 0], [0, 0, 40], [0, 0, 80]], { cruiseSpeed: 12, acceleration: 3, braking: 5 });
  assert.ok(drive.sample(0.6).pitch > 0.005);
  assert.ok(drive.sample(drive.duration - 0.6).pitch < -0.005);
  assert.ok(drive.sample(0).speed === 0);
  assert.ok(drive.sample(drive.duration + 5).speed === 0);
  assert.ok(Math.abs(drive.sample(drive.duration + 5).distance - drive.length) < 1e-6);
});

test('a lateral acceleration limit slows the vehicle in corners', () => {
  const { rig } = createTestRig();
  const fast = driveAlongPath(rig, arcPath(10, 1), { cruiseSpeed: 20, acceleration: 8, braking: 8 });
  const limited = driveAlongPath(rig, arcPath(10, 1), { cruiseSpeed: 20, acceleration: 8, braking: 8, maxLateralAcceleration: 4 });
  assert.ok(limited.duration > fast.duration);
  let peak = 0;
  for (let time = 0; time <= limited.duration; time += 0.05) peak = Math.max(peak, limited.sample(time).speed);
  assert.ok(peak <= Math.sqrt(4 * 10) + 0.5);
});

test('sampling is deterministic regardless of order', () => {
  const { rig, parts } = createTestRig();
  const ground = (x, z) => 0.05 * Math.sin(x * 0.7) * Math.cos(z * 0.4);
  const drive = driveAlongPath(rig, arcPath(12, 1), { cruiseSpeed: 8, groundHeight: ground });
  const first = drive.sample(1.37);
  drive.sample(0.2);
  drive.sample(3);
  const second = drive.sample(1.37);
  assert.deepEqual(second, first);
  applyVehiclePoseToParts(rig, first);
  const matricesFirst = parts.map(part => Array.from(part.matrix));
  applyVehiclePoseToParts(rig, drive.sample(2.5));
  applyVehiclePoseToParts(rig, second);
  assert.deepEqual(parts.map(part => Array.from(part.matrix)), matricesFirst);
});

test('wheels stay on uneven ground', () => {
  const { rig, wheels } = createTestRig();
  const ground = (x, z) => 0.06 * Math.sin(x * 0.8) + 0.05 * Math.cos(z * 0.6);
  const drive = driveAlongPath(rig, [[0, 0, 0], [3, 0, 8], [-2, 0, 16], [0, 0, 24]], { speed: 4, groundHeight: ground });
  for (const time of [0.5, 1.5, 3, 4.5]) {
    applyVehiclePoseToParts(rig, drive.sample(time));
    WHEEL_CORNERS.forEach((corner, index) => {
      const center = transformPoint(wheels[index].matrix, [corner.x, WHEEL_RADIUS, corner.z]);
      const contactHeight = center[1] - WHEEL_RADIUS;
      assert.ok(Math.abs(contactHeight - ground(center[0], center[2])) < 0.02, `${corner.id} at ${time}`);
    });
  }
});

test('name detection finds wheels, groups corners and rejects look-alikes', () => {
  const names = ['Body', 'Wheel.001', 'FrontLeftWheel', 'tire_FR', 'RL_tyre', 'rim_rr', 'Steering wheel', 'Spare wheel', 'Wheel arch', 'Primary light', 'wheel_L'];
  const { wheels, rejected } = findWheelCandidates(names);
  const byName = new Map(wheels.map(wheel => [wheel.name, wheel]));
  assert.equal(byName.get('FrontLeftWheel').corner, 'front-left');
  assert.equal(byName.get('tire_FR').corner, 'front-right');
  assert.equal(byName.get('RL_tyre').corner, 'rear-left');
  assert.equal(byName.get('rim_rr').corner, 'rear-right');
  assert.equal(byName.get('rim_rr').kind, 'rim');
  assert.equal(byName.get('Wheel.001').corner, null);
  assert.equal(byName.get('wheel_L').side, 'left');
  assert.deepEqual(rejected.map(item => item.name).sort(), ['Spare wheel', 'Steering wheel', 'Wheel arch']);
  assert.ok(!byName.has('Primary light'));
  assert.ok(!byName.has('Body'));
});

test('automatic rigs group tire, hub and bolts per corner and ignore the steering wheel', () => {
  const body = { name: 'Chassis', geometry: boxGeometry([0, 0.8, 0], [1.6, 0.5, 3.4]), matrix: mat4.create() };
  const steering = { name: 'Steering wheel', geometry: boxGeometry([0.3, 1.3, 0], [0.4, 0.4, 0.05]), matrix: mat4.create() };
  const parts = [body, steering];
  for (const corner of WHEEL_CORNERS) {
    const center = [corner.x, WHEEL_RADIUS, corner.z];
    parts.push({ name: 'Rubber road tire', geometry: wheelGeometry(center, WHEEL_RADIUS, 0.25), matrix: mat4.create() });
    parts.push({ name: 'Steel wheel hub', geometry: wheelGeometry(center, 0.2, 0.3), matrix: mat4.create() });
    parts.push({ name: 'Wheel lug bolt', geometry: boxGeometry([corner.x, WHEEL_RADIUS + 0.1, corner.z], [0.03, 0.03, 0.03]), matrix: mat4.create() });
  }
  const rig = createVehicleRig({ parts });
  assert.equal(rig.wheels.length, 4);
  assert.ok(rig.wheels.every(wheel => wheel.entries.length === 3));
  assert.ok(rig.wheels.every(wheel => Math.abs(wheel.radius - WHEEL_RADIUS) < 1e-6));
  assert.equal(rig.wheels.filter(wheel => wheel.steerable).length, 2);
  assert.ok(Math.abs(rig.wheelbase - 2.4) < 1e-6);
  assert.deepEqual(rig.rejectedNames.map(item => item.name), ['Steering wheel']);
  assert.ok(rig.bodyEntries.some(entry => entry.label === 'Steering wheel'));
});

test('forwardAxis lets a vehicle modelled along +x drive forward', () => {
  const body = { name: 'Body', geometry: boxGeometry([0, 0.8, 0], [3.4, 0.5, 1.6]), matrix: mat4.create() };
  const wheels = WHEEL_CORNERS.map(corner => ({
    name: `Wheel_${corner.id}`,
    geometry: boxGeometry([corner.z, WHEEL_RADIUS, -corner.x], [0.7, 0.7, 0.2]),
    matrix: mat4.create(),
  }));
  const rig = createVehicleRig({ parts: [body, ...wheels], body: [body], forwardAxis: '+x', wheels: wheels.map(part => ({ part })) });
  assert.ok(Math.abs(rig.wheelbase - 2.4) < 1e-6);
  const pose = driveAlongPath(rig, STRAIGHT_PATH, { speed: 5 }).sample(1);
  applyVehiclePoseToParts(rig, pose);
  const movedBody = transformPoint(body.matrix, [1.7, 0.8, 0]);
  assert.ok(Math.abs(movedBody[2] - (5 + 1.7)) < 1e-4);
  assert.ok(Math.abs(movedBody[0]) < 1e-4);
});

test('a camera path object can serve as the drive path', () => {
  const { rig } = createTestRig();
  const cameraPathLike = {
    duration: 10,
    sample: time => ({ eye: [Math.sin(time * 0.3) * 4, 0, time * 3] }),
  };
  const drive = driveAlongPath(rig, cameraPathLike, { speed: 6 });
  assert.ok(drive.length > 30);
  assert.ok(drive.sample(1).position[2] > 5);
});

test('scene-graph nodes receive the same world poses as parts', () => {
  const { body, wheels, parts } = createTestVehicleParts();
  const partRig = createVehicleRig({ parts, body: [body], wheels: wheels.map((part, index) => ({ id: WHEEL_CORNERS[index].id, part })) });
  const definitions = [
    { name: 'car' },
    { name: 'shell', parent: 'car', geometry: body.geometry, material: {} },
    ...wheels.map((part, index) => ({ name: part.name, parent: 'car', geometry: part.geometry, material: {} })),
  ];
  const graph = createSceneGraph(definitions);
  const graphRig = createVehicleRig({ graph, body: ['car'], wheels: wheels.map((part, index) => ({ id: WHEEL_CORNERS[index].id, node: part.name })) });
  const path = arcPath(12, 1);
  const pose = driveAlongPath(partRig, path, { speed: 5 }).sample(1.5);
  applyVehiclePoseToParts(partRig, pose);
  applyVehiclePoseToSceneGraph(graphRig, pose, graph);
  wheels.forEach(part => {
    const expected = Array.from(part.matrix);
    const actual = Array.from(graph.getNode(part.name).worldMatrix);
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-4, `${part.name}[${index}]`));
  });
  const shellActual = Array.from(graph.getNode('shell').worldMatrix);
  const shellExpected = Array.from(body.matrix);
  shellActual.forEach((value, index) => assert.ok(Math.abs(value - shellExpected[index]) < 1e-4, `shell[${index}]`));
});

test('imported glTF nodes get local overrides that reproduce the world pose', () => {
  const { body, wheels, parts } = createTestVehicleParts();
  const partRig = createVehicleRig({ parts, body: [body], wheels: wheels.map((part, index) => ({ id: WHEEL_CORNERS[index].id, part })) });
  const nodes = [
    { id: 'node-0', label: 'Car', parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], editable: true, meshIds: [] },
    { id: 'node-1', label: 'Shell', parent: 'node-0', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], editable: true, meshIds: ['mesh-0'] },
    ...wheels.map((part, index) => ({
      id: `node-${index + 2}`, label: part.name, parent: 'node-0', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      editable: true, meshIds: [`mesh-${index + 1}`],
    })),
  ];
  let stagedInput = null;
  const asset = {
    nodes,
    parts: parts.map(part => ({ geometry: part.geometry, matrix: Float32Array.from(part.matrix) })),
    stagePose(input) {
      stagedInput = input;
      return { commit: () => 'committed' };
    },
  };
  const rig = createVehicleRig({ asset });
  assert.equal(rig.wheels.length, 4);
  const pose = driveAlongPath(rig, arcPath(12, 1), { speed: 5 }).sample(1.5);
  assert.equal(applyVehiclePoseToAsset(rig, pose, asset), 'committed');
  const overrides = new Map(stagedInput.nodeOverrides.map(override => [override.id, override]));
  assert.equal(overrides.size, 5);
  const compose = override => mat4.fromRotationTranslationScale(mat4.create(), override.rotation, override.translation, override.scale);
  const carWorld = compose(overrides.get('node-0'));
  applyVehiclePoseToParts(partRig, pose);
  wheels.forEach((part, index) => {
    const world = mat4.multiply(mat4.create(), carWorld, compose(overrides.get(`node-${index + 2}`)));
    world.forEach((value, element) => assert.ok(Math.abs(value - part.matrix[element]) < 1e-4, `${part.name}[${element}]`));
  });
  assert.equal(createVehicleNodeOverrides(rig, pose).length, 5);
});

test('bad input produces specific errors', () => {
  const { body, wheels, parts } = createTestVehicleParts();
  const wheelSpecs = wheels.map(part => ({ part }));
  assert.throws(() => createVehicleRig({}), /exactly one of parts, graph or asset/);
  assert.throws(() => createVehicleRig({ parts, wheels: [wheelSpecs[0]] }), /^RangeError: wheels: got 1; expected at least 2 wheels, such as/);
  assert.throws(() => createVehicleRig({ parts, wheels: wheelSpecs, forwardAxis: '+y' }), /forwardAxis/);
  assert.throws(() => createVehicleRig({ parts, wheels: [{ part: 'Nothing' }, wheelSpecs[0]] }), /^RangeError: wheels\[0\]\.node: got "Nothing"; expected the name of a part in the asset, such as/);
  assert.throws(() => createVehicleRig({ parts, wheels: [{ part: wheels[0], radius: -1, center: [0, 0, 0] }, wheelSpecs[1]] }), /^RangeError: wheels\[0\]\.radius: got -1; expected a finite number above 0, such as 0\.35/);
  assert.throws(() => createVehicleRig({ parts: [body, { name: 'W1', matrix: mat4.create() }, { name: 'W2', matrix: mat4.create() }], wheels: [{ part: 'W1' }, { part: 'W2' }] }), /^RangeError: wheels.0.[.]radius: got undefined; expected a radius with a center, or geometry to measure them from, such as 0.35/);
  assert.throws(() => createVehicleRig({ parts, wheels: wheelSpecs, body: [] }), /^TypeError: body: got \[\]; expected a non-empty array of parts or nodes, such as/);
  const { rig } = createTestRig();
  assert.throws(() => driveAlongPath({}, STRAIGHT_PATH, { speed: 3 }), /needs a rig/);
  assert.throws(() => driveAlongPath(rig, [[0, 0, 0]], { speed: 3 }), /^RangeError: path: got "1 distinct point"; expected at least 2 distinct points, such as/);
  assert.throws(() => driveAlongPath(rig, [[0, 0, 0], [0, 0, NaN]], { speed: 3 }), /^TypeError: path\[1\]: got \[0,0,null\]; expected an array of 3 finite numbers, such as/);
  assert.throws(() => driveAlongPath(rig, 'road', { speed: 3 }), /^TypeError: path: got "road"; expected an array of \[x, y, z\] points, such as/);
  assert.throws(() => driveAlongPath(rig, STRAIGHT_PATH, {}), /exactly one of speed/);
  assert.throws(() => driveAlongPath(rig, STRAIGHT_PATH, { speed: 3, cruiseSpeed: 4 }), /exactly one of speed/);
  assert.throws(() => driveAlongPath(rig, STRAIGHT_PATH, { speed: -3 }), /^RangeError: speed: got -3; expected a finite number above 0, such as 8/);
  assert.throws(() => driveAlongPath(rig, STRAIGHT_PATH, { speed: 3, groundHeight: 4 }), /groundHeight must be a function/);
  const drive = driveAlongPath(rig, STRAIGHT_PATH, { speed: 3, groundHeight: () => NaN });
  assert.throws(() => drive.sample(1), /groundHeight must return a finite number/);
  assert.throws(() => driveAlongPath(rig, STRAIGHT_PATH, { speed: 3 }).sample(Infinity), /Sample time must be finite/);
  assert.throws(() => applyVehiclePoseToSceneGraph(rig, driveAlongPath(rig, STRAIGHT_PATH, { speed: 3 }).sample(0), {}), /built from parts, not graph/);
  assert.throws(() => findWheelCandidates('wheel'), /array of name strings/);
});

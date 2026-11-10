import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4, vec3 } from 'gl-matrix';
import { createPhysicsScene, planPhysicsScene } from '../src/physics.js';

function fallingBoxDefinition() {
  return {
    bodies: [
      { name: 'floor', type: 'fixed', translation: [0, -0.5, 0] },
      { name: 'box', translation: [0, 3, 0] },
    ],
    colliders: [
      { name: 'ground', body: 'floor', shape: 'cuboid', halfExtents: [5, 0.5, 5] },
      { name: 'box', body: 'box', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 },
    ],
  };
}
function bodyPose(scene, time, name) {
  const poseOffset = scene.bodyIndex(name) * 7;
  return scene.sample(time).slice(poseOffset, poseOffset + 7);
}

function anchor(pose, localAnchor) {
  const result = vec3.transformQuat(vec3.create(), localAnchor, pose.subarray(3));
  return vec3.add(result, result, pose.subarray(0, 3));
}

function near(actual, expected, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('memory plan bounds counts and rejects the bake before allocating Rapier or timeline', async () => {
  const definition = fallingBoxDefinition();
  const plan = planPhysicsScene(definition, { frameCount: 31 });
  assert.equal(plan.timelineBytes, 31 * 2 * 7 * 4);
  assert.equal(plan.estimatedPeakBytes, plan.timelineBytes + plan.solverReserveBytes);
  assert.ok(Object.isFrozen(plan));
  assert.throws(() => planPhysicsScene(definition, { frameCount: 100, maxFrames: 10 }), /frameCount/);
  assert.throws(() => planPhysicsScene(definition, { maxBodies: 1 }), /bodies/);
  assert.throws(() => planPhysicsScene(definition, { maxColliders: 1 }), /colliders/);
  await assert.rejects(createPhysicsScene(definition, { maxMemoryBytes: 1 }), /memory plan/);
  assert.throws(() => planPhysicsScene(definition, { frameCount: 1000001, maxFrames: 1000000 }), /frameCount/);
});

test('actual Rapier contact stops a falling box and supports a stable stack', async () => {
  const definition = fallingBoxDefinition();
  definition.bodies.push({ name: 'upper', translation: [0, 4.05, 0] });
  definition.colliders.push({ name: 'upper', body: 'upper', shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5], mass: 1 });
  const scene = await createPhysicsScene(definition, { frameCount: 361 });
  near(bodyPose(scene, scene.duration, 'box')[1], 0.5, 0.03);
  near(bodyPose(scene, scene.duration, 'upper')[1], 1.5, 0.05);
  assert.ok(bodyPose(scene, 0.3, 'box')[1] < 3);
  assert.deepEqual(bodyPose(scene, scene.duration, 'floor'), bodyPose(scene, 0, 'floor'));
  scene.dispose();
});

test('ball and capsule contacts use real collider dimensions', async () => {
  const definition = fallingBoxDefinition();
  definition.bodies[1].translation = [-1, 3, 0];
  definition.colliders[1] = { name: 'ball', body: 'box', shape: 'ball', radius: 0.4, mass: 1 };
  definition.bodies.push({ name: 'capsule', translation: [1, 3, 0] });
  definition.colliders.push({ name: 'capsule', body: 'capsule', shape: 'capsule', radius: 0.3, halfHeight: 0.6, mass: 1 });
  const scene = await createPhysicsScene(definition, { frameCount: 241 });
  near(bodyPose(scene, scene.duration, 'box')[1], 0.4, 0.03);
  near(bodyPose(scene, scene.duration, 'capsule')[1], 0.9, 0.03);
  scene.dispose();
});

test('compound collider mass and density both contribute to real impulse response', async () => {
  const definition = {
    gravity: [0, 0, 0],
    bodies: [{ name: 'body' }],
    colliders: [
      { name: 'left', body: 'body', shape: 'ball', radius: 0.5, translation: [-0.5, 0, 0], mass: 2 },
      { name: 'right', body: 'body', shape: 'ball', radius: 0.5, translation: [0.5, 0, 0], density: 6 / Math.PI },
    ],
    events: [{ tick: 0, body: 'body', impulse: [3, 0, 0] }],
  };
  const scene = await createPhysicsScene(definition, { frameCount: 61 });
  near(scene.sample(scene.duration)[0], scene.duration, 1e-5);
  near(scene.sample(scene.duration)[6], 1);
  scene.dispose();
});

for (const type of ['spherical', 'revolute', 'fixed']) {
  test(`${type} ragdoll constraint retains anchors while bodies collide with the floor`, async () => {
    const definition = fallingBoxDefinition();
    definition.bodies[1].translation = [0, 2.5, 0];
    definition.colliders[1] = { name: 'upper', body: 'box', shape: 'capsule', radius: 0.2, halfHeight: 0.3, mass: 1 };
    definition.bodies.push({ name: 'lower', translation: [0, 1.5, 0] });
    definition.colliders.push({ name: 'lower', body: 'lower', shape: 'capsule', radius: 0.2, halfHeight: 0.3, mass: 1 });
    definition.joints = [{
      name: 'joint',
      type,
      bodyA: 'box',
      bodyB: 'lower',
      anchorA: [0, -0.5, 0],
      anchorB: [0, 0.5, 0],
      ...(type === 'revolute' ? { axis: [0, 0, 1] } : {}),
    }];
    definition.events = [{ tick: 0, body: 'lower', impulse: [1, 0, 0], torqueImpulse: [0, 0, 0.2] }];
    const scene = await createPhysicsScene(definition, { frameCount: 241, solverIterations: 12 });
    for (const time of [0.25, 1, scene.duration]) {
      const upperPose = bodyPose(scene, time, 'box');
      const lowerPose = bodyPose(scene, time, 'lower');
      assert.ok(vec3.distance(anchor(upperPose, [0, -0.5, 0]), anchor(lowerPose, [0, 0.5, 0])) < 0.04);
      assert.ok(upperPose[1] > 0.15 && lowerPose[1] > 0.15);
    }
    if (type !== 'fixed') {
      assert.ok(Math.abs(bodyPose(scene, 0.25, 'lower')[5] - bodyPose(scene, 0.25, 'box')[5]) > 0.01, 'joint visibly bends');
    }
    scene.dispose();
  });
}

test('impulses, off-center impulses, and torque impulses are applied at declared ticks', async () => {
  const definition = {
    gravity: [0, 0, 0],
    bodies: [{ name: 'body' }],
    colliders: [{ name: 'ball', body: 'body', shape: 'ball', radius: 1, mass: 2 }],
    events: [
      { tick: 10, body: 'body', impulse: [2, 0, 0] },
      { tick: 20, body: 'body', impulse: [0, 2, 0], point: [1, 0, 0] },
      { tick: 30, body: 'body', torqueImpulse: [0, 0, 0.5] },
    ],
  };
  const scene = await createPhysicsScene(definition, { frameCount: 61 });
  near(scene.sample(scene.timestep * 10)[0], 0);
  near(scene.sample(scene.timestep * 11)[0], scene.timestep);
  assert.ok(scene.sample(scene.duration)[1] > 0.5);
  assert.ok(Math.abs(scene.sample(scene.duration)[5]) > 0.1);
  scene.dispose();
});

test('recording repeats bit exactly, and backward seeks do not change later samples', async () => {
  const definition = fallingBoxDefinition();
  definition.events = [
    { tick: 60, body: 'box', impulse: [2, 1, 0] },
    { tick: 60, body: 'box', torqueImpulse: [0, 0, 0.3] },
    { tick: 0, body: 'box', impulse: [-0.5, 0, 0] },
  ];
  const firstScene = await createPhysicsScene(definition, { frameCount: 121 });
  const secondScene = await createPhysicsScene(definition, { frameCount: 121 });
  const retainedOutput = new Float32Array(14);
  for (const tick of [120, 0, 80, 4, 120, 42]) {
    const time = tick * firstScene.timestep;
    assert.equal(firstScene.sample(time, retainedOutput), retainedOutput);
    assert.deepEqual(retainedOutput, secondScene.sample(time));
  }
  const finalPose = firstScene.sample(firstScene.duration);
  firstScene.sample(0);
  assert.deepEqual(firstScene.sample(firstScene.duration), finalPose);
  assert.deepEqual(firstScene.sample(-100), firstScene.sample(0));
  assert.deepEqual(firstScene.sample(100), finalPose);
  firstScene.dispose();
  secondScene.dispose();
});

test('kinematic targets push a dynamic body and samples interpolate translation and unit quaternions', async () => {
  const definition = {
    gravity: [0, 0, 0],
    bodies: [
      { name: 'platform', type: 'kinematic', translation: [-2, 0, 0] },
      { name: 'ball', translation: [0, 0, 0] },
    ],
    colliders: [
      { name: 'platform', body: 'platform', shape: 'cuboid', halfExtents: [0.5, 2, 2] },
      { name: 'ball', body: 'ball', shape: 'ball', radius: 0.5, mass: 1 },
    ],
    events: Array.from({ length: 60 }, (_, tick) => ({
      tick,
      type: 'kinematicPose',
      body: 'platform',
      translation: [-2 + (tick + 1) / 30, 0, 0],
      ...(tick === 59 ? { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] } : {}),
    })),
  };
  const scene = await createPhysicsScene(definition, { frameCount: 61 });
  assert.ok(bodyPose(scene, scene.duration, 'ball')[0] > 0.5);
  const previousPose = bodyPose(scene, 59 * scene.timestep, 'platform');
  const finalPose = bodyPose(scene, scene.duration, 'platform');
  const halfwayPose = bodyPose(scene, 59.5 * scene.timestep, 'platform');
  near(halfwayPose[0], (previousPose[0] + finalPose[0]) / 2);
  near(Math.hypot(...halfwayPose.subarray(3)), 1);
  near(halfwayPose[5], Math.sin(Math.PI / 8));
  scene.dispose();
});

test('part binding keeps matrix identity and scales, and updates all bindings atomically', async () => {
  const scene = await createPhysicsScene(fallingBoxDefinition(), { frameCount: 31 });
  const part = { matrix: mat4.fromScaling(mat4.create(), [-2, 3, 4]) };
  const other = { matrix: mat4.create() };
  const matrix = part.matrix;
  const binding = scene.bindParts([{ body: 'box', part }, { body: 'floor', part: other }]);
  binding.apply(scene.duration);
  assert.equal(part.matrix, matrix);
  near(part.matrix[0], -2);
  near(part.matrix[5], 3);
  near(part.matrix[10], 4);
  near(part.matrix[13], bodyPose(scene, scene.duration, 'box')[1]);
  const previous = part.matrix.slice();
  other.matrix = mat4.create();
  assert.throws(() => binding.apply(0), /identity changed/);
  assert.deepEqual(part.matrix, previous);
  scene.dispose();
  assert.throws(() => binding.apply(0), /disposed/);
});

test('malformed bodies, colliders, constraints, and events fail at the boundary', () => {
  const cases = [
    definition => definition.bodies.push({ name: 'box' }),
    definition => definition.bodies[1].rotation = [0, 0, 0, 0],
    definition => definition.bodies[1].translation = [Infinity, 0, 0],
    definition => definition.bodies[0].linearVelocity = [1, 0, 0],
    definition => definition.bodies[1].type = 'soft',
    definition => definition.colliders[1].mass = -1,
    definition => definition.colliders[1].density = 1,
    definition => definition.colliders[1].halfExtents = [0, 1, 1],
    definition => definition.colliders[1].body = 'missing',
    definition => definition.colliders[1].shape = 'mesh',
    definition => definition.colliders[1].sensor = 'yes',
    definition => definition.colliders[1].groups = 70000,
    definition => definition.colliders[1].points = [0, 0, 0],
    definition => definition.colliders = [definition.colliders[0]],
    definition => definition.joints = [{ name: 'j', type: 'spherical', bodyA: 'box', bodyB: 'box' }],
    definition => definition.joints = [{ name: 'j', type: 'revolute', bodyA: 'box', bodyB: 'floor', axis: [0, 0, 0] }],
    definition => definition.events = [{ tick: 100, body: 'box', impulse: [1, 0, 0] }],
    definition => definition.events = [{ tick: 0, body: 'floor', impulse: [1, 0, 0] }],
    definition => definition.events = [{ tick: 0, body: 'box', impulse: [1, 0, 0], translation: [1, 0, 0] }],
    definition => definition.events = [{ tick: 0, body: 'box', type: 'kinematicPose', translation: [1, 0, 0] }],
  ];
  for (const mutate of cases) {
    const definition = fallingBoxDefinition();
    mutate(definition);
    assert.throws(() => planPhysicsScene(definition, { frameCount: 10 }));
  }
});

test('binding rejects distinct overlapping matrix views before changing either target', async () => {
  const definition = fallingBoxDefinition();
  definition.bodies[1].type = 'fixed';
  const scene = await createPhysicsScene(definition, { frameCount: 1 });
  const buffer = new ArrayBuffer(21 * Float32Array.BYTES_PER_ELEMENT);
  const firstMatrix = new Float32Array(buffer, 0, 16);
  const secondMatrix = new Float32Array(buffer, 5 * Float32Array.BYTES_PER_ELEMENT, 16);
  mat4.identity(firstMatrix);
  mat4.identity(secondMatrix);
  const beforeBinding = new Float32Array(buffer).slice();
  assert.throws(() => scene.bindParts([
    { body: 'floor', part: { matrix: firstMatrix } },
    { body: 'box', part: { matrix: secondMatrix } },
  ]), /must not overlap/);
  assert.deepEqual(new Float32Array(buffer), beforeBinding);
  scene.dispose();
});

test('Float32 validation rejects rounded zero, overflow, and unsafe geometry inertia', async () => {
  for (const value of [1e-50, 1e40, NaN]) {
    const definition = fallingBoxDefinition();
    definition.colliders[1].mass = value;
    assert.throws(() => planPhysicsScene(definition), /Float32/);
  }
  const thin = fallingBoxDefinition();
  thin.colliders[1].halfExtents = [1e-15, 1e15, 1e15];
  delete thin.colliders[1].mass;
  assert.throws(() => planPhysicsScene(thin), /inertia/);
  assert.throws(() => planPhysicsScene(fallingBoxDefinition(), { timestep: 1e-50 }), /Float32/);
  const compound = fallingBoxDefinition();
  compound.colliders[1].mass = 2e38;
  compound.colliders.push({ ...compound.colliders[1], name: 'second' });
  assert.throws(() => planPhysicsScene(compound), /compound body mass/);
  const rounded = fallingBoxDefinition();
  rounded.bodies[1].translation = [0, 16777217, 0];
  const scene = await createPhysicsScene(rounded, { frameCount: 1 });
  assert.equal(bodyPose(scene, 0, 'box')[1], 16777216);
  scene.dispose();
});

test('solver preflight rejects normal-looking inputs that freeze or overflow Rapier motion', () => {
  function ballDefinition() {
    return {
      gravity: [0, 0, 0],
      bodies: [{ name: 'ball' }],
      colliders: [{ name: 'ball', body: 'ball', shape: 'ball', radius: 1, mass: 1 }],
    };
  }
  for (const tinyMass of [1e-38, 1e-40]) {
    const definition = ballDefinition();
    definition.gravity = [0, -9.81, 0];
    definition.colliders[0].mass = tinyMass;
    assert.throws(() => planPhysicsScene(definition, { frameCount: 3 }), /effective mass/);
  }
  for (const velocityField of ['linearVelocity', 'angularVelocity']) {
    const definition = ballDefinition();
    definition.bodies[0][velocityField] = [1e20, 0, 0];
    assert.throws(() => planPhysicsScene(definition, { frameCount: 3 }), /squared norm/);
  }
  const gravityOverflow = ballDefinition();
  gravityOverflow.gravity = [1e20, 0, 0];
  assert.throws(() => planPhysicsScene(gravityOverflow), /gravity squared norm/);
  for (const impulseField of ['impulse', 'torqueImpulse']) {
    const definition = ballDefinition();
    definition.events = [{ tick: 0, body: 'ball', [impulseField]: [1e20, 0, 0] }];
    assert.throws(() => planPhysicsScene(definition), /squared norm/);
  }
  const inducedVelocityOverflow = ballDefinition();
  inducedVelocityOverflow.colliders[0].mass = 1e-10;
  inducedVelocityOverflow.events = [{ tick: 0, body: 'ball', impulse: [1e10, 0, 0] }];
  assert.throws(() => planPhysicsScene(inducedVelocityOverflow), /accumulated linear velocity/);
  const offCenterOverflow = ballDefinition();
  offCenterOverflow.events = [{ tick: 0, body: 'ball', impulse: [0, 1e10, 0], point: [1e10, 0, 0] }];
  assert.throws(() => planPhysicsScene(offCenterOverflow), /off-center torque impulse/);
  const kinematicOverflow = {
    gravity: [0, 0, 0],
    bodies: [{ name: 'platform', type: 'kinematic' }],
    events: [{ tick: 0, body: 'platform', type: 'kinematicPose', translation: [1, 0, 0] }],
  };
  assert.throws(() => planPhysicsScene(kinematicOverflow, { timestep: 1e-40, frameCount: 3 }), /timestep reciprocal/);
  kinematicOverflow.events[0].translation = [1e20, 0, 0];
  assert.throws(() => planPhysicsScene(kinematicOverflow, { frameCount: 3 }), /kinematic target velocity/);
  kinematicOverflow.events = [1e19, 2e19].map(translation => ({ tick: 0, body: 'platform', type: 'kinematicPose', translation: [translation, 0, 0] }));
  assert.throws(() => planPhysicsScene(kinematicOverflow, { timestep: 1, frameCount: 3 }), /kinematic target velocity/);
});

test('small normal mass still responds to gravity instead of silently freezing', async () => {
  const definition = {
    bodies: [{ name: 'ball', translation: [0, 3, 0] }],
    colliders: [{ name: 'ball', body: 'ball', shape: 'ball', radius: 1, mass: 1e-20 }],
  };
  const scene = await createPhysicsScene(definition, { frameCount: 3 });
  assert.ok(scene.sample(scene.duration)[1] < scene.sample(0)[1]);
  scene.dispose();
});

test('inputs are copied before awaiting WASM initialization, and event/joint limits are enforced', async () => {
  const definition = fallingBoxDefinition();
  const pending = createPhysicsScene(definition, { frameCount: 2 });
  definition.bodies[1].translation[1] = 99;
  definition.colliders[1].halfExtents[1] = 99;
  const scene = await pending;
  near(bodyPose(scene, 0, 'box')[1], 3);
  scene.dispose();
  definition.joints = ['one', 'two'].map(name => ({ name, type: 'spherical', bodyA: 'floor', bodyB: 'box' }));
  assert.throws(() => planPhysicsScene(definition, { maxJoints: 1 }), /joints/);
  definition.joints = [];
  definition.events = [0, 1].map(tick => ({ tick, body: 'box', impulse: [1, 0, 0] }));
  assert.throws(() => planPhysicsScene(definition, { maxEvents: 1 }), /maxEvents/);
});

test('invalid samples and bindings cannot mutate matrices, and disposed scenes reject calls', async () => {
  const scene = await createPhysicsScene(fallingBoxDefinition(), { frameCount: 1 });
  assert.throws(() => scene.sample(NaN), /finite/);
  assert.throws(() => scene.sample(0, new Float32Array(1)), /output/);
  assert.throws(() => scene.bodyIndex('missing'), /unknown/);
  const part = { matrix: mat4.create() };
  part.matrix[4] = 0.25;
  assert.throws(() => scene.bindParts([{ body: 'box', part }]), /shear/);
  part.matrix[4] = 0;
  part.matrix[3] = 1e-6;
  assert.throws(() => scene.bindParts([{ body: 'box', part }]), /affine/);
  part.matrix[3] = 0;
  assert.throws(() => scene.bindParts([{ body: 'box', part }, { body: 'floor', part }]), /distinct/);
  scene.dispose();
  scene.dispose();
  assert.equal(scene.disposed, true);
  assert.throws(() => scene.sample(0), /disposed/);
  assert.throws(() => scene.bodyIndex('box'), /disposed/);
  assert.throws(() => scene.bindParts([]), /disposed/);
});

function actuatorDefinition(type = 'prismatic') {
  return {
    gravity: [0, 0, 0],
    bodies: [{ name: 'base', type: 'fixed' }, { name: 'driven' }],
    colliders: [{ name: 'driven', body: 'driven', shape: 'ball', radius: 1, mass: 1 }],
    joints: [{ name: 'actuator', type, bodyA: 'base', bodyB: 'driven', axis: type === 'prismatic' ? [1, 0, 0] : [0, 0, 1] }],
  };
}

function positionMotor(target = 0.5) {
  return { mode: 'position', target, stiffness: 40, damping: 8, maxForce: 10 };
}

function velocityMotor(target = 1, maxForce = 10) {
  return { mode: 'velocity', target, damping: 20, maxForce };
}

function actuatorCoordinate(scene, time, type) {
  const pose = bodyPose(scene, time, 'driven');
  return type === 'prismatic' ? pose[0] : 2 * Math.atan2(pose[5], pose[6]);
}

for (const type of ['prismatic', 'revolute']) {
  test(`${type} limits constrain a real motor in both directions`, async () => {
    const definition = actuatorDefinition(type);
    definition.joints[0].limits = [-0.25, 0.5];
    definition.joints[0].motor = velocityMotor(2);
    definition.events = [{ tick: 120, type: 'jointMotor', joint: 'actuator', motor: velocityMotor(-2) }];
    const scene = await createPhysicsScene(definition, { frameCount: 241, solverIterations: 12 });
    near(actuatorCoordinate(scene, scene.timestep * 120, type), 0.5, 0.02);
    near(actuatorCoordinate(scene, scene.duration, type), -0.25, 0.02);
    for (let frame = 0; frame < scene.frameCount; frame++) {
      const coordinate = actuatorCoordinate(scene, frame * scene.timestep, type);
      assert.ok(coordinate >= -0.28 && coordinate <= 0.53, `${type} limit escaped at frame ${frame}: ${coordinate}`);
    }
    scene.dispose();
  });

  test(`${type} position motors respond to tick target changes and wake sleeping bodies`, async () => {
    const definition = actuatorDefinition(type);
    definition.joints[0].limits = [-1, 1];
    definition.joints[0].motor = positionMotor(0);
    definition.events = [
      { tick: 120, type: 'jointMotor', joint: 'actuator', motor: positionMotor(0.5) },
      { tick: 240, type: 'jointMotor', joint: 'actuator', motor: positionMotor(-0.5) },
    ];
    const scene = await createPhysicsScene(definition, { frameCount: 361 });
    near(actuatorCoordinate(scene, scene.timestep * 120, type), 0);
    assert.ok(actuatorCoordinate(scene, scene.timestep * 150, type) > 0.05);
    near(actuatorCoordinate(scene, scene.timestep * 240, type), 0.5, 0.02);
    near(actuatorCoordinate(scene, scene.duration, type), -0.5, 0.02);
    scene.dispose();
  });
}

test('rotated prismatic endpoints use Float32 coordinate membership and still reject outside positions', async () => {
  const definition = actuatorDefinition();
  const direction = [Math.cos(0.2), Math.sin(0.2), 0];
  for (const body of definition.bodies) body.rotation = [0, 0, Math.sin(0.1), Math.cos(0.1)];
  definition.bodies[1].translation = direction;
  definition.joints[0].limits = [0, 1];
  definition.joints[0].motor = positionMotor(0.5);
  const scene = await createPhysicsScene(definition, { frameCount: 241 });
  const final = bodyPose(scene, scene.duration, 'driven');
  near(final[0] * direction[0] + final[1] * direction[1], 0.5, 0.02);
  for (let frame = 0; frame < scene.frameCount; frame++) {
    const pose = bodyPose(scene, frame * scene.timestep, 'driven');
    const coordinate = pose[0] * direction[0] + pose[1] * direction[1];
    assert.ok(coordinate >= -0.02 && coordinate <= 1.02);
  }
  scene.dispose();
  definition.bodies[1].translation = direction.map(value => value * 1.0001);
  assert.throws(() => planPhysicsScene(definition), /initial joint coordinate/);
});

test('exact half-turn antipodes share limit membership and real solver trajectories', async () => {
  for (const limits of [[0, Math.fround(Math.PI)], [-Math.fround(Math.PI), 0]]) {
    const scenes = [];
    for (const direction of [1, -1]) {
      const definition = actuatorDefinition('revolute');
      definition.bodies[1].rotation = [0, 0, direction, 0];
      definition.joints[0].limits = limits;
      definition.joints[0].motor = positionMotor(limits[0] === 0 ? 0.5 : -0.5);
      scenes.push(await createPhysicsScene(definition, { frameCount: 241 }));
    }
    for (let frame = 0; frame < scenes[0].frameCount; frame++) {
      const time = frame * scenes[0].timestep;
      assert.deepEqual(scenes[0].sample(time), scenes[1].sample(time));
    }
    const final = bodyPose(scenes[0], scenes[0].duration, 'driven');
    const target = limits[0] === 0 ? 0.5 : -0.5;
    assert.ok(Math.abs(final[5] * Math.sin(target / 2) + final[6] * Math.cos(target / 2)) > 0.999);
    scenes.forEach(scene => scene.dispose());
  }
  for (const angle of [Math.PI - 0.01, -Math.PI + 0.01]) {
    const definition = actuatorDefinition('revolute');
    definition.bodies[1].rotation = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
    definition.joints[0].limits = angle > 0 ? [-Math.fround(Math.PI), 0] : [0, Math.fround(Math.PI)];
    assert.throws(() => planPhysicsScene(definition), /initial joint coordinate/);
  }
});

test('maxForce limits real motor response, and disabling leaves momentum instead of holding a pose', async () => {
  const slowDefinition = actuatorDefinition();
  slowDefinition.joints[0].motor = velocityMotor(1, 1);
  const fastDefinition = actuatorDefinition();
  fastDefinition.joints[0].motor = velocityMotor(1, 10);
  fastDefinition.events = [{ tick: 60, type: 'jointMotor', joint: 'actuator', motor: null }];
  const slow = await createPhysicsScene(slowDefinition, { frameCount: 121 });
  const fast = await createPhysicsScene(fastDefinition, { frameCount: 121 });
  assert.ok(actuatorCoordinate(fast, 0.5, 'prismatic') > 2 * actuatorCoordinate(slow, 0.5, 'prismatic'));
  const afterDisable = actuatorCoordinate(fast, 1.5, 'prismatic') - actuatorCoordinate(fast, 1, 'prismatic');
  assert.ok(afterDisable > 0.4 && afterDisable < 0.6);
  slow.dispose();
  fast.dispose();
});

test('motor snapshots repeat bit exactly, respect same-tick order and permit arbitrary seeks', async () => {
  const definition = actuatorDefinition();
  definition.events = [
    { tick: 60, type: 'jointMotor', joint: 'actuator', motor: positionMotor(-0.5) },
    { tick: 0, type: 'jointMotor', joint: 'actuator', motor: positionMotor(-0.5) },
    { tick: 0, type: 'jointMotor', joint: 'actuator', motor: positionMotor(0.5) },
  ];
  const first = await createPhysicsScene(JSON.parse(JSON.stringify(definition)), { frameCount: 121 });
  const second = await createPhysicsScene(definition, { frameCount: 121 });
  assert.ok(actuatorCoordinate(first, 0.5, 'prismatic') > 0.1);
  for (let frame = 0; frame < first.frameCount; frame++) {
    assert.deepEqual(first.sample(frame * first.timestep), second.sample(frame * second.timestep));
  }
  const expected = first.sample(0.75);
  first.sample(first.duration);
  first.sample(0);
  first.sample(1.5);
  assert.deepEqual(first.sample(0.75), expected);
  first.dispose();
  second.dispose();
});

test('motor controls and limits are copied before asynchronous initialization, including nested event snapshots', async () => {
  const definition = actuatorDefinition();
  definition.joints[0].limits = [-1, 1];
  definition.joints[0].motor = positionMotor(0.5);
  definition.events = [{ tick: 0, type: 'jointMotor', joint: 'actuator', motor: positionMotor(-0.5) }];
  const pending = createPhysicsScene(definition, { frameCount: 121 });
  definition.joints[0].limits[0] = 100;
  definition.joints[0].motor.target = 100;
  definition.events[0].motor.target = 100;
  definition.events[0].joint = 'missing';
  const scene = await pending;
  near(actuatorCoordinate(scene, scene.duration, 'prismatic'), -0.5, 0.02);
  scene.dispose();
});

test('joint controls reject unknown fields, unsupported joints, out-of-limit targets and Float32 collapse', () => {
  for (const type of ['spherical', 'fixed']) {
    const definition = actuatorDefinition(type);
    delete definition.joints[0].axis;
    for (const field of ['motor', 'limits']) {
      definition.joints[0][field] = field === 'motor' ? null : [-1, 1];
      assert.throws(() => planPhysicsScene(definition), /revolute or prismatic/);
      delete definition.joints[0][field];
    }
    definition.events = [{ tick: 0, type: 'jointMotor', joint: 'actuator', motor: null }];
    assert.throws(() => planPhysicsScene(definition), /revolute or prismatic/);
  }
  for (const limits of [[1, -1], [0, 0], [1, 1 + 1e-8], [-1e40, 1], [-1e7, 1], [0, NaN]]) {
    const definition = actuatorDefinition();
    definition.joints[0].limits = limits;
    assert.throws(() => planPhysicsScene(definition), RangeError);
  }
  const outside = actuatorDefinition();
  outside.joints[0].limits = [-0.25, 0.25];
  outside.joints[0].motor = positionMotor(0.5);
  assert.throws(() => planPhysicsScene(outside), /within joint limits/);
  delete outside.joints[0].motor;
  outside.events = [{ tick: 0, type: 'jointMotor', joint: 'actuator', motor: positionMotor(0.5) }];
  assert.throws(() => planPhysicsScene(outside), /within joint limits/);
  for (const motor of [
    { ...positionMotor(), typo: 1 }, { ...positionMotor(), model: 'AccelerationBased' },
    { ...positionMotor(), mode: 'spherical' }, { ...velocityMotor(), stiffness: 1 },
    { ...positionMotor(), target: 1e-50 }, { ...positionMotor(), damping: 1e-50 },
    { ...velocityMotor(), damping: 0 }, { ...positionMotor(), stiffness: 0 },
  ]) {
    const definition = actuatorDefinition();
    definition.joints[0].motor = motor;
    assert.throws(() => planPhysicsScene(definition));
  }
  const invalidEvent = actuatorDefinition();
  invalidEvent.events = [{ tick: 0, type: 'jointMotor', joint: 'actuator', motor: null, body: 'driven' }];
  assert.throws(() => planPhysicsScene(invalidEvent), /unsupported/);
  invalidEvent.events = [{ tick: 0, type: 'jointMotor', joint: 'missing', motor: null }];
  assert.throws(() => planPhysicsScene(invalidEvent), /unknown joint/);
  invalidEvent.events = [{ tick: 0, type: 'jointMotor', joint: 'actuator' }];
  assert.throws(() => planPhysicsScene(invalidEvent), /motor must be an object/);
});

test('initial controlled joint coordinates, orientations and axes must match their authored limits', () => {
  const outside = actuatorDefinition();
  outside.bodies[1].translation = [2, 0, 0];
  outside.joints[0].limits = [-1, 1];
  assert.throws(() => planPhysicsScene(outside), /initial joint coordinate/);
  outside.bodies[1].translation = [0, 1, 0];
  assert.throws(() => planPhysicsScene(outside), /anchors must initially align/);
  const axes = actuatorDefinition('revolute');
  axes.joints[0].motor = positionMotor();
  axes.bodies[1].rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  assert.throws(() => planPhysicsScene(axes), /axes must initially align/);
  const anchorMismatch = actuatorDefinition('revolute');
  anchorMismatch.joints[0].motor = positionMotor();
  anchorMismatch.bodies[1].translation = [1, 0, 0];
  assert.throws(() => planPhysicsScene(anchorMismatch), /anchors must initially coincide/);
  const allFixed = actuatorDefinition();
  allFixed.bodies[1].type = 'fixed';
  allFixed.joints[0].motor = positionMotor();
  assert.throws(() => planPhysicsScene(allFixed), /dynamic body/);
});

test('motor preflight rejects huge, weak, collapsed and motor-induced unsafe Float32 states', () => {
  for (const field of ['target', 'stiffness', 'damping', 'maxForce']) {
    for (const value of [-1, 1e20, 1e40, NaN, Infinity]) {
      if (field === 'target' && value === -1) continue;
      const definition = actuatorDefinition();
      definition.joints[0].motor = { ...positionMotor(), [field]: value };
      assert.throws(() => planPhysicsScene(definition), RangeError);
    }
  }
  for (const motor of [
    positionMotor(1e7), velocityMotor(1e5),
    { ...positionMotor(), maxForce: 1e9 }, { ...positionMotor(), maxForce: 1e-20 },
    { ...positionMotor(), stiffness: 1e-30 }, { ...positionMotor(), stiffness: 1e7 },
    { ...positionMotor(), target: 1e-30 }, { ...velocityMotor(1e-16), damping: 1e-16 },
  ]) {
    const definition = actuatorDefinition();
    definition.joints[0].motor = motor;
    assert.throws(() => planPhysicsScene(definition), RangeError);
  }
  const tiny = actuatorDefinition();
  tiny.colliders[0].mass = 1e-20;
  tiny.joints[0].motor = positionMotor();
  assert.throws(() => planPhysicsScene(tiny), /motor.*acceleration/);
  const heavy = actuatorDefinition('revolute');
  heavy.colliders[0].mass = 1e38;
  heavy.joints[0].motor = positionMotor();
  assert.throws(() => planPhysicsScene(heavy), /motor angular acceleration/);
  const shortStep = actuatorDefinition();
  shortStep.joints[0].motor = positionMotor();
  assert.throws(() => planPhysicsScene(shortStep, { timestep: 1e-20 }), /motor.*step/);
  const hugePosition = actuatorDefinition();
  hugePosition.bodies[0].translation = [1e20, 0, 0];
  hugePosition.bodies[1].translation = [1e20, 0, 0];
  hugePosition.joints[0].motor = positionMotor();
  assert.throws(() => planPhysicsScene(hugePosition), /motor-induced position/);
  const chain = actuatorDefinition('revolute');
  chain.joints[0].motor = positionMotor();
  chain.bodies.push({ name: 'tiny' });
  chain.colliders.push({ name: 'tiny', body: 'tiny', shape: 'ball', radius: 1, mass: 1e-20 });
  chain.joints.push({ name: 'link', type: 'fixed', bodyA: 'driven', bodyB: 'tiny' });
  assert.throws(() => planPhysicsScene(chain), /motor angular acceleration/);
});

test('explicit initial and tick motor disable can be no-ops without changing the recorded pose', async () => {
  const definition = actuatorDefinition();
  definition.joints[0].motor = null;
  definition.events = [{ tick: 0, type: 'jointMotor', joint: 'actuator', motor: null }];
  const scene = await createPhysicsScene(definition, { frameCount: 3 });
  assert.deepEqual(scene.sample(scene.duration), scene.sample(0));
  scene.dispose();
});

test('cylinder and cone colliders, spring joints and force fields bake deterministically', async () => {
  const definition = {
    gravity: [0, 0, 0],
    fields: [{ type: 'wind', direction: [1, 0, 0], strength: 4 }],
    bodies: [
      { name: 'anchor', type: 'fixed', translation: [0, 0, 0] },
      { name: 'cyl', type: 'dynamic', translation: [0, -2, 0] },
      { name: 'cone', type: 'dynamic', translation: [2, 0, 0] },
    ],
    colliders: [
      { name: 'anchor', body: 'anchor', shape: 'cylinder', radius: 0.5, halfHeight: 0.5 },
      { name: 'cyl', body: 'cyl', shape: 'cylinder', radius: 0.4, halfHeight: 0.6, mass: 1 },
      { name: 'cone', body: 'cone', shape: 'cone', radius: 0.5, halfHeight: 0.8, mass: 1 },
    ],
    joints: [
      { name: 'spring', type: 'spring', bodyA: 'anchor', bodyB: 'cyl', restLength: 1, stiffness: 20, damping: 2 },
    ],
  };
  const scene = await createPhysicsScene(definition, { frameCount: 61 });
  const cylEnd = bodyPose(scene, 1, 'cyl');
  const coneEnd = bodyPose(scene, 1, 'cone');
  assert.ok(cylEnd[1] > -1.8, `spring pulls cylinder toward restLength, got ${cylEnd[1]}`);
  assert.ok(coneEnd[0] > 3.5, `wind field accelerates cone along +X, got ${coneEnd[0]}`);
  scene.dispose();

  assert.throws(() => planPhysicsScene({
    bodies: [{ name: 'a', type: 'dynamic' }],
    colliders: [{ name: 'a', body: 'a', shape: 'cylinder', radius: 0.5, halfHeight: 0.5, halfExtents: [1, 1, 1] }],
  }), /cylinder only accepts radius and halfHeight/);
  assert.throws(() => planPhysicsScene({
    bodies: [{ name: 'a', type: 'fixed' }, { name: 'b', type: 'dynamic' }],
    colliders: [{ name: 'b', body: 'b', shape: 'cone', radius: 0.5, halfHeight: 0.5 }],
    joints: [{ name: 'j', type: 'fixed', bodyA: 'a', bodyB: 'b', stiffness: 10 }],
  }), /spring joint/);
});

// The hash was recorded from the bake on main before createRapierWorld and applyForceFieldImpulses were extracted.
test('a force-field and spring bake matches the output recorded before the live-physics refactor', async () => {
  const definition = {
    gravity: [0, 0, 0],
    fields: [{ type: 'wind', direction: [1, 0, 0], strength: 4 }],
    bodies: [
      { name: 'anchor', type: 'fixed', translation: [0, 0, 0] },
      { name: 'cyl', type: 'dynamic', translation: [0, -2, 0] },
      { name: 'cone', type: 'dynamic', translation: [2, 0, 0] },
    ],
    colliders: [
      { name: 'anchor', body: 'anchor', shape: 'cylinder', radius: 0.5, halfHeight: 0.5 },
      { name: 'cyl', body: 'cyl', shape: 'cylinder', radius: 0.4, halfHeight: 0.6, mass: 1 },
      { name: 'cone', body: 'cone', shape: 'cone', radius: 0.5, halfHeight: 0.8, mass: 1 },
    ],
    joints: [{ name: 'spring', type: 'spring', bodyA: 'anchor', bodyB: 'cyl', restLength: 1, stiffness: 20, damping: 2 }],
  };
  const frameCount = 61;
  const scene = await createPhysicsScene(definition, { frameCount });
  const hash = createHash('sha256');
  for (let frame = 0; frame < frameCount; frame++) {
    hash.update(Buffer.from(new Float32Array(scene.sample(frame / 60)).buffer));
  }
  scene.dispose();
  assert.equal(hash.digest('hex'), '0ca9567131bd01531d04580283f2ea10009cc2180e1f08c60b1d3bd523e8fb1c');
});

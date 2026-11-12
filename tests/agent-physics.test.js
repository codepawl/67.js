import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine, needsPhysics } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

await loadPhysicsEngine();

function recipe(physics, extraNodes = []) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [
      { id: 'slab', type: 'box' },
      { id: 'ball', type: 'sphere' },
    ],
    materials: [{ id: 'paint', color: [0.6, 0.5, 0.4] }],
    nodes: [
      { id: 'floor', geometry: 'slab', material: 'paint', translation: [0, -0.25, 0], scale: [6, 0.5, 6] },
      { id: 'ball', geometry: 'ball', material: 'paint', translation: [0, 2, 0], scale: [0.5, 0.5, 0.5] },
      ...extraNodes,
    ],
    physics,
  };
}

const dropOnFloor = { duration: 3, bodies: [{ node: 'floor', type: 'fixed' }, { node: 'ball', shape: 'ball', restitution: 0.3 }] };

function matrixSnapshot(scene) {
  return scene.parts.map(part => Array.from(part.matrix));
}

test('a recipe physics section drops a body onto a trimesh floor and seeks deterministically', () => {
  const scene = createAgentScene(recipe(dropOnFloor));
  scene.sampleMotion(1.2);
  const middle = matrixSnapshot(scene);
  scene.sampleMotion(0);
  assert.equal(scene.parts[1].matrix[13], 2, 'time zero is the authored pose');
  scene.sampleMotion(3);
  const rested = scene.parts[1].matrix[13];
  assert.ok(Math.abs(rested - 0.5) < 0.02, `ball rests on the floor, got ${rested}`);
  scene.sampleMotion(1.2);
  assert.deepEqual(matrixSnapshot(scene), middle);
  scene.sampleMotion(null);
  assert.equal(scene.parts[1].matrix[13], 2);
});

test('scene_inspect reports contacts, resting state and sensors as numbers', () => {
  const scene = createAgentScene(recipe({
    duration: 3,
    bodies: [
      { node: 'floor', type: 'fixed' },
      { node: 'ball', shape: 'ball' },
      { node: 'zone', type: 'fixed', sensor: true },
    ],
  }, [{ id: 'zone', geometry: 'slab', material: 'paint', translation: [0, 1.2, 0], scale: [2, 0.2, 2] }]));
  const { physics } = scene.inspect({});
  const ball = physics.bodies.find(body => body.node === 'ball');
  assert.ok(ball.restsAtTime > 0.3 && ball.restsAtTime < 3);
  assert.ok(Math.abs(ball.finalPosition[1] - 0.5) < 0.02);
  assert.deepEqual(physics.contacts.map(({ a, b, touchingAtEnd }) => ({ a, b, touchingAtEnd })), [{ a: 'ball', b: 'floor', touchingAtEnd: true }]);
  assert.deepEqual(physics.sensorEvents.map(event => [event.sensor, event.other, event.kind]), [['zone', 'ball', 'enter'], ['zone', 'ball', 'leave']]);
});

test('physics is recorded again only when its inputs change', () => {
  const scene = createAgentScene(recipe(dropOnFloor));
  scene.apply([{ type: 'set-physics', physics: { ...dropOnFloor, bodies: [{ node: 'floor', type: 'fixed' }, { node: 'ball', shape: 'ball', restitution: 0.9 }] } }], { expectedRevision: 0 });
  scene.sampleMotion(0.9);
  const bouncy = scene.parts[1].matrix[13];
  scene.apply([{ type: 'set-physics', physics: null }], { expectedRevision: 1 });
  assert.equal(scene.inspect({}).physics, null);
  assert.equal(scene.parts[1].matrix[13], 2);
  assert.ok(bouncy < 2);
  assert.equal(scene.exportRecipe().physics, null);
});

test('masks and layers decide what a body falls through', () => {
  const scene = createAgentScene(recipe({
    duration: 3,
    bodies: [{ node: 'floor', type: 'fixed', layer: 1, collidesWith: [1] }, { node: 'ball', shape: 'ball', layer: 2, collidesWith: [2] }],
  }));
  scene.sampleMotion(3);
  assert.ok(scene.parts[1].matrix[13] < -10);
});

test('bad physics sections fail with a message that names the fix', () => {
  const cases = [
    [{ duration: 3, bodies: [{ node: 'missing' }] }, /^RangeError: physics\.bodies\[0\]\.node: got "missing"; expected the ID of a recipe node, one of /],
    [{ duration: 0, bodies: [{ node: 'ball' }] }, /duration/],
    [{ duration: 3, bodies: [] }, /at least one body/],
    [{ duration: 3, bodies: [{ node: 'ball', shape: 'trimesh' }] }, /dynamic/],
    [{ duration: 3, bodies: [{ node: 'ball' }, { node: 'ball' }] }, /^RangeError: physics\.bodies\[1\]\.node: got "ball"; expected a node with one physics body only/],
    [{ duration: 3, bodies: [{ node: 'ball', color: 1 }] }, /^TypeError: physics\.bodies\[0\]\.color: got 1; expected no such field; use one of node, type, shape/],
    [{ duration: 3, bodies: [{ node: 'ball' }], joints: [{ type: 'fixed', bodyA: 'ball', bodyB: 'floor' }] }, /physics body/],
    [{ duration: 3, bodies: [{ node: 'ball', layer: 16 }] }, /layer/],
  ];
  for (const [physics, message] of cases) {
    assert.throws(() => createAgentScene(recipe(physics)), message);
  }
});

test('a node cannot have both a physics body and a motion track on its pose', () => {
  const input = recipe({ duration: 3, bodies: [{ node: 'ball' }] });
  input.motion = { duration: 1, tracks: [{ kind: 'node', id: 'ball', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] }] };
  assert.throws(() => createAgentScene(input), /^RangeError: physics\.bodies\[0\]\.node: got "[^"]+"; expected a node without a motion translation or rotation track; pick the track or the body, not both/);
});

test('a trimesh over the triangle limit is refused before it is copied', () => {
  const input = recipe({ duration: 1, bodies: [{ node: 'floor', type: 'fixed' }] });
  input.geometries[0] = { id: 'slab', type: 'sphere', segments: 200, rings: 200 };
  assert.throws(() => createAgentScene(input), /triangles/);
});

test('capabilities name the physics surface and the detector finds a section', () => {
  assert.deepEqual(AGENT_SCENE_CAPABILITIES.physics.shapes, ['box', 'ball', 'capsule', 'convex', 'trimesh']);
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('set-physics'));
  assert.equal(needsPhysics(recipe(dropOnFloor)), true);
  assert.equal(needsPhysics(recipe(undefined)), false);
  assert.equal(needsPhysics([{ type: 'set-physics', physics: null }]), false);
});

test('recipe physics supports cylinder, cone, compound shapes, spring joints, motors, events and force fields', () => {
  const scene = createAgentScene(recipe({
    duration: 1,
    gravity: [0, 0, 0],
    fields: [{ type: 'wind', direction: [0, 0, 1], strength: 6 }],
    bodies: [
      { node: 'floor', type: 'fixed', shape: 'cylinder' },
      { node: 'ball', shape: 'cone', mass: 1 },
      { node: 'slider', shape: 'compound', shapes: [
        { shape: 'box', halfExtents: [0.2, 0.2, 0.2], translation: [-0.2, 0, 0] },
        { shape: 'ball', radius: 0.2, translation: [0.2, 0, 0] },
        { shape: 'cylinder', radius: 0.1, halfHeight: 0.2 },
      ] },
      { node: 'bob', shape: 'capsule' },
    ],
    joints: [
      { name: 'track', type: 'prismatic', bodyA: 'floor', bodyB: 'slider', anchorA: [0, 2, 0], anchorB: [0, 0, 0], axis: [1, 0, 0], limits: [-2, 2], motor: { mode: 'position', target: 0.8, stiffness: 60, damping: 10, maxForce: 100 }, contactsEnabled: false },
      { type: 'spring', bodyA: 'floor', bodyB: 'bob', anchorA: [0, 2, 0], anchorB: [0, 0, 0], restLength: 0.5, stiffness: 30, damping: 3 },
    ],
    events: [
      { time: 0.2, type: 'impulse', body: 'ball', impulse: [3, 0, 0], torqueImpulse: [0, 1, 0], point: [0, 2, 0] },
      { tick: 30, type: 'jointMotor', joint: 'track', motor: { mode: 'velocity', target: -0.5, damping: 10, maxForce: 50 } },
    ],
  }, [
    { id: 'slider', geometry: 'slab', material: 'paint', translation: [0, 1.75, 0], rotation: [0, 0, 0, 1], scale: [0.4, 0.4, 0.4] },
    { id: 'bob', geometry: 'ball', material: 'paint', translation: [0, 0.5, 0], scale: [0.3, 0.3, 0.3] },
  ]));
  scene.sampleMotion(1);
  const { physics } = scene.inspect({});
  const ball = physics.bodies.find(body => body.node === 'ball');
  const bob = physics.bodies.find(body => body.node === 'bob');
  assert.ok(ball.finalPosition[0] > 1.5, `impulse pushes ball along +X, got ${ball.finalPosition[0]}`);
  assert.ok(ball.finalPosition[2] > 2, `wind field pushes ball along +Z, got ${ball.finalPosition[2]}`);
  assert.ok(bob.finalPosition[1] > 0.8, `spring pulls bob upward, got ${bob.finalPosition[1]}`);

  const kinScene = createAgentScene(recipe({ duration: 1, bodies: [{ node: 'floor', type: 'kinematic', shape: 'box' }], events: [{ time: 0.1, type: 'kinematicPose', body: 'floor', translation: [0, 1, 0], rotation: [0, 0, 0, 1] }] }));
  kinScene.sampleMotion(0.5);
  assert.equal(kinScene.parts[0].matrix[13], 1);
  assert.throws(() => createAgentScene(recipe({ duration: 1, bodies: [{ node: 'ball', shape: 'compound', shapes: [] }] })), /at least one sub-collider/);
  assert.throws(() => createAgentScene(recipe({ duration: 1, bodies: [{ node: 'ball', shapes: [{ shape: 'box', halfExtents: [1, 1, 1] }] }] })), /compound/);
  assert.throws(() => createAgentScene(recipe({ duration: 1, bodies: [{ node: 'ball' }], events: [{ time: 0.1, type: 'impulse', body: 'ball' }] })), /impulse or torqueImpulse/);
  assert.throws(() => createAgentScene(recipe({ duration: 1, bodies: [{ node: 'floor', type: 'kinematic', shape: 'box' }], events: [{ time: 0.1, type: 'kinematicPose', body: 'floor' }] })), /translation or rotation/);
});

test('a recipe fixed joint with breakImpulse breaks under a hard hit and the report lists it', () => {
  const slab = { id: 'slab', geometry: 'slab', material: 'paint', translation: [0, 4, 0], scale: [0.6, 0.3, 0.6] };
  const glue = { name: 'glue', type: 'fixed', bodyA: 'floor', bodyB: 'ball', anchorA: [0, 2.25, 0], anchorB: [0, 0, 0], breakImpulse: 2 };
  const physics = joint => ({
    duration: 1.5,
    bodies: [{ node: 'floor', type: 'fixed' }, { node: 'ball', shape: 'ball', mass: 1 }, { node: 'slab', shape: 'box', mass: 5 }],
    joints: [joint],
  });
  const scene = createAgentScene(recipe(physics(glue), [slab]));
  scene.sampleMotion(1.5);
  const report = scene.inspect({}).physics;
  assert.equal(report.jointBreaks.length, 1);
  assert.equal(report.jointBreaks[0].joint, 'glue');
  assert.ok(report.jointBreaks[0].impulse >= 2);
  assert.throws(() => createAgentScene(recipe(physics({ ...glue, type: 'spherical' }), [slab])), /breakImpulse/);
  assert.throws(() => createAgentScene(recipe(physics({ ...glue, breakImpulse: 0 }), [slab])), /breakImpulse/);
});

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

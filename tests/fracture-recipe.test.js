import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentScene, loadPhysicsEngine, needsPhysics } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

await loadPhysicsEngine();

function wallRecipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'brick', color: [0.6, 0.3, 0.2] }],
    nodes: [
      { id: 'floor', geometry: 'slab', material: 'brick', translation: [0, -0.25, 0], scale: [8, 0.5, 8] },
      { id: 'wall', geometry: 'slab', material: 'brick', translation: [0, 1, 0], scale: [3, 2, 0.4] },
      { id: 'ball', geometry: 'ball', material: 'brick', translation: [0, 1, 5], scale: [0.5, 0.5, 0.5] },
    ],
  };
}

function operations({ shoot, strength = 5, cells = 16, extra = {} }) {
  return [
    {
      type: 'set-physics',
      physics: {
        duration: 2,
        bodies: [
          { node: 'floor', type: 'fixed', shape: 'box' },
          { node: 'ball', shape: 'ball', density: 400, ...(shoot ? { velocity: [0, 0.5, -14] } : {}) },
        ],
      },
    },
    { type: 'fracture-node', node: 'wall', seed: 7, cells, strength, ...extra },
  ];
}

function applyOperations(scene, list) {
  return scene.apply(list, { expectedRevision: scene.inspect({}).revision });
}

function fracturedScene(settings) {
  const scene = createAgentScene(wallRecipe());
  applyOperations(scene, operations(settings));
  return scene;
}

function geometryDigest(scene) {
  const hash = createHash('sha256');
  for (const part of scene.parts) {
    const { positions, indices } = part.geometry;
    hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
    hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  }
  return hash.digest('hex');
}

test('fracture-node swaps a node for glued piece nodes with bodies, deterministically', () => {
  const first = fracturedScene({ shoot: false });
  const second = fracturedScene({ shoot: false });
  const recipe = first.exportRecipe();
  const pieces = recipe.nodes.filter(node => node.id.startsWith('wall-frag-'));
  assert.equal(pieces.length, 16);
  assert.equal(recipe.nodes.some(node => node.id === 'wall'), false);
  assert.ok(pieces.every(node => node.material === 'brick' && node.scale[0] === 3 && node.translation[1] === 1));
  assert.equal(recipe.physics.bodies.filter(body => body.shape === 'convex').length, 16);
  assert.ok(recipe.physics.joints.length >= 15, `${recipe.physics.joints.length} glue joints`);
  assert.ok(recipe.physics.joints.every(joint => joint.type === 'fixed' && joint.breakImpulse === 5));
  assert.deepEqual(second.exportRecipe(), recipe);
  assert.equal(geometryDigest(first), geometryDigest(second));
  assert.equal(needsPhysics([{ type: 'fracture-node', node: 'wall', cells: 8, strength: 5 }]), true);
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('fracture-node'));
});

test('editing the source geometry changes the pieces', () => {
  const scene = fracturedScene({ shoot: false });
  const before = geometryDigest(scene);
  applyOperations(scene, [{ type: 'remove-geometry', id: 'slab' }, { type: 'add-geometry', geometry: { id: 'slab', type: 'box', bevel: 0.2 } }]);
  assert.notEqual(geometryDigest(scene), before);
});

test('a resting wall keeps all its glue and a ball fired at it breaks some', () => {
  const resting = fracturedScene({ shoot: false });
  resting.sampleMotion(2);
  assert.equal(resting.inspect({}).physics.jointBreaks, undefined);

  const hit = fracturedScene({ shoot: true });
  hit.sampleMotion(2);
  const breaks = hit.inspect({}).physics.jointBreaks;
  assert.ok(breaks.length > 0, 'the ball breaks glue');
  assert.ok(breaks.every(entry => entry.joint.startsWith('wall-glue-') && entry.impulse >= 5));
  const total = hit.exportRecipe().physics.joints.length;
  assert.ok(breaks.length < total, `${breaks.length} of ${total} joints break, the rest of the wall holds`);
});

test('an impact point and radius reach the pieces and bad input says what to pass', () => {
  const scene = fracturedScene({ shoot: false, cells: 24, extra: { impact: [0, 0, 0.2], impactRadius: 0.3 } });
  const piece = scene.exportRecipe().geometries.find(geometry => geometry.id === 'wall-frag-0');
  assert.deepEqual(piece.impact, [0, 0, 0.2]);
  const base = createAgentScene(wallRecipe());
  assert.throws(() => applyOperations(base, operations({ cells: 1 })), /cells: got 1; expected a whole number of pieces from 2 to 64/);
  assert.throws(() => applyOperations(base, operations({ cells: 65 })), /cells/);
  assert.throws(() => applyOperations(base, operations({ strength: 0 })), /strength: got 0; expected the glue strength/);
  assert.throws(() => applyOperations(base, [{ type: 'fracture-node', node: 'nope', cells: 4, strength: 5 }]), /node: got "nope"; expected the ID of an existing node/);
  assert.throws(() => applyOperations(base, [{ type: 'fracture-node', node: 'wall', cells: 4, strength: 5, extra: 1 }]), /extra/);
});

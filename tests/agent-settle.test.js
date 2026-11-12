import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine, needsPhysics } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { SETTLE_CAPABILITY_NOTE } from '../src/settle-notes.js';

await loadPhysicsEngine();

function wallRecipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box' }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }, { id: 'rust', color: [0.6, 0.3, 0.2] }],
    nodes: [
      { id: 'floor', geometry: 'slab', material: 'stone', translation: [0, -0.1, 0], scale: [8, 0.2, 8] },
      { id: 'wall', geometry: 'slab', material: 'stone', translation: [0, 1, -2], scale: [8, 2, 0.4] },
    ],
  };
}

const rubble = {
  id: 'rubble', geometry: 'slab', material: ['stone', 'rust'], colliders: ['floor', 'wall'],
  area: { min: [-2, -1.7], max: [2, -0.5] }, count: 40, size: [0.1, 0.25], seed: 5,
};

test('a settle operation adds static parts that rest on the floor and against the wall', () => {
  const scene = createAgentScene(wallRecipe());
  scene.apply([{ type: 'settle', settle: rubble }], { expectedRevision: 0 });
  const recipe = scene.exportRecipe();
  const props = recipe.nodes.filter(node => node.parent === 'rubble');
  assert.ok(props.length >= 30, `settled ${props.length} of 40`);
  assert.equal(recipe.nodes.find(node => node.id === 'rubble').geometry, undefined, 'a group node holds the props');
  assert.equal(recipe.physics, undefined, 'the result is static: no physics section is added');
  for (const node of props) {
    assert.ok(node.translation[1] > 0.04, `a prop rests on the floor, got y ${node.translation[1]}`);
    assert.ok(node.translation[2] > -1.8, 'a prop lies in front of the wall');
  }
});

test('a second settle stacks on the first because a group node stands for its children', () => {
  const scene = createAgentScene(wallRecipe());
  scene.apply([{ type: 'settle', settle: rubble }], { expectedRevision: 0 });
  scene.apply([{ type: 'settle', settle: { ...rubble, id: 'more', colliders: ['floor', 'wall', 'rubble'], seed: 6 } }], { expectedRevision: 1 });
  const nodes = scene.inspect({ limit: 200 }).nodes;
  assert.ok(nodes.filter(node => node.id.startsWith('more-')).length > 20);
});

test('the same seed gives the same recipe nodes', () => {
  const first = createAgentScene(wallRecipe());
  const second = createAgentScene(wallRecipe());
  first.apply([{ type: 'settle', settle: rubble }], { expectedRevision: 0 });
  second.apply([{ type: 'settle', settle: rubble }], { expectedRevision: 0 });
  assert.equal(JSON.stringify(first.inspect({ limit: 200 })), JSON.stringify(second.inspect({ limit: 200 })));
});

test('settle operation errors name the field and what to pass', () => {
  const scene = createAgentScene(wallRecipe());
  const attempt = settle => () => scene.apply([{ type: 'settle', settle: { ...rubble, ...settle } }], { expectedRevision: 0 });
  assert.throws(attempt({ geometry: 'missing' }), /settle\.geometry/);
  assert.throws(attempt({ material: 'missing' }), /settle\.material/);
  assert.throws(attempt({ colliders: ['nowhere'] }), /settle\.colliders\[0\]/);
  assert.throws(attempt({ id: 'floor' }), /settle\.id/);
  assert.throws(attempt({ count: 999 }), /settle\.count/);
  assert.throws(() => scene.apply([{ type: 'settle', id: 'x' }], { expectedRevision: 0 }), /put the settle fields inside "settle"/);
});

test('a settle operation asks the host to load the physics engine and is listed in the capabilities', () => {
  assert.equal(needsPhysics([{ type: 'settle', settle: rubble }]), true);
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('settle'));
  assert.match(SETTLE_CAPABILITY_NOTE, /scene_apply settle/);
});

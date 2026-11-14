import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { sessionProblem } from '../src/agent-errors.js';
import { readableErrorMessage } from '../scripts/mcp-server.mjs';

function baseRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }, { id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 } }],
    materials: [{ id: 'paint', color: [0.2, 0.4, 0.8] }],
    nodes: [{ id: 'body', geometry: 'cube', material: 'paint' }, { id: 'child', parent: 'body' }],
  };
}

function withRecipe(change) {
  const recipe = baseRecipe();
  change(recipe);
  return () => createAgentScene(recipe);
}

function onScene(action) {
  return () => action(createAgentScene(baseRecipe()));
}

// Each trigger is a way an agent reaches an error. The message must say what failed and what to do next.
const TRIGGERS = {
  'unknown geometry type': withRecipe(recipe => { recipe.geometries[0].type = 'pyramid'; }),
  'unknown geometry field': withRecipe(recipe => { recipe.geometries[0].width = 2; }),
  'node refers to a missing geometry': withRecipe(recipe => { recipe.nodes[0].geometry = 'nothing'; }),
  'node refers to a missing material': withRecipe(recipe => { recipe.nodes[0].material = 'nothing'; }),
  'node with a material and no geometry': withRecipe(recipe => { delete recipe.nodes[0].geometry; }),
  'node parent that does not exist': withRecipe(recipe => { recipe.nodes[1].parent = 'ghost'; }),
  'duplicate node id': withRecipe(recipe => { recipe.nodes.push({ id: 'body' }); }),
  'opacity above one': withRecipe(recipe => { recipe.materials[0].opacity = 2; }),
  'unknown alpha mode': withRecipe(recipe => { recipe.materials[0].alphaMode = 'additive'; }),
  'pattern with one colour': withRecipe(recipe => { recipe.materials[0].pattern = { type: 'bricks', colors: [[1, 1, 1]] }; }),
  'transmission on an unlit material': withRecipe(recipe => { Object.assign(recipe.materials[0], { tag: 'unlit', transmission: 0.5 }); }),
  'mesh edit with an unknown op': withRecipe(recipe => { recipe.geometries[1].edits = [{ op: 'explode' }]; }),
  'mesh edit that selects nothing': onScene(scene => scene.apply([{ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'delete', select: { tag: 'nowhere' } }] }], { expectedRevision: 0 })),
  'mesh edit on a primitive geometry': onScene(scene => scene.apply([{ type: 'edit-mesh', geometry: 'cube', edits: [{ op: 'flip_normals', select: { all: true } }] }], { expectedRevision: 0 })),
  'mesh edit on a missing geometry': onScene(scene => scene.apply([{ type: 'edit-mesh', geometry: 'nothing', edits: [{ op: 'flip_normals', select: { all: true } }] }], { expectedRevision: 0 })),
  'stale revision': onScene(scene => scene.apply([{ type: 'set-node', id: 'body', translation: [1, 0, 0] }], { expectedRevision: 9 })),
  'unknown operation type': onScene(scene => scene.apply([{ type: 'set-everything' }], { expectedRevision: 0 })),
  'set-node on a missing node': onScene(scene => scene.apply([{ type: 'set-node', id: 'ghost', translation: [1, 0, 0] }], { expectedRevision: 0 })),
  'set-node with an unknown field': onScene(scene => scene.apply([{ type: 'set-node', id: 'body', colour: 'red' }], { expectedRevision: 0 })),
  'remove a geometry that a node uses': onScene(scene => scene.apply([{ type: 'remove-geometry', id: 'cube' }], { expectedRevision: 0 })),
  'remove a node that has children': onScene(scene => scene.apply([{ type: 'remove-node', id: 'body' }], { expectedRevision: 0 })),
  'inspect a missing node': onScene(scene => scene.inspect({ ids: ['ghost'] })),
  'inspect with an unknown option': onScene(scene => scene.inspect({ kind: 'hierarchy' })),
  'mesh inspect of a missing geometry': onScene(scene => scene.inspectMeshes({ geometries: ['nothing'] })),
  'rotation that is not a unit quaternion': withRecipe(recipe => { recipe.nodes[0].rotation = [0, 0, 0, 0]; }),
  'scale that is not positive': withRecipe(recipe => { recipe.nodes[0].scale = [1, 0, 1]; }),
  'motion with an unknown field': withRecipe(recipe => { recipe.motion = { duration: 1, loop: false, tracks: [], speed: 2 }; }),
};

// A message needs a next action: an imperative, a statement of the accepted values, or a list of valid choices.
const NEXT_ACTION = /\b(use|call|set|remove|drop|pass|add|move|run|raise|lower|choose|check|read|list|re-?export|undo|assign|thicken|try|fix|delete|select|dispose|create|inspect|provide|name|must|needs?|expected|allowed|one of|known|between|within|at most|at least|nonzero|positive|finite)\b/i;

for (const [label, trigger] of Object.entries(TRIGGERS)) {
  test(`error for ${label} names what failed and what to do next`, () => {
    let message;
    try {
      trigger();
    } catch (error) {
      message = readableErrorMessage(error);
    }
    assert.ok(message, `${label} must throw`);
    assert.ok(message.length >= 30, `too short to name what failed: "${message}"`);
    assert.match(message, NEXT_ACTION, `no next action in: "${message}"`);
    assert.doesNotMatch(message, /^page\.evaluate|https?:\/\//, `leaks bundle internals: "${message}"`);
  });
}

test('a session error names the active session or says how to create one', () => {
  assert.match(sessionProblem('abc', undefined), /scene_create/);
  assert.match(sessionProblem('abc', 'live-id'), /active session is live-id/);
});

test('page errors lose the evaluate prefix and the bundle stack', () => {
  const error = new Error('page.evaluate: RangeError: Unknown mesh ID: node1. Use mesh-0. at Object.inspect (http://127.0.0.1:5173/preview.js:1:2) at Array.map (<anonymous>)');
  assert.equal(readableErrorMessage(error), 'Unknown mesh ID: node1. Use mesh-0.');
});

// Messages a JavaScript engine writes for a bug in our code. The agent must get advice instead, never the raw text.
const ENGINE_FAULTS = [
  new TypeError("Cannot read properties of undefined (reading 'map')"),
  new TypeError('page.evaluate: TypeError: scene.inspect is not a function at Object.look (http://127.0.0.1:5173/preview.js:1:2)'),
  new TypeError('undefined is not iterable (cannot read property Symbol(Symbol.iterator))'),
  new ReferenceError('sessionProblem is not defined'),
  new TypeError("Cannot destructure property 'id' of 'undefined' as it is undefined."),
];

for (const fault of ENGINE_FAULTS) {
  test(`engine fault "${fault.message.slice(0, 40)}" reaches an agent as advice with a next action`, () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    let message;
    try {
      message = readableErrorMessage(fault);
    } finally {
      console.error = originalConsoleError;
    }
    assert.doesNotMatch(message, /Cannot read|Cannot destructure|is not a function|is not iterable|is not defined|undefined/i);
    assert.match(message, /Internal error/);
    assert.match(message, NEXT_ACTION);
  });
}

test('the validation errors we write ourselves are not mistaken for engine faults', () => {
  const message = 'Only mesh nodes can have a skin.';
  assert.equal(readableErrorMessage(new TypeError(message)), message);
});

import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeRelations, solveRelations } from '../src/agent-relations.js';

function recipeWith(nodes, geometries = []) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }, ...geometries],
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    nodes: nodes.map(node => ({ geometry: 'cube', material: 'grey', ...node })),
  };
}

function worldBounds(scene, id) {
  return scene.inspect({ ids: [id], includeBounds: true }).nodes[0].bounds;
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual} is not ${expected}`);
}

function handleRecipe() {
  return recipeWith([
    { id: 'body', scale: [2, 1, 1] },
    { id: 'handle', scale: [0.2, 0.2, 0.2], translation: [9, 9, 9], relations: [{ kind: 'attach', to: 'body', side: '+x' }] },
  ]);
}

test('a resized body keeps its attached handle against it', () => {
  const scene = createAgentScene(handleRecipe());
  let body = worldBounds(scene, 'body');
  let handle = worldBounds(scene, 'handle');
  near(handle.min[0], body.max[0], 'handle touches the +x face');
  near((handle.min[1] + handle.max[1]) / 2, 0, 'handle centred on y');
  scene.apply([{ type: 'set-node', id: 'body', scale: [5, 3, 1], translation: [1, 2, 0] }], { expectedRevision: scene.revision });
  body = worldBounds(scene, 'body');
  handle = worldBounds(scene, 'handle');
  near(handle.min[0], body.max[0], 'handle follows the new +x face');
  near((handle.min[1] + handle.max[1]) / 2, 2, 'handle follows the new centre');
});

test('gap, flush, align and centered place parts on their own axes', () => {
  const scene = createAgentScene(recipeWith([
    { id: 'base', scale: [2, 1, 2] },
    { id: 'lamp', scale: [0.5, 0.5, 0.5], relations: [
      { kind: 'gap', to: 'base', side: '+y', offset: 0.25 },
      { kind: 'align', to: 'base', axis: 'x', at: 'min', offset: 0.1 },
      { kind: 'centered', to: 'base', axes: ['z'] },
    ] },
    { id: 'post', scale: [0.2, 3, 0.2], translation: [0, 0, 5], relations: [{ kind: 'flush', to: 'base', side: '-y' }] },
  ]));
  const base = worldBounds(scene, 'base');
  const lamp = worldBounds(scene, 'lamp');
  const post = worldBounds(scene, 'post');
  near(lamp.min[1], base.max[1] + 0.25, 'gap above');
  near(lamp.min[0], base.min[0] + 0.1, 'align min x');
  near((lamp.min[2] + lamp.max[2]) / 2, 0, 'centred z');
  near(post.min[1], base.min[1], 'flush bottoms');
  near(post.min[2] + 0.1, 5, 'post keeps its own z');
});

test('relations under a rotated and scaled parent still solve in world space', () => {
  const scene = createAgentScene(recipeWith([
    { id: 'rig', rotation: [0, 0.7071068, 0, 0.7071068], scale: [2, 2, 2], translation: [1, 0, 0] },
    { id: 'body', parent: 'rig' },
    { id: 'knob', parent: 'rig', scale: [0.1, 0.1, 0.1], relations: [{ kind: 'attach', to: 'body', side: '+y' }] },
  ]));
  const body = worldBounds(scene, 'body');
  const knob = worldBounds(scene, 'knob');
  near(knob.min[1], body.max[1], 'knob sits on the top');
  near((knob.min[0] + knob.max[0]) / 2, (body.min[0] + body.max[0]) / 2, 'centred x');
});

test('a chain of relations solves in dependency order whatever the node order', () => {
  const scene = createAgentScene(recipeWith([
    { id: 'c', scale: [0.2, 0.2, 0.2], relations: [{ kind: 'attach', to: 'b', side: '+x' }] },
    { id: 'b', scale: [0.5, 0.5, 0.5], relations: [{ kind: 'attach', to: 'a', side: '+x' }] },
    { id: 'a', scale: [1, 1, 1], translation: [3, 0, 0] },
  ]));
  near(worldBounds(scene, 'b').min[0], worldBounds(scene, 'a').max[0], 'b on a');
  near(worldBounds(scene, 'c').min[0], worldBounds(scene, 'b').max[0], 'c on b');
});

test('a tagged region of the target is the reference, not the whole part', () => {
  const body = { id: 'tank', type: 'mesh', base: { type: 'box' }, edits: [
    { op: 'extrude_face_region', select: { normal: [0, 1, 0], maxAngle: 5 }, offset: 1 },
    { op: 'tag', select: { normal: [0, 1, 0], maxAngle: 5 }, name: 'top' },
  ] };
  const scene = createAgentScene(recipeWith([
    { id: 'tank', geometry: 'tank' },
    { id: 'cap', scale: [0.2, 0.2, 0.2], relations: [{ kind: 'gap', to: 'tank', region: 'top', side: '+y' }] },
  ], [body]));
  near(worldBounds(scene, 'cap').min[1], worldBounds(scene, 'tank').max[1], 'cap rests on the tagged top');
  const bad = recipeWith([
    { id: 'tank', geometry: 'tank' },
    { id: 'cap', relations: [{ kind: 'gap', to: 'tank', region: 'lid', side: '+y' }] },
  ], [body]);
  assert.throws(() => createAgentScene(bad), /nodes\[1\]\.relations\[0\]\.region: got "lid"; expected a target that can be measured \(Unknown tag lid.*Known tags: .*top/s);
  const plain = recipeWith([{ id: 'a' }, { id: 'b', relations: [{ kind: 'gap', to: 'a', region: 'top', side: '+y' }] }]);
  assert.throws(() => createAgentScene(plain), /region: got "top"; expected a tag on a mesh geometry.*tag faces with a mesh_edit tag op/s);
});

test('relations solve the same every time and again after an edit moves a referenced region', () => {
  const first = createAgentScene(handleRecipe()).exportRecipe();
  const second = createAgentScene(handleRecipe()).exportRecipe();
  assert.deepEqual(first, second);
  const scene = createAgentScene(handleRecipe());
  const before = worldBounds(scene, 'handle');
  scene.apply([{ type: 'set-node', id: 'body', translation: [0, 0, 4] }], { expectedRevision: scene.revision });
  const after = worldBounds(scene, 'handle');
  near(after.min[2] - before.min[2], 4, 'handle moved with the body');
  assert.deepEqual(scene.exportRecipe().nodes.find(node => node.id === 'handle').relations, [{ kind: 'attach', to: 'body', side: '+x' }]);
});

test('set-node with an empty list removes relations and the part stays where it is', () => {
  const scene = createAgentScene(handleRecipe());
  const solved = worldBounds(scene, 'handle');
  scene.apply([{ type: 'set-node', id: 'handle', relations: [] }, { type: 'set-node', id: 'body', translation: [0, 0, 4] }], { expectedRevision: scene.revision });
  assert.deepEqual(worldBounds(scene, 'handle'), solved);
  assert.equal(Object.hasOwn(scene.exportRecipe().nodes.find(node => node.id === 'handle'), 'relations'), false);
});

function rejects(nodes, pattern) {
  assert.throws(() => createAgentScene(recipeWith(nodes)), pattern);
}

test('cycles, unknown parts and self references are rejected with the next action', () => {
  rejects([
    { id: 'a', relations: [{ kind: 'attach', to: 'b', side: '+x' }] },
    { id: 'b', relations: [{ kind: 'attach', to: 'a', side: '+x' }] },
  ], /nodes\[0\]\.relations: got \["a","b","a"\]; expected relations that form no loop.*remove one relation/s);
  rejects([
    { id: 'a', relations: [{ kind: 'attach', to: 'ghost', side: '+x' }] },
  ], /relations\[0\]\.to: got "ghost"; expected the ID of a node in this recipe; list them with scene_inspect/);
  rejects([
    { id: 'a', relations: [{ kind: 'centered', to: 'a' }] },
  ], /relations\[0\]\.to: got "a"; expected the ID of another part, such as "body", not its own node/);
  rejects([
    { id: 'a', relations: [{ kind: 'attach', to: 'loop', side: '+x' }] },
    { id: 'a2', relations: [{ kind: 'attach', to: 'a', side: '+x' }] },
    { id: 'loop', parent: 'a2' },
  ], /expected relations that form no loop/);
});

test('a part cannot be placed against its own child, which would move with it', () => {
  rejects([
    { id: 'parent', relations: [{ kind: 'attach', to: 'kid', side: '+x' }] },
    { id: 'kid', parent: 'parent' },
  ], /relations: got \["parent","kid","parent"\]; expected relations that form no loop.*parents included/s);
});

test('group nodes, group targets and two relations on one axis are rejected', () => {
  const noGeometry = recipeWith([{ id: 'g' }, { id: 'a', relations: [{ kind: 'centered', to: 'g' }] }]);
  noGeometry.nodes[0] = { id: 'g' };
  assert.throws(() => createAgentScene(noGeometry), /relations\[0\]\.to: got "g"; expected the ID of a mesh node, such as a box, since this one is a group with no geometry/);
  noGeometry.nodes[0] = { id: 'g', geometry: 'cube', material: 'grey' };
  noGeometry.nodes[1] = { id: 'a', relations: [{ kind: 'centered', to: 'g' }] };
  assert.throws(() => createAgentScene(noGeometry), /nodes\[1\]\.relations: got .*; expected relations on a mesh node, since this node is a group/);
  rejects([
    { id: 'a' },
    { id: 'b', relations: [{ kind: 'gap', to: 'a', side: '+x' }, { kind: 'align', to: 'a', axis: 'x', at: 'min' }] },
  ], /leaves the x axis to relation.*already decides.*one relation per axis/is);
  rejects([
    { id: 'a' },
    { id: 'b', relations: [{ kind: 'attach', to: 'a', side: '+x' }, { kind: 'centered', to: 'a', axes: ['y'] }] },
  ], /relations\[1\]\.kind: got "centered"; expected a relation that leaves the y axis to relation 0/);
});

test('hostile relation input is rejected without leaking or hanging', () => {
  const attach = { kind: 'attach', to: 'a', side: '+x' };
  const cases = [
    [{ ...attach, kind: 'weld' }, /relations\[0\]\.kind: got "weld"; expected one of attach, flush, align, centered, gap/],
    [{ ...attach, side: '+w' }, /relations\[0\]\.side: got "\+w"; expected one of \+x, -x/],
    [{ ...attach, offset: Infinity }, /Copy|finite|JSON/],
    [{ ...attach, offset: 1e12 }, /finite number of metres/],
    [{ ...attach, offset: '1' }, /finite number of metres/],
    [{ ...attach, to: 7 }, /relations\[0\]\.to: got 7; expected the ID of the part it is placed against/],
    [{ ...attach, to: '' }, /relations\[0\]\.to: got ""; expected the ID of the part it is placed against/],
    [{ ...attach, region: 5 }, /relations\[0\]\.region: got 5; expected a mesh tag name/],
    [{ ...attach, axis: 'x' }, /relations\[0\]\.axis: got "x"; expected a field a attach relation takes: kind, to, region, side, offset/],
    [{ kind: 'align', to: 'a', axis: 'q', at: 'min' }, /relations\[0\]\.axis: got "q"; expected x, y or z/],
    [{ kind: 'centered', to: 'a', axes: ['x', 'x'] }, /relations\[0\]\.axes: got .*; expected a list of x, y, z with each at most once/],
    [{ kind: 'centered', to: 'a', axes: [] }, /relations\[0\]\.axes: got .*; expected a list of x, y, z with each at most once/],
    [{ kind: 'centered', to: 'a', axes: 'x' }, /relations\[0\]\.axes: got .*; expected a list of x, y, z with each at most once/],
    [{ ...attach, to: 'x'.repeat(5000) }, /expected the ID of a node in this recipe|maxRecipeBytes|IDs/],
    [null, /relations\[0\]: got null; expected an object such as/],
    ['attach', /relations\[0\]: got "attach"; expected an object such as/],
    [[attach], /relations\[0\]: got \[\{.*; expected an object such as/],
  ];
  for (const [relation, pattern] of cases) {
    rejects([{ id: 'a' }, { id: 'b', relations: [relation] }], pattern);
  }
  rejects([{ id: 'a' }, { id: 'b', relations: 'attach' }], /relations: got "attach"; expected an array of at most 8/);
  rejects([{ id: 'a' }, { id: 'b', relations: Array.from({ length: 9 }, () => attach) }], /expected an array of at most 8 relations/);
  const polluted = JSON.parse('{"kind":"attach","to":"a","side":"+x","__proto__":{"kind":"gap"}}');
  rejects([{ id: 'a' }, { id: 'b', relations: [polluted] }], /Invalid JSON key/);
});

test('relation nodes are bounded', () => {
  const nodes = [{ id: 'anchor' }];
  for (let index = 0; index < 257; index++) {
    nodes.push({ id: `part${index}`, scale: [0.1, 0.1, 0.1], relations: [{ kind: 'attach', to: 'anchor', side: '+x' }] });
  }
  rejects(nodes, /expected relations on at most 256 nodes; group repeated parts/);
});

test('a long chain of relations solves with work in proportion to its length', () => {
  const nodes = [{ id: 'part0', scale: [0.1, 0.1, 0.1] }];
  for (let index = 1; index < 200; index++) {
    nodes.push({ id: `part${index}`, scale: [0.1, 0.1, 0.1], relations: [{ kind: 'attach', to: `part${index - 1}`, side: '+x' }] });
  }
  nodes.reverse();
  // Counting bounds reads replaces a stopwatch: each related part reads its own bounds and its target's, once.
  const solverNodes = normalizeRelations(nodes.map(node => ({
    geometry: 'cube', parent: null, rotation: [0, 0, 0, 1], translation: [0, 0, 0], ...node,
  })));
  let boundsReads = 0;
  solveRelations(solverNodes, (node, matrix) => {
    boundsReads += 1;
    return { min: [matrix[12] - 0.05, -0.05, -0.05], max: [matrix[12] + 0.05, 0.05, 0.05] };
  });
  assert.equal(boundsReads, 2 * 199);
  const scene = createAgentScene(recipeWith(nodes));
  near(worldBounds(scene, 'part199').min[0], worldBounds(scene, 'part198').max[0], 'end of the chain');
});

test('relations on a rejected edit leave the scene unchanged', () => {
  const scene = createAgentScene(handleRecipe());
  const revision = scene.revision;
  assert.throws(() => scene.apply([{ type: 'set-node', id: 'body', relations: [{ kind: 'attach', to: 'handle', side: '+x' }] }], { expectedRevision: revision }), /expected relations that form no loop/);
  assert.equal(scene.revision, revision);
});

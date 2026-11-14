import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene } from '../src/agent-scene.js';
import { taggedFacePositions } from '../src/agent-mesh.js';
import { generateTerrainGeometry } from '../src/agent-terrain.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';

function baseRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }, { id: 'sheet', type: 'grid', segments: 4 }],
    materials: [{ id: 'plain', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'body', geometry: 'cube', material: 'plain' }, { id: 'flag', geometry: 'sheet', material: 'plain' }],
  };
}

async function recipeError(change, limits) {
  const recipe = baseRecipe();
  change(recipe);
  await loadAgentSceneModules(recipe);
  try {
    createAgentScene(recipe, limits);
  } catch (error) {
    return error;
  }
  assert.fail('the recipe was accepted');
}

// Each case names the full path, the value received and what is accepted with an example or a range.
const RECIPE_CASES = [
  // src/agent-scene.js
  ['a node flag names its full path', recipe => { recipe.nodes[0].decal = 'yes'; }, TypeError, /^nodes\[0\]\.decal: got "yes"; expected true or false\.$/],
  ['an unknown node field names the field to remove', recipe => { recipe.nodes[0].colour = 'red'; }, TypeError, /^nodes\[0\]\.node\.colour: got "red"; expected one of the fields id, geometry, material.*; remove colour\.$/],
  ['a camera takes fov or focalLength, never both', recipe => { recipe.camera = { fov: 40, focalLength: 50 }; }, RangeError, /^camera\.focalLength: got 50; expected only one of fov \(degrees\) or focalLength \(millimetres with sensorWidth\), such as fov 45; remove the other\.$/],
  ['a missing material names the choices', recipe => { recipe.nodes[0].material = 'ghost'; }, RangeError, /^nodes\.body\.material: got "ghost"; expected one of plain\.$/],
  ['a duplicate ID names the collection', recipe => { recipe.nodes[1].id = 'body'; }, RangeError, /^nodes\[1\]\.id: got "body"; expected an ID no other nodes entry uses; rename one, or remove the other\.$/],
  ['a geometry type outside the list names the list', recipe => { recipe.geometries[0].type = 'blob'; }, TypeError, /^geometries\[0\]\.type: got "blob"; expected one of box, cylinder.*terrain, fragment.$/],
  ['a point list gives the range and an example', recipe => { recipe.geometries.push({ id: 'ring', type: 'lathe', profile: [[1, 0]] }); }, RangeError, /^geometries\[2\]\.profile: got "1 points"; expected a list of 2 to 4096 points of 2 numbers, such as \[\[0,0\],\[1,1\]\]\.$/],
  ['a wrong schema version gives the expected value', recipe => { recipe.schemaVersion = 2; }, RangeError, /^schemaVersion: got 2; expected 1\.$/],
  // src/agent-terrain.js
  ['a terrain size outside its range', recipe => { recipe.geometries.push({ id: 'ground', type: 'terrain', size: 0 }); }, RangeError, /^geometries\[2\]\.terrain\.size: got 0; expected a number from 1 to 2000, such as 40\.$/],
  ['a terrain resolution that is not whole', recipe => { recipe.geometries.push({ id: 'ground', type: 'terrain', resolution: 8.5 }); }, RangeError, /^geometries\[2\]\.terrain\.resolution: got 8\.5; expected a whole number, such as 64\.$/],
  ['terrain holes that are not a list', recipe => { recipe.geometries.push({ id: 'ground', type: 'terrain', holes: 'many' }); }, RangeError, /^geometries\[2\]\.terrain\.holes: got "many"; expected a list of at most 16 circles, such as \[\{ "center": \[0, 0\], "radius": 2 \}\]\.$/],
  ['a terrain amplitude outside its range', recipe => { recipe.geometries.push({ id: 'ground', type: 'terrain', amplitude: 500 }); }, RangeError, /^geometries\[2\]\.terrain\.amplitude: got 500; expected a number from 0 to 200, such as 1\.$/],
  // src/agent-mesh.js
];

for (const [name, change, ErrorType, pattern, limits] of RECIPE_CASES) {
  test(`recipe error: ${name}`, async () => {
    const error = await recipeError(change, limits);
    assert.ok(error instanceof ErrorType, `${error.name}: ${error.message}`);
    assert.match(error.message, pattern);
  });
}

test('scene operations report the field, the value and what is accepted', () => {
  const scene = createAgentScene(baseRecipe(), { maxCheckpoints: 1 });
  const expectError = (run, ErrorType, pattern) => assert.throws(run, error => error instanceof ErrorType && pattern.test(error.message), `${pattern}`);
  expectError(() => scene.apply([{ type: 'remove-node', id: 'ghost' }], { expectedRevision: 0 }), RangeError, /^id: got "ghost"; expected the ID of a node in nodes; scene_inspect lists them\.$/);
  expectError(() => scene.apply([{ type: 'set-node', id: 'ghost' }], { expectedRevision: 0 }), RangeError, /^id: got "ghost"; expected the ID of an existing node;/);
  expectError(() => scene.apply([{ type: 'launch' }], { expectedRevision: 0 }), TypeError, /^type: got "launch"; expected one of set-node, set-material/);
  expectError(() => scene.apply([], { expectedRevision: 0 }), RangeError, /^operations: got "0 operations"; expected a list of 1 to \d+ operations, such as \[\{ "type": "set-camera", "fov": 50 \}\]\.$/);
  expectError(() => scene.apply([{ type: 'set-camera', fov: 50 }], { expectedRevision: 7 }), RangeError, /^expectedRevision: got 7; expected the current revision, 0; scene_inspect returns it\.$/);
  expectError(() => scene.apply([{ type: 'remove-node', id: 'body', recursive: 'yes' }], { expectedRevision: 0 }), TypeError, /^recursive: got "yes"; expected true or false\.$/);
  expectError(() => scene.inspect({ ids: ['ghost'] }), RangeError, /^ids: got "ghost"; expected IDs of existing nodes; call scene_inspect without ids to list them\.$/);
  expectError(() => scene.inspect({ includeBounds: 'yes' }), TypeError, /^includeBounds: got "yes"; expected true or false\.$/);
  expectError(() => scene.inspect({ path: { ground: 'ghost', from: [0, 0], to: [1, 1] } }), RangeError, /^path\.ground: got "ghost"; expected the ID of a node with a drawn geometry;/);
  expectError(() => scene.inspectMeshes({ geometries: ['ghost'] }), RangeError, /^geometries: got "ghost"; expected one of cube, sheet\.$/);
  expectError(() => scene.sampleMotion(1), RangeError, /^time: got 1; expected null, because this recipe has no motion/);
  expectError(() => scene.sampleMotion(4000), RangeError, /^time: got 4000; expected null or a number of seconds from 0 to 3600, such as 0\.5\.$/);
  const checkpoint = scene.checkpoint();
  expectError(() => scene.checkpoint(), RangeError, /^checkpoints: got "1 saved"; expected at most 1 saved checkpoints;/);
  scene.releaseCheckpoint(checkpoint);
  expectError(() => scene.releaseCheckpoint(checkpoint), RangeError, /^checkpointId: got \{\}; expected a checkpointId that scene_checkpoint returned and you have not released\.$/);
});

test('a mesh region on a plain shape names the tag and the next step', () => {
  const recipe = baseRecipe();
  recipe.nodes[1] = { id: 'lid', geometry: 'cube', material: 'plain', relations: [{ kind: 'gap', to: 'body', region: 'top', side: '+y' }] };
  assert.throws(() => createAgentScene(recipe), error => error instanceof RangeError
    && /region: got "top"; expected a tag on a mesh geometry; tag faces with a mesh_edit tag op, or drop region/.test(error.message));
});

test('direct mesh and terrain builders name the field and the next step', () => {
  const scene = createAgentScene(baseRecipe());
  assert.throws(() => taggedFacePositions(scene.parts[0].geometry, 'lid'), error => error instanceof RangeError
    && /^region: got "lid"; expected a tag on a mesh geometry; tag faces with a mesh_edit tag op, or drop region\.$/.test(error.message));
  assert.throws(() => generateTerrainGeometry({ resolution: 200 }, 5000), error => error instanceof RangeError
    && /^terrain\.resolution: got 200; expected a resolution whose 40401 vertices fit maxVertices 5000; lower it\.$/.test(error.message));
  assert.throws(() => generateTerrainGeometry({ resolution: 8.5 }, 5000), error => error instanceof RangeError
    && /^terrain\.resolution: got 8.5; expected a whole number, such as 64\.$/.test(error.message));
});

// The guard: these files hold the validators an agent reaches through recipes and operations. A throw in them reports
// through invalidField, which names the path, the value and what is accepted. The throws listed here stay raw on
// purpose: whole-input size limits, JSON copy checks that run before any field has a path, and engine invariants no
// recipe field can fix. A new raw throw fails this test until it uses invalidField or is listed.
const RAW_THROWS_LEFT = {
  'src/agent-scene.js': [
    "'maxNodes cannot exceed 4096.');",
    "'JSON exceeds maxRecipeBytes. Reduce the",
    "'JSON nesting exceeds 64 levels.');",
    "'JSON exceeds maxRecipeBytes.');",
    "'Recipe must contain finite, acyclic JSO",
    "'JSON exceeds maxRecipeBytes.');",
    "'Recipe objects must be plain JSON objec",
    "'Invalid JSON key.');",
    "'JSON accessors and hidden fields are un",
    "'JSON arrays must be dense without extra",
    "'JSON arrays must be dense without trail",
    "'JSON exceeds maxRecipeBytes.');",
    "'Camera matrices must remain finite and ",
    "`Node ${node.name} normal transform exce",
    "`Node ${node.name} world geometry bounds",
    "'Retained render matrices must not be de",
    "'Motion camera matrices exceed the suppo",
    "'Motion scale must remain positive at Fl",
    "'Geometry preflight exceeds peak maxVert",
    "`Mesh ${plan.definition.id} has ${vertic",
    "'Generated geometry exceeds its conserva",
  ],
  'src/agent-recipe-checks.js': [],
  'src/agent-mesh.js': [],
  'src/agent-terrain.js': [],
};
const THROW_PATTERN = /throw new (?:Range|Type)?Error\((.{0,40})/;

for (const [file, listed] of Object.entries(RAW_THROWS_LEFT)) {
  test(`${file} adds no raw throw that lacks a field path and an expectation`, () => {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/);
    const found = lines.map(line => line.match(THROW_PATTERN)?.[1]).filter(Boolean);
    assert.deepEqual(found, listed, `${file}: report agent input mistakes with invalidField(path, value, expected) from src/field-error.js; list a throw here only when no input field can cause it`);
  });
}

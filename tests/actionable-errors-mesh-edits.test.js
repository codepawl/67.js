import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';

// Mesh edit validators (cut, deform, generator, modifier, normal, attribute edits and the recipe checks) report through
// edits[N].field, with the value received and what is accepted. Each case is reached through the public scene API.

function baseRecipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 } }],
    materials: [{ id: 'plain', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'body', geometry: 'block', material: 'plain' }],
  };
}

function badEdit(edit) {
  return async () => {
    const recipe = baseRecipe();
    await loadAgentSceneModules(recipe);
    const scene = createAgentScene(recipe);
    const operation = { type: 'edit-mesh', geometry: 'block', edits: [edit] };
    await loadAgentSceneModules(operation);
    return scene.apply([operation], { expectedRevision: 0 });
  };
}

function badRecipeEdit(edit) {
  return async () => {
    const recipe = baseRecipe();
    recipe.geometries[0].edits = [edit];
    await loadAgentSceneModules(recipe);
    return createAgentScene(recipe);
  };
}

const CURVE_PATH = [[0, 0, 0], [1, 0, 0]];

// Each case: the source file it belongs to, how an agent reaches the error, the full field path and the value echoed.
const CASES = [
  ['src/mesh-cut-edits.js', 'fill_holes sides below range', badEdit({ op: 'fill_holes', sides: 2 }), 'edits[0].sides', '2'],
  ['src/mesh-cut-edits.js', 'bisect_plane normal all zero', badEdit({ op: 'bisect_plane', point: [0, 0, 0], normal: [0, 0, 0] }), 'edits[0].normal', '[0,0,0]'],
  ['src/mesh-cut-edits.js', 'bisect_plane clears both sides', badEdit({ op: 'bisect_plane', point: [0, 0, 0], normal: [0, 1, 0], clearInner: true, clearOuter: true }), 'edits[0].clearOuter', 'true'],
  ['src/mesh-cut-edits.js', 'bisect_plane fill as text', badEdit({ op: 'bisect_plane', point: [0, 0, 0], normal: [0, 1, 0], fill: 'yes' }), 'edits[0].fill', '"yes"'],
  ['src/mesh-cut-edits.js', 'knife_project path with one point', badEdit({ op: 'knife_project', path: [[0, 0, 0]], direction: [0, 0, -1] }), 'edits[0].path', '[[0,0,0]]'],
  ['src/mesh-cut-edits.js', 'knife_project direction all zero', badEdit({ op: 'knife_project', path: CURVE_PATH, direction: [0, 0, 0] }), 'edits[0].direction', '[0,0,0]'],
  ['src/mesh-cut-edits.js', 'dissolve_edges rule as a list', badEdit({ op: 'dissolve_edges', edges: [] }), 'edits[0].edges', '[]'],
  ['src/mesh-cut-edits.js', 'subdivide_edges cuts too many', badEdit({ op: 'subdivide_edges', edges: { all: true }, cuts: 99 }), 'edits[0].cuts', '99'],
  ['src/mesh-cut-edits.js', 'dissolve_faces rule selects nothing', badEdit({ op: 'dissolve_faces', select: { faces: [] } }), 'edits[0].select', '{"faces":[]}'],
  ['src/mesh-deform-modifiers.js', 'lattice divisions too high', badEdit({ op: 'lattice', divisions: [9, 2, 2] }), 'edits[0].divisions', '9'],
  ['src/mesh-deform-modifiers.js', 'lattice move without an offset', badEdit({ op: 'lattice', moves: [{ point: [0, 0, 0] }] }), 'edits[0].moves[0].offset', 'undefined'],
  ['src/mesh-deform-modifiers.js', 'lattice move point out of the grid', badEdit({ op: 'lattice', divisions: [2, 2, 2], moves: [{ point: [2, 0, 0], offset: [0, 0, 1] }] }), 'edits[0].moves[0].point', '2'],
  ['src/mesh-deform-modifiers.js', 'curve path with one point', badEdit({ op: 'curve', path: [[0, 0, 0]] }), 'edits[0].path', '[[0,0,0]]'],
  ['src/mesh-deform-modifiers.js', 'curve axis unknown', badEdit({ op: 'curve', path: CURVE_PATH, axis: 'q' }), 'edits[0].axis', '"q"'],
  ['src/mesh-deform-modifiers.js', 'curve path without length', badEdit({ op: 'curve', path: [[1, 1, 1], [1, 1, 1]] }), 'edits[0].path', '[[1,1,1],[1,1,1]]'],
  ['src/mesh-deform-modifiers.js', 'hook falloff unknown', badEdit({ op: 'hook', falloff: 'sharp' }), 'edits[0].falloff', '"sharp"'],
  ['src/mesh-deform-modifiers.js', 'wave axes unknown', badEdit({ op: 'wave', axes: 'z' }), 'edits[0].axes', '"z"'],
  ['src/mesh-deform-modifiers.js', 'wave start with one number', badEdit({ op: 'wave', start: [1] }), 'edits[0].start', '[1]'],
  ['src/mesh-deform-modifiers.js', 'wave cyclic as text', badEdit({ op: 'wave', cyclic: 'yes' }), 'edits[0].cyclic', '"yes"'],
  ['src/mesh-generator-modifiers.js', 'screw steps too high', badEdit({ op: 'screw', steps: 999 }), 'edits[0].steps', '999'],
  ['src/mesh-generator-modifiers.js', 'screw axis unknown', badEdit({ op: 'screw', axis: 'w' }), 'edits[0].axis', '"w"'],
  ['src/mesh-generator-modifiers.js', 'wireframe replace as text', badEdit({ op: 'wireframe', replace: 'yes' }), 'edits[0].replace', '"yes"'],
  ['src/mesh-generator-modifiers.js', 'wireframe evenOffset as number', badEdit({ op: 'wireframe', evenOffset: 1 }), 'edits[0].evenOffset', '1'],
  ['src/mesh-generator-modifiers.js', 'skin radius field reaching zero', badEdit({ op: 'skin', radius: { mul: [0, { attr: 'position', component: 'z' }] } }), 'edits[0].radius', '0'],
  ['src/mesh-modifiers.js', 'simple_deform mode unknown', badEdit({ op: 'simple_deform', mode: 'melt' }), 'edits[0].mode', '"melt"'],
  ['src/mesh-modifiers.js', 'simple_deform axis unknown', badEdit({ op: 'simple_deform', mode: 'twist', axis: 'w' }), 'edits[0].axis', '"w"'],
  ['src/mesh-modifiers.js', 'simple_deform twist given a factor', badEdit({ op: 'simple_deform', mode: 'twist', factor: 2 }), 'edits[0].factor', '2'],
  ['src/mesh-modifiers.js', 'triangulate minVertices too low', badEdit({ op: 'triangulate', minVertices: 2 }), 'edits[0].minVertices', '2'],
  ['src/mesh-modifiers.js', 'smooth iterations too high', badEdit({ op: 'smooth', iterations: 1000 }), 'edits[0].iterations', '1000'],
  ['src/mesh-normal-modifiers.js', 'smooth_by_angle ignoreSharp as number', badEdit({ op: 'smooth_by_angle', ignoreSharp: 1 }), 'edits[0].ignoreSharp', '1'],
  ['src/mesh-normal-modifiers.js', 'smooth_by_angle angle too wide', badEdit({ op: 'smooth_by_angle', angle: 500 }), 'edits[0].angle', '500'],
  ['src/mesh-normal-modifiers.js', 'weighted_normal weight below range', badEdit({ op: 'weighted_normal', weight: 0 }), 'edits[0].weight', '0'],
  ['src/mesh-attribute-edits.js', 'vertex_group weight above one', badEdit({ op: 'vertex_group', name: 'mask', weight: 2 }), 'edits[0].weight', '2'],
  ['src/mesh-attribute-edits.js', 'vertex_group weight and gradient together', badEdit({ op: 'vertex_group', name: 'mask', weight: 1, gradient: { axis: 'y', range: [0, 1], weights: [0, 1] } }), 'edits[0].gradient', '{"axis":"y","range":[0,1],"weights":[...'],
  ['src/mesh-attribute-edits.js', 'vertex_group gradient axis unknown', badEdit({ op: 'vertex_group', name: 'mask', gradient: { axis: 'w', range: [0, 1], weights: [0, 1] } }), 'edits[0].gradient.axis', '"w"'],
  ['src/mesh-attribute-edits.js', 'vertex_group gradient range reversed', badEdit({ op: 'vertex_group', name: 'mask', gradient: { axis: 'y', range: [1, 0], weights: [0, 1] } }), 'edits[0].gradient.range', '[1,0]'],
  ['src/mesh-attribute-edits.js', 'vertex_group gradient with one weight', badEdit({ op: 'vertex_group', name: 'mask', gradient: { axis: 'y', range: [0, 1], weights: [0] } }), 'edits[0].gradient.weights', '[0]'],
  ['src/mesh-attribute-edits.js', 'vertex_group gradient unknown key', badEdit({ op: 'vertex_group', name: 'mask', gradient: { axis: 'y', range: [0, 1], weights: [0, 1], colors: 3 } }), 'edits[0].gradient.colors', '3'],
  ['src/mesh-attribute-edits.js', 'vertex_color with two channels', badEdit({ op: 'vertex_color', color: [1, 0] }), 'edits[0].color', '[1,0]'],
  ['src/mesh-attribute-edits.js', 'vertex_color gradient end color too bright', badEdit({ op: 'vertex_color', gradient: { axis: 'y', range: [0, 1], colors: [[1, 0, 0], [0, 4, 0]] } }), 'edits[0].gradient.colors[1]', '4'],
  ['src/mesh-recipe.js', 'edit that is not an object', badEdit('extrude'), 'edits[0]', '"extrude"'],
  ['src/mesh-recipe.js', 'edit with a field the op does not take', badEdit({ op: 'extrude_individual', offset: 1, depth: 2 }), 'edits[0].depth', '2'],
  ['src/mesh-recipe.js', 'delete without select', badEdit({ op: 'delete' }), 'edits[0].select', 'undefined'],
  ['src/mesh-recipe.js', 'boolean scale not positive', badEdit({ op: 'boolean', operation: 'union', cutter: { type: 'box' }, scale: [1, -1, 1] }), 'edits[0].scale', '[1,-1,1]'],
  ['src/mesh-recipe.js', 'boolean rotation with three numbers', badEdit({ op: 'boolean', operation: 'union', cutter: { type: 'box' }, rotation: [0, 0, 1] }), 'edits[0].rotation', '[0,0,1]'],
  ['src/mesh-recipe.js', 'boolean cutter as text', badEdit({ op: 'boolean', operation: 'union', cutter: 'box' }), 'edits[0].cutter', '"box"'],
  ['src/mesh-recipe.js', 'sculpt without strokes', badEdit({ op: 'sculpt', strokes: [] }), 'edits[0].strokes', '[]'],
  ['src/mesh-recipe.js', 'sculpt stroke type unknown', badEdit({ op: 'sculpt', strokes: [{ type: 'carve', center: [0, 0, 0], radius: 1, strength: 1 }] }), 'edits[0].strokes[0].type', '"carve"'],
  ['src/mesh-recipe.js', 'sculpt smooth stroke too strong', badEdit({ op: 'sculpt', strokes: [{ type: 'smooth', center: [0, 0, 0], radius: 1, strength: 3 }] }), 'edits[0].strokes[0].strength', '3'],
  ['src/mesh-recipe.js', 'shrinkwrap target as text', badEdit({ op: 'shrinkwrap', target: 'sphere' }), 'edits[0].target', '"sphere"'],
  ['src/mesh-recipe.js', 'shrinkwrap direction without project mode', badEdit({ op: 'shrinkwrap', target: { type: 'sphere' }, direction: [0, 1, 0] }), 'edits[0].direction', '[0,1,0]'],
  ['src/mesh-recipe.js', 'bevel rule as a list', badEdit({ op: 'bevel', width: 0.1, edges: [] }), 'edits[0].edges', '[]'],
  ['src/mesh-recipe.js', 'loop_cut without a ring rule', badEdit({ op: 'loop_cut' }), 'edits[0].edges', 'undefined'],
  ['src/mesh-recipe.js', 'loop_cut factor with several cuts', badEdit({ op: 'loop_cut', edges: { along: [0, 1, 0] }, cuts: 2, factor: 0.3 }), 'edits[0].factor', '0.3'],
  ['src/mesh-recipe.js', 'uv_unwrap seams as a list', badEdit({ op: 'uv_unwrap', seams: [1] }), 'edits[0].seams', '[1]'],
  ['src/mesh-recipe.js', 'subdivide sharpness without crease', badEdit({ op: 'subdivide', sharpness: 2 }), 'edits[0].sharpness', '2'],
  ['src/mesh-recipe.js', 'translate falloff as text', badEdit({ op: 'translate', offset: [0, 1, 0], falloff: 'wide' }), 'edits[0].falloff', '"wide"'],
  ['src/mesh-recipe.js', 'remesh with neither voxelSize nor resolution', badEdit({ op: 'remesh' }), 'edits[0].voxelSize', 'undefined'],
  ['src/mesh-recipe.js', 'remesh resolution too low', badEdit({ op: 'remesh', resolution: 1 }), 'edits[0].resolution', '1'],
  ['src/mesh-recipe.js', 'set_position without position or offset', badEdit({ op: 'set_position' }), 'edits[0].position', 'undefined'],
  ['src/mesh-recipe.js', 'displace field of the wrong kind', badEdit({ op: 'displace', field: [0, 1, 0] }), 'edits[0].field', '[0,1,0]'],
  ['src/mesh-recipe.js', 'displace group not a name', badEdit({ op: 'displace', field: 1, group: 'bad name!' }), 'edits[0].group', '"bad name!"'],
  ['src/mesh-recipe.js', 'array count zero', badEdit({ op: 'array', count: 0 }), 'edits[0].count', '0'],
  ['src/mesh-recipe.js', 'recipe edit keeps its geometry path', badRecipeEdit({ op: 'subdivide', levels: 9 }), 'geometries[0].edits[0].levels', '9'],
];

// A message is actionable when it gives a way to fix the input: a range, a list of choices or an example.
const ACCEPTED = /such as|\bfrom -?[\d.e]+ to -?[\d.e]+|one of |true or false|above \d|left out|\bor more\b/;

const SOURCE_FILES = [...new Set(CASES.map(([file]) => file))];

assert.ok(CASES.length >= 50, 'the walk covers at least 50 bad inputs');
for (const file of SOURCE_FILES) {
  assert.ok(CASES.filter(([caseFile]) => caseFile === file).length >= 3, `${file} has at least 3 cases`);
}

for (const [file, label, trigger, path, received] of CASES) {
  test(`${file}: error for ${label} names the field, the value and what is accepted`, async () => {
    let message;
    try {
      await trigger();
    } catch (error) {
      message = error.message;
    }
    assert.ok(message, `${label} must throw`);
    assert.ok(message.includes(`${path}: got ${received}`), `"${path}: got ${received}" missing in: ${message}`);
    assert.match(message, /expected /, `no expectation in: ${message}`);
    assert.match(message, ACCEPTED, `no example or range in: ${message}`);
  });
}

// The guard: a throw in these files reports through invalidField or editField, which name the path, the value and what
// is accepted. The throws listed stay raw on purpose: whole-input size limits, host wiring and engine invariants no edit
// field can fix, and the mesh stack checks, which have their own path. A new raw throw fails until it is converted or listed.
const RAW_THROWS_LEFT = {
  'src/mesh-cut-edits.js': [
    '`Not a cutting edit: ${edit.op}`);',
  ],
  'src/mesh-deform-modifiers.js': [],
  'src/mesh-generator-modifiers.js': [
    '`${operation} would make ${vertices} ver',
    '`skin edge ${edge} has no length. Weld t',
  ],
  'src/mesh-modifiers.js': [
    '`Not a modifier: ${edit.op}`);',
  ],
  'src/mesh-normal-modifiers.js': [],
  'src/mesh-attribute-edits.js': [
    '`A mesh holds at most ${MAX_VERTEX_GROUP',
  ],
  'src/mesh-edit-field.js': [],
  'src/mesh-recipe.js': [
    '`A mesh holds at most ${MAX_MESH_EDITS} ',
    '`Mesh edit ${index} (${op}) grows the me',
    "'shrinkwrap needs a target resolver; rec",
    "'A mesh edit field reads a surface given",
    '`Mesh edit ${index} (boolean) needs a cu',
    "'stack must be an array.');",
    '`A stack holds at most ${MAX_STACK_NODES',
    '`Stack node ${index} op must be one of $',
  ],
};
const THROW_PATTERN = /throw new (?:Range|Type)?Error\((.{0,40})/;

for (const [file, listed] of Object.entries(RAW_THROWS_LEFT)) {
  test(`${file} adds no raw throw that lacks a field path and an expectation`, () => {
    const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split(/\r?\n/);
    const found = lines.map(line => line.match(THROW_PATTERN)?.[1]).filter(Boolean);
    assert.deepEqual(found, listed, `${file}: report agent input mistakes with editField(index, field, value, expected) from src/mesh-edit-field.js; list a throw here only when no input field can cause it`);
  });
}

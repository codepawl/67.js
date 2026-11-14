import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { box, sphere } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits, evaluateMeshStack } from '../src/mesh.js';
import { createAgentScene } from '../src/agent-scene.js';
import {
  FIELD_OPERATORS, MAX_FIELD_NODES, MAX_FIELD_DEPTH, MAX_FIELD_ELEMENTS, compileField, evaluateField, meshFieldContext, validateField, valueNoise,
} from '../src/mesh-fields.js';
import { expandInstancedNodes, surfacePoints } from '../src/mesh-instances.js';
import { FIELD_OPERATOR_NAMES } from '../src/mesh-operations.js';

const cube = () => meshFromGeometry(box(0, 1));
const ball = () => meshFromGeometry(sphere(16, 8));

function nested(depth, leaf = 1) {
  let expression = leaf;
  for (let level = 0; level < depth; level++) expression = { abs: expression };
  return expression;
}

function bytesOf(mesh) {
  return Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength).toString('hex');
}

test('hostile expressions are rejected at the boundary and nothing runs', () => {
  globalThis.fieldExpressionRan = false;
  const cyclic = { abs: null };
  cyclic.abs = cyclic;
  const hostile = [
    ['a string that looks like code', 'globalThis.fieldExpressionRan = true'],
    ['an operator that is code', { 'globalThis.fieldExpressionRan = true': [1, 2] }],
    ['a function body as an operand', { add: ['(() => { globalThis.fieldExpressionRan = true; })()', 1] }],
    ['__proto__ as an own key', JSON.parse('{"__proto__": [1, 2]}')],
    ['constructor as an operator', JSON.parse('{"constructor": {"constructor": "globalThis.fieldExpressionRan = true"}}')],
    ['toString as an operator', { toString: [1, 2] }],
    ['hasOwnProperty as an operator', { hasOwnProperty: 'x' }],
    ['attr named __proto__', { attr: '__proto__' }],
    ['attr named constructor', { attr: 'constructor' }],
    ['a component that is a prototype member', { attr: 'position', component: 'constructor' }],
    ['a component that is a prototype member of an array', { attr: 'position', component: 'length' }],
    ['a tag with a code-like name', { attr: 'tag', name: 'x; globalThis.fieldExpressionRan = true' }],
    ['a noise seed that is a string', { noise: { seed: 'globalThis.fieldExpressionRan = true' } }],
    ['a noise with an unknown key', { noise: { scale: 1, __proto__: 1, constructor: 2 } }],
    ['nesting past the depth limit', nested(MAX_FIELD_DEPTH + 1)],
    ['a thousand levels of nesting', nested(1000)],
    ['a cyclic object', cyclic],
    ['more nodes than allowed', { add: Array.from({ length: 8 }, () => ({ add: Array.from({ length: 8 }, () => ({ add: [1, 2] })) })) }],
    ['a million operands', { add: new Array(1_000_000).fill(1) }],
    ['an operand list that is a string', { add: 'abcdef' }],
    ['a noise scale of a trillion', { noise: { scale: 1e12 } }],
    ['a noise with a billion octaves', { noise: { octaves: 1e9 } }],
    ['a literal that is Infinity', { add: [Infinity, 1] }],
    ['a literal that is NaN', { add: [NaN, 1] }],
    ['a literal past the range', { add: [1e12, 1] }],
    ['null', null],
    ['undefined', undefined],
    ['a function', () => 1],
    ['an array that is not a vector', [1, 2, 3, 4]],
    ['a vector with a string', [1, 2, 'x']],
    ['two operators in one node', { add: [1, 2], mul: [1, 2] }],
    ['an object with a custom prototype', Object.create({ add: [1, 2] })],
  ];
  for (const [label, expression] of hostile) {
    assert.throws(() => validateField(expression), error => error instanceof TypeError || error instanceof RangeError, label);
  }
  assert.equal(globalThis.fieldExpressionRan, false);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'fieldExpressionRan'), false);
  delete globalThis.fieldExpressionRan;
});

test('limits on elements and work are checked before any element is evaluated', () => {
  const tooMany = { count: MAX_FIELD_ELEMENTS + 1, positions: () => assert.fail('read positions'), normals: () => assert.fail('read normals'), tag: () => assert.fail('read tags') };
  assert.throws(() => compileField({ attr: 'index' }, tooMany), /elements/);
  const widest = Array.from({ length: MAX_FIELD_NODES - 1 }, () => 1);
  const manyNodes = { add: widest.slice(0, 7).map(() => ({ add: widest.slice(0, 7).map(() => ({ add: widest.slice(0, 1).concat(1) })) })) };
  assert.throws(() => validateField(manyNodes), /nodes/);
  const heavy = { count: MAX_FIELD_ELEMENTS, positions: () => new Float64Array(0), normals: () => new Float64Array(0), tag: () => new Float64Array(0) };
  const sixtyFourNodes = { add: [1, 2, 3, 4, 5, 6, 7].map(number => ({ add: [number, number, number, number, number, number, number] })) };
  assert.ok(compileField(sixtyFourNodes).nodeCount <= MAX_FIELD_NODES);
  assert.throws(() => compileField(sixtyFourNodes, heavy), /work limit/);
  assert.equal(compileField({ add: [1, { abs: 2 }] }, heavy).nodeCount, 4);
});

test('the language has no way to run code', () => {
  const source = readFileSync(new URL('../src/mesh-fields.js', import.meta.url), 'utf8');
  const forbidden = /\beval\s*\(|new\s+Function|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(|\bvm\b|\bprocess\b|\bglobalThis\b|__proto__|\.constructor\b/;
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, forbidden);
});

test('the operator list in the plain-data module matches the language', () => {
  assert.deepEqual([...FIELD_OPERATORS].sort(), [...FIELD_OPERATOR_NAMES].sort());
});

test('expressions compute attributes, math, comparison, logic and vectors', () => {
  const mesh = cube();
  const points = meshFieldContext(mesh, 'point');
  const evaluate = expression => evaluateField(expression, points).values;
  const heights = evaluate({ mul: [{ attr: 'position', component: 'y' }, 0.5] });
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) assert.equal(heights[vertex], mesh.positions[vertex * 3 + 1] * 0.5);
  assert.deepEqual(Array.from(evaluate({ attr: 'index' })), Array.from({ length: mesh.vertexCount }, (_, index) => index));
  assert.deepEqual(Array.from(evaluate({ if: [{ gt: [1, 2] }, 10, 20] }).slice(0, 2)), [20, 20]);
  assert.deepEqual(Array.from(evaluate({ div: [1, 0] }).slice(0, 2)), [0, 0], 'division by zero gives 0, not infinity');
  assert.deepEqual(Array.from(evaluateField({ add: [[1, 2, 3], 1] }, points).values.slice(0, 3)), [2, 3, 4]);
  assert.equal(evaluateField({ length: [3, 4, 0] }, points).values[0], 5);
  assert.equal(evaluateField({ and: [true, { lt: [1, 2] }, { not: 0 }] }, points).values[0], 1);
  assert.throws(() => evaluateField({ add: [{ attr: 'position' }, 1] }, points, { kind: 'scalar' }), /number expression/);
  assert.throws(() => evaluateField({ gt: [{ attr: 'position' }, 1] }, points), /number, not a vector/);
  assert.throws(() => evaluateField({ attr: 'tag', name: 'nothing' }, points), /Unknown tag nothing/);
});

test('the field selection rule picks faces from attributes', () => {
  const mesh = cube();
  const topOnly = { gt: [{ dot: [{ attr: 'normal' }, [0, 1, 0]] }, 0.9] };
  const top = applyMeshEdits(mesh, [{ op: 'delete', select: { field: topOnly } }]);
  assert.equal(top.results[0].deletedFaces, 1);
  const upperHalf = applyMeshEdits(mesh, [{ op: 'delete', select: { field: { gt: [{ attr: 'position', component: 'y' }, 0.2] } } }]);
  assert.equal(upperHalf.results[0].deletedFaces, 1);
  assert.throws(() => applyMeshEdits(mesh, [{ op: 'delete', select: { field: { attr: 'position' } } }]), /number, not a vector|number expression/);
  assert.throws(() => applyMeshEdits(mesh, [{ op: 'delete', select: { field: topOnly, tag: 'top' } }]), /one expression/);
});

test('set_position moves vertices by a field and leaves the rest alone', () => {
  const mesh = cube();
  const lifted = applyMeshEdits(mesh, [{ op: 'set_position', select: { tag: 'top' }, offset: [0, 1, 0] }]);
  assert.equal(lifted.results[0].movedVertices, 4);
  const stretched = applyMeshEdits(mesh, [{ op: 'set_position', position: { vec: [{ attr: 'position', component: 'x' }, { mul: [{ attr: 'position', component: 'y' }, 2] }, { attr: 'position', component: 'z' }] } }]).mesh;
  assert.equal(stretched.positions[1], mesh.positions[1] * 2);
  assert.equal(stretched.faceCount, mesh.faceCount);
  assert.throws(() => applyMeshEdits(mesh, [{ op: 'set_position' }]), /edits\[0\]\.position: got undefined; expected a vector field expression/);
  assert.throws(() => applyMeshEdits(mesh, [{ op: 'set_position', offset: 1 }]), /vector/);
  assert.throws(() => applyMeshEdits(mesh, [{ op: 'set_position', offset: { eval: 'x' } }]), /unknown operator/);
});

test('displace moves a sphere along its normals by (field - midlevel) * strength', () => {
  const mesh = ball();
  const grown = applyMeshEdits(mesh, [{ op: 'displace', field: 1, strength: 0.2, midlevel: 0.5 }]).mesh;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const before = Math.hypot(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
    const after = Math.hypot(grown.positions[vertex * 3], grown.positions[vertex * 3 + 1], grown.positions[vertex * 3 + 2]);
    assert.ok(Math.abs(after - before - 0.1) < 0.02, `vertex ${vertex}: ${before} to ${after}`);
  }
  const raised = applyMeshEdits(cube(), [{ op: 'displace', field: 1, strength: 0.4, midlevel: 0, direction: 'y' }]).mesh;
  assert.ok(Math.abs(raised.positions[1] - (cube().positions[1] + 0.4)) < 1e-6);
  assert.throws(() => applyMeshEdits(mesh, [{ op: 'displace', field: 1, direction: 'sideways' }]), /direction: got "sideways"; expected one of/);
});

test('noise is smooth, stays in 0 to 1 and changes with the seed', () => {
  let minimum = 1;
  let maximum = 0;
  for (let step = 0; step < 2000; step++) {
    const value = valueNoise(step * 0.173, step * 0.071, step * 0.331, 3);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  assert.ok(minimum >= 0 && maximum <= 1 && maximum - minimum > 0.5);
  assert.ok(Math.abs(valueNoise(0.5, 0.5, 0.5, 3) - valueNoise(0.5001, 0.5, 0.5, 3)) < 0.01);
  assert.notEqual(valueNoise(0.37, 0.52, 0.11, 1), valueNoise(0.37, 0.52, 0.11, 2));
});

test('the same expression gives identical bytes on every run', () => {
  const edits = [
    { op: 'displace', field: { noise: { scale: 3, seed: 7, octaves: 3 } }, strength: 0.3 },
    { op: 'set_position', offset: { vec: [0, { mul: [{ random: { seed: 5 } }, 0.05] }, 0] } },
  ];
  const first = applyMeshEdits(ball(), edits).mesh;
  const second = applyMeshEdits(ball(), edits).mesh;
  assert.equal(bytesOf(first), bytesOf(second));
  const otherSeed = applyMeshEdits(ball(), [{ ...edits[0], field: { noise: { scale: 3, seed: 8, octaves: 3 } } }, edits[1]]).mesh;
  assert.notEqual(bytesOf(first), bytesOf(otherSeed));
});

test('field nodes in a stack reuse earlier nodes from the cache', () => {
  const entries = new Map();
  const cache = { get: key => entries.get(key), set: (key, value) => entries.set(key, value) };
  const stack = last => [
    { op: 'displace', field: { noise: { scale: 2, seed: 1 } }, strength: 0.2 },
    { op: 'set_position', offset: [0, last, 0] },
  ];
  const first = evaluateMeshStack(ball(), stack(0.1), { cache, cacheKey: 'ball' });
  assert.deepEqual(first.results.map(result => result.cached), [undefined, undefined]);
  const second = evaluateMeshStack(ball(), stack(0.2), { cache, cacheKey: 'ball' });
  assert.deepEqual(second.results.map(result => result.cached), [true, undefined]);
  assert.equal(bytesOf(evaluateMeshStack(ball(), stack(0.1), { cache, cacheKey: 'ball' }).mesh), bytesOf(first.mesh));
});

test('instances on a grid, a scatter and a surface are seeded, bounded and filterable', () => {
  const base = { id: 'rock', geometry: 'stone', material: 'paint' };
  const surfaceGeometry = { ...sphere(16, 8) };
  const options = { maxNodes: 4096, resolveSurface: () => surfaceGeometry };
  const grid = expandInstancedNodes([{ ...base, instances: { grid: { counts: [3, 1, 2], spacing: [1, 1, 1] } } }], options);
  assert.equal(grid.length, 1 + 6);
  assert.deepEqual(grid[1].translation, [-1, 0, -0.5]);
  assert.equal(grid[1].parent, 'rock');
  const half = expandInstancedNodes([{ ...base, instances: { grid: { counts: [4, 1, 1], spacing: [1, 1, 1] }, where: { gt: [{ attr: 'position', component: 'x' }, 0] } } }], options);
  assert.equal(half.length, 1 + 2);
  const scatter = { ...base, instances: { scatter: { count: 50, min: [0, 0, 0], max: [2, 0, 2] }, seed: 4, yaw: true, scale: [0.5, 1.5] } };
  const first = expandInstancedNodes([scatter], options);
  assert.equal(JSON.stringify(first), JSON.stringify(expandInstancedNodes([scatter], options)));
  assert.notEqual(JSON.stringify(first), JSON.stringify(expandInstancedNodes([{ ...scatter, instances: { ...scatter.instances, seed: 5 } }], options)));
  for (const node of first.slice(1)) {
    assert.ok(node.translation[0] >= 0 && node.translation[0] <= 2 && node.translation[1] === 0);
    assert.ok(node.scale[0] >= 0.5 && node.scale[0] <= 1.5);
  }
  const { positions, normals } = surfacePoints(surfaceGeometry, 100, 9);
  for (let point = 0; point < 100; point++) {
    const radius = Math.hypot(positions[point * 3], positions[point * 3 + 1], positions[point * 3 + 2]);
    assert.ok(radius > 0.9 && radius <= 1.0001, `radius ${radius}`);
    assert.ok(Math.hypot(normals[point * 3], normals[point * 3 + 1], normals[point * 3 + 2]) > 0.99);
  }
  const grass = expandInstancedNodes([{ ...base, instances: { surface: { geometry: 'ground', count: 20 }, alignToNormal: true } }], options);
  assert.equal(grass.length, 21);
});

test('hostile instance records are rejected before any point is made', () => {
  const base = { id: 'rock', geometry: 'stone', material: 'paint' };
  const options = { maxNodes: 4096, resolveSurface: () => assert.fail('resolved a surface') };
  const hostile = [
    { grid: { counts: [1e9, 1, 1], spacing: [1, 1, 1] } },
    { grid: { counts: [100, 100, 100], spacing: [1, 1, 1] } },
    { scatter: { count: 1e9, min: [0, 0, 0], max: [1, 1, 1] } },
    { scatter: { count: 5, min: [0, 0, 0], max: [1, 1, 'x'] } },
    { surface: { geometry: 'ground', count: 1e9 } },
    { grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, scatter: { count: 1, min: [0, 0, 0], max: [1, 1, 1] } },
    {},
    JSON.parse('{"__proto__": {"grid": 1}, "constructor": 1}'),
    { grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, where: { eval: 'process.exit()' } },
    { grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, alignToNormal: true },
    { grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, scale: [2, 1] },
    { grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, seed: -1 },
  ];
  for (const spec of hostile) {
    assert.throws(() => expandInstancedNodes([{ ...base, instances: spec }], options), error => error instanceof TypeError || error instanceof RangeError, JSON.stringify(spec).slice(0, 80));
  }
  assert.throws(() => expandInstancedNodes([{ id: 'bare', instances: { grid: { counts: [1, 1, 1], spacing: [1, 1, 1] } } }], options), /geometry and material/);
  assert.throws(() => expandInstancedNodes([{ ...base, instances: { grid: { counts: [30, 30, 2], spacing: [1, 1, 1] } } }], { ...options, maxNodes: 100 }), /past the limit/);
});

test('a recipe with an instanced node creates one instanced batch of ordinary nodes', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'stone', type: 'sphere' }, { id: 'floor', type: 'box' }],
    materials: [{ id: 'paint' }],
    nodes: [
      { id: 'floor', geometry: 'floor', material: 'paint', scale: [4, 0.1, 4] },
      { id: 'rocks', geometry: 'stone', material: 'paint', scale: [0.1, 0.1, 0.1], instances: { scatter: { count: 30, min: [-15, 1, -15], max: [15, 1, 15] }, seed: 2 } },
    ],
  };
  const session = createAgentScene(recipe);
  assert.equal(session.parts.length, 1 + 30);
  assert.equal(new Set(session.parts.map(part => part.geometry)).size, 2);
  assert.throws(() => createAgentScene({ ...recipe, nodes: [{ ...recipe.nodes[1], instances: { scatter: { count: 10_000_000, min: [0, 0, 0], max: [1, 1, 1] } } }] }), /scatter count/);
  assert.throws(() => createAgentScene({ ...recipe, nodes: [{ ...recipe.nodes[1], instances: { surface: { geometry: 'missing', count: 3 } } }] }), /instances\.surface: got "missing"; expected the ID of a geometry in geometries/);
});

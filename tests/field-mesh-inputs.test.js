import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { MAX_FIELD_ELEMENTS, compileField, evaluateField, meshFieldContext, pointSetContext, validateField } from '../src/mesh-fields.js';

// Three triangles. 0 and 1 share the edge from vertex 0 to vertex 1 at a right angle; 2 stands apart with area 2.
function folded() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 10, 0, 0, 12, 0, 0, 10, 0, 2]);
  const indices = new Uint32Array([0, 1, 2, 0, 3, 1, 4, 5, 6]);
  return meshFromGeometry({ positions, indices }, { quads: false, tags: 'none' });
}

function faceValues(expression, mesh = folded()) {
  return Array.from(evaluateField(expression, meshFieldContext(mesh, 'face'), { kind: 'scalar' }).values);
}

function pointValues(expression, mesh = folded()) {
  return Array.from(evaluateField(expression, meshFieldContext(mesh, 'point'), { kind: 'scalar' }).values);
}

function assertClose(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `${label}[${index}] ${value} vs ${expected[index]}`));
}

test('faceArea reads the area of a face and the mean around a point', () => {
  assertClose(faceValues({ faceArea: {} }), [0.5, 0.5, 2], 'faces');
  const points = pointValues({ faceArea: {} });
  assertClose(points.slice(0, 2), [0.5, 0.5], 'shared points');
  assertClose(points.slice(4), [2, 2, 2], 'apart points');
});

test('edgeAngle is the sharpest angle between faces over the edges, 0 on a border', () => {
  assertClose(faceValues({ edgeAngle: {} }), [Math.PI / 2, Math.PI / 2, 0], 'faces');
  assertClose(pointValues({ edgeAngle: {} }), [Math.PI / 2, Math.PI / 2, 0, 0, 0, 0, 0], 'points');
  const cubeAngles = faceValues({ edgeAngle: {} }, meshFromGeometry(box(0, 1)));
  cubeAngles.forEach(angle => assert.ok(Math.abs(angle - Math.PI / 2) < 1e-6, `cube edge ${angle}`));
});

test('island counts connected pieces by their first vertex', () => {
  assert.deepEqual(faceValues({ island: {} }), [0, 0, 1]);
  assert.deepEqual(pointValues({ island: {} }), [0, 0, 0, 0, 1, 1, 1]);
});

test('neighbors counts edges or faces that touch the element', () => {
  assert.deepEqual(pointValues({ neighbors: {} }), [3, 3, 2, 2, 2, 2, 2]);
  assert.deepEqual(pointValues({ neighbors: { read: 'faces' } }), [2, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual(faceValues({ neighbors: { read: 'faces' } }), [1, 1, 0]);
  assert.deepEqual(faceValues({ neighbors: { read: 'edges' } }), [3, 3, 3]);
});

test('accumulate adds up in index order and restarts for each group', () => {
  assertClose(faceValues({ accumulate: { value: { faceArea: {} } } }), [0.5, 1, 3], 'running');
  assertClose(faceValues({ accumulate: { value: { faceArea: {} }, group: { island: {} } } }), [0.5, 1, 2], 'grouped');
});

test('statistic gives min, max, mean, sum or range to every element or group', () => {
  const area = { faceArea: {} };
  assertClose(faceValues({ statistic: { value: area, mode: 'max' } }), [2, 2, 2], 'max');
  assertClose(faceValues({ statistic: { value: area, mode: 'min' } }), [0.5, 0.5, 0.5], 'min');
  assertClose(faceValues({ statistic: { value: area, mode: 'sum' } }), [3, 3, 3], 'sum');
  assertClose(faceValues({ statistic: { value: area, mode: 'range' } }), [1.5, 1.5, 1.5], 'range');
  assertClose(faceValues({ statistic: { value: area } }), [1, 1, 1], 'mean by default');
  assertClose(faceValues({ statistic: { value: area, mode: 'mean', group: { island: {} } } }), [0.5, 0.5, 2], 'grouped mean');
});

test('blur mixes a value with the mean of its neighbours for a bounded number of iterations', () => {
  const index = { attr: 'index' };
  assertClose(faceValues({ blur: { value: index } }), [1, 0, 2], 'one step');
  assertClose(faceValues({ blur: { value: index, weight: 0.5 } }), [0.5, 0.5, 2], 'half weight');
  assertClose(faceValues({ blur: { value: index, iterations: 2 } }), [0, 1, 2], 'two steps swap a pair');
  assertClose(pointValues({ blur: { value: index } }), [2, 5 / 3, 0.5, 0.5, 5.5, 5, 4.5], 'points');
});

test('sampleIndex reads another element, clamped to the range', () => {
  const tens = { mul: [{ attr: 'index' }, 10] };
  assert.deepEqual(faceValues({ sampleIndex: { value: tens, index: { sub: [2, { attr: 'index' }] } } }), [20, 10, 0]);
  assert.deepEqual(faceValues({ sampleIndex: { value: tens, index: 99 } }), [20, 20, 20]);
  assert.deepEqual(faceValues({ sampleIndex: { value: tens, index: -4 } }), [0, 0, 0]);
});

test('rank gives the position of each element when sorted, ties kept in index order', () => {
  const area = { faceArea: {} };
  assert.deepEqual(faceValues({ rank: { value: area } }), [0, 1, 2]);
  assert.deepEqual(faceValues({ rank: { value: area, descending: true } }), [1, 2, 0]);
  assert.deepEqual(faceValues({ rank: { value: { neg: { attr: 'index' } } } }), [2, 1, 0]);
});

test('the operators compose with the rest of the language', () => {
  const large = { gt: [{ faceArea: {} }, { statistic: { value: { faceArea: {} }, mode: 'mean' } }] };
  assert.deepEqual(faceValues(large), [0, 0, 1]);
});

test('geometry edited by these fields has the same bytes on every run', () => {
  const edit = [{
    op: 'set_position',
    select: { field: { gt: [{ edgeAngle: {} }, 1] } },
    offset: { vec: [0, { blur: { value: { faceArea: {} }, iterations: 2 } }, 0] },
  }];
  const first = applyMeshEdits(folded(), edit).mesh;
  const second = applyMeshEdits(folded(), edit).mesh;
  assert.equal(Buffer.from(first.positions.buffer).toString('hex'), Buffer.from(second.positions.buffer).toString('hex'));
  assert.notDeepEqual(Array.from(first.positions), Array.from(folded().positions));
  for (const expression of [{ island: {} }, { accumulate: { value: { faceArea: {} } } }, { rank: { value: { faceArea: {} } } }]) {
    const repeated = [faceValues(expression), faceValues(expression)].map(values => Buffer.from(Float64Array.from(values).buffer).toString('hex'));
    assert.equal(repeated[0], repeated[1]);
  }
});

test('errors name the field and the fix', () => {
  assert.throws(() => validateField({ faceArea: 3 }), /faceArea takes an object, written \{\}/);
  assert.throws(() => validateField({ island: { seed: 1 } }), /island does not take "seed"/);
  assert.throws(() => validateField({ neighbors: { read: 'corners' } }), /neighbors read must be one of edges, faces/);
  assert.throws(() => validateField({ statistic: { value: 1, mode: 'median' } }), /statistic mode must be one of min, max, mean, sum, range/);
  assert.throws(() => validateField({ statistic: {} }), /statistic needs "value": a number expression/);
  assert.throws(() => validateField({ blur: { value: 1, iterations: 33 } }), /blur iterations must be an integer from 1 to 32/);
  assert.throws(() => validateField({ blur: { value: 1, iterations: 1.5 } }), /blur iterations/);
  assert.throws(() => validateField({ blur: { value: 1, weight: 2 } }), /blur weight must be a number from 0 to 1/);
  assert.throws(() => validateField({ sampleIndex: { value: 1 } }), /sampleIndex needs "index"/);
  assert.throws(() => validateField({ rank: { value: 1, descending: 'yes' } }), /rank descending must be true or false/);
  assert.throws(() => validateField({ accumulate: { value: [1, 2, 3] } }), /accumulate "value" needs a number, not a vector; read one component with x, y or z/);
  assert.equal(validateField({ blur: { value: { faceArea: {} } } }), 'scalar');
  const points = pointSetContext(new Float32Array(6), new Float32Array(6));
  assert.throws(() => evaluateField({ island: {} }, points), /island reads the faces and edges of a mesh, which a point set does not have/);
  const crowded = { ...meshFieldContext(folded(), 'face'), count: MAX_FIELD_ELEMENTS + 1 };
  assert.throws(() => compileField({ rank: { value: 1 } }, crowded), /over the limit of 250000, so rank cannot run/);
});

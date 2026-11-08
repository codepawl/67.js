import assert from 'node:assert/strict';
import test from 'node:test';
import { quat, vec3 } from 'gl-matrix';
import { createMeshData, applyMeshEdits } from '../src/mesh.js';
import { FIELD_OPERATORS, evaluateField, pointSetContext } from '../src/mesh-fields.js';
import { expandInstancedNodes } from '../src/mesh-instances.js';
import { filletCurve, resampleCurve, curveLength } from '../src/curve-operations.js';
import { boundingBoxMesh, convexHullMesh } from '../src/mesh-hull-modifiers.js';
import { signedVolume } from '../src/mesh-surface-distance.js';
import { alignEuler } from '../src/field-rotation.js';
import { FIELD_OPERATOR_NAMES } from '../src/mesh-operations.js';

function evaluateVector(expression) {
  const positions = new Float64Array(3);
  const normals = new Float64Array(3);
  return Array.from(evaluateField(expression, pointSetContext(positions, normals), { kind: 'vector' }).values);
}

function assertClose(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `${message}: ${actual} vs ${expected}`));
}

function cubePoints() {
  const points = [];
  for (let corner = 0; corner < 8; corner++) points.push([corner & 1, (corner >> 1) & 1, (corner >> 2) & 1]);
  points.push([0.5, 0.5, 0.5], [0.2, 0.3, 0.4]);
  return points;
}

function pointCloudMesh(points) {
  return createMeshData({ positions: Float32Array.from(points.flat()), faceOffsets: Uint32Array.from([0, 3]), cornerVertices: Uint32Array.from([0, 1, 2]) });
}

function instancesFor(spec, maxNodes = 100) {
  return expandInstancedNodes([{ id: 'post', geometry: 'g', material: 'm', instances: spec }], { resolveSurface: () => null, maxNodes });
}

test('rotate turns a vector about an axis by an angle', () => {
  assertClose(evaluateVector({ rotate: [[1, 0, 0], [0, 0, 1], Math.PI / 2] }), [0, 1, 0], 'x about z by a quarter turn');
  assertClose(evaluateVector({ rotate: [[1, 2, 3], [0, 0, 0], 1] }), [1, 2, 3], 'a zero axis leaves it');
});

test('align gives Euler angles that turn +Y onto the direction, and transform applies them', () => {
  for (const direction of [[1, 0, 0], [0, 0, 1], [0, -1, 0], [0, 1, 0], [1, 2, -3], [-2, -0.5, 1]]) {
    const unit = vec3.normalize(vec3.create(), direction);
    assertClose(evaluateVector({ transform: [[0, 1, 0], [0, 0, 0], { align: [direction] }, 1] }), Array.from(unit), `align ${direction}`);
  }
  assertClose(evaluateVector({ transform: [[1, 1, 1], [1, 2, 3], [0, 0, 0], [2, 3, 4]] }), [3, 5, 7], 'scale then move');
  assertClose(evaluateVector({ transform: [[1, 0, 0], [0, 0, 0], [0, 0, Math.PI / 2]] }), [0, 1, 0], 'euler z');
  assert.deepEqual(alignEuler([0, 0, 0]), [0, 0, 0]);
});

test('the field operator names stay in step with the language', () => {
  assert.deepEqual([...FIELD_OPERATORS].sort(), [...FIELD_OPERATOR_NAMES].sort());
});

test('resample places points at equal arc length with the direction of travel', () => {
  const samples = resampleCurve([[0, 0, 0], [4, 0, 0], [4, 4, 0]], 5, false);
  assertClose(samples[2].point, [4, 0, 0], 'middle of an L is its corner');
  assertClose(samples[0].direction, [1, 0, 0], 'first direction');
  assertClose(samples[4].point, [4, 4, 0], 'last sample on the end');
  assertClose(samples[3].direction, [0, 1, 0], 'second leg direction');
  const loop = resampleCurve([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]], 8, true);
  assertClose(loop[1].point, [1, 0, 0], 'closed loop step is perimeter / count');
});

test('fillet rounds a corner with an arc of the given radius and keeps the ends', () => {
  const path = filletCurve([[0, 0, 0], [4, 0, 0], [4, 4, 0]], 1, 8, false);
  assertClose(path[0], [0, 0, 0], 'start kept');
  assertClose(path.at(-1), [4, 4, 0], 'end kept');
  const arc = path.slice(1, -1);
  assert.equal(arc.length, 9);
  assertClose(arc[0], [3, 0, 0], 'arc starts one radius before the corner');
  assertClose(arc.at(-1), [4, 1, 0], 'arc ends one radius after the corner');
  for (const point of arc) assert.ok(Math.abs(Math.hypot(point[0] - 3, point[1] - 1) - 1) < 1e-9, 'every arc point is one radius from the center');
  assert.ok(curveLength(path) < 8, 'rounding shortens the path');
  const tight = filletCurve([[0, 0, 0], [1, 0, 0], [1, 1, 0]], 5, 4, false);
  assertClose(tight[1], [0.5, 0, 0], 'a radius that does not fit is reduced to half the segment');
});

test('instances align along a curve', () => {
  const children = instancesFor({ curve: { points: [[0, 0, 0], [4, 0, 0], [4, 4, 0]], count: 5 }, alignToNormal: true }).slice(1);
  assert.equal(children.length, 5);
  assertClose(children[2].translation, [4, 0, 0], 'placed on the curve');
  assertClose(Array.from(vec3.transformQuat(vec3.create(), [0, 1, 0], children[0].rotation)), [1, 0, 0], 'up follows the first leg');
  assertClose(Array.from(vec3.transformQuat(vec3.create(), [0, 1, 0], children[4].rotation)), [0, 1, 0], 'up follows the second leg');
  assert.ok(quat.length(children[0].rotation) > 0.99);
  const rounded = instancesFor({ curve: { points: [[0, 0, 0], [4, 0, 0], [4, 4, 0]], count: 9, fillet: 1 }, alignToNormal: true });
  assert.equal(rounded.length, 10);
  assert.throws(() => instancesFor({ grid: { counts: [1, 1, 1], spacing: [1, 1, 1] }, alignToNormal: true }), /surface or curve/);
});

test('bounding_box is the axis-aligned box around the mesh', () => {
  const box = boundingBoxMesh(pointCloudMesh([[1, 2, 3], [-1, 5, 0], [0, 0, 4]]));
  assert.equal(box.vertexCount, 8);
  assert.equal(box.faceCount, 6);
  assert.ok(Math.abs(signedVolume(box) - 2 * 5 * 4) < 1e-6, 'outward faces and the right size');
});

test('convex_hull wraps the points in outward triangles and drops inner points', () => {
  const hull = convexHullMesh(pointCloudMesh(cubePoints()));
  assert.equal(hull.vertexCount, 8);
  assert.ok(Math.abs(signedVolume(hull) - 1) < 1e-6, `unit cube volume, got ${signedVolume(hull)}`);
  assert.throws(() => convexHullMesh(pointCloudMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]])), /one plane/);
  assert.throws(() => convexHullMesh(pointCloudMesh([[0, 0, 0], [1, 1, 1], [2, 2, 2]])), /one line/);
});

test('bounding_box and convex_hull run as recipe edits', () => {
  const { mesh } = applyMeshEdits(pointCloudMesh(cubePoints()), [{ op: 'convex_hull' }, { op: 'bounding_box' }]);
  assert.equal(mesh.faceCount, 6);
});

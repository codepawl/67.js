import test from 'node:test';
import assert from 'node:assert/strict';
import { clipFlushOverlaps, FLUSH_CUT_STRIDE } from '../src/flush-clip.js';

// A unit square on the plane y = 0 as two triangles, with a UV, a colour and a sky value that are linear in x and z.
function squareGeometry() {
  const corners = [[0, 0], [0, 1], [1, 1], [1, 0]];
  return {
    positions: new Float32Array(corners.flatMap(([x, z]) => [x, 0, z])),
    normals: new Float32Array(corners.flatMap(() => [0, 1, 0])),
    uvs: new Float32Array(corners.flatMap(([x, z]) => [x, z])),
    colors: new Float32Array(corners.flatMap(([x, z]) => [x, z, 0.5])),
    skyVisibility: new Float32Array(corners.map(([x, z]) => 0.25 * x + 0.5 * z)),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// One cut per triangle of the square for every winner, sorted by the triangle that is cut.
function cutsOf(winners, triangles = [0, 1]) {
  const cuts = [];
  for (const triangle of triangles) {
    for (const winner of winners) cuts.push(triangle, ...winner.flatMap(([x, z]) => [x, 0, z]));
  }
  assert.equal(cuts.length % FLUSH_CUT_STRIDE, 0);
  return new Float64Array(cuts);
}

function triangleNormalAndArea(positions, indices, triangle) {
  const [first, second, third] = [0, 1, 2].map(corner => indices[triangle * 3 + corner] * 3);
  const edgeOne = [0, 1, 2].map(axis => positions[second + axis] - positions[first + axis]);
  const edgeTwo = [0, 1, 2].map(axis => positions[third + axis] - positions[first + axis]);
  const normal = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
  return { normal, area: Math.hypot(...normal) / 2 };
}

function areaOf(geometry) {
  let area = 0;
  for (let triangle = 0; triangle < geometry.indices.length / 3; triangle++) area += triangleNormalAndArea(geometry.positions, geometry.indices, triangle).area;
  return area;
}

const INSIDE = [[0.25, 0.25], [0.25, 0.75], [0.75, 0.25]];
const ACROSS_THE_CORNER = [[0.5, 0.5], [0.5, 1.5], [1.5, 0.5]];

test('what is left of the cut face and the face that covers it add up to the area of their union', () => {
  for (const { winner, shared } of [{ winner: INSIDE, shared: 0.125 }, { winner: ACROSS_THE_CORNER, shared: 0.25 }]) {
    const square = squareGeometry();
    const { geometry, sources } = clipFlushOverlaps(square, cutsOf([winner]));
    assert.notEqual(geometry, square);
    const winnerArea = 0.5 * (winner[1][1] - winner[0][1]) * (winner[2][0] - winner[0][0]);
    const union = 1 + winnerArea - shared;
    assert.ok(Math.abs(areaOf(geometry) + winnerArea - union) < 1e-6, `clipped ${areaOf(geometry)} against ${1 - shared}`);
    assert.equal(sources.length, geometry.indices.length / 3);
    assert.ok(sources.every(source => source === 0 || source === 1));
  }
});

test('two winners that overlap each other are still cut out once', () => {
  const square = squareGeometry();
  const second = [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75]].map(([x, z]) => [x, z]);
  // INSIDE and `second` share the triangle between the centre and the edge z = 0.25: their union is 3/16.
  const { geometry } = clipFlushOverlaps(square, cutsOf([INSIDE, [second[0], second[2], second[1]]]));
  // Each cut stops four float32 steps inside its winner, which is worth about 1e-6 of area along these edges.
  assert.ok(Math.abs(areaOf(geometry) - (1 - 3 / 16)) < 2e-6);
});

test('every per-vertex array is interpolated for the new vertices, and the old vertices are kept as they were', () => {
  const square = squareGeometry();
  const { geometry } = clipFlushOverlaps(square, cutsOf([INSIDE]));
  const vertexCount = geometry.positions.length / 3;
  assert.ok(vertexCount > 4);
  assert.deepEqual(Array.from(geometry.positions.subarray(0, 12)), Array.from(square.positions));
  for (const [field, stride] of [['normals', 3], ['uvs', 2], ['colors', 3], ['skyVisibility', 1]]) {
    assert.equal(geometry[field].length, vertexCount * stride, field);
    assert.ok(geometry[field] instanceof Float32Array);
  }
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = geometry.positions[vertex * 3];
    const z = geometry.positions[vertex * 3 + 2];
    assert.equal(geometry.positions[vertex * 3 + 1], 0);
    assert.deepEqual(Array.from(geometry.normals.subarray(vertex * 3, vertex * 3 + 3)), [0, 1, 0]);
    assert.ok(Math.abs(geometry.uvs[vertex * 2] - x) < 1e-6 && Math.abs(geometry.uvs[vertex * 2 + 1] - z) < 1e-6);
    assert.ok(Math.abs(geometry.colors[vertex * 3] - x) < 1e-6 && Math.abs(geometry.colors[vertex * 3 + 2] - 0.5) < 1e-6);
    assert.ok(Math.abs(geometry.skyVisibility[vertex] - (0.25 * x + 0.5 * z)) < 1e-6);
  }
});

test('the pieces keep the winding of the face they were cut from', () => {
  const { geometry } = clipFlushOverlaps(squareGeometry(), cutsOf([ACROSS_THE_CORNER]));
  for (let triangle = 0; triangle < geometry.indices.length / 3; triangle++) {
    assert.ok(triangleNormalAndArea(geometry.positions, geometry.indices, triangle).normal[1] > 0);
  }
});

test('untouched geometry keeps its identity', () => {
  const square = squareGeometry();
  assert.deepEqual(clipFlushOverlaps(square, new Float64Array(0)), { geometry: square, sources: null });
  const beside = [[2, 0], [2, 1], [3, 0]];
  assert.equal(clipFlushOverlaps(square, cutsOf([beside])).geometry, square, 'a winner that does not reach the face cuts nothing');
  const alongTheEdge = [[1, 0], [1, 1], [2, 0]];
  assert.equal(clipFlushOverlaps(square, cutsOf([alongTheEdge])).geometry, square, 'sharing an edge is not covering');
});

test('a fully covered triangle is dropped, and the other triangles keep their vertices', () => {
  const square = squareGeometry();
  const firstTriangle = [[0, 0], [0, 1], [1, 1]];
  const { geometry, sources } = clipFlushOverlaps(square, cutsOf([firstTriangle], [0]));
  assert.deepEqual(Array.from(geometry.indices), [0, 2, 3]);
  assert.deepEqual(Array.from(sources), [1]);
  assert.equal(geometry.positions.length, square.positions.length, 'no vertex was needed');
  const everything = [[-1, -1], [-1, 3], [3, -1]];
  assert.equal(clipFlushOverlaps(square, cutsOf([everything])).geometry.indices.length, 0);
});

test('the same cuts on the same geometry return the same object', () => {
  const square = squareGeometry();
  const first = clipFlushOverlaps(square, cutsOf([INSIDE]));
  assert.equal(clipFlushOverlaps(square, cutsOf([INSIDE])), first);
  assert.notEqual(clipFlushOverlaps(square, cutsOf([ACROSS_THE_CORNER])), first);
  assert.notEqual(clipFlushOverlaps(squareGeometry(), cutsOf([INSIDE])), first);
});

test('a cut stops a few float32 steps inside the winner, so the two faces overlap instead of opening a seam', () => {
  const square = squareGeometry();
  const { geometry } = clipFlushOverlaps(square, cutsOf([INSIDE]), 1e-4);
  // With a coordinate step of 0.1 mm the hole is the winner pulled in by 0.4 mm on each of its three edges.
  const inradius = 2 * 0.125 / (0.5 + 0.5 + Math.SQRT1_2);
  const shrunk = 0.125 * ((inradius - 4e-4) / inradius) ** 2;
  assert.ok(Math.abs(1 - areaOf(geometry) - shrunk) < 1e-6);
});

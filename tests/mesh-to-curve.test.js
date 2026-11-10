import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder, grid } from '../src/geometry.js';
import { curveSet } from '../src/modeling.js';
import { meshFromGeometry, meshEdgesToSplines } from '../src/mesh.js';
import { createMeshData } from '../src/mesh-data.js';

const SWEEP_RADIUS = 0.02;

// A square pillar with its top face removed: the open rim is one closed loop of four edges.
function openPillar() {
  const full = meshFromGeometry(box(0, 1));
  const { faceOffsets, cornerVertices } = full;
  const keptFaces = [];
  for (let face = 0; face < full.faceCount; face++) {
    const corners = Array.from(cornerVertices.subarray(faceOffsets[face], faceOffsets[face + 1]));
    const averageHeight = corners.reduce((sum, vertex) => sum + full.positions[vertex * 3 + 1], 0) / corners.length;
    if (!(averageHeight > 0.49 && corners.every(vertex => full.positions[vertex * 3 + 1] > 0.49))) keptFaces.push(corners);
  }
  const offsets = [0];
  const corners = [];
  for (const face of keptFaces) {
    corners.push(...face);
    offsets.push(corners.length);
  }
  return createMeshData({ positions: full.positions, faceOffsets: Uint32Array.from(offsets), cornerVertices: Uint32Array.from(corners) });
}

function distanceToSegment(point, from, to) {
  const direction = to.map((value, axis) => value - from[axis]);
  const offset = point.map((value, axis) => value - from[axis]);
  const lengthSquared = direction.reduce((sum, value) => sum + value * value, 0);
  const along = Math.min(Math.max(offset.reduce((sum, value, axis) => sum + value * direction[axis], 0) / lengthSquared, 0), 1);
  return Math.hypot(...offset.map((value, axis) => value - direction[axis] * along));
}

function distanceToLoop(point, loop) {
  return Math.min(...loop.map((from, index) => distanceToSegment(point, from, loop[(index + 1) % loop.length])));
}

test('an open mesh rim becomes a closed curve and sweeping it gives back the outline', () => {
  const pillar = openPillar();
  const [spline, ...others] = meshEdgesToSplines(pillar, { open: true });
  assert.equal(others.length, 0);
  assert.equal(spline.kind, 'poly');
  assert.equal(spline.closed, true);
  assert.equal(spline.points.length, 4);
  for (const point of spline.points) {
    assert.ok(Math.abs(point[1] - 0.5) < 1e-6, 'the rim sits at the top');
    assert.ok(Math.abs(Math.abs(point[0]) - 0.5) < 1e-6 && Math.abs(Math.abs(point[2]) - 0.5) < 1e-6);
  }
  // consecutive points share an edge: one coordinate changes by the full side
  spline.points.forEach((point, index) => {
    const next = spline.points[(index + 1) % 4];
    const changed = point.filter((value, axis) => Math.abs(value - next[axis]) > 0.5).length;
    assert.equal(changed, 1);
  });
  const sweep = curveSet([spline], { radius: SWEEP_RADIUS, radialSegments: 6, maxVertices: 100000 });
  assert.ok(sweep.indices.length > 0);
  let worst = 0;
  for (let offset = 0; offset < sweep.positions.length; offset += 3) {
    const point = Array.from(sweep.positions.subarray(offset, offset + 3));
    worst = Math.max(worst, distanceToLoop(point, spline.points));
  }
  assert.ok(worst <= SWEEP_RADIUS * 1.0001, `swept vertices stay within the tube radius of the outline (worst distance ${worst})`);
});

test('an explicit edge list gives an open chain in walking order, the same every call', () => {
  const pillar = openPillar();
  const rim = meshEdgesToSplines(pillar, { open: true })[0];
  const rimEdges = [];
  for (let edge = 0; edge < pillar.edgeCount; edge++) {
    const vertices = [pillar.edgeVertices[edge * 2], pillar.edgeVertices[edge * 2 + 1]];
    if (vertices.every(vertex => pillar.positions[vertex * 3 + 1] > 0.49)) rimEdges.push(edge);
  }
  assert.equal(rimEdges.length, 4);
  const chain = meshEdgesToSplines(pillar, { edges: rimEdges.slice(0, 3) });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].closed, false);
  assert.equal(chain[0].points.length, 4);
  assert.deepEqual(meshEdgesToSplines(pillar, { edges: rimEdges.slice(0, 3) }), chain);
  assert.deepEqual(meshEdgesToSplines(pillar, { edges: [...rimEdges].reverse() }), [rim]);
});

test('a vertex group selects the loop and a junction splits chains', () => {
  const pillar = openPillar();
  const weights = new Float32Array(pillar.vertexCount);
  for (let vertex = 0; vertex < pillar.vertexCount; vertex++) weights[vertex] = pillar.positions[vertex * 3 + 1] > 0.49 ? 1 : 0;
  const withGroup = createMeshData({
    positions: pillar.positions,
    faceOffsets: pillar.faceOffsets,
    cornerVertices: pillar.cornerVertices,
    attributes: { point: { 'group:rim': { data: weights, size: 1 } } },
  });
  assert.deepEqual(meshEdgesToSplines(withGroup, { group: 'rim' }), meshEdgesToSplines(pillar, { open: true }));
  // all four vertical edges meet the rim: they form a star of 3-edge junction vertices
  const vertical = meshEdgesToSplines(pillar, { along: [0, 1, 0] });
  assert.equal(vertical.length, 4);
  assert.ok(vertical.every(spline => spline.closed === false && spline.points.length === 2));
});

test('mesh edges to curve rejects bad selections with what to pass', () => {
  const pillar = openPillar();
  const cases = [
    [undefined, /selection must be an object/],
    [{ edges: [] }, /selection\.edges needs 1 to/],
    [{ edges: [999] }, /every index must be an integer from 0 to/],
    [{ edges: [0], extra: 1 }, /selection\.edges does not take extra/],
    [{ group: 'nope' }, /Unknown vertex group nope/],
    [{ group: 7 }, /selection\.group must be a vertex group name/],
    [{ group: 'rim', minWeight: 0 }, /selection\.minWeight must be a number above 0/],
    [{ open: { inside: { min: [5, 5, 5], max: [6, 6, 6] } } }, /matches no edge/],
  ];
  for (const [selection, pattern] of cases) assert.throws(() => meshEdgesToSplines(pillar, selection), pattern);
});

test('mesh edges to curve is bounded', () => {
  const drum = meshFromGeometry(cylinder(2000, 0, 1));
  assert.throws(() => meshEdgesToSplines(drum, { angle: 45 }), /A selected chain has 2000 points; at most 1024/);
  const rows = meshFromGeometry(grid(64));
  assert.throws(() => meshEdgesToSplines(rows, { along: [1, 0, 0] }), /makes 65 splines; at most 64/);
});

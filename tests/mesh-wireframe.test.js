import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshData } from '../src/mesh-data.js';
import { meshFromGeometry } from '../src/mesh-convert.js';
import { MAXIMUM_WIREFRAME_SEGMENTS, WIREFRAME_KINDS, WIREFRAME_SEGMENT_STRIDE, meshWireframe } from '../src/mesh-wireframe.js';

const CUBE_POSITIONS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
// Outward-wound quads: bottom, top, front, back, left, right.
const CUBE_FACES = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]];

function meshOf(positions, faces) {
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((face, index) => { faceOffsets[index + 1] = faceOffsets[index] + face.length; });
  return createMeshData({ positions: new Float32Array(positions), faceOffsets, cornerVertices: new Uint32Array(faces.flat()) });
}

function kindsOf(wireframe) {
  const kinds = [];
  for (let segment = 0; segment < wireframe.count; segment++) kinds.push(WIREFRAME_KINDS[wireframe.segments[segment * WIREFRAME_SEGMENT_STRIDE + 6]]);
  return kinds;
}

test('a clean cube is twelve regular polygon edges with no fault', () => {
  const wireframe = meshWireframe(meshOf(CUBE_POSITIONS, CUBE_FACES));
  assert.equal(wireframe.count, 12);
  assert.deepEqual(wireframe.counts, { regular: 12, boundary: 0, nonManifold: 0, flipped: 0, degenerate: 0 });
  assert.equal(wireframe.truncated, false);
  assert.equal(wireframe.segments.length, 12 * WIREFRAME_SEGMENT_STRIDE);
});

test('triangulation diagonals of planar quads are not drawn, whether the cube is quads or triangle pairs', () => {
  const triangles = [];
  for (const [a, b, c, d] of CUBE_FACES) triangles.push(a, b, c, a, c, d);
  const positions = new Float32Array(CUBE_POSITIONS);
  const geometry = { positions, normals: new Float32Array(positions.length), indices: new Uint32Array(triangles) };
  const wireframe = meshWireframe(meshFromGeometry(geometry));
  assert.equal(wireframe.count, 12);
  assert.equal(wireframe.counts.regular, 12);
});

test('an open box marks the rim as boundary edges', () => {
  const wireframe = meshWireframe(meshOf(CUBE_POSITIONS, CUBE_FACES.slice(0, 5)));
  assert.equal(wireframe.counts.boundary, 4);
  assert.equal(wireframe.counts.regular, 12 - 4);
  assert.equal(kindsOf(wireframe).slice(0, 4).every(kind => kind === 'boundary'), true);
});

test('a third face on an edge makes it non-manifold', () => {
  const positions = [...CUBE_POSITIONS, 0.5, -1, 0.5, 0.5, -1, 0.9];
  const mesh = meshOf(positions, [...CUBE_FACES, [0, 1, 8]]);
  const wireframe = meshWireframe(mesh);
  assert.equal(wireframe.counts.nonManifold, 1);
  assert.equal(wireframe.counts.boundary, 2);
});

test('a flipped face turns the edges it shares with its neighbours into flipped edges', () => {
  const faces = CUBE_FACES.map((face, index) => (index === 1 ? [...face].reverse() : face));
  const wireframe = meshWireframe(meshOf(CUBE_POSITIONS, faces));
  assert.equal(wireframe.counts.flipped, 4);
  assert.equal(wireframe.counts.regular, 8);
});

test('a zero-area face shows its edges as degenerate', () => {
  const positions = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0];
  const wireframe = meshWireframe(meshOf(positions, [[0, 1, 2], [0, 1, 4, 3]]));
  assert.ok(wireframe.counts.degenerate >= 2);
});

test('faults are kept before regular edges when the limit cuts the mesh', () => {
  const wireframe = meshWireframe(meshOf(CUBE_POSITIONS, CUBE_FACES.slice(0, 5)), { maximumSegments: 6 });
  assert.equal(wireframe.count, 6);
  assert.equal(wireframe.truncated, true);
  assert.equal(wireframe.droppedFaults, 0);
  assert.equal(kindsOf(wireframe).filter(kind => kind === 'boundary').length, 4);
  assert.equal(wireframe.counts.regular, 8);
});

test('the segment limit is validated and bounded by default', () => {
  assert.throws(() => meshWireframe(meshOf(CUBE_POSITIONS, CUBE_FACES), { maximumSegments: 0 }), /maximumSegments/);
  assert.ok(MAXIMUM_WIREFRAME_SEGMENTS <= 200_000);
});

test('the same mesh gives the same segments', () => {
  const first = meshWireframe(meshOf(CUBE_POSITIONS, CUBE_FACES));
  const second = meshWireframe(meshOf(CUBE_POSITIONS, CUBE_FACES));
  assert.deepEqual(first.segments, second.segments);
});

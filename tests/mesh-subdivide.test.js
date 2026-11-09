import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { createMeshData, meshFromGeometry, meshBounds, tagCounts, applyMeshEdits } from '../src/mesh.js';
import { subdivisionSize } from '../src/mesh-subdivide.js';
import { evaluateMeshStack, normalizeMeshEdits } from '../src/mesh-recipe.js';

const cube = () => meshFromGeometry(box(0, 1));

function triangle() {
  return createMeshData({
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
    faceOffsets: new Uint32Array([0, 3]),
    cornerVertices: new Uint32Array([0, 1, 2]),
  });
}

const subdivide = (mesh, edit) => applyMeshEdits(mesh, [{ op: 'subdivide', ...edit }]).mesh;

test('a cube keeps Euler characteristic 2 and multiplies its faces by four each level', () => {
  let mesh = cube();
  for (let level = 1; level <= 3; level++) {
    mesh = subdivide(mesh, {});
    assert.equal(mesh.faceCount, 6 * 4 ** level);
    assert.equal(mesh.vertexCount - mesh.edgeCount + mesh.faceCount, 2);
  }
});

test('the size is known from counts before anything is built', () => {
  const size = subdivisionSize(cube(), 3);
  const built = subdivide(cube(), { levels: 3 });
  assert.deepEqual([size.vertices, size.edges, size.faces, size.corners], [built.vertexCount, built.edgeCount, built.faceCount, built.cornerCount]);
});

test('an n-gon with open boundary edges splits into quads and its boundary stays on the straight edges', () => {
  const mesh = subdivide(triangle(), { levels: 2 });
  assert.equal(mesh.faceCount, 12);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const [x, y] = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1]];
    const onBoundary = Math.abs(y) < 1e-6 || Math.abs(x) < 1e-6 || Math.abs(x + y - 2) < 1e-6;
    const inside = x > 1e-6 && y > 1e-6 && x + y < 2 - 1e-6;
    assert.ok(onBoundary || inside);
  }
  const bounds = meshBounds(mesh);
  assert.deepEqual(bounds.min.map(value => Math.round(value * 1e5) / 1e5), [0, 0, 0]);
  assert.deepEqual(bounds.max.map(value => Math.round(value * 1e5) / 1e5), [2, 2, 0]);
});

test('faces keep their tags through each level', () => {
  const tagged = applyMeshEdits(cube(), [{ op: 'tag', select: { tag: 'top' }, name: 'lid' }]).mesh;
  assert.equal(tagCounts(subdivide(tagged, { levels: 2 })).lid, 16);
});

test('corner uv values blend linearly and stay inside their island', () => {
  const quad = createMeshData({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceOffsets: new Uint32Array([0, 4]),
    cornerVertices: new Uint32Array([0, 1, 2, 3]),
    attributes: { corner: { uv: { data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), size: 2 } } },
  });
  const refined = subdivide(quad, { levels: 1 });
  const uv = refined.attributes.corner.uv;
  assert.equal(uv.data.length, refined.cornerCount * 2);
  for (let corner = 0; corner < refined.cornerCount; corner++) {
    const vertex = refined.cornerVertices[corner];
    assert.ok(Math.abs(uv.data[corner * 2] - refined.positions[vertex * 3]) < 1e-6, 'u follows x on a flat unit square');
    assert.ok(Math.abs(uv.data[corner * 2 + 1] - refined.positions[vertex * 3 + 1]) < 1e-6, 'v follows y');
  }
});

test('full creases on every edge keep a cube a cube, and a half crease only partly rounds it', () => {
  const sharp = subdivide(cube(), { levels: 2, crease: { all: true } });
  assert.deepEqual(meshBounds(sharp), meshBounds(cube()));
  const smooth = meshBounds(subdivide(cube(), { levels: 2 }));
  const half = meshBounds(subdivide(cube(), { levels: 2, crease: { all: true }, sharpness: 0.5 }));
  assert.ok(half.max[0] > smooth.max[0] && half.max[0] < 0.5);
});

// How far the sharpest corner of a cube sits from the centre along the diagonal (1.5 for the cube itself).
function cornerReach(mesh) {
  let reach = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    reach = Math.max(reach, Math.abs(mesh.positions[vertex * 3]) + Math.abs(mesh.positions[vertex * 3 + 1]) + Math.abs(mesh.positions[vertex * 3 + 2]));
  }
  return reach;
}

test('a crease of sharpness 1 holds for one level only', () => {
  const held = subdivide(cube(), { levels: 1, crease: { all: true }, sharpness: 1 });
  const released = subdivide(cube(), { levels: 2, crease: { all: true }, sharpness: 1 });
  assert.ok(Math.abs(cornerReach(held) - 1.5) < 1e-6);
  assert.ok(cornerReach(released) < 1.5 - 0.01);
});

test('the budget is checked before the mesh grows', () => {
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'subdivide', levels: 4 }], { maxFaces: 1000 }), /edits\[0\]\.levels: got 4; .*\(this edit would make \d+ vertices and 1536 faces\)/);
  assert.throws(() => evaluateMeshStack(cube(), [{ op: 'subdivide', levels: 4 }], { maxVertices: 100 }), RangeError);
});

test('the recipe rejects levels out of range and a sharpness without a crease', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'subdivide', levels: 5 }]), /edits\[0\]\.levels: got 5; expected a whole number from 1 to 4/);
  assert.throws(() => normalizeMeshEdits([{ op: 'subdivide', levels: 0 }]), /levels/);
  assert.throws(() => normalizeMeshEdits([{ op: 'subdivide', sharpness: 2 }]), /edits\[0\]\.sharpness: got 2; expected left out unless a crease rule is given/);
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'subdivide', crease: { angle: 179 } }]), /selects no edges/);
});

test('subdivide runs as a stack node after the edits', () => {
  const result = evaluateMeshStack(cube(), [{ op: 'subdivide', levels: 2 }]);
  assert.equal(result.mesh.faceCount, 96);
  assert.equal(result.results[0].levels, 2);
});

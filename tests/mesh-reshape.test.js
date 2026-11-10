import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder } from '../src/geometry.js';
import { createMeshData, editMesh, validateTopology, meshFromGeometry, lintMesh, tagCounts, applyMeshEdits } from '../src/mesh.js';
import { normalizeMeshEdits, MESH_EDIT_OPERATIONS } from '../src/mesh-recipe.js';

const cube = () => meshFromGeometry(box(0, 1));

function run(mesh, edits) {
  const outcome = applyMeshEdits(mesh, edits);
  validateTopology(editMesh(outcome.mesh));
  return outcome;
}

function assertClosed(mesh) {
  const report = lintMesh(mesh);
  assert.deepEqual(report.problems, []);
  assert.equal(report.parts.closed, 1);
}

function volume(mesh) {
  let total = 0;
  for (let face = 0; face < mesh.faceCount; face++) {
    const corners = [];
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const vertex = mesh.cornerVertices[corner] * 3;
      corners.push([mesh.positions[vertex], mesh.positions[vertex + 1], mesh.positions[vertex + 2]]);
    }
    for (let index = 1; index + 1 < corners.length; index++) {
      const [a, b, c] = [corners[0], corners[index], corners[index + 1]];
      total += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  }
  return total;
}

function sameBytes(first, second) {
  assert.deepEqual(Buffer.from(first.positions.buffer), Buffer.from(second.positions.buffer));
  assert.deepEqual(first.cornerVertices, second.cornerVertices);
  assert.deepEqual(first.faceOffsets, second.faceOffsets);
}

const openCube = () => run(cube(), [{ op: 'delete', select: { tag: 'top' } }]).mesh;

test('poke turns each selected face into a fan, keeps the surface closed and is deterministic', () => {
  const { mesh, results } = run(cube(), [{ op: 'poke', name: 'spike', offset: 0.25 }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [14, 24]);
  assert.equal(tagCounts(mesh)['spike.poke'], 24);
  assert.equal(tagCounts(mesh).top, 4);
  assert.equal(results[0].pokedFaces, 6);
  assertClosed(mesh);
  assert.ok(volume(mesh) > 1, 'a positive offset pushes the centres outward');
  sameBytes(mesh, run(cube(), [{ op: 'poke', name: 'spike', offset: 0.25 }]).mesh);
});

test('poke only touches the selection and relative scales the offset by the face size', () => {
  const { mesh } = run(cube(), [{ op: 'poke', select: { tag: 'top' }, offset: 1, relative: true }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [9, 9]);
  let highest = -Infinity;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) highest = Math.max(highest, mesh.positions[vertex * 3 + 1]);
  assert.ok(Math.abs(highest - (0.5 + Math.SQRT1_2)) < 1e-6, `apex height ${highest}`);
  assert.throws(() => run(cube(), [{ op: 'poke', select: { faces: [] } }]), /select/);
});

test('dual swaps faces and vertices and keeps the winding', () => {
  const { mesh, results } = run(cube(), [{ op: 'dual', name: 'octa' }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [6, 8]);
  assert.equal(tagCounts(mesh)['octa.dual'], 8);
  assert.deepEqual([results[0].dualVertices, results[0].dualFaces], [6, 8]);
  assertClosed(mesh);
  assert.ok(volume(mesh) > 0, 'faces still point outward');
  const back = run(mesh, [{ op: 'dual' }]).mesh;
  assert.deepEqual([back.vertexCount, back.faceCount], [8, 6]);
  assert.ok(volume(back) > 0);
  sameBytes(mesh, run(cube(), [{ op: 'dual', name: 'octa' }]).mesh);
});

test('dual refuses an open mesh and a reversed face', () => {
  assert.throws(() => run(openCube(), [{ op: 'dual' }]), /open boundary.*fill_holes/s);
  const flipped = run(cube(), [{ op: 'flip_normals', select: { tag: 'top' } }]).mesh;
  assert.throws(() => run(flipped, [{ op: 'dual' }]), /consistent winding/);
});

test('tris_to_quads joins triangulated quads back, keeping tags and a closed surface', () => {
  const triangles = run(cube(), [{ op: 'triangulate' }]).mesh;
  assert.equal(triangles.faceCount, 12);
  const { mesh, results } = run(triangles, [{ op: 'tris_to_quads', name: 'quad' }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [8, 6]);
  assert.equal(results[0].joinedPairs, 6);
  assert.equal(tagCounts(mesh)['quad.merged'], 6);
  for (const tag of ['top', 'bottom', 'left', 'right', 'front', 'back']) assert.equal(tagCounts(mesh)[tag], 1, tag);
  assertClosed(mesh);
  assert.ok(Math.abs(volume(mesh) - 1) < 1e-6);
  sameBytes(mesh, run(triangles, [{ op: 'tris_to_quads', name: 'quad' }]).mesh);
});

test('tris_to_quads respects the selection, the angle limit and refuses a mesh with nothing to join', () => {
  const triangles = run(cube(), [{ op: 'triangulate' }]).mesh;
  const top = run(triangles, [{ op: 'tris_to_quads', select: { tag: 'top' } }]).mesh;
  assert.equal(top.faceCount, 11);
  // Two triangles meeting at 90 degrees never form a flat quad at the default 40 degree limit.
  assert.throws(() => run(run(cube(), [{ op: 'triangulate' }]).mesh, [{ op: 'tris_to_quads', angle: 0, select: { faces: [0] } }]), /No two adjacent selected triangles/);
  assert.throws(() => run(cube(), [{ op: 'tris_to_quads' }]), /No two adjacent selected triangles/);
});

test('scale_elements scales connected faces about their own centre and keeps the topology', () => {
  const source = cube();
  const { mesh, results } = run(source, [{ op: 'scale_elements', select: { tag: 'top' }, scale: 0.5 }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [8, 6]);
  assert.deepEqual([results[0].movedVertices, results[0].islands], [4, 1]);
  assert.deepEqual(mesh.cornerVertices, source.cornerVertices);
  const topHeights = new Set();
  const topWidths = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (mesh.positions[vertex * 3 + 1] > 0) {
      topHeights.add(mesh.positions[vertex * 3 + 1]);
      topWidths.push(Math.abs(mesh.positions[vertex * 3]));
    }
  }
  assert.deepEqual([...topHeights], [0.5]);
  assert.ok(topWidths.every(width => Math.abs(width - 0.25) < 1e-6));
  assertClosed(mesh);
  const two = run(source, [{ op: 'scale_elements', select: { or: [{ tag: 'left' }, { tag: 'right' }] }, scale: 2 }]);
  assert.equal(two.results[0].islands, 2);
});

test('symmetrize mirrors the kept half over the plane, cutting faces that cross it', () => {
  const sliced = run(cube(), [{ op: 'loop_cut', name: 'cut', edges: { along: [1, 0, 0] } }]).mesh;
  const lifted = run(sliced, [{ op: 'translate', select: { inside: { min: [0.01, -9, -9], max: [9, 9, 9] } }, offset: [0, 0.3, 0] }]).mesh;
  const { mesh, results } = run(lifted, [{ op: 'symmetrize', axis: 'x', keep: 'negative', name: 'sym' }]);
  assert.equal(results[0].removedFaces, 5);
  assert.equal(tagCounts(mesh)['sym.mirrored'], 5);
  assert.equal(tagCounts(mesh).left, 1);
  assert.equal(tagCounts(mesh).right, 1);
  assertClosed(mesh);
  const points = new Set();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    points.add(`${mesh.positions[vertex * 3].toFixed(4)},${mesh.positions[vertex * 3 + 1].toFixed(4)},${mesh.positions[vertex * 3 + 2].toFixed(4)}`);
  }
  for (const key of points) {
    const [x, y, z] = key.split(',');
    assert.ok(points.has(`${(-Number(x)).toFixed(4).replace('-0.0000', '0.0000')},${y},${z}`) || x === '0.0000', `${key} has a mirror twin`);
  }
  sameBytes(mesh, run(lifted, [{ op: 'symmetrize', axis: 'x', keep: 'negative', name: 'sym' }]).mesh);
});

test('symmetrize bisects faces that straddle the plane and refuses a mesh without a kept side', () => {
  const skewed = run(cube(), [{ op: 'translate', select: { tag: 'top' }, offset: [0.2, 0.1, 0] }]).mesh;
  const { mesh } = run(skewed, [{ op: 'symmetrize', axis: 'x' }]);
  assertClosed(mesh);
  assert.ok(Math.abs(volume(mesh) - volume(run(skewed, [{ op: 'symmetrize', axis: 'x' }]).mesh)) < 1e-9);
  const away = run(cube(), [{ op: 'translate', select: { all: true }, offset: [5, 0, 0] }]).mesh;
  assert.throws(() => run(away, [{ op: 'symmetrize', axis: 'x', keep: 'negative' }]), /No face lies on the negative side/);
});

test('extrude_edges grows a surface from its boundary and tags the new quads', () => {
  const { mesh, results } = run(openCube(), [{ op: 'extrude_edges', name: 'lip', edges: { open: true }, offset: [0, 1, 0] }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [12, 9]);
  assert.equal(results[0].extrudedEdges, 4);
  assert.equal(tagCounts(mesh)['lip.side'], 4);
  assert.equal(tagCounts(mesh).front, 1);
  assert.equal(lintMesh(mesh).problems.filter(problem => problem.kind === 'boundary-edge').length > 0, true);
  const upward = run(openCube(), [{ op: 'extrude_edges', edges: { open: true }, offset: [0, 1, 0] }]).mesh;
  const round = meshFromGeometry(cylinder(8, 0, 1));
  assert.throws(() => run(round, [{ op: 'extrude_edges', edges: { open: true }, offset: [0, 1, 0] }]), /selects no edge/);
  sameBytes(mesh, run(openCube(), [{ op: 'extrude_edges', name: 'lip', edges: { open: true }, offset: [0, 1, 0] }]).mesh);
  assert.equal(upward.faceCount, 9);
});

test('the reshaping edits validate their fields', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'scale_elements', scale: 0 }]), /edits\[0\]\.scale/);
  assert.throws(() => normalizeMeshEdits([{ op: 'poke', relative: 'yes' }]), /edits\[0\]\.relative/);
  assert.throws(() => normalizeMeshEdits([{ op: 'symmetrize', keep: 'left' }]), /positive/);
  assert.throws(() => normalizeMeshEdits([{ op: 'dual', select: { all: true } }]), /dual takes: name/);
  assert.throws(() => normalizeMeshEdits([{ op: 'extrude_edges', offset: [0, 1, 0] }]), /edits\[0\]\.edges/);
  for (const name of ['poke', 'dual', 'tris_to_quads', 'symmetrize', 'scale_elements', 'extrude_edges']) {
    assert.ok(MESH_EDIT_OPERATIONS[name], name);
  }
});

test('a poke that would pass the face limit is refused before it allocates', () => {
  const big = meshFromGeometry(cylinder(64, 0, 1));
  assert.throws(() => applyMeshEdits(big, [{ op: 'poke' }], { maxFaces: 100 }), /edits\[0\]\.select.*within 100 faces/s);
});

test('split_edges opens the surface along the chosen edges and is deterministic', () => {
  const { mesh, results } = run(cube(), [{ op: 'split_edges', edges: { all: true } }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [24, 6]);
  assert.equal(results[0].addedVertices, 16);
  assert.equal(tagCounts(mesh).top, 1);
  assert.equal(lintMesh(mesh).parts.closed, 0);
  assert.ok(Math.abs(volume(mesh) - 1) < 1e-9);
  sameBytes(mesh, run(cube(), [{ op: 'split_edges', edges: { all: true } }]).mesh);
});

test('split_edges refuses a rule with no shared edge', () => {
  assert.throws(() => run(openCube(), [{ op: 'split_edges', edges: { open: true } }]), /selects no edge shared by two faces/);
  assert.throws(() => normalizeMeshEdits([{ op: 'split_edges' }]), /edits\[0\]\.edges/);
});

test('delete_loose drops vertices no face uses', () => {
  const base = cube();
  const withLoose = createMeshData({
    positions: Float32Array.from([...base.positions, 5, 5, 5]),
    faceOffsets: base.faceOffsets, cornerVertices: base.cornerVertices,
    edgeVertices: base.edgeVertices, cornerEdges: base.cornerEdges, attributes: base.attributes,
  });
  assert.equal(lintMesh(withLoose).problems.some(problem => problem.kind === 'loose-vertex'), true);
  const { mesh, results } = run(withLoose, [{ op: 'delete_loose' }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [8, 6]);
  assert.equal(results[0].removedVertices, 1);
  assertClosed(mesh);
  assert.throws(() => run(cube(), [{ op: 'delete_loose' }]), /no loose vertex/);
});

test('flatten moves the selected vertices onto a plane', () => {
  const bumped = run(cube(), [{ op: 'translate', select: { tag: 'top' }, offset: [0, 0.2, 0] }]).mesh;
  const flatten = [{ op: 'flatten', verts: { all: true }, normal: [0, 1, 0] }];
  const { mesh, results } = run(bumped, flatten);
  assert.equal(results[0].flattenedVertices, 8);
  const heights = new Set();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) heights.add(mesh.positions[vertex * 3 + 1].toFixed(5));
  assert.equal(heights.size, 1);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [8, 6]);
  sameBytes(mesh, run(bumped, flatten).mesh);
  const half = run(cube(), [{ op: 'flatten', verts: { all: true }, normal: [0, 1, 0], factor: 0.5 }]).mesh;
  assert.ok(Math.abs(Math.abs(half.positions[1]) - 0.25) < 1e-6);
});

test('flatten validates its fields', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'flatten' }]), /edits\[0\]\.verts/);
  assert.throws(() => normalizeMeshEdits([{ op: 'flatten', verts: { all: true }, normal: [0, 0, 0] }]), /edits\[0\]\.normal/);
  assert.throws(() => normalizeMeshEdits([{ op: 'flatten', verts: { all: true }, factor: 2 }]), /edits\[0\]\.factor/);
  assert.throws(() => run(cube(), [{ op: 'flatten', verts: { vertices: [0] } }]), /Pass normal/);
});

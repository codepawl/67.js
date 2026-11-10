import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, lintMesh, tagCounts, applyMeshEdits, meshBounds } from '../src/mesh.js';
import { normalizeMeshEdits, MESH_EDIT_OPERATIONS } from '../src/mesh-recipe.js';

const cube = () => meshFromGeometry(box(0, 1));

function run(mesh, edits) {
  const outcome = applyMeshEdits(mesh, edits);
  validateTopology(editMesh(outcome.mesh));
  return outcome;
}

function assertClosed(mesh, parts = 1) {
  const report = lintMesh(mesh);
  assert.deepEqual(report.problems, []);
  assert.equal(report.parts.closed, parts);
}

const openCube = () => run(cube(), [{ op: 'delete', select: { tag: 'top' } }]).mesh;

test('fill_holes caps an open boundary and tags the cap', () => {
  const { mesh, results } = run(openCube(), [{ op: 'fill_holes', name: 'lid' }]);
  assertClosed(mesh);
  assert.equal(mesh.faceCount, 6);
  assert.equal(tagCounts(mesh)['lid.fill'], 1);
  assert.deepEqual([results[0].filled, results[0].skipped], [1, 0]);
});

test('fill_holes skips loops with more sides than allowed and refuses a closed mesh', () => {
  assert.throws(() => run(openCube(), [{ op: 'fill_holes', sides: 3 }]), /No boundary loop could be filled/);
  assert.throws(() => run(cube(), [{ op: 'fill_holes' }]), /no open boundary/);
});

test('the lint message for an open boundary points at fill_holes', () => {
  const report = lintMesh(openCube());
  assert.match(report.problems.find(problem => problem.kind === 'boundary-edge').fix, /fill_holes/);
});

const sliced = () => run(cube(), [{ op: 'loop_cut', name: 'cut', edges: { along: [0, 1, 0] } }]).mesh;

test('dissolve_edges, dissolve_verts and dissolve_limited undo a loop cut', () => {
  const merged = run(sliced(), [{ op: 'dissolve_edges', name: 'join', edges: { between: [{ tag: 'cut.band-0' }, { tag: 'cut.band-1' }] } }]);
  assert.deepEqual([merged.mesh.vertexCount, merged.mesh.faceCount], [12, 6]);
  assert.equal(tagCounts(merged.mesh)['join.merged'], 4);
  const straightened = run(merged.mesh, [{ op: 'dissolve_verts', verts: { valence: 2 } }]);
  assert.deepEqual([straightened.mesh.vertexCount, straightened.mesh.faceCount], [8, 6]);
  assertClosed(straightened.mesh);
  const limited = run(sliced(), [{ op: 'dissolve_limited', angle: 5 }]);
  assert.deepEqual([limited.mesh.vertexCount, limited.mesh.faceCount], [8, 6]);
  assertClosed(limited.mesh);
});

test('dissolve_faces merges a connected selection into one polygon', () => {
  const { mesh } = run(sliced(), [{ op: 'dissolve_faces', name: 'wall', select: { and: [{ tag: 'side' }, { normal: [1, 0, 0], maxAngle: 5 }] } }]);
  assert.equal(mesh.faceCount, 9);
  assertClosed(mesh);
  assert.throws(() => run(cube(), [{ op: 'dissolve_faces', select: { faces: [0] } }]), /nothing dissolves/);
});

test('bisect_plane cuts, clears one side and fills the cut', () => {
  const half = run(cube(), [{ op: 'bisect_plane', name: 'half', point: [0, 0.1, 0], normal: [0, 1, 0], clearOuter: true, fill: true }]);
  assertClosed(half.mesh);
  assert.equal(tagCounts(half.mesh)['half.cap'], 1);
  assert.ok(Math.abs(meshBounds(half.mesh).max[1] - 0.1) < 1e-6);
  assert.equal(half.results[0].capped, 1);
  const open = run(cube(), [{ op: 'bisect_plane', point: [0, 0, 0], normal: [0, 1, 0], clearInner: true }]);
  assert.equal(lintMesh(open.mesh).problems[0].kind, 'boundary-edge');
});

test('bisect_plane with fill and both sides kept makes two closed shells', () => {
  const { mesh } = run(cube(), [{ op: 'bisect_plane', name: 'split', point: [0, 0, 0], normal: [0, 1, 0], fill: true }]);
  assertClosed(mesh, 2);
  assert.equal(tagCounts(mesh)['split.cap'], 2);
  assert.throws(() => run(cube(), [{ op: 'bisect_plane', point: [0, 5, 0], normal: [0, 1, 0] }]), /does not cross/);
});

test('bridge_edge_loops joins two holes with a strip', () => {
  const tube = run(cube(), [{ op: 'delete', select: { or: [{ tag: 'top' }, { tag: 'bottom' }] } }]).mesh;
  const bridged = run(tube, [{ op: 'bridge_edge_loops', name: 'ring', edges: { open: true }, segments: 2 }]);
  assert.equal(bridged.mesh.faceCount, 4 + 8);
  assert.equal(tagCounts(bridged.mesh)['ring.bridge'], 8);
  assert.equal(lintMesh(bridged.mesh).problems.length, 0);
  assert.throws(() => run(openCube(), [{ op: 'bridge_edge_loops', edges: { open: true } }]), /exactly 2/);
});

test('subdivide_edges grids quads whose edges are all split', () => {
  const { mesh } = run(cube(), [{ op: 'subdivide_edges', name: 'fine', edges: { all: true }, cuts: 2 }]);
  assert.equal(mesh.faceCount, 6 * 9);
  assert.equal(mesh.vertexCount, 8 + 12 * 2 + 6 * 4);
  assertClosed(mesh);
  assert.equal(tagCounts(mesh)['fine.split'], 54);
});

test('subdivide_edges refuses to grow past the limits before allocating', () => {
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'subdivide_edges', edges: { all: true }, cuts: 16 }], { maxFaces: 100 }), /edits\[0\]\.cuts: got 16; expected a number of cuts that keeps the mesh within/);
});

test('grid_fill fills an even loop with quads', () => {
  const round = meshFromGeometry(cylinder(8, 0, 1));
  const opened = run(round, [{ op: 'delete', select: { tag: 'top' } }]).mesh;
  const { mesh } = run(opened, [{ op: 'grid_fill', name: 'cap', edges: { open: true } }]);
  assert.equal(tagCounts(mesh)['cap.fill'], 4);
  assertClosed(mesh);
  assert.throws(() => run(round, [{ op: 'grid_fill', edges: { open: true } }]), /no boundary loop/);
});

test('knife_project cuts every face a projected line crosses', () => {
  const { mesh } = run(cube(), [{ op: 'knife_project', name: 'slit', path: [[-1, 0, 0], [1, 0, 0]], direction: [0, 0, -1] }]);
  assert.deepEqual([mesh.vertexCount, mesh.faceCount], [12, 8]);
  assert.equal(tagCounts(mesh)['slit.cut'], 4);
  assertClosed(mesh);
  assert.throws(() => run(cube(), [{ op: 'knife_project', path: [[5, 5, 0], [6, 5, 0]], direction: [0, 0, -1] }]), /does not cross/);
});

test('knife_project follows a bend and adds points on the face', () => {
  const { mesh } = run(cube(), [{ op: 'knife_project', path: [[-1, -0.25, 0], [0, 0.25, 0], [1, -0.25, 0]], direction: [0, 0, -1] }]);
  assertClosed(mesh);
  assert.ok(mesh.faceCount > 6);
});

test('the cutting edits validate their fields', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'bridge_edge_loops' }]), /edges/);
  assert.throws(() => normalizeMeshEdits([{ op: 'bisect_plane', point: [0, 0, 0], normal: [0, 1, 0], clearInner: true, clearOuter: true }]), /everything/);
  assert.throws(() => normalizeMeshEdits([{ op: 'knife_project', path: [[0, 0, 0]], direction: [0, 0, 1] }]), /path/);
  assert.throws(() => normalizeMeshEdits([{ op: 'subdivide_edges', edges: { all: true }, cuts: 99 }]), /cuts/);
  for (const name of ['fill_holes', 'dissolve_faces', 'dissolve_edges', 'dissolve_verts', 'dissolve_limited', 'bisect_plane', 'bridge_edge_loops', 'subdivide_edges', 'grid_fill', 'knife_project']) {
    assert.ok(MESH_EDIT_OPERATIONS[name], name);
  }
});

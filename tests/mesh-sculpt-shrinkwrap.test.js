import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeshData, applyMeshEdits, normalizeMeshEdits, validateTopology, editMesh, MESH_EDIT_OPERATIONS } from '../src/mesh.js';
import { withFaceAttributes } from '../src/mesh-convert.js';
import { signedVolume } from '../src/mesh-surface-distance.js';
import { sculptGeometry } from '../src/sculpt.js';

function buildMesh(positions, faces, attributes) {
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((face, index) => {
    faceOffsets[index + 1] = faceOffsets[index] + face.length;
  });
  const mesh = createMeshData({ positions: new Float32Array(positions), faceOffsets, cornerVertices: new Uint32Array(faces.flat()) });
  return attributes ? withFaceAttributes(mesh, attributes) : mesh;
}

// A closed sphere of radius 1 as quads with triangle caps.
function sphere(columns = 32, rows = 16) {
  const positions = [0, 0, 1];
  for (let row = 1; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const polar = Math.PI * row / rows;
      const azimuth = 2 * Math.PI * column / columns;
      positions.push(Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar));
    }
  }
  positions.push(0, 0, -1);
  const ring = (row, column) => 1 + (row - 1) * columns + (column % columns);
  const bottom = positions.length / 3 - 1;
  const faces = [];
  for (let column = 0; column < columns; column++) faces.push([0, ring(1, column), ring(1, column + 1)]);
  for (let row = 1; row < rows - 1; row++) {
    for (let column = 0; column < columns; column++) faces.push([ring(row, column), ring(row + 1, column), ring(row + 1, column + 1), ring(row, column + 1)]);
  }
  for (let column = 0; column < columns; column++) faces.push([bottom, ring(rows - 1, column + 1), ring(rows - 1, column)]);
  return buildMesh(positions, faces);
}

// A flat square sheet, x and y from -half to half at height z, split into cells x cells quads.
function sheet(cells, half, height) {
  const positions = [];
  for (let row = 0; row <= cells; row++) {
    for (let column = 0; column <= cells; column++) positions.push(-half + 2 * half * column / cells, -half + 2 * half * row / cells, height);
  }
  const faces = [];
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const corner = row * (cells + 1) + column;
      faces.push([corner, corner + 1, corner + cells + 2, corner + cells + 1]);
    }
  }
  return buildMesh(positions, faces);
}

function tagFacesByHeight(mesh) {
  const data = new Uint8Array(mesh.faceCount);
  for (let face = 0; face < mesh.faceCount; face++) {
    let height = 0;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) height += mesh.positions[mesh.cornerVertices[corner] * 3 + 2];
    data[face] = height > 0 ? 1 : 0;
  }
  return withFaceAttributes(mesh, { 'tag:top': { data, size: 1 } });
}

const SPHERE_TARGET = { type: 'sphere' };
const resolveCutter = () => sphere();

function run(mesh, edits) {
  return applyMeshEdits(mesh, edits, { resolveCutter });
}

function radiusOf(mesh, vertex) {
  return Math.hypot(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
}

test('sculpt inflate moves only the vertices of the selected faces and keeps the topology valid', () => {
  const mesh = tagFacesByHeight(sphere());
  const { mesh: result, results } = run(mesh, [{ op: 'sculpt', select: { tag: 'top' }, strokes: [{ type: 'inflate', center: [0, 0, 1], radius: 0.6, strength: 0.2 }] }]);
  validateTopology(editMesh(result));
  assert.ok(results[0].movedVertices > 0);
  assert.ok(signedVolume(result) > signedVolume(mesh));
  assert.ok(radiusOf(result, 0) > 1.19, 'the pole moves out by the stroke strength');
  const bottom = result.vertexCount - 1;
  assert.equal(radiusOf(result, bottom), radiusOf(mesh, bottom));
  assert.equal(result.faceCount, mesh.faceCount);
});

test('sculpt displace and smooth strokes change the surface, and smooth lowers the bump', () => {
  const mesh = sphere();
  const bumped = run(mesh, [{ op: 'sculpt', strokes: [{ type: 'displace', center: [0, 0, 1], radius: 0.7, strength: 0.3, direction: [0, 0, 1] }] }]).mesh;
  const smoothed = run(bumped, [{ op: 'sculpt', strokes: [{ type: 'smooth', center: [0, 0, 1.3], radius: 0.9, strength: 1 }] }]).mesh;
  assert.ok(Math.abs(radiusOf(bumped, 0) - 1.3) < 1e-5);
  assert.ok(radiusOf(smoothed, 0) < radiusOf(bumped, 0));
  validateTopology(editMesh(smoothed));
});

test('sculpt gives the same bytes every time', () => {
  const edits = [{ op: 'sculpt', strokes: [{ type: 'inflate', center: [1, 0, 0], radius: 0.8, strength: 0.15 }, { type: 'smooth', center: [1, 0, 0], radius: 0.5, strength: 0.5 }] }];
  const first = run(sphere(), edits).mesh;
  const second = run(sphere(), edits).mesh;
  assert.deepEqual(Array.from(first.positions), Array.from(second.positions));
});

test('the shared stroke maths still serves sculptGeometry', () => {
  const triangle = { positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), indices: Uint32Array.of(0, 1, 2) };
  const moved = sculptGeometry(triangle, [{ type: 'inflate', center: [0, 0, 0], radius: 2, strength: 0.1 }]);
  assert.ok(moved.positions[2] > 0);
  assert.throws(() => sculptGeometry(triangle, [{ type: 'smooth', center: [0, 0, 0], radius: 1, strength: 2 }]), RangeError);
});

test('sculpt refuses hostile strokes before running them', () => {
  const stroke = { type: 'inflate', center: [0, 0, 1], radius: 0.5, strength: 0.1 };
  const bad = [
    { strokes: [] },
    { strokes: Array.from({ length: 33 }, () => stroke) },
    { strokes: 'inflate' },
    { strokes: [{ ...stroke, type: 'pinch' }] },
    { strokes: [{ ...stroke, radius: 0 }] },
    { strokes: [{ ...stroke, radius: -1 }] },
    { strokes: [{ ...stroke, strength: Number.NaN }] },
    { strokes: [{ ...stroke, strength: Infinity }] },
    { strokes: [{ ...stroke, center: [0, 0] }] },
    { strokes: [{ ...stroke, center: [0, 0, 1e9] }] },
    { strokes: [{ ...stroke, direction: [0, 0, 1] }] },
    { strokes: [{ type: 'displace', center: [0, 0, 1], radius: 1, strength: 1 }] },
    { strokes: [{ type: 'displace', center: [0, 0, 1], radius: 1, strength: 1, direction: [0, 0, 0] }] },
    { strokes: [{ type: 'smooth', center: [0, 0, 1], radius: 1, strength: 1.5 }] },
    { strokes: [{ ...stroke, extra: 1 }] },
    { strokes: [null] },
    { strokes: [stroke], alsoThis: true },
  ];
  for (const edit of bad) assert.throws(() => normalizeMeshEdits([{ op: 'sculpt', ...edit }]), /Mesh edit 0|does not take|edits\[0\]\./, JSON.stringify(edit).slice(0, 80));
});

test('sculpt stops when the vertex visits would be too many', () => {
  const dense = sphere(1000, 1000);
  const stroke = { type: 'inflate', center: [0, 0, 1], radius: 0.5, strength: 0.1 };
  assert.throws(() => run(dense, [{ op: 'sculpt', strokes: Array.from({ length: 8 }, () => stroke) }]), /too many vertices/);
});

test('shrinkwrap nearest puts a flat sheet on the target with an offset', () => {
  const { mesh: result, results } = run(sheet(8, 0.5, 1.5), [{ op: 'shrinkwrap', target: SPHERE_TARGET, offset: 0.01 }]);
  validateTopology(editMesh(result));
  assert.equal(results[0].movedVertices, 81);
  for (let vertex = 0; vertex < result.vertexCount; vertex++) {
    const distance = radiusOf(result, vertex);
    assert.ok(distance > 0.98 && distance < 1.02, `vertex ${vertex} sits ${distance} from the centre`);
    assert.ok(result.positions[vertex * 3 + 2] > 0.8, 'the sheet stays on the side it started');
  }
});

test('shrinkwrap project follows a direction and honours placement and select', () => {
  const sheetMesh = sheet(6, 0.4, 3);
  const projected = run(sheetMesh, [{ op: 'shrinkwrap', target: SPHERE_TARGET, mode: 'project', direction: [0, 0, -1] }]).mesh;
  for (let vertex = 0; vertex < projected.vertexCount; vertex++) {
    assert.equal(projected.positions[vertex * 3], sheetMesh.positions[vertex * 3]);
    assert.equal(projected.positions[vertex * 3 + 1], sheetMesh.positions[vertex * 3 + 1]);
    assert.ok(Math.abs(radiusOf(projected, vertex) - 1) < 0.02);
  }
  const scaled = run(sheetMesh, [{ op: 'shrinkwrap', target: SPHERE_TARGET, scale: [2, 2, 2], mode: 'project', direction: [0, 0, -1] }]).mesh;
  assert.ok(scaled.positions[2] > projected.positions[2] + 0.5, 'a larger target catches the sheet higher up');
  const partial = tagFacesByHeight(sheetMesh);
  const none = run(partial, [{ op: 'shrinkwrap', select: { tag: 'top' }, target: SPHERE_TARGET }]);
  assert.equal(none.results[0].movedVertices, partial.vertexCount);
});

test('shrinkwrap misses are an error or kept in place, and maxDistance bounds the search', () => {
  const far = sheet(4, 0.4, 5);
  assert.throws(() => run(far, [{ op: 'shrinkwrap', target: SPHERE_TARGET, maxDistance: 1 }]), /^RangeError: edits\[0\]\.onMiss: got "error"; expected "keep", such as onMiss "keep", to leave vertices that find no surface in place/);
  const kept = run(far, [{ op: 'shrinkwrap', target: SPHERE_TARGET, maxDistance: 1, onMiss: 'keep' }]);
  assert.equal(kept.results[0].missedVertices, 25);
  assert.equal(kept.results[0].movedVertices, 0);
  assert.deepEqual(Array.from(kept.mesh.positions), Array.from(far.positions));
  assert.throws(() => run(far, [{ op: 'shrinkwrap', target: SPHERE_TARGET, mode: 'project', direction: [1, 0, 0] }]), /no surface/);
});

test('shrinkwrap gives the same bytes every time', () => {
  const edits = [{ op: 'shrinkwrap', target: SPHERE_TARGET, offset: 0.02 }];
  const first = run(sheet(10, 0.6, 1.4), edits).mesh;
  const second = run(sheet(10, 0.6, 1.4), edits).mesh;
  assert.deepEqual(Array.from(first.positions), Array.from(second.positions));
});

test('shrinkwrap refuses hostile fields before running them', () => {
  const base = { op: 'shrinkwrap', target: SPHERE_TARGET };
  const bad = [
    { target: undefined },
    { target: 'sphere' },
    { target: [] },
    { target: {} },
    { mode: 'slide' },
    { mode: 'project' },
    { mode: 'project', direction: [0, 0, 0] },
    { mode: 'project', direction: [0, 1] },
    { mode: 'project', direction: [0, Number.NaN, 1] },
    { direction: [0, 0, 1] },
    { offset: -1 },
    { offset: Infinity },
    { offset: '1' },
    { maxDistance: -1 },
    { maxDistance: Number.NaN },
    { onMiss: 'ignore' },
    { scale: [0, 1, 1] },
    { scale: [1, 1] },
    { rotation: [0, 0, 0, 0] },
    { translation: [1e9, 0, 0] },
    { colour: 'red' },
  ];
  for (const change of bad) assert.throws(() => normalizeMeshEdits([{ ...base, ...change }]), /Mesh edit 0|does not take|edits\[0\]\./, JSON.stringify(change));
  assert.throws(() => applyMeshEdits(sheet(2, 0.5, 1.5), [base]), /target resolver/);
});

test('both edits are in the vocabulary agents read', () => {
  assert.ok(MESH_EDIT_OPERATIONS.sculpt.fields.includes('strokes'));
  assert.ok(MESH_EDIT_OPERATIONS.shrinkwrap.fields.includes('target'));
});

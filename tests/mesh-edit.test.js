import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, sphere, cylinder } from '../src/geometry.js';
import {
  createMeshData, editMesh, validateTopology, meshFromGeometry, lintMesh, facesWithTag, extractRender, meshBounds,
} from '../src/mesh.js';
import { selectFaces, countSelected } from '../src/mesh-select.js';
import { applyMeshEdits, normalizeMeshEdits } from '../src/mesh-recipe.js';
import { createAgentScene } from '../src/agent-scene.js';

const cube = () => meshFromGeometry(box(0, 1));

function quadPlane() {
  return createMeshData({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]),
    faceOffsets: new Uint32Array([0, 4]),
    cornerVertices: new Uint32Array([0, 1, 2, 3]),
  });
}

function edited(mesh, edits) {
  const result = applyMeshEdits(mesh, edits);
  validateTopology(editMesh(result.mesh));
  return result;
}

test('selection rules combine tags, normals, regions and growth', () => {
  const mesh = cube();
  assert.equal(countSelected(selectFaces(mesh, { all: true })), 6);
  assert.equal(countSelected(selectFaces(mesh, { tag: 'side' })), 4);
  assert.equal(countSelected(selectFaces(mesh, { normal: [0, 1, 0], maxAngle: 1 })), 1);
  assert.equal(countSelected(selectFaces(mesh, { normal: [1, 1, 0], maxAngle: 46 })), 2);
  assert.equal(countSelected(selectFaces(mesh, { inside: { min: [0.4, -1, -1], max: [1, 1, 1] } })), 1);
  assert.equal(countSelected(selectFaces(mesh, { and: [{ tag: 'side' }, { not: { tag: 'front' } }] })), 3);
  assert.equal(countSelected(selectFaces(mesh, { or: [{ tag: 'top' }, { tag: 'bottom' }] })), 2);
  assert.equal(countSelected(selectFaces(mesh, { grow: { tag: 'top' } })), 5);
  assert.equal(countSelected(selectFaces(mesh, { boundary: { or: [{ tag: 'top' }, { tag: 'front' }] } })), 2);
  assert.throws(() => selectFaces(mesh, { tag: 'lid' }), /Unknown tag lid\. Known tags: .*top/);
  assert.throws(() => selectFaces(mesh, { colour: 'red' }), /use one of/);
  assert.throws(() => selectFaces(mesh, { faces: [6] }), /outside 0\.\.5/);
  assert.throws(() => selectFaces(mesh, { normal: [0, 1, 0], radius: 2 }), /unknown fields radius/);
});

test('extrude_face_region on a closed box keeps it closed and moves the cap along the normal', () => {
  const { mesh, results } = edited(cube(), [{ op: 'extrude_face_region', select: { tag: 'top' }, offset: 0.5, name: 'tower' }]);
  assert.deepEqual([mesh.vertexCount, mesh.edgeCount, mesh.faceCount], [12, 20, 10]);
  assert.deepEqual(results[0].tags, { 'tower.cap': 1, 'tower.side': 4 });
  assert.equal(meshBounds(mesh).max[1], 1);
  const report = lintMesh(mesh);
  assert.equal(report.ok, true);
  assert.equal(report.parts.closed, 1);
  assert.deepEqual(facesWithTag(mesh, 'top'), facesWithTag(mesh, 'tower.cap'), 'the cap keeps its old tags');
  for (const face of facesWithTag(mesh, 'tower.side')) {
    assert.ok(!facesWithTag(mesh, 'top').includes(face), 'side faces do not inherit base tags');
  }
});

test('extruding a plane gives an open box with outward sides', () => {
  const { mesh } = edited(quadPlane(), [{ op: 'extrude_face_region', offset: 1 }]);
  assert.equal(mesh.faceCount, 5);
  const report = lintMesh(mesh);
  assert.equal(report.problems.length, 1);
  assert.equal(report.problems[0].kind, 'boundary-edge');
  const { geometry } = extractRender(mesh, { sharpAngle: Math.PI / 6 });
  // Sides point away from the centre: their normals agree with the direction from the centre to their vertices.
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    const normal = geometry.normals.subarray(vertex * 3, vertex * 3 + 3);
    if (Math.abs(normal[1]) > 0.5) continue;
    const outward = (geometry.positions[vertex * 3] - 0.5) * normal[0] + (geometry.positions[vertex * 3 + 2] + 0.5) * normal[2];
    assert.ok(outward > 0);
  }
});

test('extrude_face_region extrudes separate groups separately and refuses cancelling regions', () => {
  const { mesh, results } = edited(cube(), [{ op: 'extrude_face_region', select: { or: [{ tag: 'left' }, { tag: 'right' }] }, offset: 0.25 }]);
  assert.deepEqual(results[0].tags, { 'extrude-1.cap': 2, 'extrude-1.side': 8 });
  const bounds = meshBounds(mesh);
  assert.deepEqual([bounds.min[0], bounds.max[0]], [-0.75, 0.75]);
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'extrude_face_region', select: { tag: 'side' }, offset: 1 }]), /extrude_individual/);
  const along = edited(cube(), [{ op: 'extrude_face_region', select: { tag: 'side' }, offset: 1, direction: [0, 1, 0] }]);
  assert.equal(meshBounds(along.mesh).max[1], 1.5);
});

test('extrude_individual and inset_individual handle every face on its own', () => {
  const panels = edited(cube(), [
    { op: 'inset_individual', select: { tag: 'side' }, thickness: 0.1, name: 'panel' },
    { op: 'extrude_individual', select: { tag: 'panel.cap' }, offset: -0.05, name: 'recess' },
  ]);
  assert.deepEqual(panels.results.map(result => result.tags), [
    { 'panel.cap': 4, 'panel.rim': 16 },
    { 'recess.cap': 4, 'recess.side': 16 },
  ]);
  const report = lintMesh(panels.mesh);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.parts.closed, 1);
  const bounds = meshBounds(panels.mesh);
  assert.deepEqual(bounds.max.map(value => Math.round(value * 1e5) / 1e5), [0.5, 0.5, 0.5], 'recesses stay inside the box');
});

test('inset_region keeps an even rim and depth moves the inner face', () => {
  const { mesh } = edited(cube(), [{ op: 'inset_region', select: { tag: 'top' }, thickness: 0.1, depth: -0.2, name: 'well' }]);
  const cap = facesWithTag(mesh, 'well.cap')[0];
  const xs = [];
  for (let corner = mesh.faceOffsets[cap]; corner < mesh.faceOffsets[cap + 1]; corner++) {
    const vertex = mesh.cornerVertices[corner];
    xs.push(Math.abs(mesh.positions[vertex * 3]));
    assert.ok(Math.abs(mesh.positions[vertex * 3 + 1] - 0.3) < 1e-6, 'depth moves the cap down');
  }
  assert.ok(xs.every(value => Math.abs(value - 0.4) < 1e-6), 'corners sit thickness away from both edges');
  assert.equal(lintMesh(mesh).ok, true);
});

test('delete, flip_normals and merge_by_distance report what they changed', () => {
  const opened = edited(cube(), [{ op: 'delete', select: { tag: 'top' } }]);
  assert.equal(opened.results[0].deletedFaces, 1);
  assert.equal(lintMesh(opened.mesh).problems[0].kind, 'boundary-edge');
  const flipped = edited(cube(), [{ op: 'flip_normals' }]);
  assert.equal(lintMesh(flipped.mesh).problems[0].kind, 'inverted-part');
  const twice = edited(cube(), [{ op: 'flip_normals', select: { tag: 'top' } }]);
  assert.ok(lintMesh(twice.mesh).problems.some(problem => problem.kind === 'inconsistent-winding'));
  const loose = meshFromGeometry(box(0, 1), { weld: 0 });
  const merged = applyMeshEdits(loose, [{ op: 'merge_by_distance', distance: 1e-4 }]);
  assert.equal(merged.results[0].removedVertices, 0, 'already welded');
  const split = createMeshData({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1, 1.00001, 0, 0, 2, 0, 0, 2, 0, -1, 1.00001, 0, -1]),
    faceOffsets: new Uint32Array([0, 4, 8]),
    cornerVertices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
  });
  const welded = edited(split, [{ op: 'merge_by_distance', distance: 1e-3 }]);
  assert.equal(welded.results[0].removedVertices, 2);
  assert.equal(welded.mesh.edgeCount, 7);
});

test('translate with connected falloff moves nearby vertices less', () => {
  const mesh = meshFromGeometry(sphere(16, 8));
  const { mesh: moved } = edited(mesh, [
    { op: 'translate', select: { normal: [0, 1, 0], maxAngle: 30 }, offset: [0, 0.5, 0], falloff: { radius: 1, curve: 'smooth', connected: true } },
  ]);
  const before = meshBounds(mesh);
  const after = meshBounds(moved);
  assert.ok(Math.abs(after.max[1] - before.max[1] - 0.5) < 1e-6);
  assert.ok(Math.abs(after.min[1] - before.min[1]) < 1e-6, 'the far pole stays put');
  let partlyMoved = 0;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const delta = moved.positions[vertex * 3 + 1] - mesh.positions[vertex * 3 + 1];
    if (delta > 1e-4 && delta < 0.499) partlyMoved++;
  }
  assert.ok(partlyMoved > 0);
});

test('edit validation names the op, field and allowed values', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'knife' }]), /edits\[0\]\.op: got "knife"; expected one of extrude_face_region/);
  assert.throws(() => normalizeMeshEdits([{ op: 'extrude_individual', offset: 1, depth: 2 }]), /does not take depth/);
  assert.throws(() => normalizeMeshEdits([{ op: 'inset_region', thickness: 0 }]), /edits\[0\]\.thickness: got 0; expected a number above 0/);
  assert.throws(() => normalizeMeshEdits([{ op: 'delete' }]), /delete needs select/);
  assert.throws(() => normalizeMeshEdits([{ op: 'tag', select: { all: true }, name: 'bad name' }]), /edits\[0\]\.name: got "bad name"; expected 1 to 48 letters/);
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', offset: [0, 1, 0], falloff: { radius: 1, curve: 'wobbly' } }]), /edits\[0\]\.falloff\.curve: got "wobbly"; expected one of smooth/);
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'extrude_individual', select: { tag: 'top' }, offset: 1 }, { op: 'delete', select: { faces: [99] } }]), /Mesh edit 1 \(delete\): Face index 99/);
  assert.throws(() => applyMeshEdits(cube(), Array.from({ length: 8 }, () => ({ op: 'extrude_individual', offset: 0.1 })), { maxFaces: 1000 }), /over the limit/);
});

test('random edit sequences keep a valid topology', () => {
  let seed = 11;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const operations = [
    () => ({ op: 'extrude_individual', select: { faces: [] }, offset: random() - 0.3 }),
    () => ({ op: 'inset_individual', select: { faces: [] }, thickness: 0.02 + random() * 0.05 }),
    () => ({ op: 'extrude_face_region', select: { faces: [] }, offset: random() * 0.2, direction: [0, 1, 0] }),
    () => ({ op: 'translate', select: { faces: [] }, offset: [0, random() * 0.1, 0], falloff: { radius: 0.3, connected: true } }),
  ];
  let mesh = meshFromGeometry(cylinder(12, 0.05, 2));
  for (let step = 0; step < 30; step++) {
    const edit = operations[Math.floor(random() * operations.length)]();
    const count = 1 + Math.floor(random() * 3);
    edit.select = { faces: Array.from({ length: count }, () => Math.floor(random() * mesh.faceCount)) };
    mesh = applyMeshEdits(mesh, [edit], { maxVertices: 1_000_000, maxFaces: 1_000_000 }).mesh;
    validateTopology(editMesh(mesh));
    assert.equal(lintMesh(mesh).problems.filter(problem => problem.kind === 'non-manifold-edge').length, 0);
  }
});

test('recipe mesh geometry renders, reports edits and rejects bad edits atomically', () => {
  const scene = createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'crate', type: 'mesh', base: { type: 'box', bevel: 0 }, smoothAngle: 30, edits: [
      { op: 'inset_individual', select: { tag: 'side' }, thickness: 0.06, name: 'panel' },
    ] }],
    materials: [{ id: 'wood', color: [0.6, 0.4, 0.2] }],
    nodes: [{ id: 'crate', geometry: 'crate', material: 'wood' }],
  });
  const [report] = scene.inspectMeshes().meshes;
  assert.equal(report.counts.faces, 22, 'mesh_inspect reports the polygon mesh, not re-welded triangles');
  assert.equal(report.edits[0].tags['panel.cap'], 4);
  scene.apply([{ type: 'edit-mesh', geometry: 'crate', edits: [{ op: 'extrude_individual', select: { tag: 'panel.cap' }, offset: -0.03 }] }], { expectedRevision: 0 });
  assert.equal(scene.revision, 1);
  assert.throws(() => scene.apply([{ type: 'edit-mesh', geometry: 'crate', edits: [{ op: 'delete', select: { tag: 'nope' } }] }], { expectedRevision: 1 }), /Unknown tag nope/);
  assert.equal(scene.revision, 1);
  assert.equal(scene.exportRecipe().geometries[0].edits.length, 2);
  assert.throws(() => createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'plain', type: 'box', bevel: 0 }, { id: 'nested', type: 'mesh', base: { type: 'mesh', base: { type: 'box' } } }],
    materials: [], nodes: [],
  }), /geometries\[1\]\.base: got .*expected a primitive or profile record without an id/);
  const plain = createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [{ id: 'plain', type: 'box', bevel: 0 }], materials: [], nodes: [] });
  assert.throws(() => plain.apply([{ type: 'edit-mesh', geometry: 'plain', edits: [] }], { expectedRevision: 0 }), /geometry: got "plain"; expected the ID of a mesh geometry, but it is a box\. Add a mesh geometry with base/);
});

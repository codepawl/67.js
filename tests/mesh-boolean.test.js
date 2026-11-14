import './support/load-agent-scene-modules.mjs';
import { GEOMETRY_PROBLEMS } from '../src/mesh-lint.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder, sphere } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, lintMesh, meshBounds, facesWithTag } from '../src/mesh.js';
import { loadMeshBooleans, meshBoolean } from '../src/mesh-boolean.js';
import { applyMeshEdits, transformMesh } from '../src/mesh-recipe.js';
import { createAgentScene } from '../src/agent-scene.js';

await loadMeshBooleans();

function signedVolume(mesh) {
  let volume = 0;
  const p = mesh.positions;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const a = mesh.cornerVertices[start] * 3;
    for (let corner = start + 1; corner + 1 < mesh.faceOffsets[face + 1]; corner++) {
      const b = mesh.cornerVertices[corner] * 3;
      const c = mesh.cornerVertices[corner + 1] * 3;
      volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
  }
  return volume;
}

const cube = () => meshFromGeometry(box(0, 1));
const cutterFrom = geometry => meshFromGeometry(geometry);
const resolveCutter = record => {
  if (record.type === 'box') return cutterFrom(box(record.bevel ?? 0, record.subdivisions ?? 1));
  if (record.type === 'cylinder') return cutterFrom(cylinder(record.segments ?? 32, record.bevel ?? 0, 1));
  if (record.type === 'sphere') return cutterFrom(sphere(record.segments ?? 32, record.rings ?? 16));
  throw new RangeError(`no cutter ${record.type}`);
};

test('difference, union and intersect of two overlapping boxes have the expected volumes', () => {
  const shifted = transformMesh(cube(), { translation: [0.5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  const expected = { difference: 0.5, union: 1.5, intersect: 0.5 };
  for (const [operation, volume] of Object.entries(expected)) {
    const { mesh } = meshBoolean(cube(), shifted, operation, { cutTag: 'cut' });
    validateTopology(editMesh(mesh));
    assert.ok(Math.abs(signedVolume(mesh) - volume) < 1e-5, `${operation} volume ${signedVolume(mesh)}`);
    const report = lintMesh(mesh);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.parts.closed, 1);
    assert.ok(mesh.faceCount <= 10, `${operation} rebuilds flat faces as polygons, got ${mesh.faceCount}`);
  }
});

test('drilling a hole keeps the original tags and tags the cut walls', () => {
  const { mesh, results } = applyMeshEdits(cube(), [
    { op: 'boolean', operation: 'difference', name: 'hole', cutter: { type: 'cylinder', segments: 24 }, scale: [0.25, 2, 0.25] },
  ], { resolveCutter });
  assert.equal(results[0].operation, 'difference');
  assert.equal(results[0].tags['hole.cut'], 24);
  assert.equal(facesWithTag(mesh, 'hole.cut').length, 24);
  assert.ok(facesWithTag(mesh, 'top').length >= 1);
  const report = lintMesh(mesh);
  assert.equal(report.ok, true);
  assert.equal(report.parts.closed, 1);
  const holeArea = Math.PI * 0.25 ** 2;
  assert.ok(Math.abs(signedVolume(mesh) - (1 - holeArea)) < 0.01, 'volume matches a cube minus a 24-sided hole');
});

test('a cutter inside the mesh leaves a cavity that lint accepts', () => {
  const { mesh } = applyMeshEdits(meshFromGeometry(sphere(32, 16)), [
    { op: 'boolean', operation: 'difference', cutter: { type: 'box' }, scale: [0.5, 0.5, 0.5] },
  ], { resolveCutter });
  const report = lintMesh(mesh);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.parts.count, 2);
  assert.equal(report.parts.cavities, 1);
  const inverted = applyMeshEdits(mesh, [{ op: 'flip_normals' }]).mesh;
  assert.ok(lintMesh(inverted).problems.some(problem => problem.kind === 'inverted-part'), 'an inside-out shell outside any part is still an error');
});

test('rotation and translation place the cutter', () => {
  const rotated = transformMesh(cube(), { translation: [1, 2, 3], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 1, 1] });
  const bounds = meshBounds(rotated);
  assert.deepEqual(bounds.min.map(value => Math.round(value * 1e5) / 1e5), [0.5, 1.5, 2]);
  assert.deepEqual(bounds.max.map(value => Math.round(value * 1e5) / 1e5), [1.5, 2.5, 4]);
});

test('boolean errors explain open inputs, empty results and bad fields', () => {
  const open = applyMeshEdits(cube(), [{ op: 'delete', select: { tag: 'top' } }]).mesh;
  assert.throws(() => meshBoolean(open, cube(), 'union'), /must be closed for a boolean: 4 boundary-edge/);
  assert.throws(() => meshBoolean(cube(), transformMesh(cube(), { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }), 'intersect'), /leaves nothing/);
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'boolean', operation: 'xor', cutter: { type: 'box' } }], { resolveCutter }), /edits\[0\]\.operation: got "xor"; expected one of union/);
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'boolean', operation: 'union', cutter: { type: 'box' }, scale: [1, -1, 1] }], { resolveCutter }), /edits\[0\]\.scale: got \[1,-1,1\]; expected three numbers above 0/);
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'boolean', operation: 'union', cutter: { type: 'box' } }]), /needs a cutter resolver/);
});

test('chained booleans with coplanar contact stay closed', () => {
  // Regression: Manifold keeps several property vertices at one position; polygons must be rebuilt on welded ones.
  let mesh = cube();
  const steps = [
    { op: 'translate', select: { tag: 'top' }, offset: [0, -0.5, 0] },
    { op: 'boolean', operation: 'difference', name: 'bore', cutter: { type: 'cylinder', segments: 48 }, scale: [0.28, 2, 0.28] },
    { op: 'boolean', operation: 'union', name: 'boss', cutter: { type: 'cylinder', segments: 48 }, translation: [0, 0.15, 0], scale: [0.42, 0.3, 0.42] },
    { op: 'boolean', operation: 'difference', name: 'bore2', cutter: { type: 'cylinder', segments: 48 }, scale: [0.28, 2, 0.28] },
  ];
  for (const step of steps) {
    mesh = applyMeshEdits(mesh, [step], { resolveCutter }).mesh;
    validateTopology(editMesh(mesh));
    const report = lintMesh(mesh);
    assert.equal(report.ok, true, `${step.name ?? step.op}: ${JSON.stringify(report.problems)}`);
    assert.deepEqual(report.problems.filter(problem => !(problem.kind in GEOMETRY_PROBLEMS)), []);
  }
});

test('recipe meshes run booleans with inline primitive cutters', () => {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
      { op: 'boolean', operation: 'difference', name: 'bore', cutter: { type: 'cylinder', segments: 32, bevel: 0 }, scale: [0.3, 2, 0.3] },
      { op: 'boolean', operation: 'union', name: 'boss', cutter: { type: 'sphere', segments: 24, rings: 12 }, translation: [0.5, 0, 0], scale: [0.3, 0.3, 0.3] },
    ] }],
    materials: [{ id: 'steel', color: [0.7, 0.7, 0.72] }],
    nodes: [{ id: 'block', geometry: 'block', material: 'steel' }],
  });
  const [report] = scene.inspectMeshes().meshes;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.parts.closed, 1);
  assert.equal(report.edits.length, 2);
  assert.ok(report.edits[0].tags['bore.cut'] > 0);
  assert.ok(report.edits[1].tags['boss.cut'] > 0);
  assert.ok(Math.abs(report.bounds.max[0] - 0.8) < 1e-3);
  assert.throws(() => createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'bad', type: 'mesh', base: { type: 'box' }, edits: [{ op: 'boolean', operation: 'union', cutter: { type: 'box', id: 'x' } }] }],
    materials: [], nodes: [],
  }), /geometries\[0\]\.cutter: got \{"type":"box","id":"x"\}; expected a primitive or profile record without an id/);
});

import './support/load-agent-scene-modules.mjs';
import { GEOMETRY_PROBLEMS } from '../src/mesh-lint.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, lintMesh, meshBounds, tagCounts, applyMeshEdits } from '../src/mesh.js';
import { bevelEdges, selectEdges, edgeFaces } from '../src/mesh-bevel.js';
import { normalizeMeshEdits } from '../src/mesh-recipe.js';
import { createAgentScene } from '../src/agent-scene.js';

const cube = () => meshFromGeometry(box(0, 1));

// Interior profile points at one end of the corner at x = y = 0.5, as fractions of the width from the corner.
function profileFractions(profile) {
  const width = 0.1;
  const { mesh } = bevelEdges(cube(), { along: [0, 0, 1] }, { width, segments: 3, profile });
  const fractions = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const [x, y, z] = mesh.positions.subarray(vertex * 3, vertex * 3 + 3);
    if (z < 0.49 || x < 0.39 || y < 0.39) continue;
    const across = (0.5 - x) / width;
    const along = (0.5 - y) / width;
    const isSlidePoint = across > 0.999 || along > 0.999;
    if (!isSlidePoint) fractions.push([across, along]);
  }
  assert.equal(fractions.length, 2);
  return fractions;
}

test('the bevel profile has the meaning it has in Blender', () => {
  for (const [across, along] of profileFractions(0.25)) assert.ok(Math.abs(across + along - 1) < 1e-5, 'flat at 0.25');
  for (const [across, along] of profileFractions(0.5)) assert.ok(Math.abs((1 - across) ** 2 + (1 - along) ** 2 - 1) < 1e-5, 'a circle at 0.5');
  for (const [across, along] of profileFractions(1)) assert.ok(across < 1e-5 && along < 1e-5, 'square at 1');
  for (const [across, along] of profileFractions(0.1)) assert.ok(across + along > 1, 'concave below 0.25');
});

test('a beveled edge that ends at a three-faced vertex adds its points to the third face, with no fan', () => {
  const { mesh, cornerFaces } = bevelEdges(cube(), { along: [0, 0, 1] }, { width: 0.1, segments: 2 });
  assert.equal(cornerFaces, 0);
  assert.deepEqual([mesh.vertexCount, mesh.edgeCount, mesh.faceCount], [24, 36, 14]);
  validateTopology(editMesh(mesh));
  assert.equal(lintMesh(mesh).ok, true);
});

function volume(mesh) {
  let total = 0;
  const p = mesh.positions;
  for (let face = 0; face < mesh.faceCount; face++) {
    const start = mesh.faceOffsets[face];
    const a = mesh.cornerVertices[start] * 3;
    for (let corner = start + 1; corner + 1 < mesh.faceOffsets[face + 1]; corner++) {
      const b = mesh.cornerVertices[corner] * 3;
      const c = mesh.cornerVertices[corner + 1] * 3;
      total += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
  }
  return total;
}

function closed(mesh) {
  validateTopology(editMesh(mesh));
  const report = lintMesh(mesh);
  assert.deepEqual(report.problems.filter(problem => !(problem.kind in GEOMETRY_PROBLEMS)), []);
  assert.equal(report.parts.closed, 1);
  return report;
}

test('edge rules select rims, sharp edges, region borders and everything', () => {
  const mesh = cube();
  const table = edgeFaces(mesh);
  const count = rule => selectEdges(mesh, rule, table).reduce((sum, value) => sum + value, 0);
  assert.equal(count({ between: [{ tag: 'top' }, { tag: 'side' }] }), 4);
  assert.equal(count({ angle: 30 }), 12);
  assert.equal(count({ angle: 91 }), 0);
  assert.equal(count({ boundaryOf: { tag: 'front' } }), 4);
  assert.equal(count({ all: true }), 12);
  assert.throws(() => selectEdges(mesh, { angle: 30, all: true }, table), /exactly one/);
});

test('chamfering one edge removes exactly the triangular prism', () => {
  const { mesh, bevelEdges: edges, stripFaces } = bevelEdges(cube(), { between: [{ tag: 'front' }, { tag: 'right' }] }, { width: 0.2 });
  closed(mesh);
  assert.equal(edges, 1);
  assert.equal(stripFaces, 1);
  assert.ok(Math.abs(volume(mesh) - (1 - 0.5 * 0.2 * 0.2)) < 1e-6);
});

test('rounded rim keeps the box closed, keeps base tags and tags strips', () => {
  const { mesh, stripFaces, cornerFaces } = bevelEdges(cube(), { between: [{ tag: 'top' }, { tag: 'side' }] }, { width: 0.1, segments: 4, name: 'rim' });
  closed(mesh);
  assert.equal(stripFaces, 16);
  assert.equal(cornerFaces, 0, 'a rim meets the unbeveled vertical edges, so no corner fills are needed');
  const tags = tagCounts(mesh);
  assert.equal(tags['rim.strip'], 16);
  assert.equal(tags.top, 1);
  assert.equal(tags.side, 4);
  const volumeRound = volume(mesh);
  assert.ok(volumeRound > 1 - 4 * 0.5 * 0.01 && volumeRound < 1, 'rounding removes less than a chamfer');
  assert.deepEqual(meshBounds(mesh).max.map(value => Math.round(value * 1e5) / 1e5), [0.5, 0.5, 0.5]);
});

test('beveling every edge fills the corners and clamps widths that would overlap', () => {
  const all = bevelEdges(cube(), { all: true }, { width: 0.1, segments: 3 });
  closed(all.mesh);
  assert.equal(all.filledCorners, 8);
  assert.equal(all.cornerFaces, 72, "each rounded corner fans 9 triangles to its centre");
  const wide = bevelEdges(cube(), { all: true }, { width: 2 });
  closed(wide.mesh);
  assert.equal(wide.clamped, true);
  assert.ok(wide.width < 0.5);
  assert.throws(() => bevelEdges(cube(), { angle: 120 }, { width: 0.1 }), /selects no edges/);
});

test('bevel works on curved caps and on edited meshes', () => {
  const can = bevelEdges(meshFromGeometry(cylinder(24, 0, 1)), { angle: 60 }, { width: 0.05, segments: 3 });
  closed(can.mesh);
  assert.equal(can.bevelEdges, 48);
  const lid = applyMeshEdits(cube(), [
    { op: 'inset_region', select: { tag: 'top' }, thickness: 0.15, name: 'lid' },
    { op: 'extrude_face_region', select: { tag: 'lid.cap' }, offset: 0.2, name: 'raise' },
    { op: 'bevel', edges: { boundaryOf: { tag: 'raise.cap' } }, width: 0.05, segments: 2, name: 'soft' },
  ]);
  closed(lid.mesh);
  assert.equal(lid.results[2].edges, 4);
  assert.equal(lid.results[2].tags['soft.strip'], 8);
});

test('bevel on an open surface keeps the opening as the only problem, and validates its fields', () => {
  const open = applyMeshEdits(cube(), [{ op: 'delete', select: { tag: 'top' } }]).mesh;
  const beveled = bevelEdges(open, { all: true }, { width: 0.1, segments: 2 });
  validateTopology(editMesh(beveled.mesh));
  assert.deepEqual(lintMesh(beveled.mesh).problems.map(problem => problem.kind), ['boundary-edge']);
  assert.equal(beveled.bevelEdges, 8, 'only edges with two faces bevel');
  assert.throws(() => normalizeMeshEdits([{ op: 'bevel', width: 0 }]), /edits\[0\]\.width: got 0; expected a number above 0/);
  assert.throws(() => normalizeMeshEdits([{ op: 'bevel', width: 0.1, segments: 40 }]), /edits\[0\]\.segments: got 40; expected a whole number from 1 to 16/);
  assert.throws(() => normalizeMeshEdits([{ op: 'bevel', width: 0.1, edges: [] }]), /edits\[0\]\.edges: got \[\]; expected an edge rule/);
  assert.deepEqual(normalizeMeshEdits([{ op: 'bevel', width: 0.1 }])[0].edges, { angle: 30 });
});

test('beveling an already beveled mesh winds its corner fills against their neighbours', () => {
  // Regression: corner fills were oriented by an averaged normal, which flipped them next to rounded rims.
  const rim = bevelEdges(cube(), { between: [{ tag: 'top' }, { tag: 'side' }] }, { width: 0.08, segments: 3 }).mesh;
  const second = bevelEdges(rim, { angle: 80 }, { width: 0.02 });
  closed(second.mesh);
  assert.equal(second.filledCorners, 8);
});

test('random bevels on random boxes stay closed and valid', () => {
  let seed = 5;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const rules = [{ all: true }, { angle: 45 }, { between: [{ tag: 'top' }, { tag: 'side' }] }, { boundaryOf: { tag: 'front' } }, { between: [{ tag: 'left' }, { tag: 'bottom' }] }];
  for (let trial = 0; trial < 25; trial++) {
    const stretched = applyMeshEdits(cube(), [
      { op: 'translate', select: { tag: 'top' }, offset: [0, random() * 2, 0] },
      { op: 'translate', select: { tag: 'right' }, offset: [random() * 2, 0, 0] },
    ]).mesh;
    const rule = rules[Math.floor(random() * rules.length)];
    const { mesh } = bevelEdges(stretched, rule, { width: 0.02 + random() * 0.4, segments: 1 + Math.floor(random() * 4), profile: random() });
    closed(mesh);
  }
});

test('recipe meshes bevel as an edit or as a stack node', () => {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 },
      edits: [{ op: 'bevel', edges: { between: [{ tag: 'top' }, { tag: 'side' }] }, width: 0.08, segments: 3 }],
      stack: [{ op: 'bevel', edges: { angle: 80 }, width: 0.02 }] }],
    materials: [{ id: 'grey', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'block', geometry: 'block', material: 'grey' }],
  });
  const [report] = scene.inspectMeshes().meshes;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.edits[0].edges, 4);
  assert.equal(report.stack[0].op, 'bevel');
  assert.ok(report.stack[0].edges > 0);
});

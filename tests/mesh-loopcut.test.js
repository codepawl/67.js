import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder } from '../src/geometry.js';
import { lathe } from '../src/modeling.js';
import { editMesh, validateTopology, meshFromGeometry, lintMesh, tagCounts, facesWithTag, applyMeshEdits, meshBounds } from '../src/mesh.js';
import { loopCut } from '../src/mesh-loopcut.js';
import { normalizeMeshEdits } from '../src/mesh-recipe.js';
import { createAgentScene } from '../src/agent-scene.js';

const cube = () => meshFromGeometry(box(0, 1));

function closed(mesh) {
  validateTopology(editMesh(mesh));
  const report = lintMesh(mesh);
  assert.deepEqual(report.problems, []);
  assert.equal(report.parts.closed, 1);
}

function heights(mesh) {
  const values = new Set();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) values.add(Math.round(mesh.positions[vertex * 3 + 1] * 1e4) / 1e4);
  return [...values].sort((left, right) => left - right);
}

test('one cut around a cube makes one closed ring and two tagged bands', () => {
  const result = loopCut(cube(), { along: [0, 1, 0] });
  closed(result.mesh);
  assert.deepEqual([result.rings, result.closedRings, result.splitEdges], [1, 1, 4]);
  assert.deepEqual([result.mesh.vertexCount, result.mesh.faceCount], [12, 10]);
  const tags = tagCounts(result.mesh);
  assert.equal(tags['loop.band-0'], 4);
  assert.equal(tags['loop.band-1'], 4);
  assert.equal(tags.side, 8, 'split faces keep their tags');
  for (const face of facesWithTag(result.mesh, 'loop.band-0')) {
    for (let corner = result.mesh.faceOffsets[face]; corner < result.mesh.faceOffsets[face + 1]; corner++) {
      assert.ok(result.mesh.positions[result.mesh.cornerVertices[corner] * 3 + 1] <= 1e-6, 'band 0 is the low side');
    }
  }
});

test('several cuts space evenly and one cut honours factor from the low side', () => {
  assert.deepEqual(heights(loopCut(cube(), { along: [0, 1, 0] }, { cuts: 3 }).mesh), [-0.5, -0.25, 0, 0.25, 0.5]);
  assert.deepEqual(heights(loopCut(cube(), { along: [0, 1, 0] }, { factor: 0.2 }).mesh), [-0.5, -0.3, 0.5]);
});

test('faces beside an open ring get the new points, so no T-junctions appear', () => {
  const tall = applyMeshEdits(cube(), [{ op: 'loop_cut', edges: { along: [1, 0, 0] }, name: 'split' }]).mesh;
  closed(tall);
  // Cylinder: the wall is a closed ring of quads; the caps are fans that receive the new points on their rims.
  const can = loopCut(meshFromGeometry(cylinder(12, 0, 1)), { along: [0, 1, 0] }, { cuts: 2 });
  closed(can.mesh);
  assert.equal(can.splitEdges, 12);
});

test('corner UVs are interpolated at the new points', () => {
  const vase = meshFromGeometry(lathe([[0.4, 0], [0.6, 1]], { segments: 8 }));
  assert.ok(vase.attributes.corner.uv);
  const { mesh } = loopCut(vase, { along: [0.2, 1, 0], maxAngle: 20 });
  const uv = mesh.attributes.corner.uv.data;
  const middleVs = new Set();
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const y = mesh.positions[mesh.cornerVertices[corner] * 3 + 1];
    if (Math.abs(y - 0.5) < 1e-5) middleVs.add(Math.round(uv[corner * 2 + 1] * 1e4) / 1e4);
  }
  assert.deepEqual([...middleVs], [0.5], 'new points sit halfway in V as well as in height');
});

test('cutting then extruding a band makes a closed belt', () => {
  const { mesh, results } = applyMeshEdits(cube(), [
    { op: 'loop_cut', edges: { along: [0, 1, 0] }, cuts: 2, name: 'belt' },
    { op: 'extrude_individual', select: { tag: 'belt.band-1' }, offset: 0.05 },
  ]);
  closed(mesh);
  assert.deepEqual(results[0].tags, { 'belt.band-0': 4, 'belt.band-1': 4, 'belt.band-2': 4 });
  assert.ok(Math.abs(meshBounds(mesh).max[0] - 0.55) < 1e-6);
});

test('a band around a cylinder extrudes along normals as one joined hoop', () => {
  const steps = [{ op: 'loop_cut', edges: { along: [0, 1, 0] }, cuts: 2, name: 'hoop' }];
  const base = meshFromGeometry(cylinder(24, 0, 1));
  assert.throws(() => applyMeshEdits(base, [...steps, { op: 'extrude_face_region', select: { tag: 'hoop.band-1' }, offset: 0.1 }]), /alongNormals: true/);
  const { mesh, results } = applyMeshEdits(base, [...steps, { op: 'extrude_face_region', select: { tag: 'hoop.band-1' }, offset: 0.1, alongNormals: true, name: 'band' }]);
  closed(mesh);
  assert.equal(results[1].tags['band.side'], 48, 'one region: two rims of 24 side quads, not 24 separate boxes');
  for (const face of facesWithTag(mesh, 'band.cap')) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner++) {
      const vertex = mesh.cornerVertices[corner];
      const radius = Math.hypot(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 2]);
      assert.ok(Math.abs(radius - 1.1) < 0.01, `cap vertex radius ${radius}`);
    }
  }
  assert.throws(() => normalizeMeshEdits([{ op: 'extrude_face_region', offset: 1, alongNormals: true, direction: [0, 1, 0] }]), /edits\[0\]\.direction: got \[0,1,0\]; expected left out when alongNormals is true/);
  assert.throws(() => normalizeMeshEdits([{ op: 'extrude_individual', offset: 1, alongNormals: true }]), /edits\[0\]\.alongNormals: got true; expected one of the fields extrude_individual takes/);
});

test('loop cut validation and errors are explicit', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'loop_cut' }]), /edits\[0\]\.edges: got undefined; expected a rule that picks the ring/);
  assert.throws(() => normalizeMeshEdits([{ op: 'loop_cut', edges: { along: [0, 1, 0] }, cuts: 2, factor: 0.3 }]), /edits\[0\]\.factor: got 0\.3; expected left out when cuts is above 1/);
  assert.throws(() => normalizeMeshEdits([{ op: 'loop_cut', edges: { along: [0, 1, 0] }, factor: 1 }]), /edits\[0\]\.factor: got 1; expected a number above 0 and below 1/);
  assert.throws(() => loopCut(cube(), { along: [1, 1, 1], maxAngle: 1 }), /selects no edges/);
  assert.throws(() => loopCut(cube(), { all: true }), /rings cross/);
});

test('random loop cuts on stretched boxes and cylinders stay closed', () => {
  let seed = 3;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let trial = 0; trial < 20; trial++) {
    let mesh = trial % 2 ? meshFromGeometry(cylinder(8 + Math.floor(random() * 16), 0, 1)) : cube();
    for (let cut = 0; cut < 3; cut++) {
      const axis = axes[Math.floor(random() * 3)];
      try {
        mesh = loopCut(mesh, { along: axis }, { cuts: 1 + Math.floor(random() * 3) }).mesh;
      } catch (error) {
        assert.match(error.message, /selects no edges|rings cross/);
      }
      closed(mesh);
    }
  }
});

test('recipe meshes loop cut through mesh_edit-style edits', () => {
  const scene = createAgentScene({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'pillar', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [
      { op: 'translate', select: { tag: 'top' }, offset: [0, 2, 0] },
      { op: 'loop_cut', edges: { along: [0, 1, 0] }, cuts: 4, name: 'ring' },
      { op: 'extrude_individual', select: { or: [{ tag: 'ring.band-1' }, { tag: 'ring.band-3' }] }, offset: 0.04 },
    ] }],
    materials: [{ id: 'stone', color: [0.6, 0.6, 0.55] }],
    nodes: [{ id: 'pillar', geometry: 'pillar', material: 'stone' }],
  });
  const [report] = scene.inspectMeshes().meshes;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.edits[1].rings, 1);
});

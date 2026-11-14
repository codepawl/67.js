import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder, sphere, torus } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits, unwrapUv, extractRender } from '../src/mesh.js';
import { cornerCycles, edgeCornerTable } from '../src/mesh-topology.js';
import { normalizeMeshEdits, normalizeMeshStack } from '../src/mesh-recipe.js';
import { createAgentScene } from '../src/agent-scene.js';

const uvOf = (mesh, corner) => [mesh.attributes.corner.uv.data[corner * 2], mesh.attributes.corner.uv.data[corner * 2 + 1]];

function assertInsideSquare(mesh, margin = 0.01) {
  for (const value of mesh.attributes.corner.uv.data) {
    assert.ok(value >= margin - 1e-6 && value <= 1 - margin + 1e-6, `uv ${value} outside the packed square`);
  }
}

/** Across every edge that is not a seam, both faces must agree on the UVs of its two ends. */
function assertContinuousAcrossNonSeams(mesh) {
  const table = edgeCornerTable(mesh);
  const { nextCorner } = cornerCycles(mesh);
  const seam = mesh.attributes.edge.seam.data;
  let checked = 0;
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    if (seam[edge] || table.edgeOffsets[edge + 1] - table.edgeOffsets[edge] !== 2) continue;
    const first = table.edgeCorners[table.edgeOffsets[edge]];
    const second = table.edgeCorners[table.edgeOffsets[edge] + 1];
    for (const [left, right] of [[first, nextCorner[second]], [nextCorner[first], second]]) {
      const [leftU, leftV] = uvOf(mesh, left);
      const [rightU, rightV] = uvOf(mesh, right);
      assert.ok(Math.abs(leftU - rightU) < 1e-6 && Math.abs(leftV - rightV) < 1e-6, `uv jumps across edge ${edge}`);
    }
    checked++;
  }
  return checked;
}

test('a cube unwraps into six equal undistorted squares cut along its twelve edges', () => {
  const mesh = meshFromGeometry(box(0, 1));
  const result = unwrapUv(mesh);
  assert.deepEqual([result.islands, result.seamEdges, result.cutEdges, result.flipped], [6, 12, 0, 0]);
  assert.ok(result.areaDistortion < 1e-6);
  assertInsideSquare(result.mesh);
  assert.equal(result.mesh.attributes.edge.seam.data.reduce((sum, value) => sum + value, 0), 12);
  const sides = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    const [firstU, firstV] = uvOf(result.mesh, mesh.faceOffsets[face]);
    const [secondU, secondV] = uvOf(result.mesh, mesh.faceOffsets[face] + 1);
    sides.push(Math.hypot(secondU - firstU, secondV - firstV));
  }
  for (const side of sides) assert.ok(Math.abs(side - sides[0]) < 1e-5);
});

test('unwrapping keeps the topology and leaves the input untouched', () => {
  const mesh = meshFromGeometry(cylinder(16, 0, 1));
  const before = mesh.attributes.corner.uv?.data.slice();
  const result = unwrapUv(mesh);
  assert.equal(result.mesh.positions, mesh.positions);
  assert.equal(result.mesh.cornerVertices, mesh.cornerVertices);
  assert.deepEqual(mesh.attributes.corner.uv?.data, before);
  assert.equal(mesh.attributes.edge.seam, undefined);
});

test('a cylinder gets caps and one side strip, cut once to lie flat, with no stretch', () => {
  const result = unwrapUv(meshFromGeometry(cylinder(24, 0, 1)));
  assert.deepEqual([result.islands, result.cutEdges, result.flipped, result.chartEdges], [3, 1, 0, 0]);
  assert.ok(result.areaDistortion < 0.01, `distortion ${result.areaDistortion}`);
  assertInsideSquare(result.mesh);
  assert.ok(assertContinuousAcrossNonSeams(result.mesh) > 40);
});

test('closed smooth shapes split into axis charts without folds', () => {
  for (const geometry of [sphere(32, 16), torus(0.3, 24, 12), box(0.1, 3)]) {
    const result = unwrapUv(meshFromGeometry(geometry));
    assert.equal(result.flipped, 0);
    assert.equal(result.flatIslands, 0);
    assert.ok(result.chartEdges > 0);
    assert.ok(result.islands >= 6);
    assert.ok(result.areaDistortion < 0.15, `distortion ${result.areaDistortion}`);
    assertInsideSquare(result.mesh);
    assertContinuousAcrossNonSeams(result.mesh);
  }
});

test('seams follow an edge rule and margin widens the border', () => {
  const mesh = meshFromGeometry(box(0, 1));
  const all = unwrapUv(mesh, { seams: { all: true } });
  assert.equal(all.islands, 6);
  const wide = unwrapUv(mesh, { margin: 0.1 });
  assertInsideSquare(wide.mesh, 0.1);
  const none = unwrapUv(mesh, { seams: { angle: 120 } });
  assert.equal(none.seamEdges, 0);
  assert.equal(none.flipped, 0);
});

test('the edited crate unwraps into flat panels and renders with uvs', () => {
  const { mesh, results } = applyMeshEdits(meshFromGeometry(box(0, 1)), [
    { op: 'inset_individual', select: { tag: 'side' }, thickness: 0.07, name: 'panel' },
    { op: 'extrude_individual', select: { tag: 'panel.cap' }, offset: -0.04 },
    { op: 'uv_unwrap' },
  ]);
  const report = results.at(-1);
  assert.equal(report.op, 'uv_unwrap');
  assert.equal(report.flipped, 0);
  assert.ok(report.islands > 6);
  assert.ok(report.areaDistortion < 1e-3);
  assert.ok(report.utilization > 0.3 && report.utilization <= 1);
  const { geometry } = extractRender(mesh, { sharpAngle: 30 });
  assert.equal(geometry.uvs.length, geometry.positions.length / 3 * 2);
});

test('uv_unwrap validates its fields and works as an unnamed stack node', () => {
  assert.deepEqual(normalizeMeshEdits([{ op: 'uv_unwrap' }])[0], { op: 'uv_unwrap', seams: { angle: 60 }, margin: 0.01, maxDistortion: 0.25 });
  assert.throws(() => normalizeMeshEdits([{ op: 'uv_unwrap', seams: [1] }]), /edits\[0\]\.seams: got \[1\]; expected an edge rule/);
  assert.throws(() => normalizeMeshEdits([{ op: 'uv_unwrap', margin: 0.5 }]), /margin/);
  assert.throws(() => normalizeMeshEdits([{ op: 'uv_unwrap', name: 'x' }]), /edits\[0\]\.name: got "x"; expected one of the fields uv_unwrap takes/);
  assert.equal(normalizeMeshStack([{ op: 'uv_unwrap' }])[0].name, undefined);
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'drum', type: 'mesh', base: { type: 'cylinder', segments: 24, bevel: 0 }, stack: [{ op: 'mirror', axis: 'y' }, { op: 'uv_unwrap' }] }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'drum', geometry: 'drum', material: 'paint' }],
  });
  const [report] = scene.inspectMeshes().meshes;
  assert.equal(report.ok, true);
  assert.equal(report.stack.at(-1).op, 'uv_unwrap');
  assert.equal(report.stack.at(-1).flipped, 0);
});

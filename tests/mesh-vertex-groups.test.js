import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { createAgentScene } from '../src/agent-scene.js';
import { exportGlb } from '../src/export.js';
import { vertexGroupWeights } from '../src/mesh-data.js';

const slab = () => meshFromGeometry(box(0, 4));
const bottomToTopHalf = { name: 'upper', gradient: { axis: 'y', range: [-0.5, 0.5], weights: [0, 1] } };

function topFaceHeights(mesh) {
  const heights = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) heights.push(mesh.positions[vertex * 3 + 1]);
  return heights;
}

test('a vertex group limits a displace edit to the vertices it weighs', () => {
  const base = slab();
  const grouped = applyMeshEdits(base, [
    { op: 'vertex_group', name: 'top', select: { tag: 'top' }, weight: 1 },
    { op: 'displace', field: 1, strength: 0.2, midlevel: 0, direction: 'y', group: 'top' },
  ]).mesh;
  const weights = vertexGroupWeights(grouped, 'top');
  let moved = 0;
  for (let vertex = 0; vertex < grouped.vertexCount; vertex++) {
    const shift = grouped.positions[vertex * 3 + 1] - base.positions[vertex * 3 + 1];
    if (weights[vertex] === 1) {
      assert.ok(Math.abs(shift - 0.2) < 1e-6, `grouped vertex ${vertex} moved by ${shift}`);
      moved++;
    } else {
      assert.equal(shift, 0, `ungrouped vertex ${vertex} must stay`);
    }
  }
  assert.ok(moved > 0 && moved < grouped.vertexCount, 'the group holds some, not all, vertices');
  const ungrouped = applyMeshEdits(base, [{ op: 'displace', field: 1, strength: 0.2, midlevel: 0, direction: 'y' }]).mesh;
  assert.ok(topFaceHeights(ungrouped).every((height, vertex) => Math.abs(height - base.positions[vertex * 3 + 1] - 0.2) < 1e-6));
});

test('a gradient writes partial weights that scale the displacement', () => {
  const base = slab();
  const mesh = applyMeshEdits(base, [
    { op: 'vertex_group', ...bottomToTopHalf },
    { op: 'displace', field: 1, strength: 1, midlevel: 0, direction: 'x', group: 'upper' },
  ]).mesh;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const expected = Math.min(1, Math.max(0, base.positions[vertex * 3 + 1] + 0.5));
    assert.ok(Math.abs(vertexGroupWeights(mesh, 'upper')[vertex] - expected) < 1e-6);
    assert.ok(Math.abs(mesh.positions[vertex * 3] - base.positions[vertex * 3] - expected) < 1e-6);
  }
});

test('a field sets weights and an unknown group names the groups that exist', () => {
  const mesh = applyMeshEdits(slab(), [
    { op: 'vertex_group', name: 'ramp', field: { attr: 'position', component: 'x' } },
  ]).mesh;
  const weights = vertexGroupWeights(mesh, 'ramp');
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    assert.ok(Math.abs(weights[vertex] - Math.max(0, mesh.positions[vertex * 3])) < 1e-6);
  }
  assert.throws(() => applyMeshEdits(mesh, [{ op: 'displace', field: 1, group: 'missing' }]), /Unknown vertex group missing.*ramp/);
  assert.throws(() => applyMeshEdits(slab(), [{ op: 'vertex_group', weight: 1 }]), /name/);
  assert.throws(() => applyMeshEdits(slab(), [{ op: 'vertex_group', name: 'bad', weight: 2 }]), /weight/);
  assert.throws(() => applyMeshEdits(slab(), [{ op: 'vertex_group', name: 'both', weight: 1, field: 1 }]), /only one/);
});

test('vertex_color writes corner colors for the selected faces only', () => {
  const mesh = applyMeshEdits(slab(), [{ op: 'vertex_color', select: { tag: 'top' }, color: [1, 0, 0] }]).mesh;
  const colors = mesh.attributes.corner.color.data;
  let red = 0;
  let white = 0;
  for (let index = 0; index < mesh.cornerCount; index++) {
    const isRed = colors[index * 3] === 1 && colors[index * 3 + 1] === 0 && colors[index * 3 + 2] === 0;
    const isWhite = colors[index * 3] === 1 && colors[index * 3 + 1] === 1 && colors[index * 3 + 2] === 1;
    red += isRed ? 1 : 0;
    white += isWhite ? 1 : 0;
  }
  assert.ok(red > 0 && white > 0 && red + white === mesh.cornerCount);
  assert.throws(() => applyMeshEdits(slab(), [{ op: 'vertex_color', color: [2, 0, 0] }]), /color/);
});

function recipeWithColors() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{
      id: 'block', type: 'mesh', base: { type: 'box', bevel: 0, subdivisions: 2 },
      edits: [{ op: 'vertex_color', gradient: { axis: 'y', range: [-0.5, 0.5], colors: [[0, 0, 1], [1, 0, 0]] } }],
    }],
    materials: [{ id: 'paint' }],
    nodes: [{ id: 'block', geometry: 'block', material: 'paint' }],
  };
}

function glbJson(glb) {
  const bytes = new Uint8Array(glb);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
}

test('vertex colors of a recipe mesh reach the part and export as COLOR_0 in a GLB', () => {
  const scene = createAgentScene(recipeWithColors());
  const geometry = scene.parts[0].geometry;
  assert.equal(geometry.colors.length, geometry.positions.length);
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    const expectedRed = Math.min(1, Math.max(0, geometry.positions[vertex * 3 + 1] + 0.5));
    assert.ok(Math.abs(geometry.colors[vertex * 3] - expectedRed) < 1e-6);
  }
  const document = glbJson(exportGlb(scene.parts));
  assert.ok(document.meshes[0].primitives[0].attributes.COLOR_0 !== undefined, 'the GLB carries COLOR_0');
});

test('cloth holds the vertices of a pin group', () => {
  const recipe = {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{
      id: 'sheet', type: 'mesh', base: { type: 'grid', segments: 6 },
      edits: [{ op: 'vertex_group', name: 'hem', gradient: { axis: 'x', range: [-0.5, -0.4], weights: [1, 0] } }],
    }],
    materials: [{ id: 'fabric', doubleSided: true }],
    nodes: [{ id: 'flag', geometry: 'sheet', material: 'fabric', translation: [0, 2, 0] }],
    cloth: { duration: 1, sheets: [{ node: 'flag', pinGroup: 'hem' }] },
  };
  const scene = createAgentScene(recipe);
  scene.sampleMotion(1);
  const positions = scene.parts[0].geometry.positions;
  let heldLeft = 0;
  let sagging = 0;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    if (positions[vertex * 3] < -0.49) heldLeft++;
    if (positions[vertex * 3] > 0.3 && positions[vertex * 3 + 1] < -0.2) sagging++;
  }
  assert.ok(heldLeft > 0);
  assert.ok(sagging > 0, 'the free side falls under gravity');
});

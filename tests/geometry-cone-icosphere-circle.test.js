import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { circle, cone, icoSphere } from '../src/geometry.js';
import { createAgentScene } from '../src/agent-scene.js';

function bounds(geometry) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < geometry.positions.length; index++) {
    minimum[index % 3] = Math.min(minimum[index % 3], geometry.positions[index]);
    maximum[index % 3] = Math.max(maximum[index % 3], geometry.positions[index]);
  }
  return { minimum, maximum };
}

function assertUnitNormals(geometry) {
  for (let index = 0; index < geometry.normals.length; index += 3) {
    const length = Math.hypot(geometry.normals[index], geometry.normals[index + 1], geometry.normals[index + 2]);
    assert.ok(Math.abs(length - 1) < 1e-5, `normal ${index / 3} has length ${length}`);
  }
}

// The winding must agree with the stored normals, or the face renders inside out.
function assertWindingMatchesNormals(geometry) {
  for (let index = 0; index < geometry.indices.length; index += 3) {
    const corners = [0, 1, 2].map(offset => geometry.indices[index + offset]);
    const [first, second, third] = corners.map(corner => [0, 1, 2].map(axis => geometry.positions[corner * 3 + axis]));
    const edgeA = second.map((value, axis) => value - first[axis]);
    const edgeB = third.map((value, axis) => value - first[axis]);
    const cross = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
    const normalSum = [0, 1, 2].map(axis => corners.reduce((sum, corner) => sum + geometry.normals[corner * 3 + axis], 0));
    const alignment = cross.reduce((sum, value, axis) => sum + value * normalSum[axis], 0);
    assert.ok(alignment > 0, `triangle ${index / 3} faces against its normals`);
  }
}

test('cone has a point, a base cap and outward slope normals', () => {
  const geometry = cone(0, 1, 16);
  assert.equal(geometry.positions.length / 3, (16 + 1) * 2 + (16 + 2));
  assert.deepEqual(bounds(geometry), { minimum: [-1, -0.5, -1], maximum: [1, 0.5, 1] });
  assertUnitNormals(geometry);
  assertWindingMatchesNormals(geometry);
  const slopeNormal = [geometry.normals[3], geometry.normals[4], geometry.normals[5]];
  assert.ok(slopeNormal[1] > 0 && slopeNormal[0] > 0, 'slope normals lean up and outward');
});

test('cone with two radii is a capped frustum', () => {
  const geometry = cone(0.5, 1, 8);
  assert.equal(geometry.positions.length / 3, (8 + 1) * 2 + 2 * (8 + 2));
  assert.deepEqual(bounds(geometry), { minimum: [-1, -0.5, -1], maximum: [1, 0.5, 1] });
  assertUnitNormals(geometry);
  assertWindingMatchesNormals(geometry);
  assert.throws(() => cone(0, 0, 8), /at least one/);
  assert.throws(() => cone(-1, 1, 8), /negative/);
  assert.throws(() => cone(0, 1, 2), /segments/);
});

test('icoSphere has the icosahedron vertex count at each level and lies on the unit sphere', () => {
  for (const [subdivisions, vertexCount, faceCount] of [[0, 12, 20], [1, 42, 80], [2, 162, 320]]) {
    const geometry = icoSphere(subdivisions);
    assert.equal(geometry.positions.length / 3, vertexCount);
    assert.equal(geometry.indices.length / 3, faceCount);
    assertUnitNormals(geometry);
    assertWindingMatchesNormals(geometry);
    for (let index = 0; index < geometry.positions.length; index += 3) {
      const radius = Math.hypot(geometry.positions[index], geometry.positions[index + 1], geometry.positions[index + 2]);
      assert.ok(Math.abs(radius - 1) < 1e-5);
    }
  }
  const { minimum, maximum } = bounds(icoSphere(3));
  assert.ok(maximum.every(value => value > 0.9 && value <= 1 + 1e-6));
  assert.ok(minimum.every(value => value < -0.9 && value >= -1 - 1e-6));
  assert.throws(() => icoSphere(8), /subdivisions/);
});

test('circle is a filled disc or a ring facing +Z', () => {
  const disc = circle(12);
  assert.equal(disc.positions.length / 3, 12 + 2);
  assert.equal(disc.indices.length / 3, 12);
  assert.deepEqual(bounds(disc), { minimum: [-1, -1, 0], maximum: [1, 1, 0] });
  assertUnitNormals(disc);
  assertWindingMatchesNormals(disc);
  assert.ok(disc.normals.every((value, index) => value === (index % 3 === 2 ? 1 : 0)));
  const ring = circle(12, 0.5);
  assert.equal(ring.positions.length / 3, (12 + 1) * 2);
  assert.equal(ring.indices.length / 3, 24);
  assertUnitNormals(ring);
  assertWindingMatchesNormals(ring);
  const innerRadius = Math.min(...Array.from({ length: 13 }, (_, index) => Math.hypot(ring.positions[index * 3], ring.positions[index * 3 + 1])));
  assert.ok(Math.abs(innerRadius - 0.5) < 1e-6);
  assert.throws(() => circle(12, 1), /innerRadius/);
});

function sceneWith(geometries) {
  return createAgentScene({
    format: '67js.scene', schemaVersion: 1, geometries, materials: [{ id: 'paint' }],
    nodes: geometries.map(geometry => ({ id: geometry.id, geometry: geometry.id, material: 'paint' })),
  });
}

test('agent recipes accept cone, icoSphere, circle, line and plane in one record each', () => {
  const session = sceneWith([
    { id: 'spike', type: 'cone', radiusBottom: 0.5, segments: 12 },
    { id: 'ball', type: 'icoSphere', subdivisions: 2 },
    { id: 'disc', type: 'circle', innerRadius: 0.4 },
    { id: 'rod', type: 'line', from: [0, 0, 0], to: [0, 2, 0], radius: 0.05 },
    { id: 'sheet', type: 'plane', segments: 4 },
  ]);
  const inspection = session.inspect({ includeBounds: true });
  const nodeBounds = id => inspection.nodes.find(node => node.id === id).bounds;
  assert.ok(nodeBounds('ball').max.every(value => value > 0.8 && value <= 1 + 1e-6));
  assert.ok(Math.abs(nodeBounds('spike').max[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(nodeBounds('rod').max[1] - 2) < 1e-4);
  assert.ok(Math.abs(nodeBounds('rod').max[0] - 0.05) < 1e-4);
  assert.ok(Math.abs(nodeBounds('sheet').max[0] - 0.5) < 1e-6);
  assert.deepEqual(createAgentScene(session.exportRecipe()).inspect(), session.inspect());
  assert.equal(session.exportRecipe().geometries.find(geometry => geometry.id === 'sheet').type, 'grid');
  assert.throws(() => sceneWith([{ id: 'same', type: 'line', from: [1, 1, 1], to: [1, 1, 1] }]), /geometries\[0\]\.to: got \[1,1,1\]; expected a point different from from \[1,1,1\]/);
});

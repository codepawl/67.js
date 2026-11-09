import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, applyMeshEdits, evaluateMeshStack, normalizeMeshEdits } from '../src/mesh.js';
import { createMeshData } from '../src/mesh-data.js';

const cube = () => meshFromGeometry(box(0, 1));
const run = (mesh, edit, limits) => applyMeshEdits(mesh, [edit], limits);

function profileQuad() {
  return createMeshData({
    positions: Float32Array.from([1, 0, 0, 2, 0, 0, 2, 0, 1, 1, 0, 1]),
    faceOffsets: Uint32Array.from([0, 4]),
    cornerVertices: Uint32Array.from([0, 1, 2, 3]),
  });
}

test('screw closes a full turn into a ring and keeps the last copy open for a partial turn', () => {
  const ring = run(profileQuad(), { op: 'screw', angle: 360, steps: 8 }).mesh;
  assert.equal(ring.vertexCount, 32);
  assert.equal(ring.faceCount, 32);
  validateTopology(editMesh(ring));
  const partial = run(profileQuad(), { op: 'screw', angle: 90, steps: 4, iterations: 2, lift: 2 }).mesh;
  assert.equal(partial.vertexCount, 36);
  assert.equal(partial.faceCount, 32);
  assert.equal(partial.positions[(4 * 4 + 0) * 3 + 2], 2, 'after one iteration of four steps the profile has risen by the lift');
});

test('screw turns about the chosen axis and a negative angle turns the other way', () => {
  const forward = run(profileQuad(), { op: 'screw', axis: 'z', angle: 90, steps: 1 }).mesh;
  assert.ok(Math.abs(forward.positions[4 * 3]) < 1e-6);
  assert.ok(Math.abs(forward.positions[4 * 3 + 1] - 1) < 1e-6);
  const backward = run(profileQuad(), { op: 'screw', axis: 'z', angle: -90, steps: 1 }).mesh;
  assert.ok(Math.abs(backward.positions[4 * 3 + 1] + 1) < 1e-6);
});

test('screw names the limit and what to change when it would make too many vertices', () => {
  assert.throws(() => run(profileQuad(), { op: 'screw', steps: 256, iterations: 64 }, { maxVertices: 1000, maxFaces: 1000 }), /screw would make .* Lower steps or iterations/);
  assert.throws(() => normalizeMeshEdits([{ op: 'screw', steps: 257 }]), /steps must be an integer from 1 to 256/);
  assert.throws(() => normalizeMeshEdits([{ op: 'screw', axis: 'w' }]), /axis must be x, y or z/);
});

test('wireframe makes two quads per face edge, stays closed and puts the strut either side of the surface', () => {
  const frame = run(cube(), { op: 'wireframe', thickness: 0.1 }).mesh;
  assert.equal(frame.vertexCount, 40);
  assert.equal(frame.faceCount, 48);
  validateTopology(editMesh(frame));
  const kept = run(cube(), { op: 'wireframe', thickness: 0.1, replace: false }).mesh;
  assert.equal(kept.vertexCount, 48);
  assert.equal(kept.faceCount, 54);
  const reach = Math.max(...frame.positions.map(Math.abs));
  assert.ok(Math.abs(reach - 0.5289) < 1e-3);
});

test('wireframe refuses a result over the limits and bad fields', () => {
  assert.throws(() => run(cube(), { op: 'wireframe' }, { maxVertices: 10, maxFaces: 1000 }), /wireframe would make 40 vertices/);
  assert.throws(() => normalizeMeshEdits([{ op: 'wireframe', thickness: 0 }]), /edits\[0\]\.thickness: got 0; expected a number above 0/);
  assert.throws(() => normalizeMeshEdits([{ op: 'wireframe', offset: 2 }]), /edits\[0\]\.offset: got 2; expected a number from -1 to 1/);
  assert.throws(() => normalizeMeshEdits([{ op: 'wireframe', replace: 'yes' }]), /booleans/);
});

test('skin puts a closed square tube on every edge and takes a radius per vertex from a field', () => {
  const skinned = run(cube(), { op: 'skin', radius: 0.05 }).mesh;
  assert.equal(skinned.vertexCount, 12 * 8);
  assert.equal(skinned.faceCount, 12 * 6);
  const fat = run(cube(), { op: 'skin', radius: { add: [0.1, { mul: [0.1, { attr: 'position', component: 'z' }] }] } }).mesh;
  const upperReach = Math.max(...Array.from({ length: fat.vertexCount }, (_, vertex) => fat.positions[vertex * 3]));
  assert.ok(upperReach > 0.6 && upperReach < 0.7);
  assert.throws(() => run(cube(), { op: 'skin', radius: { mul: [0, { attr: 'position', component: 'z' }] } }), /radius must be above zero at every vertex/);
  assert.throws(() => run(cube(), { op: 'skin' }, { maxVertices: 50, maxFaces: 1000 }), /skin would make 96 vertices/);
  assert.throws(() => normalizeMeshEdits([{ op: 'skin', radius: -1 }]), /edits\[0\]\.radius: got -1; expected a number above 0/);
});

test('the generating modifiers run as stack nodes', () => {
  const outcome = evaluateMeshStack(cube(), [{ op: 'wireframe', thickness: 0.1 }, { op: 'skin', radius: 0.01 }]);
  assert.equal(outcome.results.length, 2);
  assert.ok(outcome.mesh.faceCount > 48);
});

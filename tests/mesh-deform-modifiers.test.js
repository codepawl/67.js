import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, applyMeshEdits, evaluateMeshStack, normalizeMeshEdits } from '../src/mesh.js';
import { createMeshData } from '../src/mesh-data.js';

const cube = () => meshFromGeometry(box(0, 1));
const run = (mesh, edit) => applyMeshEdits(mesh, [edit]).mesh;
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-4, `${message}: ${actual} against ${expected}`);

// A beam along x from 0 to 4, one unit square in section, split in four cells so a bend has something to bend.
function beam() {
  const positions = [];
  for (let step = 0; step <= 4; step++) positions.push(step, -0.5, -0.5, step, 0.5, -0.5, step, 0.5, 0.5, step, -0.5, 0.5);
  const faces = [];
  for (let step = 0; step < 4; step++) {
    for (let side = 0; side < 4; side++) {
      const next = (side + 1) % 4;
      faces.push([step * 4 + side, step * 4 + next, (step + 1) * 4 + next, (step + 1) * 4 + side]);
    }
  }
  const faceOffsets = Uint32Array.from({ length: faces.length + 1 }, (_, index) => index * 4);
  return createMeshData({ positions: Float32Array.from(positions), faceOffsets, cornerVertices: Uint32Array.from(faces.flat()) });
}

test('lattice moves a control point fully at its vertex and by the blend elsewhere, and keeps the topology', () => {
  const moved = run(cube(), { op: 'lattice', divisions: [2, 2, 2], moves: [{ point: [1, 1, 1], offset: [0, 0, 1] }] });
  validateTopology(editMesh(moved));
  const heights = Array.from({ length: moved.vertexCount }, (_, vertex) => moved.positions[vertex * 3 + 2]);
  near(Math.max(...heights), 1.5, 'the corner on the moved control point rises by the offset');
  near(Math.min(...heights), -0.5, 'the opposite face does not move');
  const threeWide = run(beam(), { op: 'lattice', divisions: [3, 2, 2], moves: [{ point: [1, 0, 0], offset: [0, 0, -1] }] });
  near(threeWide.positions[2 * 4 * 3 + 2], -1.5, 'the vertex on the middle control point follows it');
  near(threeWide.positions[2], -0.5, 'the end of the beam stays');
});

test('lattice refuses bad grids and moves with the limit in the message', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', divisions: [9, 2, 2] }]), /edits\[0\]\.divisions: got 9; expected a whole number from 2 to 8/);
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', divisions: [2, 2, 2], moves: [{ point: [2, 0, 0], offset: [0, 0, 1] }] }]), /edits\[0\]\.moves\[0\]\.point: got 2; expected a whole number from 0 to 1/);
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', moves: new Array(65).fill({ point: [0, 0, 0], offset: [0, 0, 0] }) }]), /at most 64/);
  assert.throws(() => normalizeMeshEdits([{ op: 'lattice', moves: [{ point: [0, 0, 0] }] }]), /edits\[0\]\.moves\[0\]\.offset: got undefined; expected an array of three numbers/);
});

test('curve leaves a beam alone on a straight path along its axis and bends it along an arc', () => {
  const straight = run(beam(), { op: 'curve', path: [[0, 0, 0], [4, 0, 0]], axis: 'x' });
  straight.positions.forEach((value, index) => near(value, beam().positions[index], `straight vertex ${index}`));
  const bent = run(beam(), { op: 'curve', path: [[0, 0, 0], [2, 0, 0], [3.5, 1.5, 0], [3.5, 3.5, 0]], axis: 'x' });
  validateTopology(editMesh(bent));
  const end = Array.from(bent.positions.subarray(16 * 3, 17 * 3));
  assert.ok(end[1] > 1, `the far end turned up to y ${end[1]}`);
  const sectionWidth = Math.hypot(bent.positions[17 * 3] - bent.positions[16 * 3], bent.positions[17 * 3 + 1] - bent.positions[16 * 3 + 1], bent.positions[17 * 3 + 2] - bent.positions[16 * 3 + 2]);
  near(sectionWidth, 1, 'the cross section keeps its size');
});

test('curve names its limits', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'curve', path: [[0, 0, 0]] }]), /edits\[0\]\.path: got \[\[0,0,0\]\]; expected an array of 2 to 64 points/);
  assert.throws(() => normalizeMeshEdits([{ op: 'curve', path: [[0, 0, 0], [1, 0, 0]], axis: 'q' }]), /edits\[0\]\.axis: got "q"; expected one of "x", "y", "z"/);
  assert.throws(() => run(beam(), { op: 'curve', path: [[1, 1, 1], [1, 1, 1]] }), /edits\[0\]\.path: got \[\[1,1,1\],\[1,1,1\]\]; expected points that are apart/);
});

test('hook pulls the vertices inside the radius by the falloff weight and none outside', () => {
  const pulled = run(cube(), { op: 'hook', center: [0.5, 0.5, 0.5], radius: 0.5, translation: [0, 0, 2], falloff: 'constant' });
  const raised = Array.from({ length: pulled.vertexCount }, (_, vertex) => pulled.positions[vertex * 3 + 2]).filter(value => value > 1);
  assert.equal(raised.length, 1);
  near(raised[0], 2.5, 'the one vertex at the centre moves the whole translation');
  const soft = run(cube(), { op: 'hook', center: [0.5, 0.5, 0.5], radius: 1.2, translation: [0, 0, 1], strength: 0.5 });
  assert.ok(soft.positions[2 + 3 * 6] > 0.5 && soft.positions[2 + 3 * 6] < 1.1);
  assert.throws(() => normalizeMeshEdits([{ op: 'hook', radius: 0 }]), /edits\[0\]\.radius: got 0; expected a number above 0/);
  assert.throws(() => normalizeMeshEdits([{ op: 'hook', falloff: 'sharp' }]), /edits\[0\]\.falloff: got "sharp"; expected one of smooth, linear, constant/);
  assert.throws(() => normalizeMeshEdits([{ op: 'hook', strength: 2 }]), /edits\[0\]\.strength: got 2; expected a number from 0 to 1/);
});

test('wave lifts vertices inside its ring along z, moves with time and can follow the normal', () => {
  const flat = createMeshData({
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceOffsets: Uint32Array.from([0, 4]),
    cornerVertices: Uint32Array.from([0, 1, 2, 3]),
  });
  const early = run(flat, { op: 'wave', time: 0 });
  assert.ok(early.positions[2] > 0, 'the vertex at the start is on the crest');
  const later = run(flat, { op: 'wave', time: 40, cyclic: false });
  assert.equal(later.positions[2], 0, 'the single ripple has left the face');
  const alongNormal = run(flat, { op: 'wave', normal: true });
  assert.ok(Math.abs(alongNormal.positions[2]) > 0 && alongNormal.positions[0] === 0);
  assert.throws(() => normalizeMeshEdits([{ op: 'wave', axes: 'z' }]), /edits\[0\]\.axes: got "z"; expected one of xy, x, y/);
  assert.throws(() => normalizeMeshEdits([{ op: 'wave', narrowness: 51 }]), /edits\[0\]\.narrowness: got 51; expected a number from 0 to 50/);
  assert.throws(() => normalizeMeshEdits([{ op: 'wave', start: [1] }]), /edits\[0\]\.start: got \[1\]; expected an array of two numbers/);
});

test('the deforming modifiers run as stack nodes', () => {
  const outcome = evaluateMeshStack(beam(), [
    { op: 'hook', center: [4, 0, 0], radius: 2, translation: [0, 1, 0] },
    { op: 'wave' },
    { op: 'lattice', moves: [{ point: [1, 1, 1], offset: [0, 0, 0.5] }] },
    { op: 'curve', path: [[0, 0, 0], [4, 0, 0]] },
  ]);
  assert.equal(outcome.results.length, 4);
  validateTopology(editMesh(outcome.mesh));
});

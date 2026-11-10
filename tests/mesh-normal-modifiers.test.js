import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits, evaluateMeshStack, normalizeMeshEdits } from '../src/mesh.js';
import { createMeshData } from '../src/mesh-data.js';
import { cornerNormals } from '../src/mesh-normals.js';
import { extractRender } from '../src/mesh-render.js';

const cube = () => meshFromGeometry(box(0, 1));
const run = (mesh, edit) => applyMeshEdits(mesh, [edit]).mesh;
const degrees = value => value * Math.PI / 180;

// A big floor quad and a small wall quad bent 90 degrees up along their shared edge.
function floorAndWall() {
  return createMeshData({
    positions: Float32Array.from([0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0, 4, 0, 1, 4, 4, 1]),
    faceOffsets: Uint32Array.from([0, 4, 8]),
    cornerVertices: Uint32Array.from([0, 1, 2, 3, 1, 4, 5, 2]),
  });
}

test('smooth_by_angle marks bends over the angle sharp and the rest smooth, over the angle the render would use', () => {
  // The box primitive already marks its 12 edges sharp, so the first run has to ignore those marks.
  const rounded = run(cube(), { op: 'smooth_by_angle', angle: 100, ignoreSharp: true });
  assert.equal(rounded.attributes.edge.sharp.data.reduce((total, flag) => total + flag, 0), 0);
  assert.equal(rounded.attributes.edge.smooth.data.reduce((total, flag) => total + flag, 0), 12);
  assert.equal(cornerNormals(rounded, { sharpAngle: degrees(30) }).groupCount, 8, 'one normal per vertex even though 30 degrees would split every edge');
  const hard = run(cube(), { op: 'smooth_by_angle', angle: 80 });
  assert.equal(hard.attributes.edge.sharp.data.reduce((total, flag) => total + flag, 0), 12);
  assert.equal(cornerNormals(hard, { sharpAngle: degrees(120) }).groupCount, 24);
});

test('smooth_by_angle keeps hand-marked sharp edges unless told to ignore them', () => {
  const marked = run(cube(), { op: 'smooth_by_angle', angle: 100, ignoreSharp: true });
  const sharpData = Uint8Array.from(marked.attributes.edge.sharp.data);
  sharpData[0] = 1;
  const withMark = createMeshData({
    positions: marked.positions, faceOffsets: marked.faceOffsets, cornerVertices: marked.cornerVertices,
    edgeVertices: marked.edgeVertices, cornerEdges: marked.cornerEdges,
    attributes: { ...marked.attributes, edge: { ...marked.attributes.edge, sharp: { data: sharpData, size: 1 } } },
  });
  assert.equal(run(withMark, { op: 'smooth_by_angle', angle: 100 }).attributes.edge.sharp.data[0], 1);
  assert.equal(run(withMark, { op: 'smooth_by_angle', angle: 100, ignoreSharp: true }).attributes.edge.sharp.data[0], 0);
});

test('weighted_normal tilts a shared vertex toward the larger face and the render uses the stored normals', () => {
  const plain = cornerNormals(floorAndWall(), { sharpAngle: degrees(120) });
  const weighted = run(floorAndWall(), { op: 'weighted_normal', angle: 120 });
  const normal = weighted.attributes.corner.normal;
  assert.equal(normal.size, 3);
  assert.equal(normal.data.length, weighted.cornerCount * 3);
  const sharedCorner = 1;
  const plainTilt = plain.groupNormals[plain.groupOfCorner[sharedCorner] * 3 + 0];
  const weightedTilt = normal.data[sharedCorner * 3];
  assert.ok(Math.abs(weightedTilt) < Math.abs(plainTilt), `the wall pulls less when the floor is four times larger (${weightedTilt} against ${plainTilt})`);
  assert.ok(Math.abs(Math.hypot(...normal.data.subarray(sharedCorner * 3, sharedCorner * 3 + 3)) - 1) < 1e-5);
  const { geometry } = extractRender(weighted);
  for (let index = 0; index < geometry.normals.length; index += 3) {
    assert.ok(Math.abs(Math.hypot(geometry.normals[index], geometry.normals[index + 1], geometry.normals[index + 2]) - 1) < 1e-5);
  }
  assert.ok(geometry.normals.some((value, index) => index % 3 === 2 && value > 0.9), 'the floor keeps its upward normal');
});

test('a higher weight leans further toward the large face and sharp bends stay split', () => {
  const lean = weight => Math.abs(run(floorAndWall(), { op: 'weighted_normal', angle: 120, weight }).attributes.corner.normal.data[3]);
  assert.ok(lean(100) < lean(50) && lean(50) < lean(1));
  const split = run(floorAndWall(), { op: 'weighted_normal', angle: 30 });
  assert.equal(split.attributes.corner.normal.data[2], 1, 'the floor corner keeps the floor normal when the 90 degree edge is sharp');
});

test('the normal modifiers name their limits and run as stack nodes', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'weighted_normal', weight: 0 }]), /edits\[0\]\.weight: got 0; expected a number from 1 to 100/);
  assert.throws(() => normalizeMeshEdits([{ op: 'weighted_normal', angle: 181 }]), /edits\[0\]\.angle: got 181; expected a number from 0 to 180/);
  assert.throws(() => normalizeMeshEdits([{ op: 'smooth_by_angle', ignoreSharp: 1 }]), /edits\[0\]\.ignoreSharp: got 1; expected true or false/);
  const outcome = evaluateMeshStack(cube(), [{ op: 'smooth_by_angle', angle: 100 }, { op: 'weighted_normal' }]);
  assert.equal(outcome.results.length, 2);
  assert.ok(outcome.mesh.attributes.corner.normal);
});

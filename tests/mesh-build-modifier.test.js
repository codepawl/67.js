import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeshData, applyMeshEdits, evaluateMeshStack } from '../src/mesh.js';
import { faceNormals } from '../src/mesh-normals.js';
import { visibleBuildFaces } from '../src/mesh-build-modifier.js';
import { MESH_MODIFIER_NOTES } from '../src/agent-scene-capabilities.js';

// A strip of 10 quads along x, one unit wide, each quad tagged "odd" or not and given a corner attribute.
function strip() {
  const quads = 10;
  const positions = new Float32Array((quads + 1) * 2 * 3);
  for (let column = 0; column <= quads; column++) {
    positions.set([column, 0, 0], column * 6);
    positions.set([column, 1, 0], column * 6 + 3);
  }
  const faceOffsets = new Uint32Array(quads + 1);
  const cornerVertices = new Uint32Array(quads * 4);
  for (let quad = 0; quad < quads; quad++) {
    faceOffsets[quad + 1] = (quad + 1) * 4;
    cornerVertices.set([quad * 2, quad * 2 + 2, quad * 2 + 3, quad * 2 + 1], quad * 4);
  }
  const odd = new Uint8Array(quads);
  for (let quad = 1; quad < quads; quad += 2) odd[quad] = 1;
  const cornerValue = Float32Array.from({ length: quads * 4 }, (unused, corner) => corner);
  return createMeshData({
    positions, faceOffsets, cornerVertices,
    attributes: { face: { 'tag:odd': { data: odd, size: 1 } }, corner: { marker: { data: cornerValue, size: 1 } } },
  });
}

function build(frame, overrides = {}) {
  return applyMeshEdits(strip(), [{ op: 'build', start: 10, length: 50, frame, ...overrides }]).mesh;
}

function bytes(mesh) {
  return Buffer.concat([mesh.positions, mesh.faceOffsets, mesh.cornerVertices].map(array => Buffer.from(array.buffer, array.byteOffset, array.byteLength)));
}

test('faces appear in index order between start and start + length', () => {
  assert.equal(build(0).faceCount, 1);
  assert.equal(build(10).faceCount, 1);
  assert.equal(build(15).faceCount, 1);
  assert.equal(build(35).faceCount, 5);
  assert.equal(build(60).faceCount, 10);
  assert.equal(build(999).faceCount, 10);
  const half = build(35);
  const xs = Array.from({ length: half.vertexCount }, (unused, vertex) => half.positions[vertex * 3]);
  assert.equal(Math.max(...xs), 5);
  assert.equal(half.vertexCount, 12);
});

test('a build with no face showing is one zero-area triangle with finite normals', () => {
  const empty = build(0);
  assert.equal(empty.faceCount, 1);
  assert.equal(empty.vertexCount, 3);
  assert.ok(faceNormals(empty).normals.every(Number.isFinite));
});

test('the same frame gives the same bytes on every run and after seeking back', () => {
  const frames = [5, 20, 35, 50, 60, 35, 20];
  for (const order of ['index', 'random', 'axis']) {
    const first = frames.map(frame => bytes(build(frame, { order })));
    const second = frames.map(frame => bytes(build(frame, { order })));
    first.forEach((buffer, position) => assert.ok(buffer.equals(second[position]), `${order} at ${frames[position]}`));
    assert.ok(first[2].equals(first[5]), `${order} frame 35 matches after seeking`);
    assert.ok(first[1].equals(first[6]), `${order} frame 20 matches after seeking`);
  }
});

test('random order is seeded and grows the same set of faces step by step', () => {
  const faceXs = mesh => new Set(Array.from({ length: mesh.faceCount }, (unused, face) => mesh.positions[mesh.cornerVertices[mesh.faceOffsets[face]] * 3]));
  const seeded = build(35, { order: 'random', seed: 3 });
  const other = build(35, { order: 'random', seed: 4 });
  assert.equal(seeded.faceCount, 5);
  assert.notDeepEqual(Array.from(faceXs(seeded)), Array.from(faceXs(other)));
  const earlier = faceXs(build(25, { order: 'random', seed: 3 }));
  for (const x of earlier) assert.ok(faceXs(seeded).has(x), 'a face never disappears while building');
});

test('axis order starts at the lowest centroid and tags and corner attributes follow their faces', () => {
  const mesh = applyMeshEdits(strip(), [{ op: 'build', order: 'axis', axis: 'x', start: 0, length: 10, frame: 3 }]).mesh;
  assert.equal(mesh.faceCount, 3);
  assert.deepEqual(Array.from(mesh.attributes.face['tag:odd'].data), [0, 1, 0]);
  assert.deepEqual(Array.from(mesh.attributes.corner.marker.data), Array.from({ length: 12 }, (unused, corner) => corner));
});

test('reverse unbuilds and mirrors the count', () => {
  assert.equal(build(0, { reverse: true }).faceCount, 10);
  assert.equal(build(35, { reverse: true }).faceCount, 5);
  assert.equal(build(60, { reverse: true }).faceCount, 1);
  assert.equal(visibleBuildFaces(7, { frame: 1, start: 0, length: 3, reverse: false }), 2);
});

test('it works as a stack node', () => {
  const evaluated = evaluateMeshStack(strip(), [{ op: 'build', start: 0, length: 10, frame: 4 }]);
  assert.equal(evaluated.mesh.faceCount, 4);
});

test('a wrong field names the field and what to pass', () => {
  const run = edit => applyMeshEdits(strip(), [{ op: 'build', ...edit }]);
  assert.throws(() => run({ order: 'spiral' }), /edits\[0\]\.order.*index, random, axis/);
  assert.throws(() => run({ length: 0 }), /edits\[0\]\.length/);
  assert.throws(() => run({ frame: Infinity }), /edits\[0\]\.frame/);
  assert.throws(() => run({ seed: 1 }), /edits\[0\]\.seed.*random/);
  assert.throws(() => run({ order: 'random', seed: 1.5 }), /edits\[0\]\.seed/);
  assert.throws(() => run({ axis: 'x' }), /edits\[0\]\.axis.*axis/);
  assert.throws(() => run({ order: 'axis', axis: 'w' }), /edits\[0\]\.axis/);
  assert.throws(() => run({ reverse: 'yes' }), /edits\[0\]\.reverse/);
});

test('the capability note describes the fields', () => {
  assert.match(MESH_MODIFIER_NOTES.build, /order/);
});

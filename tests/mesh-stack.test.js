import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, sphere } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, lintMesh, meshBounds, tagCounts, facesWithTag, applyMeshEdits } from '../src/mesh.js';
import { mirrorMesh, arrayMesh, solidifyMesh, removeCoincidentFaces } from '../src/mesh-stack.js';
import { evaluateMeshStack, normalizeMeshStack } from '../src/mesh-recipe.js';
import { meshCacheStats } from '../src/agent-mesh.js';
import { createAgentScene } from '../src/agent-scene.js';

const cube = () => meshFromGeometry(box(0, 1));
const rounded = bounds => ({ min: bounds.min.map(value => Math.round(value * 1e5) / 1e5), max: bounds.max.map(value => Math.round(value * 1e5) / 1e5) });

function closedReport(mesh) {
  validateTopology(editMesh(mesh));
  const report = lintMesh(mesh);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.problems, []);
  return report;
}

test('mirroring a closed half that touches the plane gives one closed whole with swapped side tags', () => {
  const half = applyMeshEdits(cube(), [{ op: 'translate', offset: [0.5, 0, 0] }]).mesh;
  const whole = mirrorMesh(half, { axis: 'x' });
  const report = closedReport(whole);
  assert.equal(report.parts.count, 1);
  assert.deepEqual([whole.vertexCount, whole.faceCount], [12, 10]);
  assert.deepEqual(rounded(meshBounds(whole)), { min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] });
  const tags = tagCounts(whole);
  assert.equal(tags.left, 1);
  assert.equal(tags.right, 1);
  assert.equal(tags['mirror.mirrored'], 5);
  for (const face of facesWithTag(whole, 'left')) {
    const vertex = whole.cornerVertices[whole.faceOffsets[face]];
    assert.ok(whole.positions[vertex * 3] < 0, 'the face tagged left is on the left');
  }
});

test('mirror across y and z keeps parts separate when they do not touch the plane', () => {
  const lifted = applyMeshEdits(cube(), [{ op: 'translate', offset: [0, 1, 0] }]).mesh;
  const report = closedReport(mirrorMesh(lifted, { axis: 'y' }));
  assert.deepEqual(report.parts, { count: 2, closed: 2, cavities: 0 });
  assert.throws(() => mirrorMesh(cube(), { axis: 'w' }), /axis must be x, y or z/);
});

test('array repeats with relative and constant offsets and merges touching copies', () => {
  const merged = arrayMesh(cube(), { count: 4, merge: 1e-4 });
  const report = closedReport(merged);
  assert.equal(report.parts.count, 1);
  assert.equal(merged.faceCount, 18, 'the faces between copies are removed');
  assert.deepEqual(rounded(meshBounds(merged)), { min: [-0.5, -0.5, -0.5], max: [3.5, 0.5, 0.5] });
  const spaced = arrayMesh(cube(), { count: 3, offset: [0, 0, -2], relativeOffset: [0, 0, 0] });
  assert.equal(closedReport(spaced).parts.count, 3);
  assert.equal(tagCounts(spaced)['array.last'], 6);
});

test('solidify turns an open surface into a closed wall and a closed surface into a hollow shell', () => {
  const cup = solidifyMesh(applyMeshEdits(cube(), [{ op: 'delete', select: { tag: 'top' } }]).mesh, { thickness: 0.05 });
  const cupReport = closedReport(cup);
  assert.equal(cupReport.parts.count, 1);
  assert.deepEqual(rounded(meshBounds(cup)), { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, 'offset -1 grows inward');
  const tags = tagCounts(cup);
  assert.equal(tags['solidify.inner'], 5);
  assert.equal(tags['solidify.rim'], 4);
  assert.equal(tags.top, 0, 'inner and rim faces do not inherit base tags');
  const shell = solidifyMesh(meshFromGeometry(sphere(24, 12)), { thickness: 0.1, offset: 1 });
  const shellReport = closedReport(shell);
  assert.equal(shellReport.parts.cavities, 1);
  assert.ok(meshBounds(shell).max[1] > 1.09, 'offset 1 grows outward');
});

test('even thickness keeps flat walls at the full thickness at corners', () => {
  const plate = applyMeshEdits(cube(), [{ op: 'delete', select: { not: { tag: 'top' } } }]).mesh;
  const even = solidifyMesh(applyMeshEdits(cube(), [{ op: 'delete', select: { tag: 'top' } }]).mesh, { thickness: 0.1 });
  const inner = facesWithTag(even, 'solidify.inner');
  const floor = inner.find(face => {
    const vertex = even.cornerVertices[even.faceOffsets[face]];
    return Math.abs(even.positions[vertex * 3 + 1] + 0.4) < 1e-5;
  });
  assert.notEqual(floor, undefined, 'the inner floor sits exactly one thickness above the outer floor');
  assert.equal(plate.faceCount, 1);
});

test('removeCoincidentFaces drops back-to-back faces and keeps one of duplicates', () => {
  const doubled = applyMeshEdits(cube(), [{ op: 'translate', offset: [0.5, 0, 0] }]).mesh;
  const pair = arrayMesh(doubled, { count: 2 });
  const welded = removeCoincidentFaces(applyMeshEdits(pair, [{ op: 'merge_by_distance', distance: 1e-4 }]).mesh);
  assert.equal(welded.removedFaces, 2);
});

test('stack validation names allowed nodes and defaults names per position', () => {
  assert.throws(() => normalizeMeshStack([{ op: 'extrude_individual', offset: 1 }]), /op must be one of mirror, array, solidify/);
  assert.throws(() => normalizeMeshStack(Array.from({ length: 17 }, () => ({ op: 'mirror' }))), /at most 16/);
  assert.deepEqual(normalizeMeshStack([{ op: 'mirror' }, { op: 'array', count: 3 }]).map(node => node.name), ['mirror-s1', 'array-s2']);
});

test('stack evaluation caches each prefix and recomputes only changed nodes', () => {
  const store = new Map();
  let gets = 0;
  const cache = { get: key => { gets++; return store.get(key); }, set: (key, value) => store.set(key, value) };
  const stack = [{ op: 'mirror', axis: 'x' }, { op: 'array', count: 3, relativeOffset: [0, 0, 1.5] }];
  const half = applyMeshEdits(cube(), [{ op: 'translate', offset: [0.5, 0, 0] }]).mesh;
  const first = evaluateMeshStack(half, stack, { cache, cacheKey: 'half' });
  assert.ok(first.results.every(result => !result.cached));
  const changed = evaluateMeshStack(half, [stack[0], { ...stack[1], count: 4 }], { cache, cacheKey: 'half' });
  assert.deepEqual(changed.results.map(result => Boolean(result.cached)), [true, false]);
  assert.equal(closedReport(changed.mesh).parts.count, 4);
  assert.ok(gets >= 4);
});

test('recipe meshes evaluate stacks, reuse cached prefixes and apply nodes into the edit log', () => {
  const recipe = stack => ({
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'wing', type: 'mesh', base: { type: 'box', bevel: 0 },
      edits: [{ op: 'translate', offset: [0.5, 0, 0] }, { op: 'inset_individual', select: { tag: 'front' }, thickness: 0.1, name: 'panel' }],
      stack }],
    materials: [{ id: 'paint', color: [0.8, 0.2, 0.2] }],
    nodes: [{ id: 'wing', geometry: 'wing', material: 'paint' }],
  });
  const scene = createAgentScene(recipe([{ op: 'mirror' }, { op: 'solidify', thickness: 0.05 }]));
  const [report] = scene.inspectMeshes().meshes;
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(report.stack.map(result => result.op), ['mirror', 'solidify']);
  assert.equal(report.parts.cavities, 1, 'solidifying a closed mesh makes a hollow');
  const before = meshCacheStats();
  scene.apply([{ type: 'set-mesh-stack', geometry: 'wing', stack: [{ op: 'mirror' }, { op: 'array', count: 2, relativeOffset: [0, 0, 1.2] }] }], { expectedRevision: 0 });
  const after = meshCacheStats();
  assert.ok(after.hits >= before.hits + 2, 'edits and the mirror prefix come from the cache');
  const [changed] = scene.inspectMeshes().meshes;
  assert.equal(changed.parts.count, 2);
  assert.equal(changed.stack[0].cached, true);
  scene.apply([{ type: 'set-mesh-stack', geometry: 'wing', apply: 1 }], { expectedRevision: 1 });
  const exported = scene.exportRecipe().geometries[0];
  assert.deepEqual(exported.edits.map(edit => edit.op), ['translate', 'inset_individual', 'mirror']);
  assert.deepEqual(exported.stack.map(node => node.op), ['array']);
  const [applied] = scene.inspectMeshes().meshes;
  assert.equal(applied.counts.faces, changed.counts.faces, 'applying a node does not change the result');
  assert.throws(() => scene.apply([{ type: 'set-mesh-stack', geometry: 'wing', apply: 5 }], { expectedRevision: 2 }), /apply must be an integer from 0 to the stack length 1/);
  assert.throws(() => scene.apply([{ type: 'set-mesh-stack', geometry: 'wing', stack: [{ op: 'translate', offset: [0, 1, 0] }] }], { expectedRevision: 2 }), /op must be one of mirror/);
  assert.equal(scene.revision, 2);
});

test('an array over the budget fails before it allocates, and names the fix', () => {
  const edits = [{ op: 'array', count: 200 }];
  assert.throws(() => applyMeshEdits(cube(), edits, { maxVertices: 100, maxFaces: 100 }), /edits\[0\]\.count: got 200; expected a count that keeps the mesh within 100 vertices and 100 faces \(this edit would make 1600 vertices/);
  assert.throws(() => evaluateMeshStack(cube(), edits, { maxVertices: 100, maxFaces: 100 }), /would make 1600 vertices/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { box } from '../src/geometry.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { loadMeshBooleans } from '../src/agent-scene.js';
import { importedMeshReport } from '../src/agent-mesh-engine.js';
import { validateSkinGeometry } from '../src/skinning.js';

// CC0 RobotExpressive: parts 1 (Torso_1) is rigid, 3 (Head_2) has three morph targets, 15 (HandR_1) is skinned.
const robotBytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
const ASSET_ID = 'ab'.repeat(32);
const TORSO = 'mesh-1';
const HEAD = 'mesh-3';
const HAND = 'mesh-15';
const LEG = 'mesh-10';

await loadMeshBooleans();

function loadRobot() {
  return parseGltf(robotBytes.buffer.slice(robotBytes.byteOffset, robotBytes.byteOffset + robotBytes.byteLength), { maxVertices: 500000 });
}

function createScene(asset, extra = {}) {
  return createAgentAssetScene(asset, { format: '67js.asset', schemaVersion: 1, assetId: ASSET_ID, ...extra });
}

function editOperation(geometry, edits, replace) {
  return { type: 'edit-mesh', geometry, edits, ...(replace === undefined ? {} : { replace }) };
}

function applyEdits(scene, geometry, edits) {
  return scene.apply([editOperation(geometry, edits)], { expectedRevision: scene.revision });
}

function partOf(scene, id) {
  return scene.parts[Number(id.slice(5))];
}

function skinWeightSums(geometry) {
  const sums = [];
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    let sum = 0;
    for (let influence = 0; influence < 4; influence++) sum += geometry.skinWeights[vertex * 4 + influence];
    sums.push(sum);
  }
  return sums;
}

test('cutting a hole in a rigid imported part keeps its material and passes the topology check', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const before = partOf(scene, TORSO);
  const revisionBefore = scene.revision;
  applyEdits(scene, TORSO, [{ op: 'delete', select: { tag: 'top' } }]);
  const after = partOf(scene, TORSO);
  assert.equal(scene.revision, revisionBefore + 1);
  assert.equal(scene.topologyRevision, 1);
  assert.notEqual(after.geometry, before.geometry);
  assert.ok(after.geometry.indices.length < before.geometry.indices.length);
  assert.equal(after.material, before.material);
  assert.equal(after.matrix, before.matrix, 'the matrix array keeps its identity so poses keep writing to it');
  const report = scene.inspectMeshes({ geometries: [TORSO] }).meshes[0];
  assert.ok(report.edits.length === 1);
  assert.ok(Object.hasOwn(report.tags, 'material-0'), `tags: ${Object.keys(report.tags)}`);
  assert.ok(report.localToWorldScale.every(value => value > 1), 'imported parts live in a small local space; the report gives the scale');
  assert.equal(scene.exportRecipe().meshEdits[0].id, TORSO);
  asset.dispose();
});

test('a boolean difference cuts a through hole in a closed imported part and an open part says how to close it', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const before = scene.inspectMeshes({ geometries: [LEG] }).meshes[0];
  assert.equal(before.parts.closed, 1);
  const cutter = { type: 'cylinder', segments: 24 };
  applyEdits(scene, LEG, [{ op: 'boolean', operation: 'difference', cutter, scale: [0.0003, 0.01, 0.0003] }]);
  const after = scene.inspectMeshes({ geometries: [LEG] }).meshes[0];
  assert.equal(after.ok, true);
  const eulerCharacteristic = after.counts.vertices - after.counts.edges + after.counts.faces;
  assert.equal((2 * after.parts.count - eulerCharacteristic) / 2, 1, 'a through hole is one handle');
  assert.ok(after.counts.triangles > before.counts.triangles);
  assert.throws(
    () => applyEdits(scene, TORSO, [{ op: 'boolean', operation: 'difference', cutter, scale: [0.004, 0.05, 0.004] }]),
    /must be closed.*fill_holes/s,
  );
  asset.dispose();
});

test('skin weights follow an edit: unmoved vertices keep theirs and new ones sum to one', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const source = partOf(scene, HAND).geometry;
  applyEdits(scene, HAND, [{ op: 'bevel', edges: { all: true }, width: 0.005, segments: 1 }]);
  const beveled = partOf(scene, HAND).geometry;
  assert.ok(beveled.positions.length > source.positions.length);
  validateSkinGeometry(beveled, partOf(scene, HAND).skin);
  for (const sum of skinWeightSums(beveled)) assert.ok(Math.abs(sum - 1) < 1e-4, `weights sum to ${sum}`);
  scene.apply([editOperation(HAND, [{ op: 'delete', select: { tag: 'top' } }], true)], { expectedRevision: scene.revision });
  const edited = partOf(scene, HAND).geometry;
  assert.ok(edited.positions.length < source.positions.length);
  validateSkinGeometry(edited, partOf(scene, HAND).skin);
  const exact = new Map();
  for (let vertex = 0; vertex < source.positions.length / 3; vertex++) {
    exact.set(source.positions.slice(vertex * 3, vertex * 3 + 3).join(), Array.from(source.skinWeights.slice(vertex * 4, vertex * 4 + 4)).join());
  }
  let matched = 0;
  for (let vertex = 0; vertex < edited.positions.length / 3; vertex++) {
    const expected = exact.get(edited.positions.slice(vertex * 3, vertex * 3 + 3).join());
    if (expected === undefined) continue;
    matched++;
    assert.equal(Array.from(edited.skinWeights.slice(vertex * 4, vertex * 4 + 4)).join(), expected);
  }
  assert.ok(matched > 0, 'some vertices sit where source vertices were');
  const pose = scene.apply([{ type: 'set-animation', clip: 0, time: 0.4 }], { expectedRevision: scene.revision });
  assert.equal(pose, scene.revision, 'an edited skinned part still poses through the clip');
  asset.dispose();
});

test('morph targets follow an edit with one delta per vertex and the weights keep their identity', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const morph = partOf(scene, HEAD).morph;
  applyEdits(scene, HEAD, [{ op: 'delete', select: { tag: 'top' } }]);
  const edited = partOf(scene, HEAD);
  assert.equal(edited.morph, morph);
  assert.equal(edited.geometry.morphTargets.length, 3);
  for (const target of edited.geometry.morphTargets) {
    assert.equal(target.positions.length, edited.geometry.positions.length);
  }
  assert.equal(scene.inspectMeshes({ geometries: [HEAD] }).meshes[0].transfer.morphTargets, 3);
  asset.dispose();
});

test('an edit that would turn skin or morph transfer into a guess is rejected and names the next action', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const revision = scene.revision;
  assert.throws(
    () => applyEdits(scene, HEAD, [{ op: 'extrude_face_region', select: { tag: 'top' }, offset: 3 }]),
    error => /skin weights and morph targets would be guesses/.test(error.message) && /Keep edits within/.test(error.message),
  );
  assert.equal(scene.revision, revision);
  assert.equal(scene.topologyRevision, 0);
  assert.equal(partOf(scene, HEAD).geometry, asset.parts[3].geometry);
  asset.dispose();
});

test('a checkpoint undoes a mesh edit and replace swaps the log', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const handle = scene.checkpoint();
  applyEdits(scene, TORSO, [{ op: 'delete', select: { tag: 'top' } }]);
  const facesAfterOne = partOf(scene, TORSO).geometry.indices.length;
  applyEdits(scene, TORSO, [{ op: 'delete', select: { tag: 'bottom' } }]);
  assert.ok(partOf(scene, TORSO).geometry.indices.length < facesAfterOne);
  scene.apply([editOperation(TORSO, [{ op: 'delete', select: { tag: 'top' } }], true)], { expectedRevision: scene.revision });
  assert.equal(partOf(scene, TORSO).geometry.indices.length, facesAfterOne);
  scene.restore(handle, { expectedRevision: scene.revision });
  assert.equal(partOf(scene, TORSO).geometry, asset.parts[1].geometry);
  assert.equal(scene.exportRecipe().meshEdits, undefined);
  asset.dispose();
});

test('restoreRevision undoes mesh edits of an asset without a checkpoint', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  applyEdits(scene, TORSO, [{ op: 'delete', select: { tag: 'top' } }]);
  applyEdits(scene, TORSO, [{ op: 'delete', select: { tag: 'bottom' } }]);
  const edited = partOf(scene, TORSO).geometry.indices.length;
  scene.restoreRevision(0, { expectedRevision: scene.revision });
  assert.equal(partOf(scene, TORSO).geometry, asset.parts[1].geometry);
  assert.equal(scene.exportRecipe().meshEdits, undefined);
  assert.throws(() => scene.restoreRevision(9, { expectedRevision: scene.revision }), /kept revisions: 0, 1, 2/);
  scene.restoreRevision(2, { expectedRevision: scene.revision });
  assert.equal(partOf(scene, TORSO).geometry.indices.length, edited);
  asset.dispose();
});

test('an exported recipe replays the edits on a fresh decode', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  applyEdits(scene, TORSO, [{ op: 'delete', select: { tag: 'top' } }]);
  const recipe = scene.exportRecipe();
  const replayAsset = await loadRobot();
  const replay = createScene(replayAsset, recipe);
  assert.deepEqual(Array.from(partOf(replay, TORSO).geometry.positions), Array.from(partOf(scene, TORSO).geometry.positions));
  asset.dispose();
  replayAsset.dispose();
});

test('hostile mesh edits are rejected without changing the scene', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const revision = scene.revision;
  const hostile = [
    ['unknown mesh', () => applyEdits(scene, 'mesh-99', [{ op: 'delete', select: { tag: 'top' } }]), /^RangeError: operations\[0\]\.geometry: got "mesh-99"; expected an imported mesh ID such as mesh-0/],
    ['prototype key', () => applyEdits(scene, '__proto__', [{ op: 'delete', select: { tag: 'top' } }]), /^RangeError: operations\[0\]\.geometry: got "__proto__"; expected an imported mesh ID such as mesh-0/],
    ['edits not an array', () => scene.apply([{ type: 'edit-mesh', geometry: TORSO, edits: 'delete' }], { expectedRevision: revision }), /^TypeError: operations\[0\]\.edits: got "delete"; expected an array of edits, such as/],
    ['unknown operation', () => applyEdits(scene, TORSO, [{ op: 'explode' }]), /explode|op/],
    ['not a number', () => applyEdits(scene, TORSO, [{ op: 'extrude_face_region', select: { tag: 'top' }, offset: Number.NaN }]), /offset|finite/],
    ['selects nothing', () => applyEdits(scene, TORSO, [{ op: 'delete', select: { tag: 'no-such-tag' } }]), /select|tag|no faces/i],
    ['too many edits', () => applyEdits(scene, TORSO, Array.from({ length: 65 }, () => ({ op: 'flip_normals', select: { tag: 'top' } }))), /64|edits/],
    ['array bomb', () => applyEdits(scene, TORSO, [{ op: 'array', count: 10000, offset: [1, 0, 0] }]), /count|vertices|budget|limit/i],
    ['mesh cutter', () => applyEdits(scene, TORSO, [{ op: 'boolean', operation: 'difference', cutter: { type: 'mesh', id: 'x' } }]), /cutter/i],
    ['extra operation field', () => scene.apply([{ type: 'edit-mesh', geometry: TORSO, edits: [], stack: [] }], { expectedRevision: revision }), /stack|unknown|key/i],
    ['stack operation', () => scene.apply([{ type: 'set-mesh-stack', geometry: TORSO, stack: [] }], { expectedRevision: revision }), /edit-mesh/],
    ['stale revision', () => scene.apply([editOperation(TORSO, [{ op: 'delete', select: { tag: 'top' } }])], { expectedRevision: revision + 5 }), /expectedRevision/],
  ];
  for (const [label, attempt, pattern] of hostile) {
    assert.throws(attempt, pattern, label);
    assert.equal(scene.revision, revision, `${label} left the revision alone`);
    assert.equal(scene.topologyRevision, 0, `${label} left the topology alone`);
  }
  assert.throws(() => createScene(asset, { meshEdits: [{ id: TORSO, edits: [{ op: 'delete', select: { tag: 'top' } }], extra: 1 }] }), /meshEdits/);
  assert.throws(() => createScene(asset, { meshEdits: [{ id: TORSO, edits: [] }, { id: TORSO, edits: [] }] }), /^RangeError: meshEdits.1.[.]id: got "[^"]+"; expected an imported mesh ID used once, such as /);
  asset.dispose();
});

function uvBoxGlb() {
  const geometry = box(0, 1);
  const uvs = new Float32Array(geometry.positions.length / 3 * 2);
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    uvs[vertex * 2] = geometry.positions[vertex * 3] * 0.5 + 0.5;
    uvs[vertex * 2 + 1] = geometry.positions[vertex * 3 + 2] * 0.5 + 0.5;
  }
  const part = { name: 'Crate', geometry: { ...geometry, uvs }, matrix: mat4.create(), material: { color: [1, 1, 1], metallic: 0, roughness: 1 } };
  return exportGlb([part]);
}

test('UVs survive an edit, and faces an edit leaves without UVs read the nearest original island', async () => {
  const asset = await parseGltf(uvBoxGlb());
  const scene = createScene(asset);
  assert.ok(partOf(scene, 'mesh-0').geometry.uvs);
  applyEdits(scene, 'mesh-0', [{ op: 'bevel', edges: { all: true }, width: 0.05, segments: 2 }]);
  const edited = partOf(scene, 'mesh-0').geometry;
  assert.equal(edited.uvs.length / 2, edited.positions.length / 3);
  let zero = 0;
  for (let vertex = 0; vertex < edited.uvs.length / 2; vertex++) {
    assert.ok(edited.uvs[vertex * 2] >= -0.2 && edited.uvs[vertex * 2] <= 1.2);
    if (edited.uvs[vertex * 2] === 0 && edited.uvs[vertex * 2 + 1] === 0) zero++;
  }
  assert.ok(zero < edited.uvs.length / 2 / 4, `${zero} vertices kept the empty 0,0 UV`);
  assert.ok(scene.inspectMeshes({ geometries: ['mesh-0'] }).meshes[0].transfer.uvFacesRebuilt > 0);
  asset.dispose();
});

test('imported parts report as polygon meshes with the shared lint', async () => {
  const asset = await loadRobot();
  const scene = createScene(asset);
  const meshes = scene.inspectMeshes().meshes;
  assert.equal(meshes.length, 16);
  assert.equal(importedMeshReport(asset.parts[1].geometry).counts.triangles, asset.parts[1].geometry.indices.length / 3);
  assert.throws(() => scene.inspectMeshes({ geometries: Array.from({ length: 17 }, (_, index) => `mesh-${index}`) }), /at most/);
  asset.dispose();
});

test('inspect accepts a source-node ID and lists its parts and those of the nodes below it', async () => {
  const scene = createScene(await loadRobot());
  const nodes = scene.inspect({ kind: 'hierarchy', limit: 256 }).nodes;
  const single = nodes.find(node => node.meshIds.length === 1);
  const several = nodes.find(node => node.meshIds.length > 1);
  const empty = nodes.find(node => node.meshIds.length === 0 && !nodes.some(other => other.parent === node.id));
  assert.ok(single && several && empty, 'the robot has leaf, group and childless mesh-less nodes');
  const byNode = scene.inspect({ ids: [single.id] }).nodes;
  assert.deepEqual(byNode.map(node => node.id), single.meshIds);
  assert.ok(byNode.every(node => node.fromNode === single.id), 'each part says which node it came from');
  const bySeveral = scene.inspect({ ids: [several.id] }).nodes.map(node => node.id);
  assert.ok(several.meshIds.every(id => bySeveral.includes(id)));
  assert.ok(scene.inspect({ ids: [several.id] }).nodes.every(node => node.fromNode === several.id));
  assert.equal(scene.inspect({ ids: [single.meshIds[0]] }).nodes[0].fromNode, undefined);
  assert.throws(() => scene.inspect({ ids: [empty.id] }), /^RangeError: geometry: got .*; expected a source node with a mesh of its own or below it, or a mesh ID such as "mesh-0"/);
  assert.throws(() => scene.inspect({ ids: ['nothing-here'] }), /^RangeError: geometry: got "nothing-here"; expected an imported mesh ID such as "mesh-0"/);
});

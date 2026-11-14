import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

const recipe = () => ({ format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) });

async function fixture(edit) {
  return parseGltf(skinnedStripAsset(edit));
}

function pose(asset) {
  return asset.parts.map(part => ({
    matrix: Array.from(part.matrix), joints: Array.from(part.skin?.jointMatrices ?? []),
    weights: Array.from(part.morph?.weights ?? []),
  }));
}

test('decoded resources and retained identities survive root, look, and material edits', async () => {
  const asset = await fixture();
  const descriptor = { data: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 };
  asset.parts[0].material.map = descriptor;
  const scene = createAgentAssetScene(asset, recipe());
  const part = scene.parts[0];
  const matrix = part.matrix;
  const initialCamera = scene.camera;
  assert.deepEqual(initialCamera.target, [1, 3, 0]);
  assert.equal(part.geometry, asset.parts[0].geometry);
  assert.equal(part.skin, asset.parts[0].skin);
  assert.equal(part.material.map, descriptor);
  scene.apply([
    { type: 'set-root', translation: [4, 0, 0] },
    { type: 'set-material', id: 'material-0', color: [0.2, 0.3, 0.4] },
    { type: 'set-effects', effects: { bloom: { strength: 0.25 } } },
  ], { expectedRevision: 0 });
  assert.equal(scene.parts[0], part);
  assert.equal(part.matrix, matrix);
  assert.equal(part.matrix[12], 5);
  assert.deepEqual(part.material.color, [0.2, 0.3, 0.4]);
  assert.equal(scene.effects.bloom.strength, 0.25);
  assert.deepEqual(scene.camera, initialCamera);
  assert.equal(scene.topologyRevision, 0);
  assert.equal(scene.inspect().counts.materials, 1);
  assert.equal(scene.inspect().nodes[0].id, 'mesh-0');
  const bounds = scene.inspect({ includeBounds: true }).nodes[0];
  assert.equal(bounds.boundsKind, 'authored-base-world');
  assert.ok(Math.abs(bounds.bounds.min[0] - 4.7) < 1e-6);
  asset.dispose();
});

test('absolute animation reverse seeks and initial-pose reset are deterministic', async () => {
  const asset = await fixture();
  const initialPose = pose(asset);
  const scene = createAgentAssetScene(asset, recipe());
  scene.apply([{ type: 'set-animation', clip: 0, time: 0.5 }], { expectedRevision: 0 });
  const halfPose = pose(asset);
  scene.apply([{ type: 'set-animation', time: 1.5 }], { expectedRevision: 1 });
  assert.notDeepEqual(pose(asset), halfPose);
  scene.apply([{ type: 'set-animation', time: 0.5 }], { expectedRevision: 2 });
  assert.deepEqual(pose(asset), halfPose);
  scene.apply([{ type: 'set-animation', clip: 1 }], { expectedRevision: 3 });
  assert.deepEqual(scene.exportRecipe().animation, { clip: 1, time: 0 });
  scene.apply([{ type: 'set-animation', clip: null }], { expectedRevision: 4 });
  assert.deepEqual(pose(asset), initialPose);
  assert.equal(scene.exportRecipe().animation, null);
  asset.dispose();
});

test('failed commands and Float32 root staging leave pose, recipe, materials, and revision atomic', async () => {
  const asset = await fixture();
  const scene = createAgentAssetScene(asset, { ...recipe(), animation: { clip: 0, time: 0.75 } });
  const checkpointRecipe = scene.exportRecipe();
  const checkpointPose = pose(asset);
  const matrix = Array.from(scene.parts[0].matrix);
  assert.throws(() => scene.apply([
    { type: 'set-material', id: 'material-0', color: [1, 0, 0] },
    { type: 'set-animation', time: 1.5 },
    { type: 'set-root', scale: [1e-40, 1e-40, 1e-40] },
  ], { expectedRevision: 0 }), /nonsingular/);
  assert.deepEqual(scene.exportRecipe(), checkpointRecipe);
  assert.deepEqual(pose(asset), checkpointPose);
  assert.deepEqual(Array.from(scene.parts[0].matrix), matrix);
  assert.equal(scene.revision, 0);
  assert.throws(() => scene.apply([{ type: 'set-root', translation: [2, 0, 0] }, { type: 'add-node', node: {} }], { expectedRevision: 0 }), /^TypeError: operations\[1\]\.type: got "add-node"; expected one of set-camera, set-root/);
  assert.deepEqual(scene.exportRecipe(), checkpointRecipe);
  scene.apply([{ type: 'set-animation', time: 0.25 }], { expectedRevision: 0 });
  assert.equal(scene.revision, 1);
  asset.dispose();
});

test('real decoded morph weights retain identity and restore alongside animation', async () => {
  const asset = await fixture((document, append) => {
    const positions = append(new Float32Array(Array.from({ length: 6 }, () => [0, 0, 0.5]).flat()), 'VEC3');
    document.accessors[positions].min = [0, 0, 0.5];
    document.accessors[positions].max = [0, 0, 0.5];
    document.meshes[0].primitives[0].targets = [{ POSITION: positions }];
    document.meshes[0].weights = [0];
    const times = append(new Float32Array([0, 2]), 'SCALAR');
    const weights = append(new Float32Array([0, 1]), 'SCALAR');
    document.animations.push({
      name: 'Morph', samplers: [{ input: times, output: weights }],
      channels: [{ sampler: 0, target: { node: 1, path: 'weights' } }],
    });
  });
  const scene = createAgentAssetScene(asset, recipe());
  const weights = scene.parts[0].morph.weights;
  const checkpoint = scene.checkpoint();
  scene.apply([{ type: 'set-animation', clip: 2, time: 1 }], { expectedRevision: 0 });
  assert.equal(weights[0], 0.5);
  assert.equal(scene.parts[0].morph, asset.parts[0].morph);
  scene.restore(checkpoint, { expectedRevision: 1 });
  assert.equal(scene.parts[0].morph.weights, weights);
  assert.equal(weights[0], 0);
  assert.equal(scene.inspect().nodes[0].morphTargets, 1);
  asset.dispose();
});

test('checkpoint handles are private, bounded, revision checked, and restore identities', async () => {
  const asset = await fixture();
  const scene = createAgentAssetScene(asset, recipe());
  const handles = Array.from({ length: 8 }, () => scene.checkpoint());
  assert.throws(() => scene.checkpoint(), /^RangeError: checkpoints: got .*; expected at most 8 saved checkpoints; release one first, such as/);
  assert.throws(() => scene.restore({}, { expectedRevision: 0 }), /^RangeError: checkpointId: got .*; expected a checkpointId that scene_checkpoint returned and you have not released, such as/);
  const parts = scene.parts;
  scene.apply([{ type: 'set-root', scale: [2, 2, 2] }], { expectedRevision: 0 });
  assert.throws(() => scene.restore(handles[0], { expectedRevision: 0 }), /expectedRevision/);
  scene.restore(handles[0], { expectedRevision: 1 });
  assert.equal(scene.parts, parts);
  assert.equal(scene.revision, 2);
  assert.deepEqual(scene.exportRecipe().root.scale, [1, 1, 1]);
  scene.releaseCheckpoint(handles[0]);
  assert.throws(() => scene.releaseCheckpoint(handles[0]), /^RangeError: checkpointId: got .*; expected a checkpointId that scene_checkpoint returned and you have not released, such as/);
  assert.throws(() => scene.restore(handles[0], { expectedRevision: 2 }), /^RangeError: checkpointId: got .*; expected a checkpointId that scene_checkpoint returned and you have not released, such as/);
  scene.checkpoint();
  asset.dispose();
});

test('ordinary JSON, strict schemas, numeric domains, budgets, and stale revisions reject', async () => {
  const asset = await fixture();
  for (const invalid of [
    { ...recipe(), unknown: 1 }, { ...recipe(), root: { scale: [0, 1, 1] } },
    { ...recipe(), root: { rotation: [0, 0, 0, 0] } },
    { ...recipe(), animation: { clip: 0, time: 3 } },
    { ...recipe(), materialOverrides: [{ id: 'material-9', color: [1, 1, 1] }] },
    { ...recipe(), effects: { bloom: { unknown: 1 } } },
    { ...recipe(), assetId: 'x'.repeat(64) },
  ]) {
    assert.throws(() => createAgentAssetScene(asset, invalid));
  }
  let accessorRead = false;
  const accessor = recipe();
  Object.defineProperty(accessor, 'root', { enumerable: true, get() { accessorRead = true; return {}; } });
  assert.throws(() => createAgentAssetScene(asset, accessor), /accessors/);
  assert.equal(accessorRead, false);
  assert.throws(() => createAgentAssetScene(asset, { ...recipe(), root: { translation: [1, , 3] } }), /dense/);
  assert.throws(() => createAgentAssetScene(asset, { ...recipe(), extra: 'x'.repeat(1024 * 1024) }), /1 MiB/);
  const scene = createAgentAssetScene(asset, recipe());
  assert.throws(() => scene.apply([{ type: 'set-root', scale: [2, 2, 2] }]), /expectedRevision/);
  assert.throws(() => scene.apply([{ type: 'set-animation', clip: null, time: 0 }], { expectedRevision: 0 }), /^TypeError: operations\[0\]\.time: got 0; expected no time when clip is null/);
  assert.throws(() => scene.inspect({ ids: ['mesh-9'] }), /^RangeError: geometry: got "mesh-9"; expected an imported mesh ID such as "mesh-0"/);
  assert.throws(() => createAgentAssetScene({ ...asset, animations: Array(257).fill(asset.animations[0]) }, recipe()), /budgets/);
  assert.throws(() => createAgentAssetScene({ ...asset, parts: Array(4097).fill(asset.parts[0]) }, recipe()), /budgets/);
  asset.dispose();
});

test('detached matrices and replaced pose buffers fail before publishing canonical state', async () => {
  const asset = await fixture();
  const scene = createAgentAssetScene(asset, recipe());
  const before = scene.exportRecipe();
  const palette = asset.parts[0].skin.jointMatrices;
  asset.parts[0].skin.jointMatrices = new Float32Array(palette);
  assert.throws(() => scene.apply([{ type: 'set-root', translation: [1, 0, 0] }], { expectedRevision: 0 }), /identity/);
  asset.parts[0].skin.jointMatrices = palette;
  structuredClone(scene.parts[0].matrix, { transfer: [scene.parts[0].matrix.buffer] });
  assert.throws(() => scene.apply([{ type: 'set-root', translation: [1, 0, 0] }], { expectedRevision: 0 }), /detach/);
  assert.equal(scene.revision, 0);
  assert.deepEqual(scene.exportRecipe(), before);
  asset.dispose();
});

test('nonanimated assets support root edits and detached exports while clips reject', async () => {
  const asset = await fixture(document => { document.animations = []; });
  const scene = createAgentAssetScene(asset, recipe());
  assert.throws(() => scene.apply([{ type: 'set-animation', clip: 0 }], { expectedRevision: 0 }), /^RangeError: animation\.clip: got 0; expected no animation, since this asset has no clips; drop it, such as null/);
  const exported = scene.exportRecipe();
  exported.root.translation[0] = 100;
  const camera = scene.camera;
  camera.eye[0] = 100;
  assert.deepEqual(scene.exportRecipe().root.translation, [0, 0, 0]);
  assert.notEqual(scene.camera.eye[0], 100);
  assert.throws(() => { scene.parts[0].material.color[0] = 100; }, TypeError);
  scene.apply([{ type: 'set-root', rotation: [0, 0, 0, 2] }], { expectedRevision: 0 });
  assert.deepEqual(scene.exportRecipe().root.rotation, [0, 0, 0, 1]);
  asset.dispose();
});

test('decoder animation validation failure rolls back and permits later valid seeks', async () => {
  const asset = await fixture((document, append) => {
    const times = append(new Float32Array([0, 2]), 'SCALAR');
    const scales = append(new Float32Array([1, 1, 1, 0, 0, 0]), 'VEC3');
    document.animations.push({
      name: 'Collapse', samplers: [{ input: times, output: scales }],
      channels: [{ sampler: 0, target: { node: 0, path: 'scale' } }],
    });
  });
  const scene = createAgentAssetScene(asset, { ...recipe(), animation: { clip: 0, time: 0.5 } });
  const previousPose = pose(asset);
  const previousRecipe = scene.exportRecipe();
  assert.throws(() => scene.apply([{ type: 'set-animation', clip: 2, time: 2 }], { expectedRevision: 0 }));
  assert.deepEqual(pose(asset), previousPose);
  assert.deepEqual(scene.exportRecipe(), previousRecipe);
  assert.equal(scene.revision, 0);
  scene.apply([{ type: 'set-animation', clip: 0, time: 0.25 }], { expectedRevision: 0 });
  assert.equal(scene.revision, 1);
  asset.dispose();
});

test('decoded instances share original geometry and material wrappers', async () => {
  const asset = await fixture(document => {
    document.nodes.push({ name: 'Second strip', mesh: 0, skin: 0, translation: [3, 0, 0] });
    document.nodes[0].children.push(4);
  });
  const scene = createAgentAssetScene(asset, recipe());
  assert.equal(scene.parts.length, 2);
  assert.equal(scene.parts[0].geometry, scene.parts[1].geometry);
  assert.equal(scene.parts[0].material, scene.parts[1].material);
  assert.equal(scene.inspect().counts.geometries, 1);
  scene.apply([{ type: 'set-material', id: 'material-0', roughness: 0.2 }], { expectedRevision: 0 });
  assert.equal(scene.parts[1].material.roughness, 0.2);
  asset.dispose();
});

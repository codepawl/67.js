import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

const recipe = () => ({ format: 'crucible.asset', schemaVersion: 1, assetId: 'ac'.repeat(32) });
const motion = () => ({ duration: 2, tracks: [{ kind: 'node', id: 'node-3', property: 'rotation',
  keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 2, value: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }] }] });
const pose = scene => scene.parts.map(part => ({ matrix: [...part.matrix], palette: [...(part.skin?.jointMatrices ?? [])], weights: [...(part.morph?.weights ?? [])] }));

test('imported source-node authoring reaches actual joints with stable hierarchy IDs', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  try {
    const scene = createAgentAssetScene(asset, recipe());
    const hierarchy = scene.inspect({ kind: 'hierarchy', limit: 2 });
    assert.equal(hierarchy.counts.joints, 2);
    assert.equal(hierarchy.truncated, true);
    const tip = scene.inspect({ kind: 'hierarchy', ids: ['node-3'] }).nodes[0];
    assert.equal(tip.joint, true);
    assert.equal(tip.parent, 'node-2');
    assert.deepEqual(tip.translation, [0, 1, 0]);
    assert.equal(scene.inspect({ kind: 'hierarchy', offset: 2, limit: 2 }).nodes.length, 2);
    const previous = pose(scene);
    const part = scene.parts[0];
    const palette = part.skin.jointMatrices;
    assert.equal(scene.apply([{ type: 'set-asset-node', id: 'node-3', rotation: [0, 0, 0.4, 1] }], { expectedRevision: 0 }), 1);
    assert.notDeepEqual(pose(scene), previous);
    assert.equal(scene.parts[0], part);
    assert.equal(part.skin.jointMatrices, palette);
    tip.translation[1] = 9;
    assert.deepEqual(scene.inspect({ kind: 'hierarchy', ids: ['node-3'] }).nodes[0].translation, [0, 1, 0]);
  } finally { asset.dispose(); }
});

test('authored asset motion is transient and shuffled seeks preserve every retained binding', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  try {
    const scene = createAgentAssetScene(asset, { ...recipe(), motion: motion() });
    const canonical = scene.exportRecipe();
    const retained = scene.parts[0];
    const base = pose(scene);
    const checkpoint = scene.checkpoint();
    scene.sampleMotion(1);
    const middle = pose(scene);
    assert.notDeepEqual(middle, base);
    for (const time of [2, 0.25, 0, 1.9, 1]) scene.sampleMotion(time);
    assert.deepEqual(pose(scene), middle);
    assert.equal(scene.revision, 0);
    assert.equal(scene.motionTime, 1);
    assert.deepEqual(scene.exportRecipe(), canonical);
    scene.sampleMotion(null);
    assert.deepEqual(pose(scene), base);
    scene.apply([{ type: 'set-asset-node', id: 'node-2', translation: [2, 0, 0] }], { expectedRevision: 0 });
    assert.notDeepEqual(pose(scene), base);
    scene.restore(checkpoint, { expectedRevision: 1 });
    assert.deepEqual(pose(scene), base);
    assert.equal(scene.parts[0], retained);
    assert.equal(scene.motionTime, 0);
  } finally { asset.dispose(); }
});

test('pose layers preserve imported animation while overriding selected local components', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  try {
    const scene = createAgentAssetScene(asset, { ...recipe(), animation: { clip: 1, time: 1 },
      nodeOverrides: [{ id: 'node-3', translation: [0, 1.25, 0] }], motion: motion() });
    const importedTranslation = scene.parts[0].skin.jointWorldMatrices[12];
    scene.sampleMotion(1.5);
    assert.equal(scene.parts[0].skin.jointWorldMatrices[12], importedTranslation);
    assert.equal(scene.exportRecipe().animation.time, 1);
    assert.equal(scene.inspect().motion.time, 1.5);
    scene.apply([{ type: 'set-animation', clip: null }], { expectedRevision: 0 });
    assert.notEqual(scene.parts[0].skin.jointWorldMatrices[12], importedTranslation);
  } finally { asset.dispose(); }
});

test('invalid authored poses roll back decoder private state and complete adapter state', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  try {
    const scene = createAgentAssetScene(asset, { ...recipe(), motion: motion() });
    scene.sampleMotion(1);
    const before = pose(scene);
    const canonical = scene.exportRecipe();
    for (const commands of [
      [{ type: 'set-asset-node', id: 'node-3', rotation: [0, 0, 0, 0] }],
      [{ type: 'set-asset-node', id: 'mesh-0', translation: [1, 0, 0] }],
      [{ type: 'set-asset-node', id: 'node-3' }],
      [{ type: 'set-motion' }],
      [{ type: 'set-motion', motion: { ...motion(), tracks: [{ ...motion().tracks[0], id: 'missing' }] } }],
      [{ type: 'set-material', id: 'material-0', color: [1, 0, 0] }, { type: 'set-root', scale: [1e-40, 1e-40, 1e-40] }],
    ]) {
      assert.throws(() => scene.apply(commands, { expectedRevision: 0 }));
      assert.deepEqual(pose(scene), before);
      assert.deepEqual(scene.exportRecipe(), canonical);
      assert.equal(scene.motionTime, 1);
    }
    scene.sampleMotion(0.3);
    scene.sampleMotion(1);
    assert.deepEqual(pose(scene), before);
    assert.equal(scene.revision, 0);
  } finally { asset.dispose(); }
});

test('material and camera tracks share authored timing while texture resources remain retained', async () => {
  const asset = await parseGltf(skinnedStripAsset());
  const descriptor = { data: new Uint8Array([20, 30, 40, 255]), width: 1, height: 1 };
  asset.parts[0].material.map = descriptor;
  try {
    const scene = createAgentAssetScene(asset, { ...recipe(), motion: { duration: 2, tracks: [
      { kind: 'material', id: 'material-0', property: 'roughness', keyframes: [{ time: 0, value: 0.2 }, { time: 2, value: 0.8 }] },
      { kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [4, 3, 5] }, { time: 2, value: [5, 4, 6] }] },
    ] } });
    const base = scene.camera;
    scene.sampleMotion(1);
    assert.ok(Math.abs(scene.parts[0].material.roughness - 0.5) < 1e-6);
    assert.deepEqual(scene.camera.eye, [4.5, 3.5, 5.5]);
    assert.notDeepEqual(scene.camera, base);
    assert.equal(scene.parts[0].material.map, descriptor);
    scene.apply([{ type: 'set-motion', motion: null }], { expectedRevision: 0 });
    assert.equal(scene.motionTime, null);
    assert.throws(() => scene.sampleMotion(1), /no authored motion/);
    scene.sampleMotion(null);
  } finally { asset.dispose(); }
});

test('independent imported and authored clocks stage once without an invalid intermediate pose', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append, chunks) => {
    const accessor = document.animations[0].samplers[0].output;
    const bufferView = document.accessors[accessor].bufferView;
    chunks[bufferView].set([0, 0, 1, 0], 4);
  }));
  try {
    const scene = createAgentAssetScene(asset, { ...recipe(), motion: { duration: 2, tracks: [{
      kind: 'node', id: 'node-3', property: 'scale', keyframes: [
        { time: 0, value: [1, 1, 1] }, { time: 2, value: [2, 2, 2] },
      ],
    }] } });
    const canonical = scene.exportRecipe();
    scene.sampleFrame({ animation: { clip: 0, time: 2 }, motionTime: 2 });
    const final = pose(scene);
    assert.equal(scene.revision, 0);
    assert.deepEqual(scene.exportRecipe(), canonical);
    assert.throws(() => scene.sampleFrame({ animation: { clip: 0, time: 2 }, motionTime: 0 }), /singular weighted/);
    assert.deepEqual(pose(scene), final);
    scene.sampleFrame({ animation: null, motionTime: 0 });
    scene.sampleFrame({ animation: { clip: 0, time: 2 }, motionTime: 2 });
    assert.deepEqual(pose(scene), final);
  } finally { asset.dispose(); }
});

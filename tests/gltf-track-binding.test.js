import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createRigFromSkin } from '../src/retarget.js';
import { clipFromGltfAnimation, createAssetPose } from '../src/skeleton-pose.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

// Issues #565 (clip tracks keyed by node name) and #551 (a skinned file whose nodes have no names).
// Strip nodes: 0 Character, 1 Strip (mesh), 2 Root, 3 Tip. Clip "Bend" rotates node 3.

/** A second bone chain that reuses the first chain's names, animated by the same clip. */
function withDuplicateSkeleton(names) {
  return (document, append) => {
    document.nodes.push({ name: names[0], children: [5] }, { name: names[1], translation: [0, 1, 0] });
    document.nodes[0].children.push(4);
    const bend = document.animations[0];
    bend.channels.push({ sampler: 0, target: { node: 4, path: 'rotation' } }, { sampler: 0, target: { node: 5, path: 'rotation' } });
  };
}

async function posedAt(asset, clip, time) {
  const pose = createAssetPose(asset, { layers: [{ clip }] });
  pose.apply(time);
  return pose;
}

const BENT = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

function assertRotation(actual, expected) {
  actual.forEach((component, axis) => assert.ok(Math.abs(component - expected[axis]) < 1e-6, `${actual} is not ${expected}`));
}

test('two skeletons with the same bone names each follow the clip (#565)', async () => {
  const asset = await parseGltf(skinnedStripAsset(withDuplicateSkeleton(['Root', 'Tip'])));
  const clip = clipFromGltfAnimation(asset.animations[0]);
  assert.equal(new Set(clip.tracks.map(track => track.target)).size, clip.tracks.length);
  const pose = await posedAt(asset, clip, 2);
  assertRotation(pose.jointWorld('Tip').rotation, BENT);
  assertRotation(pose.jointWorld('Root_1').rotation, BENT);
  assertRotation(pose.jointWorld('Tip_1').rotation, [0, 0, 1, 0]);
  asset.dispose();
});

test('a real node named like a generated duplicate name does not collide (#565)', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append) => {
    withDuplicateSkeleton(['Root', 'Tip'])(document, append);
    document.nodes[5].name = 'Root_1';
  }));
  const clip = clipFromGltfAnimation(asset.animations[0]);
  assert.equal(new Set(clip.tracks.map(track => track.target)).size, clip.tracks.length);
  await posedAt(asset, clip, 1);
  asset.dispose();
});

test('nodes without names bind their own tracks (#551)', async () => {
  const asset = await parseGltf(skinnedStripAsset(document => {
    for (const node of document.nodes) delete node.name;
  }));
  const clip = clipFromGltfAnimation(asset.animations[0]);
  assert.equal(clip.tracks.length, 1);
  const pose = await posedAt(asset, clip, 2);
  assertRotation(pose.jointWorld('node-3').rotation, BENT);
  asset.dispose();
});

test('scale keys of exactly zero hide a node instead of throwing (#565)', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append) => {
    const times = document.animations[0].samplers[0].input;
    const scales = append(new Float32Array([1, 1, 1, 0, 0, 0]), 'VEC3');
    document.animations[0].samplers.push({ input: times, output: scales, interpolation: 'LINEAR' });
    document.animations[0].channels.push({ sampler: 1, target: { node: 3, path: 'scale' } });
  }));
  const clip = clipFromGltfAnimation(asset.animations[0]);
  const scaleTrack = clip.tracks.find(track => track.property === 'scale');
  assert.deepEqual(scaleTrack.keyframes[1].value, [0, 0, 0]);
  await posedAt(asset, clip, 2);
  asset.dispose();
});

test('a skin joint with zero scale still gives a rig (#565)', async () => {
  const asset = await parseGltf(skinnedStripAsset((document, append) => {
    document.nodes[3].scale = [0, 0, 0];
    document.skins[0].inverseBindMatrices = append(new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]), 'MAT4');
  }));
  const rig = createRigFromSkin(asset.parts[0].skin);
  assert.equal(rig.joints.length, 2);
  assert.ok(rig.joints.every(joint => joint.rotation.every(Number.isFinite) && joint.translation.every(Number.isFinite)));
  asset.dispose();
});

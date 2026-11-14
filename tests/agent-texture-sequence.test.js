import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { normalizeMapSequence, sequenceFrameIds, sequenceFrameIndex } from '../src/agent-texture-sequence.js';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';

await loadAllAgentSceneModules();

const FRAME_IDS = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64));

function solidFrame(red) {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([red, 0, 0, 255], offset);
  return { width: 2, height: 2, data };
}

function framePool() {
  return new Map(FRAME_IDS.map((id, index) => [id, solidFrame(index * 60)]));
}

function quadRecipe(sequence) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'screen', map: { sequence } }],
    nodes: [{ id: 'screen', geometry: 'quad', material: 'screen' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  };
}

test('frame index is floor(time * fps), looped by default and held on the last frame without loop', () => {
  const looped = { frames: FRAME_IDS, fps: 10, loop: true };
  const held = { ...looped, loop: false };
  assert.equal(sequenceFrameIndex(looped, 0), 0);
  assert.equal(sequenceFrameIndex(looped, 0.099), 0);
  assert.equal(sequenceFrameIndex(looped, 0.1), 1);
  assert.equal(sequenceFrameIndex(looped, 0.3), 3);
  assert.equal(sequenceFrameIndex(looped, 0.4), 0);
  assert.equal(sequenceFrameIndex(looped, null), 0);
  assert.equal(sequenceFrameIndex(held, 0.4), 3);
  assert.equal(sequenceFrameIndex(held, 100), 3);
  assert.equal(sequenceFrameIndex({ frames: FRAME_IDS, fps: 100, loop: false }, 0.03), 3);
});

test('a bad frame ID, frame count, fps or loop is rejected with a message that names the field', () => {
  const good = { frames: FRAME_IDS, fps: 12 };
  assert.deepEqual(normalizeMapSequence({ sequence: { ...good, frames: FRAME_IDS.map(id => id.toUpperCase()) } }).sequence.frames, FRAME_IDS);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, frames: [FRAME_IDS[0], 'not-an-id'] } }), /map\.sequence\.frames\[1\]: got "not-an-id"; expected the 64 hexadecimal characters/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, frames: [FRAME_IDS[0]] } }), /map\.sequence\.frames: got "1 frames"; expected a list of 2 to 64 catalog image asset IDs/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, fps: 0 } }), /map\.sequence\.fps: got 0; expected a number above 0 and at most 60/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, fps: 61 } }), /map\.sequence\.fps: got 61; expected a number above 0 and at most 60/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, fps: Number.NaN } }), /fps/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, loop: 'yes' } }), /map\.sequence\.loop: got "yes"; expected true or false/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, url: 'https://example.com/a.png' } }), /map\.sequence\.url: got "https:\/\/example\.com\/a\.png"; expected no such field; use one of frames, fps, loop/);
  assert.throws(() => normalizeMapSequence({ url: 'https://example.com/a.png' }), /map\.url: got "https:\/\/example\.com\/a\.png"; expected no such field; use one of sequence/);
});

test('the scene shows the frame of its motion time, reports it and seeks deterministically', () => {
  const scene = createAgentScene(quadRecipe({ frames: FRAME_IDS, fps: 10 }), {}, { sequenceFrames: framePool() });
  assert.deepEqual(scene.sequenceTextures().map(texture => texture.index), [0]);
  const descriptor = scene.parts[0].material.map;
  assert.equal(scene.sequenceTextures()[0].descriptor, descriptor);
  scene.sampleMotion(0.25);
  assert.equal(scene.sequenceTextures()[0].index, 2);
  assert.equal(scene.sequenceTextures()[0].image.data[0], 120);
  assert.equal(scene.parts[0].material.map, descriptor, 'the descriptor stays one object for the renderer');
  const reported = scene.inspect().textureSequences;
  assert.deepEqual(reported.map(({ material, frames, fps, loop, index }) => ({ material, frames, fps, loop, index })),
    [{ material: 'screen', frames: 4, fps: 10, loop: true, index: 2 }]);
  scene.sampleMotion(0.05);
  scene.sampleMotion(0.25);
  assert.equal(scene.sequenceTextures()[0].index, 2);
  scene.sampleMotion(null);
  assert.equal(scene.sequenceTextures()[0].index, 0);
});

test('the scene rejects frames that are missing or differ in size, and a map with a pattern', () => {
  assert.throws(() => createAgentScene(quadRecipe({ frames: FRAME_IDS, fps: 10 }), {}, { sequenceFrames: new Map() }), /was not loaded/);
  const mixed = framePool();
  mixed.set(FRAME_IDS[1], { width: 4, height: 4, data: new Uint8ClampedArray(64) });
  assert.throws(() => createAgentScene(quadRecipe({ frames: FRAME_IDS, fps: 10 }), {}, { sequenceFrames: mixed }), /map\.sequence\.frames: got "frames of different sizes in materia.*; expected frames that all measure 2x2/);
  const recipe = quadRecipe({ frames: FRAME_IDS, fps: 10 });
  recipe.materials[0].pattern = { type: 'bricks' };
  assert.throws(() => createAgentScene(recipe, {}, { sequenceFrames: framePool() }), /pattern: got \{"type":"bricks"\}; expected nothing, because a material takes a pattern or a map sequence/);
});

test('an edit can set a sequence and the frame IDs of a recipe are collected for the host', () => {
  const recipe = quadRecipe({ frames: FRAME_IDS, fps: 10 });
  assert.deepEqual(sequenceFrameIds(recipe).sort(), [...FRAME_IDS].sort());
  assert.deepEqual(sequenceFrameIds([{ type: 'set-material', id: 'screen', map: { sequence: { frames: [FRAME_IDS[0], 'zz'], fps: 1 } } }]), [FRAME_IDS[0]]);
});

test('the catalog lists PNG, JPEG and WebP images by content and rejects a mismatched extension', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-sequence-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
  const webp = Buffer.alloc(32, 3);
  webp.write('RIFF', 0, 'latin1');
  webp.writeUInt32LE(webp.length - 8, 4);
  webp.write('WEBP', 8, 'latin1');
  await writeFile(join(directory, 'frame-0.png'), png);
  await writeFile(join(directory, 'frame-1.jpg'), jpeg);
  await writeFile(join(directory, 'frame-2.webp'), webp);
  const catalog = await createAgentAssetCatalog(directory);
  const images = catalog.list().assets;
  assert.deepEqual(images.map(asset => [asset.name, asset.kind, asset.mimeType]),
    [['frame-0.png', 'image', 'image/png'], ['frame-1.jpg', 'image', 'image/jpeg'], ['frame-2.webp', 'image', 'image/webp']]);
  assert.deepEqual(await catalog.read(images[0].assetId), png);
  await writeFile(join(directory, 'wrong.png'), jpeg);
  await assert.rejects(createAgentAssetCatalog(directory), /extension must match/);
});

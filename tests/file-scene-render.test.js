import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRenderOptions } from '../scripts/render-media.mjs';
import { prepareFileScene, readCameraKeys } from '../scripts/file-scene.mjs';
import { createCameraSampler } from '../src/camera-track.js';

async function writeWorld() {
  const folder = await mkdtemp(join(tmpdir(), 'file-scene-'));
  await mkdir(join(folder, 'public/world'), { recursive: true });
  await writeFile(join(folder, 'public/world/scene.glb'), 'glb');
  await writeFile(join(folder, 'public/world/sky.hdr'), 'hdr');
  const config = join(folder, 'scene.json');
  await writeFile(config, JSON.stringify({ glb: '/world/scene.glb', hdri: '/world/sky.hdr', renderer: { memoryBudgetMiB: 2048 } }));
  const keys = join(folder, 'keys.json');
  await writeFile(keys, JSON.stringify({ fps: 30, frames: [[[0, 0, 0], [0, 0, -1]], [[0, 0, 3], [0, 0, 2]]] }));
  return { folder, config, keys };
}

test('a scene file resolves its served-root asset paths under --root and swaps them for export URLs', async () => {
  const { folder, config } = await writeWorld();
  const { description, assets } = prepareFileScene({ configPath: config, root: join(folder, 'public') });
  assert.equal(description.glb, '/__file/asset/0/scene.glb');
  assert.equal(description.hdri, '/__file/asset/1/sky.hdr');
  assert.equal(assets.length, 2);
  assert.throws(() => prepareFileScene({ configPath: config }), /was not found/);
});

test('render options take fps from the camera keys and the memory budget from the scene file', async () => {
  const { config, keys } = await writeWorld();
  const plan = parseRenderOptions(['--kind', 'video', '--scene', 'file', '--config', config, '--camera', keys]);
  assert.equal(plan.fps, 30);
  assert.equal(plan.memory, 2048);
  assert.equal(plan.cameraKeys.duration, 2 / 30);
  assert.throws(() => parseRenderOptions(['--scene', 'file']), /--config/);
  assert.throws(() => parseRenderOptions(['--config', config]), /--scene file/);
});

test('camera keys validate and sample by time', async () => {
  const { keys } = await writeWorld();
  const track = createCameraSampler(readCameraKeys(keys));
  assert.deepEqual(track.sample(0).eye, [0, 0, 0]);
  assert.deepEqual(track.sample(1 / 60).eye, [0, 0, 1.5]);
  assert.deepEqual(track.sample(5).eye, [0, 0, 3]);
  await writeFile(keys, JSON.stringify({ frames: [[[0, 0], [1, 1, 1]]] }));
  assert.throws(() => readCameraKeys(keys), /Every camera frame/);
});

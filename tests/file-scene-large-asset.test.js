import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFileScene } from '../scripts/file-scene.mjs';
import { LARGE_ASSET_BYTES, startAssetServer } from '../scripts/asset-server.mjs';

async function writeWorld(glbBytes) {
  const folder = await mkdtemp(join(tmpdir(), 'large-asset-'));
  await writeFile(join(folder, 'scene.glb'), Buffer.alloc(glbBytes, 7));
  await writeFile(join(folder, 'sky.hdr'), 'hdr');
  const config = join(folder, 'scene.json');
  await writeFile(config, JSON.stringify({ glb: 'scene.glb', hdri: 'sky.hdr' }));
  return config;
}

test('an asset above the size limit is routed to the local asset server and small ones stay on the page route', async () => {
  const config = await writeWorld(2048);
  const origin = 'http://127.0.0.1:1234';
  const { description } = prepareFileScene({ configPath: config, largeAssetOrigin: origin, largeAssetBytes: 1024 });
  assert.equal(description.glb, `${origin}/asset/0/scene.glb`);
  assert.equal(description.hdri, '/__file/asset/1/sky.hdr');
  const small = prepareFileScene({ configPath: config, largeAssetOrigin: origin });
  assert.equal(small.description.glb, '/__file/asset/0/scene.glb');
  const withoutServer = prepareFileScene({ configPath: config, largeAssetBytes: 1024 });
  assert.equal(withoutServer.description.glb, '/__file/asset/0/scene.glb');
  assert.ok(LARGE_ASSET_BYTES > 1024 ** 2);
});

test('the asset server streams a file whole with the headers a cross-origin isolated page needs', async () => {
  const config = await writeWorld(300_000);
  const assetPaths = [];
  const server = await startAssetServer(assetPaths);
  try {
    const { assets } = prepareFileScene({ configPath: config, largeAssetOrigin: server.origin, largeAssetBytes: 1024 });
    assetPaths.push(...assets);
    const response = await fetch(`${server.origin}/asset/0/scene.glb`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.byteLength, 300_000);
    assert.ok(bytes.every(value => value === 7));
    assert.equal((await fetch(`${server.origin}/asset/9/missing.glb`)).status, 404);
  } finally {
    await server.close();
  }
});

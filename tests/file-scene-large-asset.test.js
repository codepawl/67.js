import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
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

function requestWithHost(port, path, host) {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, response => {
      response.resume();
      response.on('end', () => resolveRequest(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

async function withServer(options, run) {
  const config = await writeWorld(300_000);
  const assetPaths = [];
  const server = await startAssetServer(assetPaths, options);
  try {
    const { assets } = prepareFileScene({ configPath: config, largeAssetOrigin: server.origin, largeAssetBytes: 1024 });
    assetPaths.push(...assets);
    await run(server);
  } finally {
    await server.close();
  }
}

test('the asset server streams a file whole to the render page origin only', async () => {
  const pageOrigin = 'http://127.0.0.1:4321';
  await withServer({ pageOrigin }, async server => {
    const response = await fetch(`${server.origin}/asset/0/scene.glb`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(response.headers.get('access-control-allow-origin'), pageOrigin);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.byteLength, 300_000);
    assert.ok(bytes.every(value => value === 7));
    assert.equal((await fetch(`${server.origin}/asset/9/missing.glb`)).status, 404);
  });
});

test('the asset server sends no CORS header when it has no page origin, and never a wildcard', async () => {
  await withServer({}, async server => {
    const response = await fetch(`${server.origin}/asset/0/scene.glb`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await response.arrayBuffer();
  });
});

test('a request without the token, with a wrong token or with a malformed index is a 404', async () => {
  await withServer({}, async server => {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/asset/0/scene.glb`)).status, 404);
    assert.equal((await fetch(`${base}/wrong-token/asset/0/scene.glb`)).status, 404);
    assert.equal((await fetch(`${server.origin}/asset/0x0/scene.glb`)).status, 404);
    assert.equal((await fetch(`${server.origin}/asset/-1/scene.glb`)).status, 404);
  });
});

test('a request whose Host is not this server on loopback is rejected', async () => {
  await withServer({}, async server => {
    const path = new URL(`${server.origin}/asset/0/scene.glb`).pathname;
    assert.equal(await requestWithHost(server.port, path, 'attacker.example'), 404);
    assert.equal(await requestWithHost(server.port, path, `attacker.example:${server.port}`), 404);
    assert.equal(await requestWithHost(server.port, path, `localhost:${server.port}`), 200);
  });
});

test('a file that disappears after it was listed answers 500, not an uncaught exception', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'large-asset-gone-'));
  const server = await startAssetServer([join(folder, 'gone.glb')]);
  try {
    const response = await fetch(`${server.origin}/asset/0/gone.glb`);
    assert.equal(response.status, 500);
  } finally {
    await server.close();
  }
});

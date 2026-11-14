import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import {
  UPDATE_CHECK_URL, UPDATE_CHECK_INTERVAL_MS, isNewerVersion, updateCheckDisabled, startUpdateCheck, describeUpdateCheck, buildUpdateAvailable,
} from '../src/mcp-update-check.js';

const NOW = 1_800_000_000_000;

function registryAnswer(version) {
  return async () => ({ ok: true, json: async () => ({ version }) });
}

function countingFetch(inner) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    return inner(url, options);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function withCacheFolder(run) {
  const folder = await mkdtemp(join(tmpdir(), 'crucible-update-'));
  try {
    await run(join(folder, 'nested', 'update-check.json'));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('versions compare numerically and ignore anything that is not a stable x.y.z', () => {
  assert.equal(isNewerVersion('0.20.0', '0.19.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true);
  assert.equal(isNewerVersion('0.19.0', '0.19.0'), false);
  assert.equal(isNewerVersion('0.18.9', '0.19.0'), false);
  assert.equal(isNewerVersion('0.20.0-beta.1', '0.19.0'), false);
  assert.equal(isNewerVersion('latest', '0.19.0'), false);
  assert.equal(isNewerVersion('0.19.0', '0.19.0-beta.1'), true);
});

test('each off switch disables the check', () => {
  assert.equal(updateCheckDisabled({}), false);
  assert.equal(updateCheckDisabled({ SIXTYSEVENJS_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(updateCheckDisabled({ NO_UPDATE_NOTIFIER: '1' }), true);
  assert.equal(updateCheckDisabled({ CI: 'true' }), true);
  assert.equal(updateCheckDisabled({ CI: '1' }), true);
  assert.equal(updateCheckDisabled({ CI: 'false' }), false);
  assert.equal(updateCheckDisabled({ SIXTYSEVENJS_NO_UPDATE_CHECK: '0' }), false);
});

test('a newer version is found, written to the cache and reported', async () => {
  await withCacheFolder(async cachePath => {
    const fetchImpl = countingFetch(registryAnswer('0.20.0'));
    const check = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl, now: () => NOW, cachePath });
    assert.equal(check.current(), null);
    await check.settled;
    const found = check.current();
    assert.equal(found.current, '0.19.0');
    assert.equal(found.latest, '0.20.0');
    assert.match(found.releaseNotes, /\/releases\/tag\/v0\.20\.0$/);
    assert.deepEqual(Object.keys(found.update), ['plugin', 'npx', 'project']);
    assert.deepEqual(fetchImpl.calls, [UPDATE_CHECK_URL]);
    assert.deepEqual(JSON.parse(await readFile(cachePath, 'utf8')), { checkedAt: NOW, latest: '0.20.0' });
  });
});

test('the same version reports nothing', async () => {
  await withCacheFolder(async cachePath => {
    const check = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: registryAnswer('0.19.0'), now: () => NOW, cachePath });
    await check.settled;
    assert.equal(check.current(), null);
  });
});

test('registry errors, bad bodies and thrown fetches stay silent', async () => {
  const failures = [
    async () => ({ ok: false, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ version: 'not-a-version' }) }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }),
    async () => { throw new Error('offline'); },
  ];
  for (const failing of failures) {
    await withCacheFolder(async cachePath => {
      const check = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: failing, now: () => NOW, cachePath });
      await check.settled;
      assert.equal(check.current(), null);
    });
  }
});

test('a failed request is remembered for a day and keeps the last known version', async () => {
  await withCacheFolder(async cachePath => {
    await startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: registryAnswer('0.20.0'), now: () => NOW, cachePath }).settled;
    const offline = countingFetch(async () => { throw new Error('offline'); });
    const later = NOW + UPDATE_CHECK_INTERVAL_MS;
    const failed = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: offline, now: () => later, cachePath });
    await failed.settled;
    assert.equal(failed.current().latest, '0.20.0');
    assert.deepEqual(JSON.parse(await readFile(cachePath, 'utf8')), { checkedAt: later, latest: '0.20.0' });
    const nextStart = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: offline, now: () => later + 1, cachePath });
    await nextStart.settled;
    assert.equal(offline.calls.length, 1, 'no second request on the same day');
  });
  await withCacheFolder(async cachePath => {
    const offline = countingFetch(async () => { throw new Error('offline'); });
    await startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: offline, now: () => NOW, cachePath }).settled;
    assert.deepEqual(JSON.parse(await readFile(cachePath, 'utf8')), { checkedAt: NOW, latest: null });
    const nextStart = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: offline, now: () => NOW + 1, cachePath });
    await nextStart.settled;
    assert.equal(nextStart.current(), null);
    assert.equal(offline.calls.length, 1);
  });
});

test('a registry that never answers is cut off at the timeout', async () => {
  await withCacheFolder(async cachePath => {
    const hanging = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const started = Date.now();
    const check = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: hanging, now: () => NOW, cachePath, timeoutMs: 30 });
    await check.settled;
    assert.equal(check.current(), null);
    assert.ok(Date.now() - started < 1500);
  });
});

test('a cache under a day old answers without a request, an older one refreshes', async () => {
  await withCacheFolder(async cachePath => {
    const fetchImpl = countingFetch(registryAnswer('0.21.0'));
    await startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl, now: () => NOW, cachePath }).settled;
    assert.equal(fetchImpl.calls.length, 1);
    const fresh = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl, now: () => NOW + UPDATE_CHECK_INTERVAL_MS - 1, cachePath });
    assert.equal(fresh.current().latest, '0.21.0', 'the cached answer is available before any request');
    await fresh.settled;
    assert.equal(fetchImpl.calls.length, 1);
    const stale = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl, now: () => NOW + UPDATE_CHECK_INTERVAL_MS, cachePath });
    await stale.settled;
    assert.equal(fetchImpl.calls.length, 2);
  });
});

test('a damaged cache is ignored', async () => {
  await withCacheFolder(async cachePath => {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, '{not json');
    const check = startUpdateCheck({ currentVersion: '0.19.0', env: {}, fetchImpl: registryAnswer('0.20.0'), now: () => NOW, cachePath });
    await check.settled;
    assert.equal(check.current().latest, '0.20.0');
  });
});

test('every off switch makes no request and no cache file', async () => {
  for (const env of [{ SIXTYSEVENJS_NO_UPDATE_CHECK: '1' }, { NO_UPDATE_NOTIFIER: '1' }, { CI: 'true' }]) {
    await withCacheFolder(async cachePath => {
      const fetchImpl = countingFetch(registryAnswer('0.20.0'));
      const check = startUpdateCheck({ currentVersion: '0.19.0', env, fetchImpl, now: () => NOW, cachePath });
      await check.settled;
      assert.equal(check.current(), null);
      assert.equal(fetchImpl.calls.length, 0);
      await assert.rejects(readFile(cachePath, 'utf8'));
    });
  }
});

test('--check-update text names current and latest', async () => {
  assert.equal(await describeUpdateCheck({ currentVersion: '0.19.0', fetchImpl: registryAnswer('0.20.0') }),
    'current 0.19.0\nlatest 0.20.0\nupdate available: https://github.com/codepawl/crucible/releases/tag/v0.20.0');
  assert.match(await describeUpdateCheck({ currentVersion: '0.19.0', fetchImpl: registryAnswer('0.19.0') }), /up to date$/);
  assert.match(await describeUpdateCheck({ currentVersion: '0.19.0', fetchImpl: async () => { throw new Error('offline'); } }), /latest unknown/);
});

const runtime = {
  activeSessionId: () => null,
  async close() {},
  async capabilities() { return { scene: {}, phase: 'idle', availableIn: 'test' }; },
};

async function connect(context, options) {
  const server = createAgentMcpServer(runtime, options);
  const client = new Client({ name: 'update-check-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('an older running version puts the notice in instructions and the first scene_capabilities result only', async context => {
  const client = await connect(context, { updateAvailable: () => buildUpdateAvailable('0.19.0', '0.20.0') });
  assert.match(client.getInstructions(), /A newer Crucible is out \(running 0\.19\.0, latest 0\.20\.0/);
  const first = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
  assert.equal(first.updateAvailable.latest, '0.20.0');
  assert.equal(first.updateAvailable.current, '0.19.0');
  assert.ok(first.updateAvailable.update.plugin && first.updateAvailable.update.npx && first.updateAvailable.update.project);
  const second = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
  assert.equal('updateAvailable' in second, false);
});

test('without a newer version the instructions and results carry no notice', async context => {
  const client = await connect(context, {});
  assert.doesNotMatch(client.getInstructions(), /newer crucible/);
  const result = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
  assert.equal('updateAvailable' in result, false);
});

const serverEntry = new URL('../bin/crucible-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const hasBuild = existsSync(new URL('../build/mcp/server.mjs', import.meta.url));

// The real bin in a child process: the cache file is seeded through XDG_CACHE_HOME and is fresh, so no request is made.
test('the started server reads a seeded cache and reports the newer version in instructions and the first scene_capabilities', { skip: !hasBuild && 'run npm run build:mcp first' }, async () => {
  const cacheHome = await mkdtemp(join(tmpdir(), 'crucible-update-cli-'));
  const cacheFile = join(cacheHome, 'crucible', 'update-check.json');
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0' }));
  const { CI, NO_UPDATE_NOTIFIER, SIXTYSEVENJS_NO_UPDATE_CHECK, ...inheritedEnvironment } = process.env;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, '--backend', 'cpu'],
    env: { ...inheritedEnvironment, XDG_CACHE_HOME: cacheHome },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'update-check-cli-test', version: '1' });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions(), /A newer Crucible is out \(running \d+\.\d+\.\d+, latest 99\.0\.0/);
    const first = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
    assert.equal(first.updateAvailable.latest, '99.0.0');
    const second = (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent;
    assert.equal('updateAvailable' in second, false);
  } finally {
    await client.close();
    await rm(cacheHome, { recursive: true, force: true });
  }
});

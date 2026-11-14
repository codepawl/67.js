// Through MCP on the CPU backend: a scene created with no placed asset gains its first catalog GLB through one
// scene_apply call, then a second instance of it, and an unknown asset id fails with a clear error and leaves the scene alone.
// Usage: node scripts/smoke-agent-apply-first-asset.mjs [width] [height]   (a small still lands in artifacts/apply-first-asset.png)
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [width = 480, height = 320] = process.argv.slice(2).map(Number);
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const assetsDirectory = resolve('artifacts/apply-first-asset-assets');
await rm(assetsDirectory, { recursive: true, force: true });
await mkdir(assetsDirectory, { recursive: true });
await writeFile(resolve(assetsDirectory, 'robot.glb'), await readFile('public/wall-e.glb'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', assetsDirectory],
  stderr: 'pipe', cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-apply-first-asset-proof', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } },
});
async function call(name, argumentsValue = {}, { expectError = false } = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (expectError) {
    assert.equal(result.isError, true, `${name} should have failed`);
    return text;
  }
  assert.equal(result.isError, undefined, text);
  return result;
}

try {
  await client.connect(transport, { timeout: 180000 });
  const robot = (await call('scene_asset_catalog')).structuredContent.assets.find(asset => asset.name === 'robot.glb').assetId;
  const created = (await call('scene_create', { recipe: {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'floor', type: 'terrain', size: 12, resolution: 16, amplitude: 0.1 }],
    materials: [{ id: 'sand', color: [0.6, 0.55, 0.4], roughness: 0.9 }],
    nodes: [{ id: 'ground', geometry: 'floor', material: 'sand' }],
    camera: { eye: [0, 3, 8], target: [0, 1, 0], fov: 45 },
  } })).structuredContent;
  const { sessionId } = created;
  assert.equal(created.render.drawBatches > 0, true);

  const unknown = await call('scene_apply', { sessionId, expectedRevision: created.revision,
    operations: [{ type: 'add-node', node: { id: 'ghost', asset: { id: 'f'.repeat(64) } } }] }, { expectError: true });
  assert.match(unknown, /Unknown asset ID ffffffffffff.*scene_asset_catalog/);

  const first = (await call('scene_apply', { sessionId, expectedRevision: created.revision,
    operations: [{ type: 'add-node', node: { id: 'robot-1', translation: [-1.5, 0, 0], asset: { id: robot } } }] })).structuredContent;
  const second = (await call('scene_apply', { sessionId, expectedRevision: first.revision,
    operations: [{ type: 'add-node', node: { id: 'robot-2', translation: [1.5, 0, 0], asset: { id: robot } } }] })).structuredContent;
  const placements = (await call('scene_inspect', { sessionId })).structuredContent.assets;
  assert.deepEqual(placements.map(placement => placement.assetId), [robot, robot]);

  const image = (await call('scene_look', { sessionId, width, height })).content.find(item => item.type === 'image');
  await writeFile('artifacts/apply-first-asset.png', Buffer.from(image.data, 'base64'));
  await call('scene_dispose', { sessionId });
  console.log(JSON.stringify({ unknownAssetRefused: true, revisions: [created.revision, first.revision, second.revision], placements: placements.length }));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

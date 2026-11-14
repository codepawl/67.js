import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTexturedRigFixture } from './agent-asset-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts/asset-catalog-proof', { recursive: true });
await writeFile('artifacts/asset-catalog-proof/wall-e.glb', await readFile('public/wall-e.glb'));
await writeFile('artifacts/asset-catalog-proof/textured-rig.glb', await createTexturedRigFixture());
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', resolve('artifacts/asset-catalog-proof')],
  stderr: 'pipe', cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-asset-proof', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } },
});
async function call(name, argumentsValue = {}) {
  const timeout = name === 'scene_create_asset' ? 180000 : 60000;
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
async function look(sessionId, label) {
  const result = await call('scene_look', { sessionId, width: 768, height: 512 });
  const bytes = Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
  await writeFile(`artifacts/agent-asset-${label}.png`, bytes);
  assert.match(result.structuredContent.graphics, /SwiftShader/);
  assert.ok(result.structuredContent.estimatedBytes < 192 * 1024 * 1024);
  return bytes;
}
try {
  await client.connect(transport, { timeout: 180000 });
  assert.equal((await client.listTools()).tools.length, 22);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  assert.equal(catalog.configured, true);
  assert.equal(catalog.assets.length, 2);
  const robot = catalog.assets.find(asset => asset.name === 'wall-e.glb');
  const created = (await call('scene_create_asset', { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: robot.assetId } })).structuredContent;
  const sessionId = created.sessionId;
  const before = await look(sessionId, 'wall-e-before');
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const edited = (await call('scene_apply', { sessionId, expectedRevision: 0, operations: [
    { type: 'set-root', rotation: [0, Math.sin(0.3), 0, Math.cos(0.3)] },
    { type: 'set-environment', environment: { keyColor: [2.8, 3.5, 5], fillIntensity: 0.4 } },
  ] })).structuredContent;
  assert.equal(edited.renderSucceeded, true);
  const after = await look(sessionId, 'wall-e-after');
  assert.notDeepEqual(after, before);
  await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 1 });
  assert.deepEqual(await look(sessionId, 'wall-e-restored'), before);
  const exported = (await call('scene_export_recipe', { sessionId })).structuredContent;
  assert.equal(exported.recipe.assetId, robot.assetId);
  await call('scene_dispose', { sessionId });
  const rig = catalog.assets.find(asset => asset.name === 'textured-rig.glb');
  assert.equal(rig.skins, 1);
  assert.equal(rig.images, 1);
  assert.equal(rig.animations.length, 2);
  const rigCreated = (await call('scene_create_asset', { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: rig.assetId,
    camera: { eye: [1, 3, 7], target: [1, 3, 0], near: 0.1, far: 40, fov: 35 },
  } })).structuredContent;
  const rigId = rigCreated.sessionId;
  assert.equal(rigCreated.render.materialTextures, 1);
  assert.equal(rigCreated.render.skinTextures, 1);
  const initial = await look(rigId, 'rig-initial');
  const initialCheckpoint = (await call('scene_checkpoint', { sessionId: rigId })).structuredContent;
  const sampled = (await call('scene_apply', { sessionId: rigId, expectedRevision: 0, operations: [{ type: 'set-animation', clip: 0, time: 1.1 }] })).structuredContent;
  assert.equal(sampled.renderSucceeded, true);
  assert.equal(sampled.render.materialTextures, 1);
  assert.equal(sampled.render.skinTextures, 1);
  assert.equal(sampled.render.gpuBuffers, rigCreated.render.gpuBuffers);
  const bent = await look(rigId, 'rig-bent');
  assert.notDeepEqual(bent, initial);
  await call('scene_apply', { sessionId: rigId, expectedRevision: 1, operations: [{ type: 'set-animation', clip: 0, time: 0.4 }] });
  await call('scene_apply', { sessionId: rigId, expectedRevision: 2, operations: [{ type: 'set-animation', clip: 0, time: 1.1 }] });
  assert.deepEqual(await look(rigId, 'rig-repeated'), bent);
  await call('scene_restore', { sessionId: rigId, checkpointId: initialCheckpoint.checkpointId, expectedRevision: 3 });
  assert.deepEqual(await look(rigId, 'rig-restored'), initial);
  await call('scene_dispose', { sessionId: rigId });
  const report = { tools: 18, backend: 'cpu', robotParts: created.inspection.counts.parts,
    robotRestoreExact: true, texturedRigLoaded: true, backwardSeekExact: true, originalPoseRestoreExact: true };
  await writeFile('artifacts/agent-assets-cpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

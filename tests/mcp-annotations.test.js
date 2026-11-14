import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

const READ_ONLY_TOOLS = ['scene_capabilities', 'scene_inspect', 'scene_look', 'scene_ask_user', 'scene_review', 'mesh_inspect', 'scene_walkmap',
  'scene_asset_catalog', 'scene_render_status', 'scene_render_result', 'scene_export_recipe'];
const DESTRUCTIVE_TOOLS = ['scene_dispose', 'scene_render_release', 'scene_release_checkpoint'];
const TOOLS_WITH_OUTPUT_SCHEMA = ['scene_capabilities', 'scene_inspect', 'scene_checkpoint', 'scene_release_checkpoint', 'scene_render_status', 'scene_render_result'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

async function connect(context, runtime) {
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'annotation-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('every tool has a title and complete annotations, with the read-only and destructive sets fixed', async context => {
  const client = await connect(context, { activeSessionId: () => null, async close() {} });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 25);
  for (const tool of tools) {
    assert.ok(tool.title && tool.annotations.title === tool.title, `${tool.name} has a title`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint']) {
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} ${hint}`);
    }
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.readOnlyHint, READ_ONLY_TOOLS.includes(tool.name), `${tool.name} readOnlyHint`);
    assert.equal(tool.annotations.destructiveHint, DESTRUCTIVE_TOOLS.includes(tool.name), `${tool.name} destructiveHint`);
  }
  const withSchema = tools.filter(tool => tool.outputSchema).map(tool => tool.name).sort();
  assert.deepEqual(withSchema, [...TOOLS_WITH_OUTPUT_SCHEMA].sort());
});

test('structuredContent validates against the outputSchema and the text content stays', async context => {
  const sessionId = randomUUID();
  const jobId = randomUUID();
  const checkpointId = randomUUID();
  const runtime = {
    activeSessionId: () => sessionId,
    async close() {},
    async capabilities() { return { phase: 'idle', scene: {} }; },
    async inspect() { return { sessionId, revision: 0, nodes: [] }; },
    async checkpoint() { return { checkpointId, sessionId, revision: 0 }; },
    async releaseCheckpoint() { return { released: true, sessionId, checkpointId }; },
    async jobStatus() { return { jobId, state: 'running', progress: { frames: 1 } }; },
  };
  const client = await connect(context, runtime);
  const calls = { scene_capabilities: {}, scene_inspect: {}, scene_checkpoint: {}, scene_release_checkpoint: { checkpointId }, scene_render_status: { jobId } };
  for (const [name, argumentsValue] of Object.entries(calls)) {
    const result = await client.callTool({ name, arguments: argumentsValue });
    assert.equal(result.isError, undefined, `${name}: ${result.content[0]?.text}`);
    assert.ok(result.structuredContent, name);
    assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
  }
});

test('a render result returns the PNG as image content and a resource link to each file', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-annotations-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const imagePath = join(directory, 'image.png');
  const videoPath = join(directory, 'video.mp4');
  await writeFile(imagePath, Buffer.from(PNG, 'base64'));
  await writeFile(videoPath, Buffer.from('not really a video'));
  const jobId = randomUUID();
  const artifacts = [
    { filename: 'image.png', mimeType: 'image/png', bytes: 70, sha256: 'a'.repeat(64), path: imagePath },
    { filename: 'video.mp4', mimeType: 'video/mp4', bytes: 18, sha256: 'b'.repeat(64), path: videoPath },
  ];
  const client = await connect(context, {
    activeSessionId: () => null,
    async close() {},
    async jobResult() { return { jobId, state: 'completed', artifacts, metrics: {} }; },
  });
  const result = await client.callTool({ name: 'scene_render_result', arguments: { jobId } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.artifacts.length, 2);
  const images = result.content.filter(item => item.type === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].data, PNG);
  assert.equal(images[0].mimeType, 'image/png');
  const links = result.content.filter(item => item.type === 'resource_link');
  assert.deepEqual(links.map(link => link.uri), [pathToFileURL(imagePath).href, pathToFileURL(videoPath).href]);
  assert.equal(links[1].mimeType, 'video/mp4');
});

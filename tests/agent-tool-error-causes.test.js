import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer, readableErrorMessage } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { createNavmesh } from '../src/navmesh.js';
import { createTerrain } from '../src/terrain.js';
import { parseGltf } from '../src/gltf.js';

// Failed scene_capabilities and scene_inspect calls of a Haiku bench run (issue 761): each test sends the input the agent sent.

async function askCapabilities(context, topic) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-error-cause-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: 'scene_capabilities', arguments: { topic } });
  return { ...result, text: result.content?.[0]?.text };
}

test('meshEdit.inset and meshEdit.extrude open the one or both branches that start with that name', async context => {
  const inset = await askCapabilities(context, 'meshEdit.inset');
  assert.notEqual(inset.isError, true);
  assert.deepEqual(Object.keys(inset.structuredContent.fields.branches), ['inset_region', 'inset_individual']);
  const extrude = await askCapabilities(context, 'meshEdit.extrude');
  assert.deepEqual(Object.keys(extrude.structuredContent.fields.branches), ['extrude_face_region', 'extrude_individual', 'extrude_edges']);
});

test('meshEdit.select says select is a field of the branches and lists the branches', async context => {
  const answer = await askCapabilities(context, 'meshEdit.select');
  assert.equal(answer.isError, true);
  assert.match(answer.text, /Branches: extrude_face_region/);
  assert.match(answer.text, /select is a field of those branches/);
});

test('environment.spotLights answers with the outline of that environment field', async context => {
  const answer = await askCapabilities(context, 'environment.spotLights');
  assert.notEqual(answer.isError, true);
  assert.match(JSON.stringify(answer.structuredContent.fields), /castShadow/);
  const unknown = await askCapabilities(context, 'environment.nothing');
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Fields: .*spotLights/);
});

test('uvs and scene.terrain stand for the topics meshUv and terrain', async context => {
  assert.equal((await askCapabilities(context, 'uvs')).structuredContent.topic, 'meshUv');
  assert.equal((await askCapabilities(context, 'scene.terrain')).structuredContent.topic, 'terrain');
  assert.equal((await askCapabilities(context, 'nope')).isError, true);
});

test('an inspected source node without a mesh of its own lists the parts below it', async () => {
  const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  const scene = createAgentAssetScene(asset, { format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) });
  const bare = scene.inspect({ kind: 'hierarchy', limit: 256 }).nodes.find(node => node.meshIds.length === 0 && asset.nodes.some(other => other.parent === node.id));
  assert.ok(bare, 'the robot has a group node without parts');
  const inspected = scene.inspect({ ids: [bare.id], includeBounds: true });
  assert.ok(inspected.nodes.length >= 1);
  assert.ok(inspected.nodes.every(node => node.bounds && node.id.startsWith('mesh-')));
});

test('includeBounds with kind hierarchy is accepted and says where bounds are', async () => {
  const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  const scene = createAgentAssetScene(asset, { format: 'crucible.asset', schemaVersion: 1, assetId: 'ab'.repeat(32) });
  const report = scene.inspect({ kind: 'hierarchy', includeBounds: true, limit: 4 });
  assert.equal(report.kind, 'hierarchy');
  assert.match(report.note, /without kind/);
});

test('an unwalkable start names the nearest walkable point and loses the page stack', () => {
  const terrain = createTerrain({ size: 40, chunks: 1, levels: 1, resolution: 64, holes: [], height: () => 0 });
  const { positions, indices } = terrain.parts[0].geometry;
  const navmesh = createNavmesh({ positions, indices, obstacles: [{ min: [-17, -17], max: [-13, -13] }] });
  let thrown;
  try {
    navmesh.findPath([-15, -15], [15, 15]);
  } catch (error) {
    thrown = error;
  }
  assert.match(thrown.message, /Start \[-15, -15\] is not walkable.*nearest walkable point is \[-?\d+\.\d+, -?\d+\.\d+\]/);
  const pageError = new Error(`page.evaluate: RangeError: ${thrown.message}\n    at Object.L [as findPath] (http://127.0.0.1:52976/navmesh.js:140:34)`);
  assert.doesNotMatch(readableErrorMessage(pageError), /http|\bat Object/);
});

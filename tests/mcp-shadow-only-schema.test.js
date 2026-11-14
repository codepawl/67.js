import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

async function listedTools() {
  const server = createAgentMcpServer({ async close() {}, async capabilities() { return { scene: {}, phase: 'idle' }; } });
  const client = new Client({ name: 'crucible-shadow-only-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

test('scene_apply lists shadowOnly as a boolean node field next to the other render flags', async () => {
  const tools = await listedTools();
  const text = JSON.stringify(tools.find(tool => tool.name === 'scene_apply').inputSchema);
  assert.match(text, /"shadowOnly":\{"type":"boolean"\}/);
  assert.match(text, /"shadowCatcher":\{"type":"boolean"\}/);
});

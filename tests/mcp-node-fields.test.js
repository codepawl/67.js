import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

async function backendNodeFields() {
  const source = await readFile(new URL('../src/agent-scene.js', import.meta.url), 'utf8');
  const list = source.match(/const NODE_FIELDS = \[([^\]]+)\]/);
  assert.ok(list, 'NODE_FIELDS moved out of src/agent-scene.js');
  return [...list[1].matchAll(/'(\w+)'/g)].map(match => match[1]);
}

function findOperationSchema(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.properties?.type?.const === type) return node;
  for (const value of Object.values(node)) {
    const found = findOperationSchema(value, type);
    if (found) return found;
  }
  return null;
}

test('the scene_apply set-node schema accepts every node field the backend does', async () => {
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: 'crucible-node-fields-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const setNode = findOperationSchema(tools.find(tool => tool.name === 'scene_apply').inputSchema, 'set-node');
    assert.ok(setNode, 'scene_apply no longer lists set-node');
    const rejected = (await backendNodeFields()).filter(field => !(field in setNode.properties));
    assert.deepEqual(rejected, [], 'These node fields pass the backend but the MCP schema rejects them');
  } finally {
    await client.close();
    await server.close();
  }
});

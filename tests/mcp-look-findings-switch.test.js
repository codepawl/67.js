import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const FINDING = { kind: 'floating-node', severity: 'warning', target: 'crate', nodes: ['crate'] };

async function lookMetadata(context, serverOptions) {
  const runtime = {
    activeSessionId: () => 'scene-1',
    async close() {},
    async look() {
      return { data: PNG, mimeType: 'image/png', metadata: { sessionId: 'scene-1', revision: 0, diagnostics: [FINDING] } };
    },
  };
  const server = createAgentMcpServer(runtime, serverOptions);
  const client = new Client({ name: 'findings-switch-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name: 'scene_look', arguments: {} });
  return result.structuredContent;
}

test('scene_look returns the structured findings by default', async context => {
  const metadata = await lookMetadata(context, {});
  assert.deepEqual(metadata.diagnostics, [FINDING]);
});

test('--findings off removes the findings from scene_look and keeps the rest', async context => {
  const metadata = await lookMetadata(context, { findings: false });
  assert.equal(metadata.diagnostics, undefined);
  assert.equal(metadata.sessionId, 'scene-1');
});

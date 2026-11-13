import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

const numberWords = new Map([
  ['twenty-one', 21], ['twenty-two', 22], ['twenty-three', 23], ['twenty-four', 24],
  ['twenty-five', 25], ['twenty-six', 26], ['twenty-seven', 27], ['twenty-eight', 28],
  ['thirty', 30],
]);

async function listedToolCount() {
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: '67js-tool-count-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.length;
}

async function countStatedIn(file, pattern) {
  const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const match = text.match(pattern);
  assert.ok(match, `${file} no longer states the MCP tool count`);
  const stated = match[1].toLowerCase();
  return numberWords.get(stated) ?? Number(stated);
}

test('documented MCP tool counts match the protocol listing', async () => {
  const listed = await listedToolCount();
  const statements = {
    'docs/learn/models-and-ai-agents.md': /(\d+) tools for authoring/,
    'docs/mcp.md': /Lists all (\d+) tools/,
    'site/index.html': /(\d+) MCP tools/,
    'scripts/smoke-mcp.mjs': /listing\.tools\.length, (\d+)\)/,
    'scripts/smoke-mcp-package.mjs': /listTools\(\)\)\.tools\.length, (\d+)\)/,
  };
  for (const [file, pattern] of Object.entries(statements)) {
    assert.equal(await countStatedIn(file, pattern), listed, `${file} states a different tool count than tools/list`);
  }
});

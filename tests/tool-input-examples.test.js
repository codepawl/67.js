import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { AGENT_TOOL_EXAMPLES } from '../scripts/tool-examples.mjs';

const EXAMPLE_TOOLS = ['scene_create', 'scene_apply', 'scene_create_asset', 'scene_render_submit'];

async function connect(context) {
  const runtime = { async close() {}, async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; } };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: '67js-examples-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('every tool example passes the input schema its tool advertises', async context => {
  const client = await connect(context);
  const { tools } = await client.listTools();
  const validator = new Ajv2020({ strict: false });
  for (const toolName of EXAMPLE_TOOLS) {
    const tool = tools.find(candidate => candidate.name === toolName);
    const validate = validator.compile(tool.inputSchema);
    assert.ok(validate(AGENT_TOOL_EXAMPLES[toolName]), `${toolName}: ${JSON.stringify(validate.errors)}`);
  }
});

test('the scene_create and scene_apply examples build and edit a real scene', () => {
  const scene = createAgentScene(AGENT_TOOL_EXAMPLES.scene_create.recipe);
  const { expectedRevision, operations } = AGENT_TOOL_EXAMPLES.scene_apply;
  assert.equal(scene.revision, expectedRevision);
  scene.apply(operations, { expectedRevision });
  assert.equal(scene.revision, expectedRevision + 1);
});

test('scene_capabilities serves the examples whole and one tool at a time', async context => {
  const client = await connect(context);
  const call = async topic => JSON.parse((await client.callTool({ name: 'scene_capabilities', arguments: topic ? { topic } : {} })).content[0].text);
  assert.deepEqual((await call('examples')).value.scene_apply, AGENT_TOOL_EXAMPLES.scene_apply);
  const single = await call('examples.scene_render_submit');
  assert.equal(single.topic, 'examples.scene_render_submit');
  assert.deepEqual(single.value, AGENT_TOOL_EXAMPLES.scene_render_submit);
  assert.ok((await call()).topics.scene.includes('examples'));
});

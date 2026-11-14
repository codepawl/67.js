import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

const vine = { id: 'vine', type: 'curve', shape: { type: 'spiral', rotations: 4, height: 3 }, trim: { end: 0.5 }, radius: 0.04 };
const nurbs = { id: 'ribbon', type: 'curve', kind: 'nurbs', points: [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]], weights: [1, 2, 2, 1] };
const bundle = {
  id: 'bundle',
  type: 'curve',
  splines: [
    { shape: { type: 'arc', radius: 1 } },
    { kind: 'poly', points: [[0, 0, 0], [1, 0, 0]], trim: { start: 0.25, end: 0.75 } },
  ],
};
const growing = { id: 'growing', type: 'curve', shape: { type: 'spiral' }, grow: { name: 'grow', steps: 4 } };

function recipeWith(geometry) {
  return { format: 'crucible.scene', schemaVersion: 1, geometries: [geometry], materials: [], nodes: [] };
}

async function connectRecordingServer() {
  const received = { create: [], apply: [] };
  const runtime = {
    async close() {},
    async create(requestArguments) {
      received.create.push(requestArguments);
      return { sessionId: 's', revision: 0 };
    },
    async apply(requestArguments) {
      received.apply.push(requestArguments);
      return { sessionId: 's', revision: 1 };
    },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-curve-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, received };
}

async function withServer(body) {
  const connection = await connectRecordingServer();
  try {
    await body(connection);
  } finally {
    await connection.client.close();
    await connection.server.close();
  }
}

for (const [name, geometry] of [['spiral with trim', vine], ['nurbs with weights', nurbs], ['splines', bundle], ['grow', growing]]) {
  test(`scene_create accepts a curve with ${name}`, async () => {
    await withServer(async ({ client, received }) => {
      const result = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWith(geometry) } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.equal(received.create.length, 1);
    });
  });

  test(`scene_apply add-geometry accepts a curve with ${name}`, async () => {
    await withServer(async ({ client, received }) => {
      const result = await client.callTool({
        name: 'scene_apply',
        arguments: { sessionId: '00000000-0000-4000-8000-000000000000', expectedRevision: 0, operations: [{ type: 'add-geometry', geometry }] },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.equal(received.apply.length, 1);
    });
  });
}

test('scene_create refuses a curve with no points, shape or splines and names the fields to pass', async () => {
  await withServer(async ({ client }) => {
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWith({ id: 'empty', type: 'curve' }) } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /points.*shape.*splines/s);
  });
});

test('scene_create bounds the spline count', async () => {
  await withServer(async ({ client }) => {
    const splines = Array.from({ length: 65 }, () => ({ shape: { type: 'arc' } }));
    const result = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWith({ id: 'many', type: 'curve', splines }) } });
    assert.equal(result.isError, true);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { sessionProblem, SCENE_STORE_LIMITS } from '../src/agent-errors.js';
import { AGENT_SCENE_DEFAULT_LIMITS } from '../src/agent-scene-capabilities.js';

const serverEntry = new URL('../bin/crucible-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const hasBuild = existsSync(new URL('../build/mcp/server.mjs', import.meta.url));

function recipeWithNode(nodeId) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
    nodes: [{ id: nodeId, geometry: 'cube', material: 'blue' }],
  };
}

function textOf(result) {
  return (result.content ?? []).map(part => part.text ?? '').join('\n');
}

async function connectServer(context) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--backend', 'cpu'], stderr: 'ignore' });
  const client = new Client({ name: 'scene-ids-test', version: '1.0.0' });
  await client.connect(transport);
  context.after(() => client.close());
  return client;
}

async function createScene(client, nodeId) {
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeWithNode(nodeId) } });
  assert.notEqual(created.isError, true, textOf(created));
  return created;
}

function nodeIdsOf(inspected) {
  return inspected.structuredContent.nodes.map(node => node.id);
}

test('session errors name the evicted scene and the open ones', () => {
  const evicted = sessionProblem('old', 'b', { openSessionIds: ['a', 'b'], evictedSessionIds: ['old'] });
  assert.match(evicted, /sessionId old was evicted/);
  assert.match(evicted, /Open scenes: a, b/);
  assert.match(evicted, /scene_create/);
  const unknown = sessionProblem('ghost', 'b', { openSessionIds: ['a', 'b'] });
  assert.match(unknown, /Open scenes: a, b; the last used is b/);
  assert.match(unknown, /leave sessionId out/);
});

test('two scenes in one server are edited without interference and a call without an id means the last used scene',
  { skip: !hasBuild && 'run npm run build first', timeout: 180000 }, async context => {
    const client = await connectServer(context);
    const first = await createScene(client, 'alpha').catch(error => {
      context.skip(`no browser for the scene: ${error.message.slice(0, 120)}`);
    });
    if (!first) return;
    const second = await createScene(client, 'beta');
    const firstId = first.structuredContent.sessionId;
    const secondId = second.structuredContent.sessionId;
    assert.notEqual(firstId, secondId);

    // Interleave edits and renders so the two scenes take turns on the one canvas.
    const movedFirst = await client.callTool({ name: 'scene_apply', arguments: { sessionId: firstId, expectedRevision: 0,
      operations: [{ type: 'set-node', id: 'alpha', translation: [3, 0, 0] }] } });
    assert.notEqual(movedFirst.isError, true, textOf(movedFirst));
    const lookSecond = await client.callTool({ name: 'scene_look', arguments: { sessionId: secondId, width: 64, height: 64 } });
    assert.notEqual(lookSecond.isError, true, textOf(lookSecond));
    const movedSecond = await client.callTool({ name: 'scene_apply', arguments: { sessionId: secondId, expectedRevision: 0,
      operations: [{ type: 'set-node', id: 'beta', translation: [0, 5, 0] }] } });
    assert.notEqual(movedSecond.isError, true, textOf(movedSecond));
    const lookFirst = await client.callTool({ name: 'scene_look', arguments: { sessionId: firstId, width: 64, height: 64 } });
    assert.notEqual(lookFirst.isError, true, textOf(lookFirst));

    const firstNodes = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: firstId } });
    const secondNodes = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: secondId } });
    assert.deepEqual(nodeIdsOf(firstNodes), ['alpha']);
    assert.deepEqual(nodeIdsOf(secondNodes), ['beta']);
    assert.equal(firstNodes.structuredContent.revision, 1);
    assert.equal(secondNodes.structuredContent.revision, 1);
    const firstRecipe = await client.callTool({ name: 'scene_export_recipe', arguments: { sessionId: firstId } });
    const secondRecipe = await client.callTool({ name: 'scene_export_recipe', arguments: { sessionId: secondId } });
    assert.deepEqual(firstRecipe.structuredContent.recipe.nodes[0].translation, [3, 0, 0]);
    assert.deepEqual(secondRecipe.structuredContent.recipe.nodes[0].translation, [0, 5, 0]);

    // No id: the scene used last. After naming the first scene, a bare call reads it, and a bare edit lands on it.
    const bare = await client.callTool({ name: 'scene_inspect', arguments: {} });
    assert.equal(bare.structuredContent.sessionId, secondId);
    await client.callTool({ name: 'scene_inspect', arguments: { sessionId: firstId } });
    const bareAfterNaming = await client.callTool({ name: 'scene_inspect', arguments: {} });
    assert.equal(bareAfterNaming.structuredContent.sessionId, firstId);
    const bareEdit = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 1,
      operations: [{ type: 'set-node', id: 'alpha', translation: [9, 0, 0] }] } });
    assert.notEqual(bareEdit.isError, true, textOf(bareEdit));
    assert.equal(bareEdit.structuredContent.sessionId, firstId);
    const untouched = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: secondId } });
    assert.equal(untouched.structuredContent.revision, 1);

    // Disposing one scene leaves the other open and makes it the default.
    const disposed = await client.callTool({ name: 'scene_dispose', arguments: { sessionId: firstId } });
    assert.notEqual(disposed.isError, true, textOf(disposed));
    const afterDispose = await client.callTool({ name: 'scene_inspect', arguments: {} });
    assert.equal(afterDispose.structuredContent.sessionId, secondId);
    const gone = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: firstId } });
    assert.equal(gone.isError, true);
    assert.match(textOf(gone), /Unknown scene session/);
  });

test('the least recently used scene is evicted past the open scene cap and its id gets a clear error',
  { skip: !hasBuild && 'run npm run build first', timeout: 240000 }, async context => {
    const client = await connectServer(context);
    const opened = [];
    for (let index = 0; index < SCENE_STORE_LIMITS.maxOpenScenes; index++) {
      const created = await createScene(client, `node${index}`).catch(error => {
        context.skip(`no browser for the scene: ${error.message.slice(0, 120)}`);
      });
      if (!created) return;
      assert.equal(created.structuredContent.evictedSessions, undefined);
      opened.push(created.structuredContent.sessionId);
    }
    // Using the oldest scene makes the second one the least recently used.
    const touched = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: opened[0] } });
    assert.notEqual(touched.isError, true, textOf(touched));

    const overflow = await createScene(client, 'overflow');
    assert.deepEqual(overflow.structuredContent.evictedSessions, [opened[1]]);

    const evicted = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: opened[1] } });
    assert.equal(evicted.isError, true);
    assert.match(textOf(evicted), new RegExp(`sessionId ${opened[1]} was evicted`));
    assert.match(textOf(evicted), /scene_create/);

    for (const survivor of [opened[0], opened[2], opened[3], overflow.structuredContent.sessionId]) {
      const inspected = await client.callTool({ name: 'scene_inspect', arguments: { sessionId: survivor } });
      assert.notEqual(inspected.isError, true, textOf(inspected));
    }
  });

test('checkpoints are kept up to the limit per scene and the oldest is evicted first',
  { skip: !hasBuild && 'run npm run build first', timeout: 240000 }, async context => {
    const client = await connectServer(context);
    const created = await createScene(client, 'alpha').catch(error => {
      context.skip(`no browser for the scene: ${error.message.slice(0, 120)}`);
    });
    if (!created) return;
    const other = await createScene(client, 'beta');
    const sessionId = created.structuredContent.sessionId;
    const limit = AGENT_SCENE_DEFAULT_LIMITS.maxCheckpoints;
    assert.ok(limit > 8);

    const checkpointIds = [];
    for (let index = 0; index < limit; index++) {
      const saved = await client.callTool({ name: 'scene_checkpoint', arguments: { sessionId } });
      assert.notEqual(saved.isError, true, textOf(saved));
      assert.equal(saved.structuredContent.evictedCheckpointIds, undefined);
      checkpointIds.push(saved.structuredContent.checkpointId);
    }
    // Checkpoints of another scene do not count against this one.
    const foreignSave = await client.callTool({ name: 'scene_checkpoint', arguments: { sessionId: other.structuredContent.sessionId } });
    assert.notEqual(foreignSave.isError, true, textOf(foreignSave));

    const overflow = await client.callTool({ name: 'scene_checkpoint', arguments: { sessionId } });
    assert.notEqual(overflow.isError, true, textOf(overflow));
    assert.deepEqual(overflow.structuredContent.evictedCheckpointIds, [checkpointIds[0]]);

    const restoreEvicted = await client.callTool({ name: 'scene_restore', arguments: { sessionId, checkpointId: checkpointIds[0], expectedRevision: 0 } });
    assert.equal(restoreEvicted.isError, true);
    assert.match(textOf(restoreEvicted), /checkpointId .* was evicted as the oldest/);
    const restoreKept = await client.callTool({ name: 'scene_restore', arguments: { sessionId, checkpointId: checkpointIds[1], expectedRevision: 0 } });
    assert.notEqual(restoreKept.isError, true, textOf(restoreKept));

    // A checkpoint of one scene is foreign to the other.
    const foreignRestore = await client.callTool({ name: 'scene_restore', arguments: { sessionId: other.structuredContent.sessionId, checkpointId: checkpointIds[1], expectedRevision: 0 } });
    assert.equal(foreignRestore.isError, true);
    assert.match(textOf(foreignRestore), /scene_checkpoint returned for sessionId/);
  });

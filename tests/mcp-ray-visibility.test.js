// Issue 1081: a node's rayVisibility, set through the MCP scene tools, reaches the path tracer's per-part bits.
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { buildTraceScene, partRayVisibilityFlags, RAY_VISIBILITY_BITS } from '../src/path-tracer-scene.js';

const ALL_RAY_KINDS = 63;

function roomRecipe(paneFields) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }],
    materials: [
      { id: 'wall', color: [0.7, 0.7, 0.7], emission: 0 },
      { id: 'glass', color: [0.9, 0.95, 1], emission: 0, opacity: 0.2, alphaMode: 'blend' },
    ],
    nodes: [
      { id: 'floor', geometry: 'slab', material: 'wall', scale: [4, 0.1, 4] },
      { id: 'pane', geometry: 'slab', material: 'glass', translation: [0, 1, 2], scale: [1, 1, 0.02], ...paneFields },
    ],
    camera: { eye: [4, 3, 5], target: [0, 0, 0] },
  };
}

function flagsOf(scene, nodeId) {
  const parts = scene.parts;
  const index = parts.findIndex(part => part.name === nodeId);
  const packed = buildTraceScene(parts, { keyColor: [3, 3, 3], lightDirection: [0.4, 0.8, 0.5] });
  return packed.partRayVisibility === null ? ALL_RAY_KINDS : packed.partRayVisibility[index];
}

test("rayVisibility: 'glass' on a window pane lets shadow rays through and keeps every other ray", () => {
  const scene = createAgentScene(roomRecipe({ rayVisibility: 'glass' }));
  assert.equal(flagsOf(scene, 'pane'), ALL_RAY_KINDS & ~RAY_VISIBILITY_BITS.shadow);
  assert.equal(flagsOf(scene, 'floor'), ALL_RAY_KINDS);
});

test('the explicit object form sets the same bits and any other ray kind can be hidden', () => {
  const shadowOff = createAgentScene(roomRecipe({ rayVisibility: { shadow: false } }));
  assert.equal(flagsOf(shadowOff, 'pane'), ALL_RAY_KINDS & ~RAY_VISIBILITY_BITS.shadow);
  const volumeOff = createAgentScene(roomRecipe({ rayVisibility: { volumeScatter: false, shadow: true } }));
  assert.equal(flagsOf(volumeOff, 'pane'), ALL_RAY_KINDS & ~RAY_VISIBILITY_BITS.volumeScatter);
});

test('an empty or all-true rayVisibility changes nothing and a scene without the field packs as before', () => {
  for (const rayVisibility of [{}, { shadow: true }]) {
    const scene = createAgentScene(roomRecipe({ rayVisibility }));
    assert.equal(scene.parts.every(part => part.rayVisibility === undefined), true);
  }
  assert.equal(buildTraceScene(createAgentScene(roomRecipe({})).parts, {}).partRayVisibility, null);
});

test('scene.apply sets and replaces rayVisibility on an existing node', () => {
  const scene = createAgentScene(roomRecipe({}));
  assert.equal(flagsOf(scene, 'pane'), ALL_RAY_KINDS);
  scene.apply([{ type: 'set-node', id: 'pane', rayVisibility: 'glass' }], { expectedRevision: 0 });
  assert.equal(flagsOf(scene, 'pane'), ALL_RAY_KINDS & ~RAY_VISIBILITY_BITS.shadow);
  scene.apply([{ type: 'set-node', id: 'pane', rayVisibility: { shadow: true } }], { expectedRevision: 1 });
  assert.equal(flagsOf(scene, 'pane'), ALL_RAY_KINDS);
});

test('invalid values say what to pass instead', () => {
  assert.throws(() => createAgentScene(roomRecipe({ rayVisibility: 'clear' })), /rayVisibility: got "clear"; expected 'glass'/);
  assert.throws(() => createAgentScene(roomRecipe({ rayVisibility: { sun: false } })), /rayVisibility\.sun: .*ray kind from camera, diffuse/);
  assert.throws(() => createAgentScene(roomRecipe({ rayVisibility: { shadow: 0 } })), /rayVisibility\.shadow: got 0; expected true or false/);
  assert.throws(() => createAgentScene(roomRecipe({ rayVisibility: 'glass', shadowOnly: true })), /shadow rays on when shadowOnly/);
  const recipe = roomRecipe({});
  recipe.nodes.push({ id: 'group', rayVisibility: 'glass' });
  assert.throws(() => createAgentScene(recipe), /mesh node/);
});

test('an emitter hidden from bounce rays is still refused at the path tracer, with the reason', () => {
  const recipe = roomRecipe({ rayVisibility: { diffuse: false } });
  recipe.materials[1].emission = 2;
  const scene = createAgentScene(recipe);
  assert.throws(() => partRayVisibilityFlags(scene.parts.find(part => part.name === 'pane')), /emits light and sets rayVisibility/);
});

test('scene_apply and scene_create list rayVisibility as one node field', async () => {
  const server = createAgentMcpServer({ async close() {}, async capabilities() { return { scene: {}, phase: 'idle' }; } });
  const client = new Client({ name: 'crucible-ray-visibility-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['scene_apply', 'scene_create']) {
      const text = JSON.stringify(tools.find(tool => tool.name === name).inputSchema);
      assert.match(text, /"rayVisibility"/, name);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

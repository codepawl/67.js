import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { hasPatternTextures } from '../scripts/agent-preview-textures.js';

async function sourceText(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

async function backendEnvironmentFields() {
  const source = await sourceText('src/agent-look.js');
  const list = source.match(/const ENVIRONMENT_FIELDS = \[([^\]]+)\]/);
  assert.ok(list, 'ENVIRONMENT_FIELDS moved out of src/agent-look.js');
  return [...list[1].matchAll(/'(\w+)'/g)].map(match => match[1]);
}

async function documentedEnvironmentFields() {
  const text = (await sourceText('docs/agent-look.md')).replaceAll('\r\n', '\n');
  const section = text.slice(text.indexOf('\n## Environment\n'));
  const table = section.slice(0, section.indexOf('\n\n', section.indexOf('| --- |')));
  return [...table.matchAll(/^\| `(\w+)` \|/gm)].map(match => match[1]);
}

function findSetEnvironmentSchema(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.properties?.type?.const === 'set-environment' && node.properties.environment) return node.properties.environment;
  for (const value of Object.values(node)) {
    const found = findSetEnvironmentSchema(value);
    if (found) return found;
  }
  return null;
}

async function withMcpClient(use) {
  const server = createAgentMcpServer({ async close() {}, async capabilities() { return { scene: {}, phase: 'idle' }; } });
  const client = new Client({ name: 'crucible-environment-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function listedTools() {
  return withMcpClient(async client => (await client.listTools()).tools);
}

function toolSchema(tools, name) {
  return tools.find(tool => tool.name === name).inputSchema;
}

// Every tool lists the same short environment; scene_capabilities topic environment outlines the full schema.
async function mcpEnvironmentFields() {
  return withMcpClient(async client => {
    const outline = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'environment' } })).structuredContent.fields;
    return Object.keys(outline).filter(key => key !== '_' && key !== '$defs').map(key => key.replace(/[?]$/, ''));
  });
}

test('every tool lists a short environment that names the capabilities topic instead of repeating the fields', async () => {
  const tools = await listedTools();
  const references = [
    findSetEnvironmentSchema(toolSchema(tools, 'scene_apply')),
    toolSchema(tools, 'scene_create_asset').properties.recipe.properties.environment,
    toolSchema(tools, 'scene_create').properties.recipe.properties.environment,
  ];
  for (const reference of references) {
    assert.match(reference.description, /scene_capabilities environment/);
    assert.ok(Object.keys(reference.properties).length < 10);
  }
});

test('the server still checks every environment field of scene_apply and scene_create_asset', async () => {
  await withMcpClient(async client => {
    const apply = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 0, operations: [{ type: 'set-environment', environment: { skyTop: 'blue', bogus: 1 } }] } });
    const asset = await client.callTool({ name: 'scene_create_asset', arguments: { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: 'a'.repeat(64), environment: { world: 'yes' } } } });
    for (const result of [apply, asset]) assert.equal(result.isError, true);
    assert.match(apply.content[0].text, /bogus/);
    assert.match(apply.content[0].text, /skyTop/);
    assert.match(asset.content[0].text, /world/);
  });
});

test('the MCP environment schema lists exactly the fields the backend allows', async () => {
  const backend = (await backendEnvironmentFields()).sort();
  assert.deepEqual((await mcpEnvironmentFields()).sort(), backend);
});

test('every documented environment field is in the MCP schema', async () => {
  const schema = await mcpEnvironmentFields();
  const documented = await documentedEnvironmentFields();
  assert.ok(documented.length > 10);
  assert.deepEqual(documented.filter(field => !schema.includes(field)), []);
  for (const field of ['viewTransform', 'resolveCoplanar', 'ground']) assert.ok(schema.includes(field), field);
});

function coplanarRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', scale: [1, 0.5, 0.2] },
    ],
  };
}

test('set-environment accepts every optional volume fog field on a recipe that set none', () => {
  const scene = createAgentScene(coplanarRecipe());
  const fields = { scatterOctaves: 2, multiScatter: 0.5, multiExtinction: 0.4, multiAnisotropy: 0.3, keyTransmittance: 0.6, surfaceTransmittance: 0.7, detailOctaves: 2, detailAmount: 0.3, warp: 1, contrast: 1.2, profileSoftness: 0.4, keyScattering: 2 };
  for (const [field, value] of Object.entries(fields)) {
    const fresh = createAgentScene(coplanarRecipe());
    fresh.apply([{ type: 'set-environment', environment: { volumeFog: { [field]: value } } }], { expectedRevision: fresh.revision });
    assert.ok(Object.hasOwn(fresh.environment.volumeFog, field), field);
  }
  scene.apply([{ type: 'set-environment', environment: { volumeFog: fields } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.volumeFog.scatterOctaves, fields.scatterOctaves);
});

test('the MCP schema accepts the opt-in fog fields', async () => {
  await withMcpClient(async client => {
    const result = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 0, operations: [{ type: 'set-environment', environment: { volumeFog: { scatterOctaves: 2, multiScatter: 0.5 } } }] } });
    assert.doesNotMatch(result.content[0].text, /Unrecognized|Unknown volumeFog/);
  });
});

test('set-environment accepts ground, viewTransform and resolveCoplanar', () => {
  const scene = createAgentScene(coplanarRecipe());
  scene.apply([{ type: 'set-environment', environment: { ground: false, viewTransform: 'agx', resolveCoplanar: 'offset' } }], { expectedRevision: scene.revision });
  assert.equal(scene.environment.ground, false);
  assert.equal(scene.environment.viewTransform, 'agx');
  assert.equal(scene.environment.resolveCoplanar, 'offset');
});

test('switching the flush ranks on regroups parts, and the preview sees every texture map so it rebuilds the renderer', () => {
  const scene = createAgentScene({ ...coplanarRecipe(), environment: { resolveCoplanar: false } });
  const before = scene.topologyRevision;
  scene.apply([{ type: 'set-environment', environment: { resolveCoplanar: 'offset' } }], { expectedRevision: scene.revision });
  assert.ok(scene.topologyRevision > before, 'the edit changes topology, which replaceParts refuses for textured parts');
  for (const field of ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap']) {
    assert.equal(hasPatternTextures([{ material: { [field]: {} } }]), true, field);
  }
  assert.equal(hasPatternTextures(scene.parts), false);
});

const OPTIONAL_VOLUME_FOG_PATCH = { scatterOctaves: 2, multiScatter: 0.6, multiExtinction: 0.4, multiAnisotropy: 0.3, keyTransmittance: 0.2, surfaceTransmittance: 0.1, heightFalloff: 2 };

test('set-environment sets every optional volumeFog field on a recipe that did not set them at creation', () => {
  const scene = createAgentScene(coplanarRecipe());
  scene.apply([{ type: 'set-environment', environment: { volumeFog: OPTIONAL_VOLUME_FOG_PATCH } }], { expectedRevision: scene.revision });
  for (const [field, value] of Object.entries(OPTIONAL_VOLUME_FOG_PATCH)) assert.equal(scene.environment.volumeFog[field], value, field);
  assert.throws(() => scene.apply([{ type: 'set-environment', environment: { volumeFog: { mystery: 1 } } }], { expectedRevision: scene.revision }), /mystery/);
});

// The MCP schema names only the two fields agents use; the others stay reachable through the recipe, within the tool cost allowance.
const MCP_VOLUME_FOG_PATCH = { scatterOctaves: 2, multiScatter: 0.6 };

test('the MCP scene_create and scene_apply schemas accept the optional volumeFog fields', async () => {
  let scene;
  const runtime = {
    async capabilities() { return {}; },
    async create({ recipe }) {
      scene = createAgentScene(recipe);
      return { revision: scene.revision };
    },
    async apply({ expectedRevision, operations }) {
      scene.apply(operations, { expectedRevision });
      return { revision: scene.revision };
    },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-volume-fog-schema-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const created = await client.callTool({ name: 'scene_create', arguments: { recipe: coplanarRecipe() } });
    assert.notEqual(created.isError, true, created.content?.[0]?.text);
    const applied = await client.callTool({ name: 'scene_apply', arguments: { expectedRevision: 0, operations: [{ type: 'set-environment', environment: { volumeFog: MCP_VOLUME_FOG_PATCH } }] } });
    assert.notEqual(applied.isError, true, applied.content?.[0]?.text);
    assert.equal(scene.environment.volumeFog.multiScatter, 0.6);
    const atCreation = await client.callTool({ name: 'scene_create', arguments: { recipe: { ...coplanarRecipe(), environment: { volumeFog: MCP_VOLUME_FOG_PATCH } } } });
    assert.notEqual(atCreation.isError, true, atCreation.content?.[0]?.text);
  } finally {
    await client.close();
    await server.close();
  }
});
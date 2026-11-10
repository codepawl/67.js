import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from './mcp-server.mjs';
import { VEGETATION_CAPABILITY_NOTE } from '../src/agent-vegetation-notes.js';
import { CROWD_CAPABILITY_NOTE } from '../src/agent-crowd-notes.js';
import { USER_PASS_CAPABILITIES } from '../src/user-pass.js';
import { GAME_CAPABILITIES } from '../src/game-setup-notes.js';
import { MESH_BLEND_CAPABILITIES } from '../src/mesh-blend.js';
import { MATERIAL_SNIPPET_CAPABILITIES } from '../src/material-snippet.js';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { TEXTURE_SEQUENCE_CAPABILITIES } from '../src/texture-sequence-limits.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';

// JSON is dense in tokens: about 3.5 characters each for schemas and recipes (an estimate, not a tokenizer count).
const CHARACTERS_PER_TOKEN = 3.5;
const SAMPLE_SESSION = '00000000-0000-4000-8000-000000000000';
const SMALL_EDIT = { op: 'extrude_face_region', select: { tag: 'dish.cap' }, offset: -0.02, name: 'well' };

export function estimateTokens(bytes) {
  return Math.ceil(bytes / CHARACTERS_PER_TOKEN);
}

function sizeOf(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return { bytes, tokens: estimateTokens(bytes) };
}

/** A small furniture recipe: one mesh geometry with an edit log and a few plain nodes. */
export function sampleRecipe() {
  const leg = index => ({
    id: `leg-${index}`, geometry: 'leg', material: 'wood',
    translation: [index % 2 ? 0.4 : -0.4, 0.25, index > 1 ? 0.4 : -0.4], scale: [0.08, 0.5, 0.08],
  });
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [
      {
        id: 'seat', type: 'mesh', base: { type: 'box', bevel: 0 },
        edits: [
          { op: 'inset_region', select: { tag: 'top' }, thickness: 0.08, name: 'rim' },
          { op: 'extrude_face_region', select: { tag: 'rim.cap' }, offset: -0.03, name: 'dish' },
        ],
      },
      { id: 'leg', type: 'box', bevel: 0 },
      { id: 'back', type: 'box', bevel: 0 },
    ],
    materials: [{ id: 'wood', color: [0.45, 0.28, 0.14], roughness: 0.7 }, { id: 'cushion', color: [0.7, 0.1, 0.1], roughness: 0.9 }],
    nodes: [
      { id: 'seat', geometry: 'seat', material: 'cushion', translation: [0, 0.55, 0], scale: [1, 0.1, 1] },
      ...[0, 1, 2, 3].map(leg),
      { id: 'back', geometry: 'back', material: 'wood', translation: [0, 0.95, -0.46], scale: [1, 0.7, 0.08] },
    ],
  };
}

async function withClient(runtime, use) {
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'tool-cost', version: '1' });
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

export async function listTools() {
  return withClient({ async close() {} }, async client => (await client.listTools()).tools);
}

/** What an agent receives from scene_capabilities with no topic: the index on this branch, the whole list on an older one. */
async function defaultCapabilitiesResult() {
  const scene = { ...AGENT_SCENE_CAPABILITIES, game: GAME_CAPABILITIES, postPasses: USER_PASS_CAPABILITIES, meshBlend: MESH_BLEND_CAPABILITIES, materialSnippet: MATERIAL_SNIPPET_CAPABILITIES, vegetation: VEGETATION_CAPABILITY_NOTE, crowd: CROWD_CAPABILITY_NOTE, textureSequence: TEXTURE_SEQUENCE_CAPABILITIES };
  const runtime = { async close() {}, async capabilities() { return { scene, phase: 'idle', availableIn: '0.0.0' }; } };
  return withClient(runtime, async client => (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent);
}

async function typicalResults(recipe) {
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  const status = { sessionId: SAMPLE_SESSION, revision: scene.revision, inspection: scene.inspect(), render: { backend: 'gpu' } };
  scene.apply([{ type: 'edit-mesh', geometry: 'seat', edits: [SMALL_EDIT] }], { expectedRevision: scene.revision });
  const meshReport = scene.inspectMeshes({ geometries: ['seat'] });
  const { inspection, ...statusWithoutInspection } = status;
  return {
    scene_capabilities: await defaultCapabilitiesResult(),
    scene_create: status,
    scene_inspect: { sessionId: SAMPLE_SESSION, ...scene.inspect() },
    mesh_inspect: { sessionId: SAMPLE_SESSION, ...meshReport },
    mesh_edit: { ...status, mesh: meshReport.meshes[0] },
    scene_apply: statusWithoutInspection,
    scene_export_recipe: { sessionId: SAMPLE_SESSION, revision: scene.revision, recipe: scene.exportRecipe() },
  };
}

/** One small mesh change sent as a mesh_edit call, against the same change sent as a whole new recipe. */
function smallChangeComparison(recipe) {
  const meshEditCall = { sessionId: SAMPLE_SESSION, expectedRevision: 1, geometry: 'seat', edits: [SMALL_EDIT] };
  const changed = structuredClone(recipe);
  changed.geometries[0].edits.push(SMALL_EDIT);
  return {
    meshEditCall: sizeOf(meshEditCall),
    rewriteCall: sizeOf({ recipe: changed }),
    rewriteNeedsDispose: sizeOf({ sessionId: SAMPLE_SESSION }),
  };
}

export async function measureToolCost() {
  const tools = await listTools();
  const entries = tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  const schemas = entries
    .map(entry => ({ name: entry.name, descriptionBytes: Buffer.byteLength(entry.description), ...sizeOf(entry) }))
    .sort((first, second) => second.bytes - first.bytes);
  const recipe = sampleRecipe();
  const results = Object.entries(await typicalResults(recipe)).map(([name, value]) => ({ name, ...sizeOf(value) }));
  return { schemas, schemaTotal: sizeOf(entries), results, comparison: smallChangeComparison(recipe) };
}

function printRow(name, row, note = '') {
  console.log(`  ${name.padEnd(26)} ${String(row.bytes).padStart(7)} B  ~${String(row.tokens).padStart(6)} tokens${note}`);
}

function printReport(report) {
  console.log('Tool schemas (description + input schema), largest first');
  for (const row of report.schemas) printRow(row.name, row, `  (description ${row.descriptionBytes} B)`);
  printRow('TOTAL', report.schemaTotal);
  console.log('Typical results');
  for (const row of report.results) printRow(row.name, row);
  const { meshEditCall, rewriteCall, rewriteNeedsDispose } = report.comparison;
  console.log('Small mesh change (one inset on the seat)');
  printRow('mesh_edit call', meshEditCall);
  printRow('scene_create rewrite', rewriteCall, `  (+ scene_dispose ${rewriteNeedsDispose.bytes} B)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await measureToolCost();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report));
  else printReport(report);
}

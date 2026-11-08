import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants, setPriority } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { PatientStdioClientTransport } from './patient-stdio-transport.mjs';

// One recipe through the real MCP server that uses light linking and cascaded sun shadows together: a long street under
// the sun, a lamp that lights only the left wall, and a car that moves, so a seek has something to redraw.
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'cpu';
await mkdir('artifacts', { recursive: true });

function streetRecipe() {
  const buildings = Array.from({ length: 8 }, (_, index) => ({
    id: `building-${index}`, geometry: 'box', material: 'wall', translation: [index % 2 === 0 ? -6 : 6, 3, -index * 14], scale: [4, 6, 10],
  }));
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'wall', color: [0.75, 0.7, 0.62], roughness: 0.9 }, { id: 'paint', color: [0.7, 0.1, 0.08], roughness: 0.4 }],
    nodes: [
      { id: 'road', geometry: 'box', material: 'wall', translation: [0, -0.1, -50], scale: [14, 0.2, 130] },
      ...buildings,
      { id: 'car', geometry: 'box', material: 'paint', translation: [2, 0.6, -6], scale: [1.8, 1.2, 4] },
    ],
    camera: { eye: [0, 2.2, 8], target: [0, 1.5, -30], fov: 55, near: 0.2, far: 300 },
    environment: {
      lightDirection: [-0.5, 0.8, 0.4],
      shadowCascades: 3,
      keyAffects: ['road', 'car', 'building-1', 'building-3', 'building-5'],
      pointLights: [{ position: [-3, 3, -4], color: [1, 0.7, 0.4], intensity: 60, range: 14, affects: ['building-0', 'building-2'] }],
    },
    shadow: { target: [0, 0, -40], extent: 85, distance: 120, near: 1, far: 260 },
    motion: { duration: 2, tracks: [{ kind: 'node', id: 'car', property: 'translation', interpolation: 'LINEAR',
      keyframes: [{ time: 0, value: [2, 0.6, -6] }, { time: 2, value: [2, 0.6, -20] }] }] },
  };
}

const transport = new PatientStdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', backend, '--memory', '192'],
  stderr: 'pipe',
  cwd: process.cwd(),
});
const client = new Client({ name: '67js-linking-proof', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function look(sessionId, motionTime) {
  const result = await call('scene_look', { sessionId, motionTime, width: 640, height: 360 });
  return Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
}

let report;
try {
  await client.connect(transport);
  const capabilities = (await call('scene_capabilities', { topic: 'lightLinking' })).structuredContent;
  assert.ok(capabilities.value.fields.length > 0);
  const created = (await call('scene_create', { recipe: streetRecipe() })).structuredContent;
  const { sessionId } = created;
  assert.ok(created.render.graphics, 'the scene rendered');
  const firstSeek = await look(sessionId, 1);
  await look(sessionId, 0);
  const secondSeek = await look(sessionId, 1);
  assert.deepEqual(secondSeek, firstSeek, 'seeking to the same time gives the same bytes');
  await writeFile(`artifacts/mcp-linking-${backend}.png`, firstSeek);

  const unknown = await client.callTool({ name: 'scene_apply', arguments: { sessionId, expectedRevision: created.revision,
    operations: [{ type: 'set-environment', environment: { keyAffects: ['no-such-node'] } }] } });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /no-such-node.*scene_inspect/);

  const exported = (await call('scene_export_recipe', { sessionId })).structuredContent.recipe;
  assert.equal(exported.environment.shadowCascades, 3);
  assert.deepEqual(exported.environment.pointLights[0].affects, ['building-0', 'building-2']);
  assert.equal(exported.environment.keyAffects.length, 5);
  await call('scene_dispose', { sessionId });
  report = { backend, graphics: created.render.graphics, seekSha256: createHash('sha256').update(firstSeek).digest('hex'), seekBytes: firstSeek.byteLength,
    unknownNodeRejected: true, recipeKeepsLinksAndCascades: true };
} finally {
  await client.close();
}
await writeFile(`artifacts/mcp-linking-${backend}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

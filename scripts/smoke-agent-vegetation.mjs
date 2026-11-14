// Through MCP on the CPU backend: a forest clearing grown by the vegetation node on terrain, an imported tree whose leaf
// material is tagged foliage, and wind. Checks the inspected counts, that wind moves the frame and that a seek reproduces it.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTree } from '../src/vegetation.js';
import { exportGlb } from '../src/export.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const proofFolder = 'artifacts/vegetation-proof';
await mkdir(proofFolder, { recursive: true });

// exportGlb writes no material names, so name the materials in the GLB JSON chunk, in order of first use.
function nameGlbMaterials(glb, names) {
  const bytes = Buffer.from(glb);
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  document.materials.forEach((material, index) => { material.name = names[index]; });
  const padded = Buffer.from(JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length / 4) * 4, ' '));
  const rest = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + rest.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.write('JSON', 16, 'latin1');
  return Buffer.concat([header, padded, rest]);
}

// An imported tree: the addon's mesh-leaf tree written as a GLB, so its materials are plain named glTF materials.
const tree = createTree({ species: 'broadleaf', leaves: 'mesh', height: 8 }, 4);
const importedParts = tree.levels[1].parts.map(part => ({
  name: part.role, geometry: part.geometry, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: { ...part.material, tag: 'surface' },
}));
await writeFile(`${proofFolder}/imported-tree.glb`, nameGlbMaterials(exportGlb(importedParts), ['Bark', 'Leaves']));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', resolve(proofFolder)],
  stderr: 'pipe', cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-vegetation-proof', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } },
});
async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
// The wind clock is the renderer time, so a review at one renderer time is the frame a render job draws at that time.
async function look(sessionId, revision, label, rendererTime) {
  const result = await call('scene_review', { sessionId, expectedRevision: revision, width: 480, height: 270, labels: false, shots: [{ rendererTime }] });
  const bytes = Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
  await writeFile(`artifacts/vegetation-${label}.png`, bytes);
  return bytes;
}
try {
  await client.connect(transport, { timeout: 180000 });
  assert.equal((await client.listTools()).tools.length, 22);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const imported = catalog.assets.find(asset => asset.name === 'imported-tree.glb').assetId;
  const created = (await call('scene_create', { recipe: {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'hills', type: 'terrain', size: 50, resolution: 64, amplitude: 1.2, seed: 4 }, { id: 'beacon', type: 'sphere' }],
    materials: [{ id: 'turf', tag: 'grass', color: [0.2, 0.34, 0.1], roughness: 0.95 }, { id: 'lamp', color: [1, 0.8, 0.3], emission: 2 }],
    nodes: [
      { id: 'ground', geometry: 'hills', material: 'turf' },
      { id: 'forest', vegetation: { mix: { broadleaf: 3, birch: 1.5, conifer: 2, bush: 2 }, seed: 11, leaves: 'cards', season: 0.4,
        scatter: { ground: 'ground', density: 0.014, slopeLimit: 30, exclude: [{ center: [0, 0], radius: 8 }, { node: 'imported', radius: 3 }], variants: 2 } } },
      { id: 'imported', translation: [2.5, 0.3, 1], asset: { id: imported, materials: [{ name: 'Leaves', tag: 'foliage', color: [0.2, 0.5, 0.12] }] } },
      { id: 'beacon', geometry: 'beacon', material: 'lamp', translation: [-3, 0.4, 1], scale: [0.3, 0.3, 0.3] },
    ],
    environment: { wind: { strength: 2.5, direction: 20 } },
    camera: { eye: [0, 3, 13], target: [0, 3.5, 0], fov: 55 },
  } })).structuredContent;
  const sessionId = created.sessionId;
  const inspection = (await call('scene_inspect', { sessionId })).structuredContent;
  const forest = inspection.vegetation[0];
  assert.equal(forest.mode, 'scatter');
  assert.ok(forest.instances > 20 && forest.triangles > 0);
  assert.ok(Object.values(forest.species).every(species => species.levels.length > 0));
  assert.equal(inspection.assets.length, 1);
  const first = await look(sessionId, created.revision, 'wind-start', 0.4);
  const later = await look(sessionId, created.revision, 'wind-later', 2.3);
  assert.notDeepEqual(first, later, 'the wind moves the leaves');
  assert.deepEqual(await look(sessionId, created.revision, 'wind-later-again', 2.3), later, 'a seek reproduces its frame');
  assert.deepEqual(await look(sessionId, created.revision, 'wind-start-again', 0.4), first);
  await call('scene_dispose', { sessionId });
  const report = { backend: 'cpu', instances: forest.instances, species: forest.species, triangles: forest.triangles, seekExact: true };
  await writeFile('artifacts/vegetation-cpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

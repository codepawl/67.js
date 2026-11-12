import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { constants, setPriority } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { PatientStdioClientTransport } from './patient-stdio-transport.mjs';
import { createAgentPreviewFixture } from './agent-preview-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'gpu';
const era = process.argv[3] ?? 'modern';
assert.ok(['gpu', 'cpu'].includes(backend));
assert.ok(['modern', 'legacy'].includes(era));
await mkdir('artifacts', { recursive: true });
const transport = new PatientStdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', backend, '--memory', '192'],
  stderr: 'pipe',
  cwd: process.cwd(),
});
let errors = '';
transport.stderr.on('data', chunk => { errors += chunk.toString(); });
const client = new Client({ name: '67js-render-proof', version: '1' }, {
  versionNegotiation: { mode: era === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
});
let processId;
let report;

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function look(sessionId, label, width = 960, height = 540) {
  const result = await call('scene_look', { sessionId, width, height });
  const image = result.content.find(item => item.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  const bytes = Buffer.from(image.data, 'base64');
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(bytes.byteLength > 10000);
  assert.ok(bytes.byteLength <= 1024 * 1024);
  assert.equal(bytes.readUInt32BE(16), result.structuredContent.width);
  assert.equal(bytes.readUInt32BE(20), result.structuredContent.height);
  assert.equal(result.structuredContent.requestedWidth, width);
  assert.equal(result.structuredContent.requestedHeight, height);
  assert.ok(result.structuredContent.estimatedBytes <= 192 * 1024 * 1024);
  await writeFile(`artifacts/mcp-${backend}-${era}-${label}.png`, bytes);
  return { bytes, metadata: result.structuredContent };
}

try {
  await client.connect(transport);
  processId = transport.pid;
  const listing = await client.listTools();
  assert.equal(listing.tools.length, 25);
  const capabilities = (await call('scene_capabilities')).structuredContent;
  assert.equal(capabilities.phase, 'idle');
  const fixture = createAgentPreviewFixture();
  const empty = (await call('scene_create', { recipe: { ...fixture, geometries: [], materials: [], nodes: [] } })).structuredContent;
  const { sessionId } = empty;
  assert.equal(empty.inspection.counts.parts, 0);
  const created = (await call('scene_apply', { sessionId, expectedRevision: 0, operations: [
    ...fixture.geometries.map(geometry => ({ type: 'add-geometry', geometry })),
    ...fixture.materials.map(material => ({ type: 'add-material', material })),
    ...fixture.nodes.map(node => ({ type: 'add-node', node })),
  ] })).structuredContent;
  assert.equal(created.renderSucceeded, true);
  const createdCounts = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.equal(createdCounts.counts.parts, 19);
  assert.equal(createdCounts.counts.geometries, 7);
  assert.equal(created.revision, 1);
  assert.match(created.render.graphics, backend === 'gpu' ? /NVIDIA/i : /SwiftShader/i);
  const meshes = (await call('mesh_inspect', { sessionId })).structuredContent;
  assert.equal(meshes.meshes.length, 7);
  assert.ok(meshes.meshes.every(mesh => mesh.counts.faces > 0 && Array.isArray(mesh.problems)));
  const before = await look(sessionId, 'before');
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const edited = (await call('scene_apply', {
    sessionId, expectedRevision: 1,
    operations: [
      { type: 'set-node', id: 'lamp', translation: [0.18, 0.82, 0] },
      { type: 'set-node', id: 'glow', scale: [0.34, 0.3, 0.34], translation: [0, 0.75, 0] },
      { type: 'set-material', id: 'light', color: [0.9, 0.28, 0.04], emissiveColor: [0.9, 0.28, 0.04] },
      { type: 'set-environment', environment: { lightDirection: [0, 1, 0], keyColor: [1, 2, 4], pointLights: [{ position: [1, 1, 1], color: [1, 0.2, 0.05], intensity: 4 }], volumeFog: { density: 0.04 } } },
      { type: 'set-effects', effects: { exposure: 0.8, bloom: { strength: 0.2 } } },
      { type: 'set-shadow', shadow: { extent: 5, distance: 9, far: 20 } },
    ],
  })).structuredContent;
  assert.equal(edited.revision, 2);
  assert.equal(edited.committed, true);
  assert.equal(edited.renderSucceeded, true);
  assert.equal(edited.render.depth, true);
  assert.equal(edited.inspection, undefined);
  const editedLook = (await call('scene_inspect', { sessionId })).structuredContent.look;
  assert.equal(editedLook.pointLights, 1);
  assert.equal(editedLook.volumeFogDensity, 0.04);
  const after = await look(sessionId, 'after');
  assert.notDeepEqual(after.bytes, before.bytes);
  const stale = await client.callTool({ name: 'scene_apply', arguments: {
    sessionId, expectedRevision: 0, operations: [{ type: 'set-node', id: 'lamp', translation: [20, 0, 0] }],
  } });
  assert.equal(stale.isError, true);
  const inspection = (await call('scene_inspect', { sessionId, ids: ['lamp', 'glow'], includeBounds: true })).structuredContent;
  assert.equal(inspection.revision, 2);
  assert.equal(inspection.nodes.length, 2);
  assert.ok(inspection.nodes[1].bounds);
  const restoredStatus = (await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 2 })).structuredContent;
  assert.equal(restoredStatus.committed, true);
  assert.equal(restoredStatus.renderSucceeded, true);
  const restored = await look(sessionId, 'restored');
  assert.deepEqual(restored.bytes, before.bytes);
  // The ornament stays inside the pedestal's footprint: a wider scene stops the pedestal counting as the floor, and the automatic floor disc adds a geometry buffer of its own.
  const enlarged = (await call('scene_apply', { sessionId, expectedRevision: 3, operations: [
    { type: 'add-geometry', geometry: { id: 'ornament', type: 'sphere', segments: 24, rings: 16 } },
    { type: 'add-material', material: { id: 'ruby', color: [0.8, 0.04, 0.06], metallic: 0.6, roughness: 0.2 } },
    { type: 'add-node', node: { id: 'ornament', geometry: 'ornament', material: 'ruby', translation: [-0.5, 0.8, 0], scale: [0.28, 0.28, 0.28] } },
  ] })).structuredContent;
  assert.equal(enlarged.renderSucceeded, true);
  assert.equal((await call('scene_inspect', { sessionId })).structuredContent.counts.parts, 20);
  assert.equal(enlarged.render.geometryBuffers, before.metadata.geometryBuffers + 1);
  const topology = await look(sessionId, 'topology');
  assert.notDeepEqual(topology.bytes, before.bytes);
  await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 4 });
  const topologyRestored = await look(sessionId, 'topology-restored');
  assert.deepEqual(topologyRestored.bytes, before.bytes);
  assert.equal(topologyRestored.metadata.geometryBuffers, before.metadata.geometryBuffers);
  const removed = (await call('scene_apply', { sessionId, expectedRevision: 5, operations: [
    { type: 'remove-node', id: 'lamp', recursive: true },
    ...fixture.geometries.map(geometry => ({ type: 'remove-geometry', id: geometry.id })),
    ...fixture.materials.map(material => ({ type: 'remove-material', id: material.id })),
  ] })).structuredContent;
  assert.equal(removed.renderSucceeded, true);
  assert.equal((await call('scene_inspect', { sessionId })).structuredContent.counts.parts, 0);
  assert.equal(removed.render.gpuBuffers, 0);
  await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 6 });
  assert.deepEqual((await look(sessionId, 'recreated')).bytes, before.bytes);
  await call('scene_release_checkpoint', { sessionId, checkpointId: checkpoint.checkpointId });
  const exported = (await call('scene_export_recipe', { sessionId })).structuredContent;
  assert.equal(exported.revision, 7);
  assert.deepEqual(exported.recipe.nodes.find(node => node.id === 'lamp').translation, [0, 0.82, 0]);
  await writeFile(`artifacts/mcp-${backend}-${era}-recipe.json`, JSON.stringify(exported.recipe, null, 2));
  const portrait = await look(sessionId, 'portrait', 540, 960);
  await call('scene_apply', { sessionId, expectedRevision: 7, operations: [
    { type: 'set-camera', eye: [0, 5.5, 0], target: [0, 1.06, 0], up: [0, 0, -1] },
  ] });
  await look(sessionId, 'top', 540, 960);
  const disposed = (await call('scene_dispose', { sessionId })).structuredContent;
  assert.equal(disposed.disposed, true);
  const missing = await client.callTool({ name: 'scene_inspect', arguments: { sessionId } });
  assert.equal(missing.isError, true);
  // The browser remains available after disposal, but a new scene receives a new identity.
  const replacement = (await call('scene_create', { recipe: createAgentPreviewFixture() })).structuredContent;
  assert.notEqual(replacement.sessionId, sessionId);
  await call('scene_dispose', { sessionId: replacement.sessionId });
  report = { backend, era, tools: listing.tools.length, parts: createdCounts.counts.parts, geometryBytes: createdCounts.geometryBytes,
    graphics: created.render.graphics, before: before.metadata, portrait: portrait.metadata, restorePngExact: true, staleRevisionRejected: true,
    builtFromEmpty: true, topologyRestoreExact: true, disposedGeometryBuffers: true };
} finally {
  await client.close();
}
assert.match(errors, /67js preview resources closed\./);
assert.doesNotMatch(errors, /cleanup failed|shutdown failed/);
assert.throws(() => process.kill(processId, 0), /ESRCH/);
await writeFile(`artifacts/mcp-${backend}-${era}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

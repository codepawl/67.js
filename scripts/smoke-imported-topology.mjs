// Edits the topology of RobotExpressive parts through the real MCP server: a through hole in a closed leg, a cut in a
// skinned hand and in a morphed head, an edit that must be rejected, a checkpoint restore and a GLB export of the result.
// Run `npm run prepare:release` first; the preview page comes from its build. Prints the measured outcome per part.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseGltf } from '../src/gltf.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'gpu';
const directory = await mkdtemp(join(tmpdir(), 'crucible-topology-'));
const assets = join(directory, 'assets');
await mkdir(assets);
await copyFile(resolve('tests/fixtures/RobotExpressive.glb'), join(assets, 'robot.glb'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', backend, '--memory', '192', '--assets', assets, '--jobs', join(directory, 'jobs')],
  stderr: 'pipe',
  cwd: process.cwd(),
});
const client = new Client({ name: 'crucible-topology-smoke', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content).slice(0, 700)}`);
  return result.structuredContent;
}

async function callExpectingError(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.ok(result.isError, `${name} should have been rejected`);
  return JSON.stringify(result.content);
}

function summarize(mesh) {
  return { triangles: mesh.counts.triangles, closed: mesh.parts.closed, ok: mesh.ok, transfer: mesh.transfer };
}

const report = {};
try {
  await client.connect(transport);
  const catalog = await call('scene_asset_catalog');
  const created = await call('scene_create_asset', { recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: catalog.assets[0].assetId } });
  const { sessionId } = created;
  let { revision } = created;
  const before = (await call('mesh_inspect', { sessionId, geometries: ['mesh-10', 'mesh-15', 'mesh-3'] })).meshes;
  report.before = before.map(summarize);
  const checkpoint = await call('scene_checkpoint', { sessionId });

  const hole = await call('mesh_edit', {
    sessionId, expectedRevision: revision, geometry: 'mesh-10',
    edits: [{ op: 'boolean', operation: 'difference', cutter: { type: 'cylinder', segments: 24 }, scale: [0.0003, 0.01, 0.0003] }],
  });
  assert.equal(hole.renderSucceeded, true, hole.renderError);
  assert.equal(hole.topologyRevision, 1);
  revision = hole.revision;
  report.hole = summarize(hole.mesh);
  assert.ok(hole.mesh.parts.closed === 1 && hole.mesh.ok);

  const hand = await call('mesh_edit', { sessionId, expectedRevision: revision, geometry: 'mesh-15', edits: [{ op: 'delete', select: { tag: 'top' } }] });
  revision = hand.revision;
  report.skinnedHand = summarize(hand.mesh);
  const head = await call('mesh_edit', { sessionId, expectedRevision: revision, geometry: 'mesh-3', edits: [{ op: 'delete', select: { tag: 'top' } }] });
  revision = head.revision;
  report.morphedHead = summarize(head.mesh);

  const rejection = await callExpectingError('mesh_edit', {
    sessionId, expectedRevision: revision, geometry: 'mesh-3', edits: [{ op: 'extrude_face_region', select: { tag: 'front' }, offset: 3 }],
  });
  assert.match(rejection, /Keep edits within/);
  report.rejection = rejection.slice(0, 160);

  const withClip = await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-animation', clip: 10, time: 0.3 }] });
  assert.equal(withClip.renderSucceeded, true, withClip.renderError);
  revision = withClip.revision;
  const glb = await call('scene_export_glb', { sessionId });
  report.glbBytes = glb.bytes;
  const reread = await parseGltf((await readFile(glb.path)).buffer.slice(0), { maxVertices: 500000 });
  assert.equal(reread.parts.length, 19);
  const leg = reread.parts[10];
  assert.equal(leg.geometry.indices.length / 3, hole.mesh.counts.triangles, 'the exported leg is the edited one');
  assert.ok(reread.parts[15].skin, 'the edited hand keeps its skin in the export');
  reread.dispose();
  const exported = await call('scene_export_recipe', { sessionId });
  assert.deepEqual((exported.recipe ?? exported).meshEdits.map(entry => entry.id).sort(), ['mesh-10', 'mesh-15', 'mesh-3']);

  const restored = await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: revision });
  assert.equal(restored.renderSucceeded, true, restored.renderError);
  const after = (await call('mesh_inspect', { sessionId, geometries: ['mesh-10'] })).meshes[0];
  assert.equal(after.counts.triangles, before[0].counts.triangles);
  await call('scene_dispose', { sessionId });
  console.log(`Imported topology passed on ${backend}: ${JSON.stringify(report)}`);
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(error => console.warn(`Left ${directory}: ${error.code}`));
}

// scene_export_glb through the real MCP server: a recipe with a pattern material, the robot posed by IK, and the robot's
// walk clip. The files are copied to artifacts/glb-export-*.glb for opening in Blender. Run `npm run prepare:release` first.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'cpu';
const directory = await mkdtemp(join(tmpdir(), 'crucible-glb-export-'));
const assets = join(directory, 'assets');
const jobs = join(directory, 'jobs');
await mkdir(assets);
await mkdir('artifacts', { recursive: true });
await copyFile(resolve('tests/fixtures/RobotExpressive.glb'), join(assets, 'robot.glb'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', backend, '--memory', '192', '--assets', assets, '--jobs', jobs],
  stderr: 'pipe',
  cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => {
  diagnostics += chunk.toString();
});
const client = new Client({ name: 'crucible-glb-export-smoke', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content).slice(0, 700)}\n${diagnostics.slice(-500)}`);
  return result.structuredContent;
}

async function failure(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, true, `${name} should have failed`);
  return result.content[0].text;
}

async function keepExport(result, label) {
  assert.match(result.filename, /^[0-9a-f-]{36}\.glb$/);
  assert.ok(result.path.startsWith(join(jobs, 'exports')));
  const bytes = await readFile(result.path);
  assert.equal(bytes.length, result.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
  assert.equal(bytes.toString('latin1', 0, 4), 'glTF');
  await copyFile(result.path, `artifacts/glb-export-${label}.glb`);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
}

const report = {};
try {
  await client.connect(transport);

  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0.05 }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'oak', pattern: { type: 'wood', size: 0.6, axis: 'z' }, roughness: 0.8 }, { id: 'red', color: [0.8, 0.1, 0.1] }],
    nodes: [{ id: 'crate', geometry: 'cube', material: 'oak' }, { id: 'ball', geometry: 'ball', material: 'red', translation: [1.6, 0, 0], scale: [0.5, 0.5, 0.5] }],
  };
  const scene = await call('scene_create', { recipe });
  const patterned = await call('scene_export_glb', { sessionId: scene.sessionId, maxTextureSize: 1024 });
  const patternedDocument = await keepExport(patterned, 'pattern');
  assert.ok(patternedDocument.textures.length >= 1, 'the pattern material is written as textures');
  assert.equal(patternedDocument.meshes.length, 2);
  assert.match(await failure('scene_export_glb', { sessionId: scene.sessionId, clip: 0 }), /imported asset/);
  report.pattern = { bytes: patterned.bytes, textures: patternedDocument.textures.length, images: patternedDocument.images.length };
  await call('scene_dispose', { sessionId: scene.sessionId });

  const catalog = await call('scene_asset_catalog');
  const assetRecipe = { format: 'crucible.asset', schemaVersion: 1, assetId: catalog.assets[0].assetId };
  const posed = await call('scene_create_asset', { recipe: assetRecipe });
  const nodes = [];
  for (let offset = 0; ; offset += 64) {
    const page = await call('scene_inspect', { sessionId: posed.sessionId, kind: 'hierarchy', offset, limit: 64 });
    nodes.push(...page.nodes);
    if (!page.truncated) break;
  }
  const jointId = label => nodes.find(node => node.label === label && node.joint).id;
  const motion = {
    duration: 2, tracks: [],
    ik: [{
      type: 'two-bone', root: jointId('UpperArm.R'), middle: jointId('LowerArm.R'), end: jointId('Palm2.R'), keepEndRotation: false,
      target: { interpolation: 'SMOOTH', keyframes: [{ time: 0, value: [-1.3, 2.6, 0.8] }, { time: 1, value: [-1, 1.7, 1.1] }, { time: 2, value: [-1.3, 2.6, 0.8] }] },
    }],
  };
  const applied = await call('scene_apply', { sessionId: posed.sessionId, expectedRevision: posed.revision, operations: [{ type: 'set-motion', motion }] });
  assert.equal(applied.renderSucceeded, true, applied.renderError);
  const withIk = await call('scene_export_glb', { sessionId: posed.sessionId, motionTime: 1 });
  const ikDocument = await keepExport(withIk, 'robot-ik');
  assert.ok(ikDocument.skins.length >= 1);
  assert.equal(ikDocument.animations, undefined, 'a posed export carries no clip');
  assert.match(await failure('scene_export_glb', { sessionId: posed.sessionId, clip: 0 }), /unposed asset/);
  report.ik = { bytes: withIk.bytes, skins: ikDocument.skins.length, joints: ikDocument.skins[0].joints.length };
  await call('scene_dispose', { sessionId: posed.sessionId });

  const plain = await call('scene_create_asset', { recipe: assetRecipe });
  const clipIndex = plain.inspection.animations.findIndex(clip => /walking/i.test(clip.label));
  assert.ok(clipIndex >= 0, 'the robot has a Walking clip');
  const walk = await call('scene_export_glb', { sessionId: plain.sessionId, clip: clipIndex });
  const walkDocument = await keepExport(walk, 'robot-walk');
  assert.equal(walkDocument.animations.length, 1);
  report.walk = { bytes: walk.bytes, channels: walkDocument.animations[0].channels.length };
  assert.match(await failure('scene_export_glb', { sessionId: plain.sessionId, clip: 99 }), /does not exist/);
  await call('scene_dispose', { sessionId: plain.sessionId });

  const kept = await readdir(join(jobs, 'exports'));
  assert.equal(kept.length, 3);
  console.log(`GLB export passed on ${backend}: ${JSON.stringify(report)}`);
} finally {
  await client.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(error => console.warn(`Left ${directory}: ${error.code}`));
}

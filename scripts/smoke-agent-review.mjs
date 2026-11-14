import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { PatientStdioClientTransport } from './patient-stdio-transport.mjs';
import { createAgentCharacterFixture } from './agent-character-fixture.mjs';
import { createTexturedRigFixture } from './agent-asset-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-review-proof-'));
const assets = join(directory, 'assets');
await mkdir(assets);
const fixture = await createAgentCharacterFixture();
await writeFile(join(assets, 'pip.glb'), fixture.bytes);
fixture.recipe.assetId = createHash('sha256').update(fixture.bytes).digest('hex');
const clipFixture = await createTexturedRigFixture();
await writeFile(join(assets, 'clip-rig.glb'), clipFixture);
const clipAssetId = createHash('sha256').update(clipFixture).digest('hex');
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const transport = new PatientStdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '96', '--assets', assets], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-review-proof', version: '1' });
async function call(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
async function rejected(argumentsValue) {
  const result = await client.callTool({ name: 'scene_review', arguments: argumentsValue }, { timeout: 60000 });
  assert.equal(result.isError, true, 'Invalid review must fail rather than commit source changes');
}
function image(result) {
  const block = result.content.find(item => item.type === 'image');
  assert.equal(block.mimeType, 'image/png');
  return Buffer.from(block.data, 'base64');
}
function pixels(bytes, crop) {
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    ...(crop ? ['-vf', crop] : []), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { input: bytes, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  return decoded.stdout;
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 22);
  const created = (await call('scene_create_asset', { recipe: fixture.recipe })).structuredContent;
  const sessionId = created.sessionId;
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const canonical = (await call('scene_export_recipe', { sessionId })).structuredContent.recipe;
  const base = image(await call('scene_look', { sessionId, motionTime: null, width: 384, height: 384 }));
  const preview = image(await call('scene_look', { sessionId, motionTime: 1.5, width: 384, height: 384 }));
  assert.notDeepEqual(base, preview);
  const settings = { sessionId, expectedRevision: 0, width: 384, height: 384 };
  const single = await call('scene_review', { ...settings, shots: [{ label: 'One pose', motionTime: 1.5 }] });
  assert.equal(single.structuredContent.width, 384);
  assert.equal(single.structuredContent.height, 408);
  assert.deepEqual(pixels(image(single), 'crop=384:384:0:24'), pixels(preview));
  const maximum = await call('scene_review', { ...settings, shots: [
    { label: 'Start', motionTime: 0 }, { label: 'Middle', motionTime: 1.5 },
    { label: 'End', motionTime: 3 }, { label: 'Authored base' },
  ] });
  assert.equal(maximum.structuredContent.width, 768);
  assert.equal(maximum.structuredContent.height, 816);
  assert.deepEqual(pixels(image(maximum), 'crop=384:384:384:432'), pixels(base));

  const views = await call('scene_review', { ...settings, shots: [
    { label: 'Front', motionTime: 1.5, camera: { eye: [0, 2, 7], target: [0, 1.55, 0] } },
    { label: 'Side', motionTime: 1.5, camera: { eye: [7, 2, 0], target: [0, 1.55, 0] } },
    { label: 'Back', motionTime: 1.5, camera: { eye: [0, 2, -7], target: [0, 1.55, 0] } },
  ] });
  const grid = image(views);
  assert.ok(grid.length <= 1024 * 1024);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/agent-review-views.png', grid);
  const poses = await call('scene_review', { ...settings,
    shots: [{ label: 'Motion at 1.5', motionTime: 1.5 }, { label: 'Authored base' }] });
  const poseGrid = image(poses);
  await writeFile('artifacts/agent-review-poses.png', poseGrid);
  assert.deepEqual(pixels(poseGrid, 'crop=384:384:384:24'), pixels(base), 'Omitted second shot must independently return the authored base');
  assert.notDeepEqual(pixels(poseGrid, 'crop=384:384:0:24'), pixels(base));
  assert.deepEqual(image(await call('scene_look', { sessionId, width: 384, height: 384 })), preview);
  assert.deepEqual((await call('scene_export_recipe', { sessionId })).structuredContent.recipe, canonical);
  for (const invalid of [
    { ...settings, expectedRevision: 1, shots: [{}] },
    { ...settings, shots: Array(5).fill({}) },
    { ...settings, shots: [{ file: 'outside.png' }] },
    { ...settings, shots: [{ motionTime: 0 }, { animation: { clip: 999, time: 0 } }] },
    { ...settings, shots: [{}, { camera: { eye: [0, 0, 0], target: [0, 0, 0] } }] },
  ]) {
    await rejected(invalid);
    assert.deepEqual(image(await call('scene_look', { sessionId, width: 384, height: 384 })), preview);
    assert.deepEqual((await call('scene_export_recipe', { sessionId })).structuredContent.recipe, canonical);
  }
  const inspected = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.equal(inspected.revision, 0);
  await call('scene_apply', { sessionId, expectedRevision: 0,
    operations: [{ type: 'set-camera', eye: [0, 4, 7] }] });
  await call('scene_restore', { sessionId, expectedRevision: 1, checkpointId: checkpoint.checkpointId });
  assert.deepEqual(image(await call('scene_look', { sessionId, motionTime: 1.5, width: 384, height: 384 })), preview);
  await call('scene_dispose', { sessionId });
  const imported = (await call('scene_create_asset', { recipe: {
    format: 'crucible.asset', schemaVersion: 1, assetId: clipAssetId,
    camera: { eye: [1, 3, 7], target: [1, 3, 0], fov: 35, near: 0.1, far: 40 },
  } })).structuredContent;
  const clipSessionId = imported.sessionId;
  const clipBase = image(await call('scene_look', { sessionId: clipSessionId, width: 384, height: 384 }));
  await call('scene_apply', { sessionId: clipSessionId, expectedRevision: 0,
    operations: [{ type: 'set-animation', clip: 0, time: 1.1 }] });
  const clipPreview = image(await call('scene_look', { sessionId: clipSessionId, width: 384, height: 384 }));
  assert.notDeepEqual(clipPreview, clipBase);
  const clips = await call('scene_review', { sessionId: clipSessionId, expectedRevision: 1,
    width: 384, height: 384, shots: [
      { label: 'Clip at zero', animation: { clip: 0, time: 0 } },
      { label: 'Authored clip at 1.1' },
    ] });
  const clipGrid = image(clips);
  assert.deepEqual(pixels(clipGrid, 'crop=384:384:0:24'), pixels(clipBase));
  assert.deepEqual(pixels(clipGrid, 'crop=384:384:384:24'), pixels(clipPreview));
  assert.deepEqual(image(await call('scene_look', { sessionId: clipSessionId, width: 384, height: 384 })), clipPreview);
  await writeFile('artifacts/agent-review-clips.png', clipGrid);
  await call('scene_dispose', { sessionId: clipSessionId });
  const report = { cli, tools: 18, singleShotPixelsExact: true, maximumShotsPixelsExact: true, sourceRevisionUnchanged: true, previewPngExact: true,
    independentBasePixelsExact: true, checkpointRetained: true, invalidInputsPreserveSource: true,
    importedClipPixelsExact: true, views: views.structuredContent, poses: poses.structuredContent,
    clips: clips.structuredContent };
  await writeFile('artifacts/mcp-agent-review-proof.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await client.close();
  assert.equal(diagnostics.replace('Crucible preview resources closed.\n', '').trim(), '');
}

// Through MCP on the CPU backend: a recipe with terrain, two different catalog GLBs and ten copies of one of them,
// one of which plays a clip. Checks the draw batches, the inspected assets and that a seek reproduces its frame.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTexturedRigFixture } from './agent-asset-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await rm('artifacts/scene-assets-jobs', { recursive: true, force: true });
await mkdir('artifacts/scene-assets-jobs', { recursive: true });
await mkdir('artifacts/scene-assets-proof', { recursive: true });
await writeFile('artifacts/scene-assets-proof/wall-e.glb', await readFile('public/wall-e.glb'));
await writeFile('artifacts/scene-assets-proof/textured-rig.glb', await createTexturedRigFixture());
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', resolve('artifacts/scene-assets-proof'),
    '--jobs', resolve('artifacts/scene-assets-jobs')],
  stderr: 'pipe', cwd: process.cwd(),
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-scene-assets-proof', version: '1' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } },
});
async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
async function look(sessionId, label, motionTime) {
  const result = await call('scene_look', { sessionId, width: 768, height: 512, ...(motionTime === undefined ? {} : { motionTime }) });
  const bytes = Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
  await writeFile(`artifacts/scene-assets-${label}.png`, bytes);
  return bytes;
}
const MINIMUM_PARITY_DECIBELS = 30;
const ffmpeg = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.local/bin/ffmpeg.exe') : 'ffmpeg';
const ffprobe = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.local/bin/ffprobe.exe') : 'ffprobe';
async function renderJob(sessionId, settings) {
  const { jobId } = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings })).structuredContent;
  for (let attempt = 0; attempt < 1200; attempt++) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (record.state === 'completed') return (await call('scene_render_result', { jobId })).structuredContent.artifacts[0].path;
    assert.ok(!['failed', 'cancelled'].includes(record.state), `render job ${record.state}: ${record.reason}`);
    await delay(100);
  }
  throw new Error('Render job did not finish.');
}
function psnr(firstPath, secondPath) {
  const compare = spawnSync(ffmpeg, ['-hide_banner', '-i', firstPath, '-i', secondPath, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const average = /average:(\S+)/.exec(compare.stderr)?.[1];
  return average === 'inf' ? Infinity : Number(average);
}
try {
  await client.connect(transport, { timeout: 180000 });
  assert.equal((await client.listTools()).tools.length, 22);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const robot = catalog.assets.find(asset => asset.name === 'wall-e.glb').assetId;
  const rig = catalog.assets.find(asset => asset.name === 'textured-rig.glb').assetId;
  const copies = Array.from({ length: 10 }, (_, index) => ({
    id: `rig-${index}`, translation: [index * 1.5 - 7, 0, 2],
    asset: index === 4 ? { id: rig, clip: { index: 0, start: 0.25 } } : { id: rig },
  }));
  const created = (await call('scene_create', { recipe: {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'hills', type: 'terrain', size: 30, resolution: 48, amplitude: 0.4 }],
    materials: [{ id: 'grass', color: [0.25, 0.45, 0.2], roughness: 0.9 }],
    nodes: [
      { id: 'ground', geometry: 'hills', material: 'grass', translation: [0, -0.5, 0] },
      { id: 'robot', translation: [0, 0, -3], asset: { id: robot } },
      ...copies,
    ],
    camera: { eye: [0, 6, 14], target: [0, 1, 0], fov: 45 },
  } })).structuredContent;
  const sessionId = created.sessionId;
  const batches = created.render.drawBatches;
  const inspection = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.equal(inspection.assets.length, 11);
  assert.equal(inspection.assets.filter(placement => placement.assetId === rig).length, 10);
  assert.ok(inspection.assets.every(placement => placement.bounds.max[1] > placement.bounds.min[1]));
  const first = await look(sessionId, 'start', 0);
  const later = await look(sessionId, 'later', 1.1);
  assert.notDeepEqual(first, later, 'the placed clip changes the frame');
  assert.deepEqual(await look(sessionId, 'later-again', 1.1), later, 'a seek reproduces its frame');
  assert.deepEqual(await look(sessionId, 'start-again', 0), first);
  // A render job places the same assets and plays the placed clip on scene time, so it matches scene_look.
  const stillPath = await renderJob(sessionId, { kind: 'image', width: 768, height: 512, motion: { start: 1.1 } });
  const parity = psnr(stillPath, 'artifacts/scene-assets-later.png');
  assert.ok(parity >= MINIMUM_PARITY_DECIBELS, `the job still matches scene_look at ${parity} dB, below ${MINIMUM_PARITY_DECIBELS} dB`);
  const videoPath = await renderJob(sessionId, { kind: 'video', width: 320, height: 214, fps: 8, duration: 1, motion: { start: 0 } });
  const probe = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', videoPath], { encoding: 'utf8' });
  assert.equal(JSON.parse(probe.stdout).streams[0].nb_read_frames, '8');
  const exported = (await call('scene_export_recipe', { sessionId })).structuredContent;
  assert.equal(exported.recipe.nodes.length, 12);
  await call('scene_dispose', { sessionId });
  const report = { backend: 'cpu', placements: 11, drawBatches: batches, seekExact: true, jobStillParityDecibels: Number.isFinite(parity) ? parity : 'identical', jobVideoFrames: 8 };
  await writeFile('artifacts/scene-assets-cpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

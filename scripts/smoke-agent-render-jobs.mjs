import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTexturedRigFixture } from './agent-asset-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-jobs-'));
const assets = join(directory, 'assets');
const jobs = join(directory, 'jobs');
await mkdir(assets);
const assetBytes = await createTexturedRigFixture();
await writeFile(join(assets, 'rig.glb'), assetBytes);
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
let client;
let transport;
let diagnostics = '';
async function connect() {
  transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, '--backend', 'cpu', '--memory', '96', '--assets', assets, '--jobs', jobs],
    cwd: directory, stderr: 'pipe' });
  transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
  client = new Client({ name: '67js-job-proof', version: '1' });
  await client.connect(transport);
}
async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 30000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
async function status(jobId, predicate = record => ['completed', 'cancelled', 'failed'].includes(record.state)) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (predicate(record)) return record;
    await delay(50);
  }
  throw new Error('Job did not reach its expected state within 20 seconds.');
}
async function close() {
  const processId = transport.pid;
  await client.close();
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try { process.kill(processId, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`Owned MCP process did not exit: ${diagnostics}`);
}
try {
  await connect();
  assert.equal((await client.listTools()).tools.length, 23);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const created = (await call('scene_create_asset', { recipe: {
    format: '67js.asset', schemaVersion: 1, assetId: catalog.assets[0].assetId,
    camera: { eye: [1, 3, 7], target: [1, 3, 0], fov: 35, near: 0.1, far: 40 },
  } })).structuredContent;
  const sessionId = created.sessionId;
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const before = (await call('scene_look', { sessionId, width: 320, height: 320 })).content[0].data;
  const videoJob = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: {
    kind: 'video', width: 320, height: 320, fps: 8, duration: 1, animation: { clip: 0, start: 0 },
  } })).structuredContent;
  // The admitted job owns its bytes even when the catalog file changes.
  await writeFile(join(assets, 'rig.glb'), Buffer.from('changed after submission'));
  assert.equal((await status(videoJob.jobId)).state, 'completed');
  await writeFile(join(assets, 'rig.glb'), assetBytes);
  const result = (await call('scene_render_result', { jobId: videoJob.jobId })).structuredContent;
  const output = join(jobs, videoJob.jobId, 'render.mp4');
  assert.equal(result.artifacts[0].path, output);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=width,height,nb_read_frames:format=duration', '-of', 'json', output], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  const video = JSON.parse(probe.stdout);
  assert.equal(video.streams[0].nb_read_frames, '8');
  assert.equal(Number(video.format.duration), 1);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '8', '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'], { windowsHide: true, maxBuffer: 4 * 1024 ** 2 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const frameBytes = 320 * 320 * 3;
  assert.notDeepEqual(decoded.stdout.subarray(0, frameBytes), decoded.stdout.subarray(frameBytes * 7, frameBytes * 8));
  await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 0 });
  assert.equal((await call('scene_look', { sessionId, width: 320, height: 320 })).content[0].data, before);
  const imageJobs = [];
  for (const kind of ['image', 'stills']) {
    const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: 1, settings: {
      kind, width: 128, height: 128, duration: 1, animation: { clip: 0, start: 0 },
    } })).structuredContent;
    assert.equal((await status(submitted.jobId)).state, 'completed');
    const images = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
    assert.equal(images.artifacts.length, kind === 'image' ? 1 : 8);
    for (const artifact of images.artifacts) {
      const bytes = await readFile(artifact.path);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), 128);
      assert.equal(bytes.readUInt32BE(20), 128);
    }
    imageJobs.push(submitted.jobId);
  }
  // Output options (issue #611): each one writes a file of its own kind from a real job.
  async function optionFiles(settings) {
    const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: 1, settings })).structuredContent;
    assert.equal((await status(submitted.jobId)).state, 'completed');
    imageJobs.push(submitted.jobId);
    const { artifacts } = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
    return Promise.all(artifacts.map(async artifact => ({ ...artifact, data: await readFile(artifact.path) })));
  }
  const pngColorType = data => data[25];
  const pngBitDepth = data => data[24];
  const [transparentFile] = await optionFiles({ kind: 'image', width: 128, height: 128, transparent: true });
  assert.equal(pngColorType(transparentFile.data), 6);
  const [sixteenBit, depthSixteen] = await optionFiles({ kind: 'image', width: 128, height: 128, format: 'png16', passes: ['depth'] });
  assert.deepEqual([pngBitDepth(sixteenBit.data), pngColorType(sixteenBit.data), pngBitDepth(depthSixteen.data), pngColorType(depthSixteen.data)], [16, 2, 16, 0]);
  const [exrFile, exrDepth] = await optionFiles({ kind: 'image', width: 128, height: 128, format: 'exr', passes: ['depth'] });
  for (const file of [exrFile, exrDepth]) {
    assert.equal(file.mimeType, 'image/x-exr');
    assert.equal(file.data.subarray(0, 4).toString('hex'), '762f3101');
  }
  const [cropped] = await optionFiles({ kind: 'image', width: 128, height: 128, region: { x: 16, y: 8, width: 64, height: 48 } });
  assert.deepEqual([cropped.data.readUInt32BE(16), cropped.data.readUInt32BE(20)], [64, 48]);
  const [croppedSixteen] = await optionFiles({ kind: 'image', width: 128, height: 128, format: 'png16', region: { x: 16, y: 8, width: 64, height: 48 } });
  assert.deepEqual([croppedSixteen.data.readUInt32BE(16), croppedSixteen.data.readUInt32BE(20)], [64, 48]);
  const [fastVideo] = await optionFiles({ kind: 'video', width: 128, height: 128, fps: 60, duration: 0.25, animation: { clip: 0, start: 0 }, region: { x: 16, y: 8, width: 64, height: 48 } });
  assert.equal(fastVideo.data.subarray(4, 8).toString('latin1'), 'ftyp');
  const longJob = (await call('scene_render_submit', { sessionId, expectedRevision: 1,
    settings: { kind: 'video', width: 320, height: 320, fps: 30, duration: 30 } })).structuredContent;
  await status(longJob.jobId, record => record.progress.frames > 0);
  await call('scene_render_cancel', { jobId: longJob.jobId });
  assert.equal((await status(longJob.jobId)).state, 'cancelled');
  assert.equal((await call('scene_look', { sessionId, width: 320, height: 320 })).content[0].data, before);
  const interrupted = (await call('scene_render_submit', { sessionId, expectedRevision: 1,
    settings: { kind: 'video', width: 320, height: 320, fps: 30, duration: 30 } })).structuredContent;
  await status(interrupted.jobId, record => record.progress.frames > 0);
  await close();
  await connect();
  const recovered = (await call('scene_capabilities')).structuredContent;
  assert.equal(recovered.phase, 'idle');
  assert.equal(recovered.jobs.records.find(record => record.jobId === interrupted.jobId).state, 'cancelled');
  assert.deepEqual((await call('scene_render_result', { jobId: videoJob.jobId })).structuredContent, result);
  for (const jobId of [videoJob.jobId, longJob.jobId, interrupted.jobId, ...imageJobs]) await call('scene_render_release', { jobId });
  assert.equal((await call('scene_capabilities')).structuredContent.jobs.records.length, 0);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/mcp-render-jobs-proof.json', JSON.stringify({ cli, video, result,
    animatedFramesDiffer: true, activeCancel: true, eofCleanup: true, restartResults: true,
    sourcePngExact: true, sourceCheckpointRetained: true, immutableAsset: true,
    imageAndEightStills: true, release: true }, null, 2));
  console.log(JSON.stringify({ tools: 18, videoFrames: 8, activeCancel: true, eofCleanup: true,
    restartResults: true, sourcePngExact: true, maximumPendingFrames: result.metrics.maximumPendingFrames }));
} finally {
  if (client) await client.close();
}

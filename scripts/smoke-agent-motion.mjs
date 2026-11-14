import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createAgentMotionFixture } from './agent-motion-fixture.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-mcp-motion-'));
const jobs = join(directory, 'jobs');
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '96', '--jobs', jobs],
  cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-motion-proof', version: '1' });

async function call(name, argumentsValue = {}, timeout = 30000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function status(jobId, predicate = record => ['completed', 'cancelled', 'failed'].includes(record.state)) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (predicate(record)) {
      return record;
    }
    await delay(100);
  }
  throw new Error('Motion job did not reach its expected state within 60 seconds.');
}

async function look(sessionId, motionTime, width = 480, height = 480) {
  const result = await call('scene_look', { sessionId, width, height,
    ...(motionTime !== undefined ? { motionTime } : {}) });
  assert.equal(result.structuredContent.revision, 0);
  assert.match(result.structuredContent.graphics, /swiftshader/i);
  return result.content.find(item => item.type === 'image').data;
}

try {
  await client.connect(transport);
  const fixture = createAgentMotionFixture();
  const created = (await call('scene_create', { recipe: fixture }, 180000)).structuredContent;
  assert.equal(created.inspection.motion.tracks, 5);
  const sessionId = created.sessionId;
  const checkpoint = (await call('scene_checkpoint', { sessionId })).structuredContent;
  const canonical = (await call('scene_export_recipe', { sessionId })).structuredContent.recipe;
  const start = await look(sessionId, 0);
  const middle = await look(sessionId, 1.5);
  const end = await look(sessionId, 3);
  assert.notEqual(start, middle);
  assert.notEqual(middle, end);
  for (const time of [0.3, 2.7, 0, 1.5, 3]) {
    const expected = time === 0 ? start : time === 1.5 ? middle : time === 3 ? end : null;
    const actual = await look(sessionId, time);
    if (expected) {
      assert.equal(actual, expected, `Shuffled seek ${time} must reproduce PNG bytes.`);
    }
  }
  await look(sessionId, 1.5);
  assert.deepEqual((await call('scene_export_recipe', { sessionId })).structuredContent.recipe, canonical);
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/agent-motion-start.png', Buffer.from(start, 'base64'));
  await writeFile('artifacts/agent-motion-middle.png', Buffer.from(middle, 'base64'));
  await writeFile('artifacts/agent-motion-end.png', Buffer.from(end, 'base64'));
  const portrait = await look(sessionId, 1.5, 390, 640);
  await writeFile('artifacts/agent-motion-portrait.png', Buffer.from(portrait, 'base64'));
  await look(sessionId, 1.5);
  const completed = [];
  let video;
  let videoResult;
  for (const kind of ['stills', 'video']) {
    const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: {
      kind, width: 480, height: 480, fps: 6, duration: 3, motion: { start: 0 }, rendererTime: { rate: 0 },
    } })).structuredContent;
    assert.equal((await status(submitted.jobId)).state, 'completed');
    const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
    assert.equal(result.metrics.maximumPendingFrames, 1);
    assert.equal(await look(sessionId), middle, 'Renderer lease must preserve the nonzero source preview pose.');
    if (kind === 'stills') {
      assert.equal(result.artifacts.length, 8);
      for (let index = 0; index < 8; index++) {
        await copyFile(result.artifacts[index].path, `artifacts/agent-motion-still-${index}.png`);
      }
    } else {
      videoResult = result;
      const output = result.artifacts[0].path;
      await copyFile(output, 'artifacts/agent-motion.mp4');
      const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
        'stream=width,height,nb_read_frames,codec_name,color_space:format=duration', '-of', 'json', output],
      { encoding: 'utf8', windowsHide: true });
      assert.equal(probe.status, 0, probe.stderr);
      video = JSON.parse(probe.stdout);
      assert.equal(video.streams[0].nb_read_frames, '18');
      assert.equal(video.streams[0].color_space, 'bt709');
      assert.equal(Number(video.format.duration), 3);
      const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-frames:v', '18',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'],
      { windowsHide: true, maxBuffer: 16 * 1024 ** 2 });
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      const frameBytes = 480 * 480 * 3;
      assert.equal(decoded.stdout.length, frameBytes * 18);
      assert.notDeepEqual(decoded.stdout.subarray(0, frameBytes), decoded.stdout.subarray(frameBytes * 17));
    }
    completed.push(submitted.jobId);
  }
  const cancelled = (await call('scene_render_submit', { sessionId, expectedRevision: 0,
    settings: { kind: 'video', width: 480, height: 480, fps: 30, duration: 3, motion: {} } })).structuredContent;
  await status(cancelled.jobId, record => record.progress.frames > 0);
  await call('scene_render_cancel', { jobId: cancelled.jobId });
  assert.equal((await status(cancelled.jobId)).state, 'cancelled');
  assert.equal(await look(sessionId), middle);
  const restored = (await call('scene_restore', { sessionId, checkpointId: checkpoint.checkpointId, expectedRevision: 0 })).structuredContent;
  assert.equal(restored.revision, 1);
  const restoredImage = await call('scene_look', { sessionId, width: 480, height: 480 });
  assert.equal(restoredImage.content[0].data, start);
  for (const jobId of [...completed, cancelled.jobId]) {
    await call('scene_render_release', { jobId });
  }
  await call('scene_dispose', { sessionId });
  const processId = transport.pid;
  await client.close();
  const deadline = Date.now() + 7000;
  let exited = false;
  while (Date.now() < deadline && !exited) {
    try {
      process.kill(processId, 0);
      await delay(50);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      exited = true;
    }
  }
  assert.equal(exited, true, `Owned MCP process must exit: ${diagnostics}`);
  await writeFile('artifacts/mcp-agent-motion-proof.json', JSON.stringify({ cli, video, videoResult,
    shuffledPngSeeksExact: true, sourceNonzeroPosePreserved: true, activeCancel: true,
    canonicalRecipeUnchanged: true, checkpointRetained: true, eightStills: true, eofCleanup: true }, null, 2));
  console.log(JSON.stringify({ frames: 18, duration: 3, shuffledPngSeeksExact: true,
    sourceNonzeroPosePreserved: true, activeCancel: true, eofCleanup: true,
    elapsedSeconds: videoResult.metrics.elapsedSeconds }));
} finally {
  await client.close();
}

// Proves the two done conditions of render passes through the real MCP runtime: render jobs write every pass to a
// file, and a seek to any frame gives the same pixels, with depth of field and motion blur on.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-passes-'));
const jobs = join(directory, 'jobs');
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const backend = process.argv[3] ?? 'cpu';
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', backend, '--memory', '128', '--jobs', jobs], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-passes-proof', version: '1' });
const ALL_PASSES = ['albedo', 'normal', 'emission', 'depth', 'objectId'];
const SIZE = 160;

async function call(name, argumentsValue = {}, timeout = 60000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function finished(jobId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(100);
  }
  throw new Error('Job did not finish within 120 seconds.');
}

async function runJob(sessionId, settings, expectedRevision = 0) {
  const submitted = (await call('scene_render_submit', { sessionId, expectedRevision, settings })).structuredContent;
  const record = await finished(submitted.jobId);
  assert.equal(record.state, 'completed', record.reason);
  const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
  const files = new Map();
  for (const artifact of result.artifacts) {
    const bytes = await readFile(artifact.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    files.set(artifact.path.split(/[\\/]/).pop(), bytes);
  }
  await call('scene_render_release', { jobId: submitted.jobId });
  return { files, metrics: result.metrics ?? record.metrics };
}

function recipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'sphere', type: 'sphere', segments: 24, rings: 16 }],
    materials: [
      { id: 'red', color: [0.8, 0.1, 0.1], roughness: 0.6 },
      { id: 'glow', color: [0.1, 0.3, 0.9], emission: 2 },
    ],
    nodes: [
      { id: 'floor', geometry: 'box', material: 'red', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
      { id: 'near-ball', geometry: 'sphere', material: 'glow', translation: [-0.6, 0.5, 1.5], scale: [1, 1, 1] },
      { id: 'far-block', geometry: 'box', material: 'red', translation: [1.4, 0.5, -3], scale: [1, 1, 1] },
    ],
    // The ball dips below the floor slab, which would add the automatic floor as a fourth object.
    environment: { ground: false },
    camera: { eye: [0, 1.6, 6], target: [0, 0.5, 0], fov: 40 },
    effects: { depthOfField: { blur: 0.8, focusDistance: 4.5 }, motionBlur: { shutter: 0.25 } },
    motion: { duration: 2, tracks: [{ kind: 'camera', property: 'eye', keyframes: [
      { time: 0, value: [-2, 1.6, 6] }, { time: 2, value: [2, 1.6, 6] },
    ] }] },
  };
}

function pixelDigest(png) {
  return createHash('sha256').update(png).digest('hex').slice(0, 12);
}

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe: recipe() }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const base = { width: SIZE, height: SIZE, motion: { start: 0 } };

  // Done condition 2: every pass becomes a file.
  const stills = await runJob(sessionId, { ...base, kind: 'stills', duration: 2, passes: ALL_PASSES });
  assert.equal(stills.files.size, 8 * (1 + ALL_PASSES.length));
  for (const pass of ALL_PASSES) assert.ok(stills.files.has(`frame-3-${pass}.png`), `frame-3-${pass}.png is missing.`);
  assert.deepEqual([...stills.metrics.objectNames].sort(), ['far-block', 'floor', 'near-ball']);
  for (const [name, bytes] of process.env.RENDER_PASSES_COPY_DIRECTORY ? stills.files : []) await writeFile(join(process.env.RENDER_PASSES_COPY_DIRECTORY, name), bytes);
  const digests = new Set(ALL_PASSES.map(pass => pixelDigest(stills.files.get(`frame-3-${pass}.png`))));
  assert.equal(digests.size, ALL_PASSES.length, 'Each pass must differ from the others.');
  assert.notEqual(pixelDigest(stills.files.get('frame-0.png')), pixelDigest(stills.files.get('frame-7.png')), 'The camera move must change the lit image.');

  // Done condition 1: a seek to frame 3 gives the same pixels as that frame inside the sequence, in any order.
  const frameTime = 2 * 3 / 7;
  const seekOrder = [frameTime, 1.9, 0, frameTime];
  for (const time of seekOrder) {
    const seek = await runJob(sessionId, { ...base, kind: 'image', motion: { start: time }, passes: ALL_PASSES });
    if (time === frameTime) {
      assert.deepEqual(seek.files.get('render.png'), stills.files.get('frame-3.png'), 'Lit frame differs after a seek.');
      for (const pass of ALL_PASSES) {
        assert.deepEqual(seek.files.get(`render-${pass}.png`), stills.files.get(`frame-3-${pass}.png`), `${pass} differs after a seek.`);
      }
    }
  }

  // The effects visibly act: the same frame without them is different.
  const plain = (await call('scene_apply', { sessionId, expectedRevision: 0, operations: [
    { type: 'set-effects', effects: { depthOfField: { blur: 0 }, motionBlur: { shutter: 0 } } },
  ] })).structuredContent;
  assert.equal(plain.committed, true);
  const unblurred = await runJob(sessionId, { ...base, kind: 'image', motion: { start: frameTime } }, plain.revision);
  assert.notEqual(unblurred.files.get('render.png').equals(stills.files.get('frame-3.png')), true, 'Depth of field and motion blur changed nothing.');
  console.log(`render passes smoke passed on ${backend}: ${stills.files.size} files, ${seekOrder.length} seeks identical (${stills.metrics.graphics})`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

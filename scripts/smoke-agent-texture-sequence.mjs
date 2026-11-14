// Through MCP on the CPU backend: a quad whose colour map is a sequence of four generated PNG frames (red, green, blue,
// yellow). Checks that scene_look shows the frame of its motion time, that a repeated seek gives identical PNG bytes, and
// that a render job (a still and a short video) shows the same frame as scene_look at the same time.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync, crc32 } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);

const FRAME_COLORS = [[230, 30, 30], [30, 230, 30], [30, 30, 230], [230, 230, 30]];
const FRAMES_PER_SECOND = 10;
const SIZE = 192;

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function solidPng(color, side = 16) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((side * 3 + 1) * side);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) rows.set(color, row * (side * 3 + 1) + 1 + column * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** RGB of the middle pixel of a PNG or of one raw frame, decoded by ffmpeg so the smoke needs no image library. */
function centerPixel(input, width, height) {
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { input, windowsHide: true, maxBuffer: 16 * 1024 ** 2 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const offset = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 3;
  return [...decoded.stdout.subarray(offset, offset + 3)];
}

function dominantFrame(pixel) {
  const [red, green, blue] = pixel;
  if (red > blue + 60 && green > blue + 60) return 3;
  if (red > green + 60 && red > blue + 60) return 0;
  if (green > red + 60 && green > blue + 60) return 1;
  if (blue > red + 60 && blue > green + 60) return 2;
  return -1;
}

const directory = await mkdtemp(join(tmpdir(), 'crucible-sequence-smoke-'));
const assets = join(directory, 'assets');
const jobs = join(directory, 'jobs');
await mkdir(assets);
for (const [index, color] of FRAME_COLORS.entries()) await writeFile(join(assets, `frame-${index}.png`), solidPng(color));
const cli = resolve('scripts/mcp-server.mjs');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '192', '--assets', assets, '--jobs', jobs], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-sequence-proof', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
async function look(sessionId, motionTime) {
  const result = await call('scene_look', { sessionId, width: SIZE, height: SIZE, ...(motionTime === undefined ? {} : { motionTime }) });
  return Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
}
async function completed(jobId) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) {
      assert.equal(record.state, 'completed', JSON.stringify(record));
      return;
    }
    await delay(100);
  }
  throw new Error('Job did not complete within 90 seconds.');
}

try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 22);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const frames = catalog.assets.filter(asset => asset.kind === 'image').sort((left, right) => left.name.localeCompare(right.name)).map(asset => asset.assetId);
  assert.equal(frames.length, 4);
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'screen', roughness: 1, map: { sequence: { frames, fps: FRAMES_PER_SECOND } } }],
    nodes: [{ id: 'screen', geometry: 'quad', material: 'screen', scale: [6, 1, 6] }],
    camera: { eye: [0, 5, 0.5], target: [0, 0, 0], fov: 40 },
  };
  const bad = await client.callTool({ name: 'scene_create', arguments: { recipe: { ...recipe, materials: [{ id: 'screen', map: { sequence: { frames: [frames[0], 'ab'.repeat(32)], fps: 10 } } }] } } });
  assert.equal(bad.isError, true, 'an unknown catalog image must be refused');
  const created = (await call('scene_create', { recipe })).structuredContent;
  const sessionId = created.sessionId;

  const shots = new Map();
  for (const index of [0, 1, 2, 3]) {
    const bytes = await look(sessionId, index / FRAMES_PER_SECOND + 0.01);
    shots.set(index, bytes);
    assert.equal(dominantFrame(centerPixel(bytes, SIZE, SIZE)), index, `scene_look at ${index / FRAMES_PER_SECOND + 0.01} s shows frame ${index}`);
  }
  assert.notDeepEqual(shots.get(0), shots.get(2));
  const wrapped = await look(sessionId, 0.43);
  assert.equal(dominantFrame(centerPixel(wrapped, SIZE, SIZE)), 0, 'the sequence loops after its last frame');

  await look(sessionId, 0.05);
  const again = await look(sessionId, 0.21);
  assert.deepEqual(again, shots.get(2), 'a repeated seek gives identical PNG bytes');
  const inspected = (await call('scene_inspect', { sessionId })).structuredContent;
  assert.deepEqual(inspected.textureSequences.map(({ material, frames: count, fps, loop, index }) => ({ material, count, fps, loop, index })),
    [{ material: 'screen', count: 4, fps: FRAMES_PER_SECOND, loop: true, index: 2 }]);

  const still = (await call('scene_render_submit', { sessionId, expectedRevision: created.revision ?? 0,
    settings: { kind: 'image', width: SIZE, height: SIZE, motion: { start: 0.21 } } })).structuredContent;
  await completed(still.jobId);
  const stillResult = (await call('scene_render_result', { jobId: still.jobId })).structuredContent;
  const stillBytes = await readFile(stillResult.artifacts[0].path);
  assert.deepEqual(centerPixel(stillBytes, SIZE, SIZE), centerPixel(shots.get(2), SIZE, SIZE), 'the job still matches scene_look at the same time');

  const video = (await call('scene_render_submit', { sessionId, expectedRevision: created.revision ?? 0,
    settings: { kind: 'video', width: 128, height: 128, fps: FRAMES_PER_SECOND, duration: 0.4, motion: { start: 0.01 } } })).structuredContent;
  await completed(video.jobId);
  const videoResult = (await call('scene_render_result', { jobId: video.jobId })).structuredContent;
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', videoResult.artifacts[0].path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'],
    { windowsHide: true, maxBuffer: 16 * 1024 ** 2 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const frameBytes = 128 * 128 * 3;
  assert.equal(decoded.stdout.length, frameBytes * 4);
  for (let index = 0; index < 4; index++) {
    const offset = index * frameBytes + (64 * 128 + 64) * 3;
    assert.equal(dominantFrame([...decoded.stdout.subarray(offset, offset + 3)]), index, `video frame ${index} shows sequence frame ${index}`);
  }
  console.log(JSON.stringify({ ok: true, frames: 4, looked: [0, 1, 2, 3], stillMatchesLook: true, videoFrames: 4 }));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

// Proves per-object motion blur through the real MCP runtime: a spinning prop smears while the still background stays
// byte for byte sharp, and a scene that leaves `objects` off renders exactly as before. Set OBJECT_MOTION_BLUR_COPY_DIRECTORY
// to keep the before and after stills and a short clip.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-object-blur-'));
const jobs = join(directory, 'jobs');
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const backend = process.argv[3] ?? 'cpu';
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', backend, '--memory', '128', '--jobs', jobs], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-object-blur-proof', version: '1' });
const SIZE = 160;
const COPY_DIRECTORY = process.env.OBJECT_MOTION_BLUR_COPY_DIRECTORY;

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

async function runJob(sessionId, settings, expectedRevision) {
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
  return { files };
}

function recipe() {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [
      { id: 'floor', color: [0.55, 0.55, 0.6], roughness: 0.8 },
      { id: 'blade', color: [0.9, 0.15, 0.1], roughness: 0.5 },
      { id: 'post', color: [0.1, 0.3, 0.9], roughness: 0.5 },
    ],
    nodes: [
      { id: 'floor', geometry: 'box', material: 'floor', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
      { id: 'post', geometry: 'box', material: 'post', translation: [2.2, 0.6, -1], scale: [0.5, 1.2, 0.5] },
      { id: 'propeller', geometry: 'box', material: 'blade', translation: [0, 1.2, 0], scale: [2.4, 0.16, 0.16] },
    ],
    camera: { eye: [0, 1.2, 5], target: [0, 1.2, 0], fov: 40 },
    motion: { duration: 1, loop: true, tracks: [{ kind: 'node', id: 'propeller', property: 'rotation', keyframes: [
      { time: 0, value: [0, 0, 0, 1] }, { time: 0.5, value: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      { time: 1, value: [0, 0, 1, 0] },
    ] }] },
  };
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

// Reads an 8-bit RGB or RGBA PNG (the only kind the render jobs write) into a flat byte array.
function decodePng(bytes) {
  let offset = 8;
  let header = null;
  const chunks = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
    if (type === 'IDAT') chunks.push(data);
    offset += 12 + length;
  }
  assert.equal(header.depth, 8);
  const channels = header.colorType === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row++) {
    const filter = raw[row * (stride + 1)];
    for (let column = 0; column < stride; column++) {
      const value = raw[row * (stride + 1) + 1 + column];
      const left = column >= channels ? pixels[row * stride + column - channels] : 0;
      const up = row > 0 ? pixels[(row - 1) * stride + column] : 0;
      const upLeft = row > 0 && column >= channels ? pixels[(row - 1) * stride + column - channels] : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      pixels[row * stride + column] = (value + predictor) & 255;
    }
  }
  return { ...header, channels, pixels };
}

// The pixels where two renders differ by more than a rounding step, as { x, y } pairs.
function differingPixels(first, second) {
  const before = decodePng(first);
  const after = decodePng(second);
  const found = [];
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        const index = (y * before.width + x) * before.channels + channel;
        if (Math.abs(before.pixels[index] - after.pixels[index]) > 2) {
          found.push({ x, y });
          break;
        }
      }
    }
  }
  return found;
}

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe: recipe() }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const base = { width: SIZE, height: SIZE, kind: 'image', motion: { start: 0.25 } };
  let revision = 0;

  async function setBlur(motionBlur) {
    const applied = (await call('scene_apply', { sessionId, expectedRevision: revision,
      operations: [{ type: 'set-effects', effects: { motionBlur } }] })).structuredContent;
    assert.equal(applied.committed, true);
    revision = applied.revision;
  }

  async function renderStill() {
    return (await runJob(sessionId, base, revision)).files.get('render.png');
  }

  await setBlur({ shutter: 0 });
  const sharp = await renderStill();
  await setBlur({ shutter: 0.1 });
  const shutterOnly = await renderStill();
  await setBlur({ shutter: 0.1, objects: 0 });
  const objectsOff = await renderStill();
  await setBlur({ shutter: 0.1, objects: 1 });
  const blurred = await renderStill();

  // Off by default: a shutter alone, with or without `objects: 0`, leaves a still camera's frame untouched.
  assert.deepEqual(shutterOnly, sharp, 'A shutter without objects must not change a still camera frame.');
  assert.deepEqual(objectsOff, sharp, 'objects: 0 must render exactly as before.');

  // The spinning prop smears and nothing else moves: every changed pixel sits on the propeller's turn (a 2.4 m blade 5 m
  // from the lens, about 44 px a metre at this size), so the floor, the post and the sky stay sharp.
  const changed = differingPixels(sharp, blurred);
  assert.ok(changed.length > 40, `The spinning propeller must blur; only ${changed.length} pixels changed.`);
  const center = SIZE / 2;
  const reach = 1.25 * 44 + 4;
  for (const { x, y } of changed) {
    assert.ok(Math.hypot(x - center, y - center) <= reach, `Background pixel (${x}, ${y}) changed; only the prop may blur.`);
  }

  if (COPY_DIRECTORY) {
    await writeFile(join(COPY_DIRECTORY, 'before.png'), sharp);
    await writeFile(join(COPY_DIRECTORY, 'after.png'), blurred);
    const clip = await runJob(sessionId, { width: 320, height: 180, kind: 'video', fps: 24, duration: 1, motion: { start: 0 } }, revision);
    for (const [name, bytes] of clip.files) await writeFile(join(COPY_DIRECTORY, `clip-${name}`), bytes);
  }
  console.log(`object motion blur smoke passed on ${backend}: ${changed.length} prop pixels blurred, background identical`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

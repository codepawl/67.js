// A render job films a recipe whose only motion is physics: no authored motion and no bake-motion step.
// Runs the real MCP server, so it needs Chrome and ffmpeg like the other MCP tests.
// Set PHYSICS_FILM_CLIP to a file path to also keep the wall film there (640x360, 3 s) as a visual proof, and
// PHYSICS_FILM_BACKEND (gpu) with PHYSICS_FILM_BROWSER (a Chrome wrapper) to film on a GPU.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const FRAME_WIDTH = 128;
const FRAME_HEIGHT = 64;
const clipPath = process.env.PHYSICS_FILM_CLIP;

let directory;
let client;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), '67js-physics-film-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/67js-mcp.mjs'), '--backend', process.env.PHYSICS_FILM_BACKEND ?? 'cpu', '--memory', '96', '--jobs', join(directory, 'jobs'),
      ...(process.env.PHYSICS_FILM_BROWSER ? ['--browser', process.env.PHYSICS_FILM_BROWSER] : [])],
    cwd: directory, stderr: 'pipe' });
  client = new Client({ name: '67js-physics-film-test', version: '1' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

async function finished(jobId) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const record = await call('scene_render_status', { jobId });
    if (['completed', 'failed', 'cancelled'].includes(record.state)) {
      return record;
    }
    await delay(200);
  }
  throw new Error('The render job did not finish in time.');
}

function decodedFrames(file, width, height) {
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'],
    { windowsHide: true, maxBuffer: 256 * 1024 ** 2 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const frameBytes = width * height * 3;
  const frames = [];
  for (let offset = 0; offset + frameBytes <= decoded.stdout.length; offset += frameBytes) {
    frames.push(decoded.stdout.subarray(offset, offset + frameBytes));
  }
  return frames;
}

function sceneWithGround(nodes, physics) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'brick', color: [0.6, 0.3, 0.2] }, { id: 'steel', color: [0.7, 0.7, 0.75] }],
    nodes: [{ id: 'floor', geometry: 'slab', material: 'brick', translation: [0, -0.25, 0], scale: [8, 0.5, 8] }, ...nodes],
    camera: { eye: [4, 2.5, 7], target: [0, 1, 0] },
    ...(physics ? { physics } : {}),
  };
}

async function submitJob(sessionId, kind, settings) {
  const submitted = await call('scene_render_submit', { sessionId, expectedRevision: (await call('scene_inspect', { sessionId })).revision,
    settings: { kind, width: FRAME_WIDTH, height: FRAME_HEIGHT, fps: 6, ...settings } });
  const record = await finished(submitted.jobId);
  assert.equal(record.state, 'completed', JSON.stringify(record.error ?? record));
  return call('scene_render_result', { jobId: submitted.jobId });
}

// The eight PNGs of a stills job need no ffmpeg, so the physics checks read them and only the encode test needs the encoder.
async function stillBytes(result) {
  assert.equal(result.artifacts.length, 8);
  return Promise.all(result.artifacts.map(artifact => readFile(artifact.path)));
}

async function createFracturedWall() {
  const recipe = sceneWithGround([
    { id: 'wall', geometry: 'slab', material: 'brick', translation: [0, 1.25, 0], scale: [4, 2.5, 0.4] },
    { id: 'ball', geometry: 'ball', material: 'steel', translation: [0, 1.2, 5], scale: [0.5, 0.5, 0.5] },
  ]);
  const { sessionId } = await call('scene_create', { recipe });
  const applied = await call('scene_apply', { sessionId, expectedRevision: 0, operations: [
    { type: 'set-physics', physics: { duration: 3, bodies: [
      { node: 'floor', type: 'fixed', shape: 'box' },
      { node: 'ball', shape: 'ball', density: 400, velocity: [0, 0.3, -18] },
    ] } },
    { type: 'fracture-node', node: 'wall', seed: 7, cells: 64, strength: 1, impact: [0, 0, 0.2], impactRadius: 0.8 },
  ] });
  assert.ok(applied.revision > 0);
  const inspected = await call('scene_inspect', { sessionId });
  assert.equal(inspected.physics.bodies.filter(body => body.node.startsWith('wall-frag-')).length, 64);
  return sessionId;
}

test('a stills job films a falling body from physics alone, spread over the bake', async () => {
  const recipe = sceneWithGround(
    [{ id: 'drop', geometry: 'ball', material: 'steel', translation: [0, 3, 0], scale: [0.5, 0.5, 0.5] }],
    { duration: 1.5, bodies: [{ node: 'floor', type: 'fixed', shape: 'box' }, { node: 'drop', shape: 'ball' }] });
  const { sessionId } = await call('scene_create', { recipe });
  const result = await submitJob(sessionId, 'stills', { motion: { start: 0 } });
  const frames = await stillBytes(result);
  assert.ok(!frames[0].equals(frames[3]), 'the ball moves between frame 0 and frame 3');
  assert.ok(!frames[3].equals(frames[7]), 'and between frame 3 and frame 7');
  await call('scene_dispose', { sessionId });
});

test('a recipe with nothing that moves still errors and names physics as a source', async () => {
  const recipe = sceneWithGround([{ id: 'rock', geometry: 'ball', material: 'steel', translation: [0, 1, 0] }]);
  const { sessionId } = await call('scene_create', { recipe });
  const result = await client.callTool({ name: 'scene_render_submit', arguments: { sessionId, expectedRevision: 0,
    settings: { kind: 'video', width: FRAME_WIDTH, height: FRAME_HEIGHT, motion: { start: 0 } } } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /authored motion, physics/);
  await call('scene_dispose', { sessionId });
});

test('a 64 piece fractured wall renders as stills with the ball breaking it', async () => {
  const sessionId = await createFracturedWall();
  const frames = await stillBytes(await submitJob(sessionId, 'stills', { motion: { start: 0 } }));
  assert.ok(!frames[0].equals(frames[7]), 'the wall changes over the film');
  assert.ok(!frames[2].equals(frames[4]));
  await call('scene_dispose', { sessionId });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;

test('a 64 piece fractured wall encodes as video for the length of the bake', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const sessionId = await createFracturedWall();
  const wide = clipPath !== undefined;
  const result = await submitJob(sessionId, 'video', wide ? { width: 640, height: 360, fps: 24, motion: { start: 0 } } : { motion: { start: 0 } });
  const frames = decodedFrames(result.artifacts[0].path, wide ? 640 : FRAME_WIDTH, wide ? 360 : FRAME_HEIGHT);
  assert.equal(frames.length, wide ? 72 : 18);
  assert.notDeepEqual(frames[0], frames[frames.length - 1], 'the wall changes over the film');
  if (clipPath) {
    await copyFile(result.artifacts[0].path, clipPath);
  }
  await call('scene_dispose', { sessionId });
});

function markerCentroid(frame, width, height) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const [red, green, blue] = [frame[offset], frame[offset + 1], frame[offset + 2]];
      if (green > red + 40 && green > blue + 40) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }
  assert.ok(count > 0, 'the green marker is visible in the frame');
  return { x: sumX / count, y: sumY / count, count };
}

test('a fixed camera stays locked while a fractured wall flies apart', async () => {
  const width = 320;
  const height = 180;
  const recipe = sceneWithGround([
    { id: 'wall', geometry: 'slab', material: 'brick', translation: [0, 1.25, 0], scale: [4, 2.5, 0.4] },
    { id: 'ball', geometry: 'ball', material: 'steel', translation: [0, 1.2, 5], scale: [0.5, 0.5, 0.5] },
    { id: 'marker', geometry: 'slab', material: 'green', translation: [1.5, 0.5, 3], scale: [0.6, 1, 0.6] },
  ]);
  recipe.materials.push({ id: 'green', color: [0.1, 0.9, 0.1] });
  const { sessionId } = await call('scene_create', { recipe });
  await call('scene_apply', { sessionId, expectedRevision: 0, operations: [
    { type: 'set-physics', physics: { duration: 3, bodies: [
      { node: 'floor', type: 'fixed', shape: 'box' },
      { node: 'ball', shape: 'ball', density: 400, velocity: [0, 0.3, -18] },
    ] } },
    { type: 'fracture-node', node: 'wall', seed: 7, cells: 64, strength: 1, impact: [0, 0, 0.2], impactRadius: 0.8 },
  ] });
  const result = await submitVideo(sessionId, { width, height, fps: 6, motion: { start: 0 } });
  const frames = decodedFrames(result.artifacts[0].path, width, height);
  const first = markerCentroid(frames[0], width, height);
  const last = markerCentroid(frames[frames.length - 1], width, height);
  assert.ok(Math.abs(first.x - last.x) < 1 && Math.abs(first.y - last.y) < 1,
    `the static marker moved on screen from ${JSON.stringify(first)} to ${JSON.stringify(last)}`);
  await call('scene_dispose', { sessionId });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { encodeVolumeGrid } from '../src/volume-grid.js';
import { GRID_DIRECTORY_VARIABLE, readVolumeGridFiles } from '../src/mcp-volume-grids.js';
import { decodePngPixels, meanBrightness } from './support/png-pixels.mjs';

// Grid volumes through the MCP render path (#1161): the server reads the .67vg files a recipe names and hands their bytes to the preview page, which has
// no file access. Tiny 4x4x4 grids put the density in the left half of the box (frame "left") or the right half (frame "right"), so which frame a
// render drew shows as which side of the picture is bright.

const SIDE = 128;
const FRAMES_PER_SECOND = 10;
const LEFT_HALF = [0.2, 0.3, 0.45, 0.7];
const RIGHT_HALF = [0.55, 0.3, 0.8, 0.7];
const MINIMUM_SIDE_DIFFERENCE = 12;

function halfBoxGrid(side) {
  const density = new Float32Array(64);
  for (let z = 0; z < 4; z++) {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) density[x + y * 4 + z * 16] = (side === 'left' ? x < 2 : x >= 2) ? 1 : 0;
    }
  }
  return encodeVolumeGrid({ resolution: [4, 4, 4], channels: { density }, size: [2, 2, 2] });
}

function gridRecipe(volume) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [], materials: [], nodes: [],
    camera: { eye: [0, 1, 6], target: [0, 1, 0], fov: 40 },
    environment: { localVolumes: [{ shape: 'grid', center: [0, 1, 0], size: [2, 2, 2], density: 6, emission: [1, 1, 1], emissionStrength: 40, ...volume }] },
  };
}

async function startServer(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-grid-mcp-'));
  const gridFolder = join(directory, 'grids');
  await mkdir(gridFolder);
  await writeFile(join(gridFolder, 'left.67vg'), halfBoxGrid('left'));
  await writeFile(join(gridFolder, 'right.67vg'), halfBoxGrid('right'));
  const previousFolder = process.env[GRID_DIRECTORY_VARIABLE];
  process.env[GRID_DIRECTORY_VARIABLE] = gridFolder;
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, jobs: join(directory, 'jobs') });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'grid-volume-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
    await runtime.close();
    if (previousFolder === undefined) delete process.env[GRID_DIRECTORY_VARIABLE];
    else process.env[GRID_DIRECTORY_VARIABLE] = previousFolder;
    await rm(directory, { recursive: true, force: true });
  });
  return { client, gridFolder };
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

async function renderStill(client, sessionId, revision, start) {
  const submitted = await call(client, 'scene_render_submit', { sessionId, expectedRevision: revision,
    settings: { kind: 'image', width: SIDE, height: SIDE, ...(start === undefined ? {} : { motion: { start } }) } });
  const deadline = Date.now() + 90000;
  for (;;) {
    const record = await call(client, 'scene_render_status', { jobId: submitted.jobId });
    if (record.state === 'completed') break;
    assert.ok(!['cancelled', 'failed'].includes(record.state), JSON.stringify(record));
    assert.ok(Date.now() < deadline, 'the render job did not finish in 90 seconds');
    await delay(100);
  }
  const result = await call(client, 'scene_render_result', { jobId: submitted.jobId });
  const bytes = await readFile(result.artifacts[0].path);
  const picture = decodePngPixels(bytes);
  return { bytes, left: meanBrightness(picture, LEFT_HALF), right: meanBrightness(picture, RIGHT_HALF) };
}

test('a render job draws a still grid volume from a file in the grid folder', { timeout: 180000 }, async context => {
  const { client } = await startServer(context);
  const created = await call(client, 'scene_create', { recipe: gridRecipe({ grid: 'left.67vg' }) });
  const shot = await renderStill(client, created.sessionId, created.revision ?? 0);
  assert.ok(shot.left - shot.right > MINIMUM_SIDE_DIFFERENCE, `the left half holds the density: left ${shot.left}, right ${shot.right}`);
});

test('a render job draws the grid frame its motion time selects, and scene_apply swaps the grid', { timeout: 240000 }, async context => {
  const { client } = await startServer(context);
  const created = await call(client, 'scene_create', { recipe: gridRecipe({ frames: ['left.67vg', 'right.67vg'], fps: FRAMES_PER_SECOND }) });
  const revision = created.revision ?? 0;
  const firstFrame = await renderStill(client, created.sessionId, revision, 0.01);
  const secondFrame = await renderStill(client, created.sessionId, revision, 0.11);
  const wrapped = await renderStill(client, created.sessionId, revision, 0.21);
  assert.ok(firstFrame.left - firstFrame.right > MINIMUM_SIDE_DIFFERENCE, `0.01 s draws frame 0: left ${firstFrame.left}, right ${firstFrame.right}`);
  assert.ok(secondFrame.right - secondFrame.left > MINIMUM_SIDE_DIFFERENCE, `0.11 s draws frame 1: left ${secondFrame.left}, right ${secondFrame.right}`);
  assert.ok(wrapped.left - wrapped.right > MINIMUM_SIDE_DIFFERENCE, `0.21 s wraps to frame 0: left ${wrapped.left}, right ${wrapped.right}`);
  assert.deepEqual(wrapped.bytes, firstFrame.bytes, 'the same frame gives the same pixels');

  const applied = await call(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: revision,
    operations: [{ type: 'set-environment', environment: { localVolumes: [{ shape: 'grid', grid: 'right.67vg', center: [0, 1, 0], size: [2, 2, 2], density: 6, emission: [1, 1, 1], emissionStrength: 40 }] } }] });
  const swapped = await renderStill(client, created.sessionId, applied.revision);
  assert.ok(swapped.right - swapped.left > MINIMUM_SIDE_DIFFERENCE, `an applied grid draws too: left ${swapped.left}, right ${swapped.right}`);
});

test('a grid name that is not a file in the grid folder is refused with what to pass instead', { timeout: 60000 }, async context => {
  const { client } = await startServer(context);
  for (const [grid, message] of [['absent.67vg', /not in the grid folder/], ['../left.67vg', /never a path/], ['left', /file name such as "blast\.67vg"/]]) {
    const refused = await client.callTool({ name: 'scene_create', arguments: { recipe: gridRecipe({ grid }) } });
    assert.equal(refused.isError, true, grid);
    assert.match(refused.content.find(item => item.type === 'text').text, message);
  }
});

test('grid bytes are bounded by name: one sequence may not pass its byte budget', async context => {
  const { gridFolder } = await startServer(context);
  const frames = Array.from({ length: 4 }, (unused, index) => `big${index}.67vg`);
  const bigGrid = Buffer.alloc(64 * 1024 * 1024 + 100);
  for (const name of frames) await writeFile(join(gridFolder, name), bigGrid);
  assert.throws(() => readVolumeGridFiles(gridRecipe({ frames }), gridFolder), /over the 268435456 byte limit for a sequence/);
  await writeFile(join(gridFolder, 'huge.67vg'), Buffer.alloc(64 * 1024 * 1024 + 8192));
  assert.throws(() => readVolumeGridFiles(gridRecipe({ grid: 'huge.67vg' }), gridFolder), /over the 67108864 byte limit; convert it with a lower --max-resolution/);
});

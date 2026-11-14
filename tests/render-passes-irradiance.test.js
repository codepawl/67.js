// A render job with passes on a scene that holds a baked irradiance grid (issue 1204), through the real MCP server on the CPU backend
// (SwiftShader). A pass links a new program, so the grid's uniform locations must be looked up again for it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'b', type: 'box', bevel: 0 }, { id: 's', type: 'sphere' }],
  materials: [{ id: 'floor', color: [0.5, 0.5, 0.5] }, { id: 'ball', color: [0.9, 0.9, 0.9] }],
  nodes: [
    { id: 'floor', geometry: 'b', material: 'floor', scale: [4, 0.1, 4] },
    { id: 'ball', geometry: 's', material: 'ball', translation: [0, 0.6, 0], scale: [0.5, 0.5, 0.5] },
  ],
  camera: { eye: [2, 1.5, 3], target: [0, 0.4, 0] },
  bake: { preset: 'draft', irradianceGrid: 10, probes: false },
};

let directory;
let client;
let sessionId;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crucible-pass-irradiance-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
  client = new Client({ name: 'crucible-pass-irradiance-test', version: '1' });
  await client.connect(transport, { timeout: 240000 });
  sessionId = (await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 120000 })).structuredContent.sessionId;
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

async function untilFinished(jobId) {
  for (let poll = 0; poll < 600; poll++) {
    const record = (await client.callTool({ name: 'scene_render_status', arguments: { jobId } })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(record.state)) return record;
    await delay(200);
  }
  throw new Error('The job did not finish.');
}

test('a depth pass completes on a scene with an irradiance grid and writes both images', { timeout: 300000 }, async () => {
  const submitted = await client.callTool({
    name: 'scene_render_submit',
    arguments: { sessionId, expectedRevision: 0, settings: { kind: 'image', width: 320, height: 240, passes: ['depth'] } },
  }, { timeout: 120000 });
  assert.equal(submitted.isError, undefined, submitted.content?.[0]?.text);
  const record = await untilFinished(submitted.structuredContent.jobId);
  assert.equal(record.state, 'completed', JSON.stringify(record.error ?? record));
  assert.deepEqual(record.artifacts, ['render.png', 'render-depth.png']);
  const result = (await client.callTool({ name: 'scene_render_result', arguments: { jobId: record.jobId } })).structuredContent;
  const depthPath = result.artifacts.find(artifact => artifact.filename === 'render-depth.png').path;
  const bytes = await readFile(depthPath);
  assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], 'the depth pass is a PNG');
});

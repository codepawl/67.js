// scene_render_submit with settings.quality through the real MCP server on the CPU backend (SwiftShader), so it needs Chrome like the
// other MCP tests: the conflict with budget is rejected first, and a tier the runtime cannot run falls back and still renders.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const FRAME = { kind: 'image', width: 128, height: 72 };
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box' }],
  materials: [{ id: 'red', color: [0.7, 0.2, 0.2] }],
  nodes: [{ id: 'cube', geometry: 'box', material: 'red' }],
  camera: { eye: [3, 2, 3], target: [0, 0, 0], fov: 40 },
};

let directory;
let client;
let sessionId;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crucible-quality-submit-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
  client = new Client({ name: 'crucible-quality-submit-test', version: '1' });
  await client.connect(transport, { timeout: 240000 });
  sessionId = (await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 120000 })).structuredContent.sessionId;
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

function submit(settings) {
  return client.callTool({ name: 'scene_render_submit', arguments: { sessionId, expectedRevision: 0, settings: { ...FRAME, ...settings } } }, { timeout: 120000 });
}

async function untilFinished(jobId) {
  for (let poll = 0; poll < 300; poll++) {
    const record = (await client.callTool({ name: 'scene_render_status', arguments: { jobId } })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(record.state)) return record;
    await delay(200);
  }
  throw new Error('The job did not finish.');
}

test('quality with a budget is refused for the conflict, whatever the tier', async () => {
  for (const quality of ['draft', 'realtime', 'realtime-high', 'final']) {
    const result = await submit({ quality, budget: { secondsPerFrame: 5 } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /budget picks the tier: leave settings.quality out/);
  }
});

test('capabilities list the tiers of this runtime and a SwiftShader runtime lacks realtime-high', async () => {
  const tiers = (await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'jobs' } })).structuredContent.value.tiers;
  assert.deepEqual(tiers.map(entry => entry.tier), ['draft', 'realtime', 'realtime-high', 'final']);
  assert.equal(tiers[2].available, false);
  assert.match(tiers[2].missing, /hardware GPU/);
});

test('realtime-high falls back to realtime with the missing capability named, and the job renders', async () => {
  const result = await submit({ quality: 'realtime-high' });
  assert.equal(result.isError, undefined);
  const report = result.structuredContent.quality;
  assert.equal(report.picked, 'realtime');
  assert.match(report.message, /realtime-high lacks a hardware GPU/);
  assert.equal((await untilFinished(result.structuredContent.jobId)).state, 'completed');
});

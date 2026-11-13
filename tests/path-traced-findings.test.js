import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// End to end: a path traced render job has no raster frame and no object ID, depth or normal pass. It still reports the
// part findings of its first frame, and one `findings-unavailable` entry says what it cannot report and why.
const serverEntry = new URL('../bin/67js-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const hasBuild = existsSync(new URL('../build/mcp/server.mjs', import.meta.url));
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hasBrowser = existsSync(chromePath) || Boolean(process.env.CI);

const recipe = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [{ id: 'block', type: 'box' }],
  materials: [{ id: 'stone', color: [0.7, 0.68, 0.64] }],
  nodes: [
    { id: 'floor', geometry: 'block', material: 'stone', scale: [8, 0.1, 8], translation: [0, -0.05, 0] },
    { id: 'crate', geometry: 'block', material: 'stone', scale: [0.5, 0.5, 0.5], translation: [0, 1, 0] },
  ],
  camera: { target: [0, 0.5, 0], eye: [3, 2, 4], up: [0, 1, 0], fov: 50, near: 0.1, far: 60 },
};

test('a path traced job reports part findings and says why exposure findings and passes are unavailable',
  { skip: (!hasBuild && 'run npm run build:lib first') || (!hasBrowser && 'no Chrome'), timeout: 300000 }, async context => {
    const workDirectory = await mkdtemp(join(tmpdir(), '67js-traced-findings-'));
    context.after(() => rm(workDirectory, { recursive: true, force: true }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry, '--backend', 'cpu', '--memory', '384', '--jobs', join(workDirectory, 'jobs')],
      cwd: workDirectory,
      env: { ...process.env, JS67_NATIVE_TRACER: 'off' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'traced-findings-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 120000 });
      const created = (await call('scene_create', { recipe })).structuredContent;
      const settings = { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer', backend: 'cpu', samples: 2, bounces: 2, denoise: false, seed: 1, maxSeconds: 60 } };
      const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: 0, settings });
      assert.notEqual(submitted.isError, true, submitted.content?.[0]?.text);
      const { jobId } = submitted.structuredContent;
      let record;
      for (;;) {
        record = (await call('scene_render_status', { jobId })).structuredContent;
        if (['completed', 'cancelled', 'failed'].includes(record.state)) break;
        await delay(200);
      }
      assert.equal(record.state, 'completed', record.error);
      const result = (await call('scene_render_result', { jobId })).structuredContent;
      const diagnostics = (result.metrics ?? record.metrics).diagnostics ?? [];
      const floating = diagnostics.find(problem => problem.kind === 'floating-node');
      assert.deepEqual(floating?.nodes, ['crate']);
      const unavailable = diagnostics.find(problem => problem.kind === 'findings-unavailable');
      assert.match(unavailable?.message ?? '', /object ID, depth and normal/);

      const refused = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: 0, settings: { ...settings, passes: ['objectId'] } });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /no object ID, depth or normal pass/);
    } finally {
      await client.close();
    }
  });

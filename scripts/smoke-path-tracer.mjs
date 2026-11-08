// Proves the path tracer through the real MCP runtime: an image job with settings.renderer writes a PNG that differs
// from the rasterizer's, the same recipe and seed give the same bytes, another seed does not, bad settings are refused,
// and a job that passes maxSeconds fails without writing an image.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-path-tracer-'));
const jobs = join(directory, 'jobs');
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '128', '--jobs', jobs], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-path-tracer-proof', version: '1' });
const SIZE = 96;

async function call(name, argumentsValue = {}, timeout = 60000) {
  return client.callTool({ name, arguments: argumentsValue }, { timeout });
}

async function finished(jobId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(200);
  }
  throw new Error('Job did not finish within 120 seconds.');
}

async function submit(sessionId, settings) {
  return call('scene_render_submit', { sessionId, expectedRevision: 0, settings });
}

async function renderedBytes(sessionId, settings) {
  const submitted = await submit(sessionId, settings);
  assert.equal(submitted.isError, undefined, submitted.content?.[0]?.text);
  const record = await finished(submitted.structuredContent.jobId);
  assert.equal(record.state, 'completed', JSON.stringify(record));
  const result = (await call('scene_render_result', { jobId: submitted.structuredContent.jobId })).structuredContent;
  const bytes = await readFile(result.artifacts[0].path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.artifacts[0].sha256);
  await call('scene_render_release', { jobId: submitted.structuredContent.jobId });
  return { bytes, metrics: result.metrics ?? record.metrics };
}

const recipe = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box' }, { id: 'sphere', type: 'sphere', segments: 24, rings: 16 }],
  materials: [
    { id: 'floor', color: [0.5, 0.5, 0.5], roughness: 0.8 },
    { id: 'glass', color: [1, 1, 1], roughness: 0.05, transmission: 1 },
  ],
  nodes: [
    { id: 'floor', geometry: 'box', material: 'floor', translation: [0, -0.1, 0], scale: [12, 0.2, 12] },
    { id: 'ball', geometry: 'sphere', material: 'glass', translation: [0, 0.5, 0], scale: [1, 1, 1] },
  ],
  camera: { eye: [0, 1.6, 6], target: [0, 0.5, 0], fov: 40 },
};

try {
  await client.connect(transport);
  const created = (await call('scene_create', { recipe }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const base = { kind: 'image', width: SIZE, height: SIZE };
  const tracer = { type: 'pathTracer', samples: 4, bounces: 4 };

  const first = await renderedBytes(sessionId, { ...base, renderer: tracer });
  assert.equal(first.metrics.pathTracer.samples, 4);
  assert.equal(first.metrics.pathTracer.threads, 8);
  assert.equal(first.metrics.pathTracer.backend, 'cpu');
  const second = await renderedBytes(sessionId, { ...base, renderer: tracer });
  assert.deepEqual(second.bytes, first.bytes, 'The same recipe and seed must give the same PNG.');
  const reseeded = await renderedBytes(sessionId, { ...base, renderer: { ...tracer, seed: 5 } });
  assert.notDeepEqual(reseeded.bytes, first.bytes, 'Another seed must change the noise.');
  const rasterized = await renderedBytes(sessionId, base);
  assert.notDeepEqual(rasterized.bytes, first.bytes, 'The path tracer must not return the rasterizer image.');

  // denoise "oidn" runs the native tool of the optional package when it is installed; without it the job says it used the wavelet filter.
  const { findOidnBinary } = await import('@codepawlhq/67js-denoise-oidn').catch(() => ({ findOidnBinary: () => null }));
  const external = await renderedBytes(sessionId, { ...base, renderer: { ...tracer, denoise: 'oidn' } });
  if (findOidnBinary()) {
    assert.equal(external.metrics.pathTracer.denoiser, 'oidn');
    assert.ok(external.metrics.pathTracer.denoiseSeconds > 0);
    const again = await renderedBytes(sessionId, { ...base, renderer: { ...tracer, denoise: 'oidn' } });
    assert.deepEqual(again.bytes, external.bytes, 'The same recipe, seed and OIDN must give the same PNG on one machine.');
  } else {
    assert.equal(external.metrics.pathTracer.denoiser, 'wavelet');
    assert.match(external.metrics.pathTracer.denoiserNote, /wavelet filter ran instead/);
  }
  for (const [settings, message] of [
    [{ ...base, renderer: { ...tracer, samples: 99999 } }, /samples/],
    [{ ...base, renderer: { ...tracer, extra: 1 } }, /extra|Unrecognized|Unknown/],
    [{ ...base, renderer: tracer, passes: ['albedo'] }, /passes/],
    [{ ...base, renderer: { ...tracer, backend: 'metal' } }, /backend/],
  ]) {
    const refused = await submit(sessionId, settings);
    assert.equal(refused.isError, true, JSON.stringify(settings));
    assert.match(refused.content[0].text, message);
  }

  // A SwiftShader runtime keeps the CPU tracer: a job that asks for the GPU backend fails instead of drawing something else.
  const gpuOnSwiftShader = await submit(sessionId, { ...base, renderer: { ...tracer, backend: 'gpu' } });
  assert.equal(gpuOnSwiftShader.isError, undefined, gpuOnSwiftShader.content?.[0]?.text);
  assert.equal((await finished(gpuOnSwiftShader.structuredContent.jobId)).state, 'failed', 'backend gpu must fail on a cpu runtime.');

  const slow = await submit(sessionId, { kind: 'image', width: 512, height: 512, renderer: { type: 'pathTracer', samples: 1024, maxSeconds: 1 } });
  assert.equal(slow.isError, undefined, slow.content?.[0]?.text);
  const slowRecord = await finished(slow.structuredContent.jobId);
  assert.equal(slowRecord.state, 'failed', 'A job past maxSeconds must fail.');
  console.log(`path tracer smoke passed: ${first.bytes.length} byte PNG in ${first.metrics.pathTracer.seconds.toFixed(1)} s on ${first.metrics.pathTracer.threads} threads`);
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

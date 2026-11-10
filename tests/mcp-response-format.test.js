import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';
import { conciseJobResult, conciseJobStatus, conciseReview, withoutNotes } from '../scripts/mcp-response-format.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const jobId = '0f95a6dd-4128-440e-bc31-8a529180caf2';

const shot = {
  label: 'Front', camera: { eye: [4, 2, 1], target: [0, 1, 0], up: [0, 1, 0], fov: 36, near: 0.1, far: 40 },
  animation: null, motionTime: null, rendererTime: 0, requestedWidth: 384, requestedHeight: 384,
  graphics: 'ANGLE (SwiftShader)', estimatedBytes: 23703276, width: 384, height: 384, samples: 0, hdr: true, depth: true,
  geometryBuffers: 7, materialTextures: 0, skinTextures: 0, morphTextures: 0, gpuBuffers: 33, drawBatches: 7,
  labels: [{ id: 'mesh', name: 'mesh', tag: 'surface', faceTags: [], problems: [], x: 10, y: 20 }],
};
const reviewMetadata = {
  sessionId: jobId, sourceRevision: 3, backend: 'cpu', width: 768, height: 384, shots: [shot, { ...shot, label: 'Back', motionTime: 1.5 }],
  peakNodeBytes: 136802304, peakBrowserHeap: 19285872, maximumPendingFrames: 1, elapsedSeconds: 13.8,
};
const jobRecord = {
  schemaVersion: 1, jobId, sourceRevision: 3, state: 'completed',
  settings: { kind: 'image', width: 128, height: 128, fps: 24, duration: 1, frameCount: 1, rendererTime: { start: 0, rate: 1 } },
  progress: { frames: 1, maximumPendingFrames: 1 },
  artifacts: [{ filename: 'render.mp4', mimeType: 'video/mp4', bytes: 8765, sha256: 'ab'.repeat(32) }],
  metrics: { backend: 'cpu', width: 128, renderSeconds: 0.36, depthRangeMetres: [1, 9], peakNodeBytes: 146837504, graphics: 'ANGLE (SwiftShader)', estimatedBytes: 17936108 },
};
const jobResult = {
  jobId, sourceRevision: 3, metrics: jobRecord.metrics,
  artifacts: [{ ...jobRecord.artifacts[0], path: 'jobs/render.mp4' }],
};

async function connect(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async review() { return { data: png, mimeType: 'image/png', metadata: structuredClone(reviewMetadata) }; },
    async jobStatus() { return structuredClone(jobRecord); },
    async jobResult() { return structuredClone(jobResult); },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: '67js-response-format-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const textBytes = result => Buffer.byteLength(result.content.find(block => block.type === 'text').text);

async function rejectsFormat(client, name, argumentsValue) {
  let result;
  try {
    result = await client.callTool({ name, arguments: { ...argumentsValue, response_format: 'verbose' } });
  } catch (error) {
    assert.match(error.message, /invalid|response_format|expected/i);
    return;
  }
  assert.equal(result.isError, true, `${name} must reject an unknown response_format`);
}

test('scene_review defaults to concise and keeps the full metadata as detailed', async context => {
  const client = await connect(context);
  const arguments_ = { expectedRevision: 3, shots: [{}, {}] };
  const fallback = await client.callTool({ name: 'scene_review', arguments: arguments_ });
  const concise = await client.callTool({ name: 'scene_review', arguments: { ...arguments_, response_format: 'concise' } });
  const detailed = await client.callTool({ name: 'scene_review', arguments: { ...arguments_, response_format: 'detailed' } });
  assert.deepEqual(fallback.structuredContent, concise.structuredContent);
  assert.deepEqual(detailed.structuredContent, reviewMetadata);
  assert.equal(concise.structuredContent.shots[0].graphics, undefined);
  assert.equal(concise.structuredContent.peakNodeBytes, undefined);
  assert.deepEqual(concise.structuredContent.shots[0].camera, shot.camera);
  assert.deepEqual(concise.structuredContent.shots[0].labels, shot.labels);
  assert.equal(concise.structuredContent.shots[1].motionTime, 1.5);
  assert.equal(concise.structuredContent.shots[0].motionTime, undefined);
  assert.ok(textBytes(concise) * 2 < textBytes(detailed), 'concise review is under half the detailed size');
  await rejectsFormat(client, 'scene_review', arguments_);
});

test('scene_render_status defaults to concise and keeps the full record as detailed', async context => {
  const client = await connect(context);
  const concise = await client.callTool({ name: 'scene_render_status', arguments: { jobId } });
  const detailed = await client.callTool({ name: 'scene_render_status', arguments: { jobId, response_format: 'detailed' } });
  assert.deepEqual(concise.structuredContent, { jobId, state: 'completed', frames: 1, frameCount: 1, artifacts: ['render.mp4'] });
  assert.deepEqual(detailed.structuredContent, jobRecord);
  assert.ok(textBytes(concise) * 3 < textBytes(detailed), 'concise status is under a third of the detailed size');
  await rejectsFormat(client, 'scene_render_status', { jobId });
});

test('a failed job keeps its reason in the concise status', () => {
  const concise = conciseJobStatus({ jobId, state: 'failed', progress: { frames: 0 }, reason: 'Out of memory.', artifacts: [], settings: {} });
  assert.equal(concise.reason, 'Out of memory.');
  assert.equal(concise.artifacts, undefined);
});

test('scene_render_result defaults to concise and keeps digests and resource counters as detailed', async context => {
  const client = await connect(context);
  const concise = await client.callTool({ name: 'scene_render_result', arguments: { jobId } });
  const detailed = await client.callTool({ name: 'scene_render_result', arguments: { jobId, response_format: 'detailed' } });
  assert.deepEqual(concise.structuredContent, {
    jobId, sourceRevision: 3, metrics: { backend: 'cpu', width: 128, renderSeconds: 0.36, depthRangeMetres: [1, 9] },
    artifacts: [{ filename: 'render.mp4', mimeType: 'video/mp4', bytes: 8765, path: 'jobs/render.mp4' }],
  });
  assert.deepEqual(detailed.structuredContent, jobResult);
  assert.equal(concise.content.filter(block => block.type === 'resource_link').length, 1);
  assert.ok(textBytes(concise) < textBytes(detailed));
  await rejectsFormat(client, 'scene_render_result', { jobId });
});

test('scene_capabilities defaults to detailed and concise drops the field notes of a topic', async context => {
  const client = await connect(context);
  const fallback = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'materialFields' } });
  const detailed = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'materialFields', response_format: 'detailed' } });
  const concise = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'materialFields', response_format: 'concise' } });
  assert.deepEqual(fallback.structuredContent, detailed.structuredContent);
  assert.ok(textBytes(concise) < textBytes(detailed));
  assert.deepEqual(Object.keys(concise.structuredContent.fields), Object.keys(detailed.structuredContent.fields).filter(name => name !== '_'));
  assert.ok(!JSON.stringify(concise.structuredContent.fields).includes(' // '));
  const index = await client.callTool({ name: 'scene_capabilities', arguments: { response_format: 'concise' } });
  assert.deepEqual(index.structuredContent, (await client.callTool({ name: 'scene_capabilities', arguments: {} })).structuredContent);
  await rejectsFormat(client, 'scene_capabilities', {});
});

test('the helpers leave unknown fields alone', () => {
  assert.deepEqual(conciseReview({ shots: [{ extra: 1, graphics: 'x' }], backend: 'cpu', other: 2 }), { shots: [{ extra: 1 }], other: 2 });
  assert.deepEqual(conciseJobResult({ jobId, sourceRevision: 1, artifacts: [{ filename: 'a.png', sha256: 'x' }] }), { jobId, sourceRevision: 1, artifacts: [{ filename: 'a.png' }] });
  assert.deepEqual(withoutNotes({ _: 'note', 'a?': 'number[0..1] // unit', list: ['x // y'] }), { 'a?': 'number[0..1]', list: ['x'] });
});

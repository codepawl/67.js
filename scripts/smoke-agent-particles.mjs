// Recipe particles and hair through the real MCP server: the SwiftShader preview swaps the particle parts for each
// seek, a seek back must reproduce the same PNG bytes, and a second session of the same recipe must match them too.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-particles-'));
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '96', '--jobs', join(directory, 'jobs')],
  cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-particles-proof', version: '1' });

async function call(name, argumentsValue = {}, timeout = 60000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function look(sessionId, motionTime) {
  const result = await call('scene_look', { sessionId, width: 480, height: 480, ...(motionTime !== undefined ? { motionTime } : {}) });
  assert.match(result.structuredContent.graphics, /swiftshader/i);
  return result.content.find(item => item.type === 'image').data;
}

// Sparks thrown up from a floor beside a furry ball that sways in the wind.
const recipe = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [
    { id: 'speck', type: 'box', bevel: 0 },
    { id: 'floor', type: 'box', bevel: 0 },
    { id: 'ball', type: 'sphere', segments: 24, rings: 16 },
    { id: 'strand', type: 'box', bevel: 0 },
  ],
  materials: [
    { id: 'glow', color: [1, 0.55, 0.12], emission: 5 },
    { id: 'ground', color: [0.3, 0.3, 0.33] },
    { id: 'fur', color: [0.55, 0.35, 0.2], roughness: 0.9 },
  ],
  nodes: [
    { id: 'floor', geometry: 'floor', material: 'ground', translation: [0, -0.05, 0], scale: [8, 0.1, 8] },
    { id: 'sparks', geometry: 'speck', material: 'glow' },
    { id: 'ball', geometry: 'ball', material: 'fur', translation: [1.4, 0.5, 0], scale: [0.5, 0.5, 0.5] },
    { id: 'fur', geometry: 'strand', material: 'fur' },
  ],
  camera: { eye: [0, 1.6, 5], target: [0.4, 0.7, 0] },
  particles: {
    wind: [1, 0, 0],
    systems: [
      { node: 'sparks', seed: 11, count: 300, rate: 150, lifetime: [0.8, 1.6], speed: [2, 4], spread: 35, size: 0.035, drag: 0.3, floor: 0, scale: 'shrink', emitter: { shape: 'disc', position: [-0.8, 0, 0], radius: 0.15 } },
      { type: 'hair', node: 'fur', surface: 'ball', seed: 3, count: 600, length: [0.08, 0.16], segments: 4, width: 0.01, droop: 1, sway: 0.03 },
    ],
  },
};

try {
  await client.connect(transport);
  const capabilities = (await call('scene_capabilities', { topic: 'particles' })).structuredContent;
  assert.equal(capabilities.value.limits.maxParticles, 4000);
  const created = (await call('scene_create', { recipe }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const report = (await call('scene_inspect', { sessionId })).structuredContent.particles;
  assert.equal(report.systems[0].particles, 300);
  assert.equal(report.systems[1].strands, 600);

  const start = await look(sessionId, 0);
  const middle = await look(sessionId, 0.9);
  const end = await look(sessionId, 2.4);
  assert.notEqual(start, middle);
  assert.notEqual(middle, end);
  for (const [time, expected] of [[1.7, null], [0, start], [0.9, middle], [2.4, end], [0.3, null], [0.9, middle]]) {
    const actual = await look(sessionId, time);
    if (expected) {
      assert.equal(actual, expected, `Seek to ${time} s must reproduce the same PNG bytes.`);
    }
  }
  await call('scene_dispose', { sessionId });
  const second = (await call('scene_create', { recipe }, 180000)).structuredContent.sessionId;
  assert.equal(await look(second, 0.9), middle, 'A second session of the same recipe renders the same bytes.');
  await mkdir('artifacts', { recursive: true });
  for (const [name, data] of [['start', start], ['middle', middle], ['end', end]]) {
    await writeFile(`artifacts/agent-particles-${name}.png`, Buffer.from(data, 'base64'));
  }
  await call('scene_dispose', { sessionId: second });
  const processId = transport.pid;
  await client.close();
  const deadline = Date.now() + 7000;
  let exited = false;
  while (Date.now() < deadline && !exited) {
    try {
      process.kill(processId, 0);
      await delay(50);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      exited = true;
    }
  }
  assert.equal(exited, true, `Owned MCP process must exit: ${diagnostics}`);
  console.log(JSON.stringify({ shuffledPngSeeksExact: true, secondSessionExact: true, particles: report.systems[0].particles, strands: report.systems[1].strands, eofCleanup: true }));
} finally {
  await client.close();
}

// Recipe cloth through the real MCP server: the sheet is baked when the scene is created, the SwiftShader preview swaps
// the deformed part for each seek, and seeking back must reproduce the same PNG bytes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), '67js-mcp-cloth-'));
const cli = resolve(process.argv[2] ?? 'bin/67js-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '96', '--jobs', join(directory, 'jobs')],
  cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: '67js-cloth-proof', version: '1' });

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

// A red flag pinned along its top edge, blown by wind, beside a pole and a ball it can touch.
const recipe = {
  format: '67js.scene', schemaVersion: 1,
  geometries: [
    { id: 'flag', type: 'grid', segments: 20 },
    { id: 'pole', type: 'box', bevel: 0 },
    { id: 'ball', type: 'sphere' },
  ],
  materials: [{ id: 'cloth', color: [0.85, 0.15, 0.12], doubleSided: true, roughness: 0.9 }, { id: 'metal', color: [0.6, 0.6, 0.65] }],
  nodes: [
    { id: 'pole', geometry: 'pole', material: 'metal', translation: [-1.05, 1.5, 0], scale: [0.08, 3, 0.08] },
    { id: 'flag', geometry: 'flag', material: 'cloth', translation: [0, 2.5, 0], scale: [2, 1.2, 1] },
    { id: 'ball', geometry: 'ball', material: 'metal', translation: [0.2, 1.4, 0.35], scale: [0.3, 0.3, 0.3] },
  ],
  camera: { eye: [2.5, 2, 5], target: [0, 1.8, 0] },
  cloth: { duration: 3, wind: [4, 0, 2], sheets: [{ node: 'flag', pin: ['left'] }], colliders: [{ node: 'ball', shape: 'ball' }] },
};

try {
  await client.connect(transport);
  const capabilities = (await call('scene_capabilities', { topic: 'cloth' })).structuredContent;
  assert.deepEqual(capabilities.notes.limits.maxSheets, 8);
  const created = (await call('scene_create', { recipe }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const report = (await call('scene_inspect', { sessionId })).structuredContent.cloth;
  assert.equal(report.sheets[0].particles, 21 * 21);
  assert.equal(report.sheets[0].pinned, 21);

  const start = await look(sessionId, 0);
  const middle = await look(sessionId, 1);
  const end = await look(sessionId, 3);
  assert.notEqual(start, middle);
  assert.notEqual(middle, end);
  for (const [time, expected] of [[2.2, null], [0, start], [1, middle], [3, end], [0.4, null], [1, middle]]) {
    const actual = await look(sessionId, time);
    if (expected) {
      assert.equal(actual, expected, `Seek to ${time} s must reproduce the same PNG bytes.`);
    }
  }
  await mkdir('artifacts', { recursive: true });
  for (const [name, data] of [['start', start], ['middle', middle], ['end', end]]) {
    await writeFile(`artifacts/agent-cloth-${name}.png`, Buffer.from(data, 'base64'));
  }
  await call('scene_dispose', { sessionId });
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
  console.log(JSON.stringify({ shuffledPngSeeksExact: true, particles: report.sheets[0].particles, eofCleanup: true }));
} finally {
  await client.close();
}

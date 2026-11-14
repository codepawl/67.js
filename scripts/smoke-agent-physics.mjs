// Recipe physics through the real MCP server: Rapier loads in the SwiftShader preview page, the bake is recorded when
// the scene is created, and seeking back must reproduce the same PNG bytes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-mcp-physics-'));
const cli = resolve(process.argv[2] ?? 'bin/crucible-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath,
  args: [cli, '--backend', 'cpu', '--memory', '96', '--jobs', join(directory, 'jobs')],
  cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-physics-proof', version: '1' });

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

// An authored ramp: a box mesh whose right face is lifted, so the top slopes down toward -X.
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [
    { id: 'ramp', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'translate', select: { tag: 'right' }, offset: [0, 0.5, 0] }] },
    { id: 'ball', type: 'sphere' },
  ],
  materials: [{ id: 'stone', color: [0.5, 0.5, 0.55] }, { id: 'red', color: [0.9, 0.2, 0.15] }],
  nodes: [
    { id: 'ramp', geometry: 'ramp', material: 'stone', scale: [4, 1, 3] },
    { id: 'ball-a', geometry: 'ball', material: 'red', translation: [0.8, 2.5, 0], scale: [0.3, 0.3, 0.3] },
    { id: 'ball-b', geometry: 'ball', material: 'red', translation: [0.2, 3.2, 0.5], scale: [0.3, 0.3, 0.3] },
  ],
  camera: { eye: [5, 4, 6], target: [0, 1, 0] },
  physics: { duration: 4, bodies: [
    { node: 'ramp', type: 'fixed', shape: 'trimesh' },
    { node: 'ball-a', shape: 'ball', restitution: 0.4 },
    { node: 'ball-b', shape: 'ball', restitution: 0.4 },
  ] },
};

try {
  await client.connect(transport);
  const capabilities = (await call('scene_capabilities', { topic: 'physics' })).structuredContent;
  assert.deepEqual(capabilities.notes.shapes, ['box', 'ball', 'capsule', 'convex', 'trimesh']);
  const created = (await call('scene_create', { recipe }, 180000)).structuredContent;
  const sessionId = created.sessionId;
  const report = (await call('scene_inspect', { sessionId })).structuredContent.physics;
  const ballA = report.bodies.find(body => body.node === 'ball-a');
  assert.ok(ballA.finalPosition[1] < 2.5, 'the ball fell');
  assert.ok(report.contacts.some(contact => contact.a === 'ball-a' && contact.b === 'ramp'), 'the ball touched the ramp');

  const start = await look(sessionId, 0);
  const middle = await look(sessionId, 1.2);
  const end = await look(sessionId, 4);
  assert.notEqual(start, middle);
  assert.notEqual(middle, end);
  for (const [time, expected] of [[2.7, null], [0, start], [1.2, middle], [4, end], [0.4, null], [1.2, middle]]) {
    const actual = await look(sessionId, time);
    if (expected) {
      assert.equal(actual, expected, `Seek to ${time} s must reproduce the same PNG bytes.`);
    }
  }
  await mkdir('artifacts', { recursive: true });
  for (const [name, data] of [['start', start], ['middle', middle], ['end', end]]) {
    await writeFile(`artifacts/agent-physics-${name}.png`, Buffer.from(data, 'base64'));
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
  console.log(JSON.stringify({ shuffledPngSeeksExact: true, contacts: report.contacts.length, ballARestsAt: ballA.restsAtTime, eofCleanup: true }));
} finally {
  await client.close();
}

import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { formatSummary, summarizeCalls } from '../scripts/summarize-mcp-log.mjs';

const SECRET_MARKER = 'secret-topic-marker';

const runtime = {
  activeSessionId: () => null,
  async close() {},
  async inspect() {
    return { assets: [] };
  },
  async dispose() {
    throw new Error('No scene is active.');
  },
};

async function connect(context, callLogPath) {
  const server = createAgentMcpServer(runtime, { callLogPath });
  const client = new Client({ name: 'call-log-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function temporaryLogPath(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-call-log-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'calls.jsonl');
}

test('with no log path the server writes no file', async context => {
  const logPath = await temporaryLogPath(context);
  const client = await connect(context, undefined);
  await client.callTool({ name: 'scene_asset_catalog', arguments: {} });
  assert.equal(existsSync(logPath), false);
});

test('with a log path each call adds one line that holds no arguments', async context => {
  const logPath = await temporaryLogPath(context);
  const client = await connect(context, logPath);
  await client.callTool({ name: 'scene_inspect', arguments: { ids: [SECRET_MARKER] } });
  const failed = await client.callTool({ name: 'scene_dispose', arguments: {} });
  assert.equal(failed.isError, true);

  const text = readFileSync(logPath, 'utf8');
  assert.ok(!text.includes(SECRET_MARKER), 'argument values are never written');
  const lines = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['durationMs', 'ok', 'resultBytes', 'time', 'tool']);
  assert.equal(lines[0].tool, 'scene_inspect');
  assert.equal(lines[0].ok, true);
  assert.ok(lines[0].resultBytes > 0);
  assert.ok(!Number.isNaN(Date.parse(lines[0].time)));
  assert.equal(lines[1].tool, 'scene_dispose');
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].error, 'tool_error');
});

test('the summary counts calls, error rate and median duration per tool, most called first', () => {
  const calls = [
    { tool: 'scene_apply', ok: true, durationMs: 10 },
    { tool: 'scene_apply', ok: false, durationMs: 30 },
    { tool: 'scene_apply', ok: true, durationMs: 20 },
    { tool: 'scene_apply', ok: true, durationMs: 40 },
    { tool: 'scene_look', ok: true, durationMs: 5 },
  ];
  const rows = summarizeCalls(calls);
  assert.deepEqual(rows, [
    { tool: 'scene_apply', calls: 4, errors: 1, errorRate: 0.25, medianMs: 25 },
    { tool: 'scene_look', calls: 1, errors: 0, errorRate: 0, medianMs: 5 },
  ]);
  assert.match(formatSummary(rows), /scene_apply\s+4\s+1\s+25\.0%\s+25\.0/);
});

test('the summary script reads several log files and prints a table', async context => {
  const first = await temporaryLogPath(context);
  const second = join(first, '..', 'second.jsonl');
  await writeFile(first, `${JSON.stringify({ tool: 'scene_look', ok: true, durationMs: 4 })}\nnot json\n`);
  await writeFile(second, `${JSON.stringify({ tool: 'scene_look', ok: false, durationMs: 8 })}\n`);
  const script = new URL('../scripts/summarize-mcp-log.mjs', import.meta.url);
  const run = spawnSync(process.execPath, [script.pathname.replace(/^\/(\w:)/, '$1'), first, second], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /scene_look\s+2\s+1\s+50\.0%\s+6\.0/);
});

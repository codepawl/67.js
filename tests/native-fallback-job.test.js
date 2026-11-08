import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// End to end: a real render job through the MCP server on a SwiftShader runtime, asked for the native backend while the
// package is switched off (JS67_NATIVE_TRACER=off, the same answer as a missing package or an adapter without ray queries).
// The job must run the cpu backend and give the bytes and report fields of a job that asked for cpu.
const serverEntry = new URL('../bin/67js-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const recipeUrl = new URL('./fixtures/demo-room.recipe.json', import.meta.url);
const hasBuild = existsSync(new URL('../build/mcp/server.mjs', import.meta.url));
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const hasBrowser = existsSync(chromePath) || Boolean(process.env.CI);
const DETERMINISTIC_FIELDS = ['width', 'height', 'samples', 'bounces', 'seed', 'denoised', 'denoiser', 'threads', 'backend', 'triangles', 'averageSamples', 'ignored'];

async function renderDemoRoom(requestedBackend, workDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, '--backend', 'cpu', '--memory', '384', '--jobs', join(workDirectory, `jobs-${requestedBackend}`)],
    cwd: workDirectory,
    env: { ...process.env, JS67_NATIVE_TRACER: 'off' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'native-fallback-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 300000 });
    const recipe = JSON.parse(await readFile(recipeUrl, 'utf8'));
    const created = (await call('scene_create', { recipe })).structuredContent;
    const settings = { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer', backend: requestedBackend, samples: 2, bounces: 2, denoise: false, seed: 3, maxSeconds: 120 } };
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
    const imagePath = join(workDirectory, `${requestedBackend}.png`);
    await copyFile(result.artifacts[0].path, imagePath);
    return { png: await readFile(imagePath), report: (result.metrics ?? record.metrics).pathTracer };
  } finally {
    await client.close();
  }
}

test('a native job without the native tracer runs the cpu backend with the same image and report fields',
  { skip: (!hasBuild && 'run npm run build:lib first') || (!hasBrowser && 'no Chrome'), timeout: 600000 }, async context => {
    const workDirectory = await mkdtemp(join(tmpdir(), '67js-native-fallback-'));
    context.after(() => rm(workDirectory, { recursive: true, force: true }));
    const cpu = await renderDemoRoom('cpu', workDirectory);
    const native = await renderDemoRoom('native', workDirectory);
    assert.equal(native.report.backend, 'cpu');
    assert.match(native.report.backendNote, /switched off by JS67_NATIVE_TRACER=off.*cpu backend ran instead/);
    assert.equal(cpu.report.backendNote, undefined);
    assert.ok(native.png.equals(cpu.png), 'the fallback image is byte-identical to the cpu backend');
    for (const field of DETERMINISTIC_FIELDS) assert.deepEqual(native.report[field], cpu.report[field], field);
    const reportKeys = report => Object.keys(report).filter(key => key !== 'backendNote').sort();
    assert.deepEqual(reportKeys(native.report), reportKeys(cpu.report));
  });

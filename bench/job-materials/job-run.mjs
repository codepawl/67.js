// Real native render jobs through the MCP server of one checkout, to compare two checkouts byte for byte.
//   node bench/job-materials/job-run.mjs <mcp entry> <output folder> <samples> <scene...> [--browser <chrome path>]
// Each scene of scenes.mjs `recipeFor` is rendered as one native path-traced image job. <scene>.png and <scene>.json (the job
// report and the SHA-256 of the PNG) land in the output folder; run it once per checkout and compare the digests.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { recipeFor } from './scenes.mjs';

const WIDTH = 192;
const HEIGHT = 128;
const [entry, outputFolder, samples, ...rest] = process.argv.slice(2);
const browserIndex = rest.indexOf('--browser');
const browser = browserIndex >= 0 ? rest[browserIndex + 1] : undefined;
const scenes = rest.filter((value, index) => value !== '--browser' && index !== browserIndex + 1);
if (!entry || !outputFolder || !samples || scenes.length === 0) {
  throw new RangeError('Usage: job-run.mjs <mcp entry> <output folder> <samples> <scene...> [--browser <chrome path>]');
}

async function renderScene(sceneName) {
  const workFolder = mkdtempSync(join(tmpdir(), '67js-job-materials-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(entry), '--backend', 'gpu', '--memory', '192', '--jobs', join(workFolder, 'jobs'), ...(browser ? ['--browser', browser] : [])],
    cwd: workFolder, env: { ...process.env }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
  const client = new Client({ name: '67js-job-materials', version: '1' });
  await client.connect(transport);
  const call = async (name, argumentsValue) => {
    const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
    if (result.isError) throw new Error(`${name}: ${result.content?.find(item => item.type === 'text')?.text}`);
    return result.structuredContent ?? result;
  };
  try {
    const created = await call('scene_create', { recipe: recipeFor(sceneName) });
    const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: {
      kind: 'image', width: WIDTH, height: HEIGHT,
      renderer: { type: 'pathTracer', backend: 'native', samples: Number(samples), bounces: 4, denoise: false, seed: 1, maxSeconds: 300 },
    } });
    let record;
    for (let attempt = 0; attempt < 1200; attempt++) {
      record = await call('scene_render_status', { jobId: submitted.jobId });
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(record.state)) break;
      await delay(500);
    }
    if (record.state !== 'completed') throw new Error(`job ${record.state}: ${record.reason ?? ''} ${diagnostics}`);
    const result = await call('scene_render_result', { jobId: submitted.jobId });
    const bytes = readFileSync(result.artifacts[0].path);
    writeFileSync(join(outputFolder, `${sceneName}.png`), bytes);
    const summary = { scene: sceneName, pngSha256: createHash('sha256').update(bytes).digest('hex'), report: result.metrics?.pathTracer };
    writeFileSync(join(outputFolder, `${sceneName}.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ scene: sceneName, pngSha256: summary.pngSha256, backend: summary.report?.backend, nativeBackend: summary.report?.nativeBackend,
      kernel: summary.report?.kernel, instances: summary.report?.instances, instancing: summary.report?.instancing, ignored: summary.report?.ignored }));
  } finally {
    await client.close();
  }
}

mkdirSync(outputFolder, { recursive: true });
for (const sceneName of scenes) await renderScene(sceneName);

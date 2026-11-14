// Times a 1920 by 1080 path traced still of the demo room through the real MCP image job, for each denoiser:
//   node bench/reference/denoise-1080.mjs [--samples 16] [--denoisers oidn,wavelet] [--out artifacts/denoise-1080.json]
// Needs `npm run build`. Prints the job wall time, the tracer's own seconds, the denoise seconds and what actually ran.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const samples = Number(optionValue('--samples', '16'));
const denoisers = optionValue('--denoisers', 'oidn,wavelet').split(',');
const outputPath = optionValue('--out', 'artifacts/denoise-1080.json');

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const directory = await mkdtemp(join(tmpdir(), 'crucible-denoise-1080-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '256', '--jobs', join(directory, 'jobs')], cwd: resolve('.'), stderr: 'pipe' });
const client = new Client({ name: 'crucible-denoise-1080', version: '1' });
const call = (name, argumentsValue) => client.callTool({ name, arguments: argumentsValue }, { timeout: 900000 });

async function finished(jobId) {
  for (;;) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(500);
  }
}

const results = {};
try {
  await client.connect(transport);
  const recipe = JSON.parse(await readFile('tests/fixtures/demo-room.recipe.json', 'utf8'));
  const sessionId = (await call('scene_create', { recipe })).structuredContent.sessionId;
  for (const denoise of denoisers) {
    const started = performance.now();
    const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'image', width: 1920, height: 1080, renderer: { type: 'pathTracer', samples, denoise } } });
    const record = await finished(submitted.structuredContent.jobId);
    const wallSeconds = (performance.now() - started) / 1000;
    const metrics = (await call('scene_render_result', { jobId: submitted.structuredContent.jobId })).structuredContent.metrics ?? record.metrics;
    const report = metrics.pathTracer;
    results[denoise] = { state: record.state, samples, wallSeconds: Number(wallSeconds.toFixed(1)), tracedSeconds: Number(report.tracedSeconds.toFixed(1)), reportSeconds: Number(report.seconds.toFixed(1)), denoiseSeconds: report.denoiseSeconds === undefined ? null : Number(report.denoiseSeconds.toFixed(1)), ranDenoiser: report.denoiser, note: report.denoiserNote ?? null };
    console.log(denoise, JSON.stringify(results[denoise]));
    await call('scene_render_release', { jobId: submitted.structuredContent.jobId });
  }
} finally {
  await client.close();
}
await writeFile(outputPath, JSON.stringify(results, null, 1));

// One MCP image render job of a recipe with settings.renderer.backend set, timed from submit to completed. Run it through gpu-lock.
//   node bench/native-tracer/job.mjs <output directory> --backend native|gpu|cpu [--recipe tests/fixtures/demo-room.recipe.json]
//     [--samples 64] [--width 1920] [--height 1080] [--label run1] [--denoise true]
// Writes job-<label>.png and job-<label>.json (seconds, the metrics.pathTracer report and the job state).
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const backend = valueAfter('--backend', 'native');
const label = valueAfter('--label', 'run1');
const width = Number(valueAfter('--width', 1920));
const height = Number(valueAfter('--height', 1080));
const samples = Number(valueAfter('--samples', 64));
const denoise = JSON.parse(valueAfter('--denoise', 'true'));
const recipePath = valueAfter('--recipe', 'tests/fixtures/demo-room.recipe.json');

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const workDirectory = await mkdtemp(join(tmpdir(), '67js-native-job-'));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('bin/67js-mcp.mjs'), '--backend', 'gpu', '--memory', '384', '--jobs', join(workDirectory, 'jobs')], cwd: workDirectory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
const client = new Client({ name: '67js-native-job-bench', version: '1' });

async function call(name, toolArguments = {}, timeout = 600000) {
  return client.callTool({ name, arguments: toolArguments }, { timeout });
}

try {
  await client.connect(transport);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  const created = (await call('scene_create', { recipe }, 600000)).structuredContent;
  const settings = { kind: 'image', width, height, renderer: { type: 'pathTracer', backend, samples, bounces: 8, denoise, maxSeconds: 600 } };
  const started = performance.now();
  const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: 0, settings });
  if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
  const { jobId } = submitted.structuredContent;
  let record;
  for (;;) {
    record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) break;
    await delay(100);
  }
  const jobSeconds = (performance.now() - started) / 1000;
  const result = (await call('scene_render_result', { jobId })).structuredContent;
  if (record.state === 'completed') await copyFile(result.artifacts[0].path, join(outputDirectory, `job-${label}.png`));
  const summary = { backend, label, width, height, samples, denoise, state: record.state, jobSeconds, pathTracer: (result.metrics ?? record.metrics)?.pathTracer, error: record.error };
  await writeFile(join(outputDirectory, `job-${label}.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary));
  await call('scene_render_release', { jobId });
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close();
}

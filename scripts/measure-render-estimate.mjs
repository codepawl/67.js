// Compares the render estimate with real jobs. Builds a small, a medium and a large scene, renders short previews of each through
// the MCP runtime and prints the estimate next to the measured time and memory as a table.
//   node scripts/measure-render-estimate.mjs [--backend gpu|cpu] [--json]
// On a shared machine run it through your GPU job lock, so it waits for a free card.
import { mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backendArgument = process.argv.indexOf('--backend');
const backend = backendArgument > 0 ? process.argv[backendArgument + 1] : 'gpu';
const printJson = process.argv.includes('--json');
// --asset <file.glb> adds an asset-heavy scene: ten copies of that model placed from the asset catalog.
const assetArgument = process.argv.indexOf('--asset');
const assetFile = assetArgument > 0 ? resolve(process.argv[assetArgument + 1]) : undefined;
const ASSET_COPIES = 10;

const SCENES = [
  { name: 'small', spheres: 3, segments: 16, rings: 10, pointLights: 1 },
  { name: 'medium', spheres: 120, segments: 32, rings: 20, pointLights: 4 },
  { name: 'large', spheres: 400, segments: 64, rings: 40, pointLights: 8, rasterOnly: true },
];

const JOBS = [
  { label: 'image 640x360', settings: { kind: 'image', width: 640, height: 360 } },
  { label: 'video 24f 480x270', settings: { kind: 'video', width: 480, height: 270, fps: 12, duration: 2 } },
  { label: 'path trace cpu 160x90', settings: { kind: 'image', width: 160, height: 90, renderer: { type: 'pathTracer', backend: 'cpu', samples: 16, bounces: 2, maxSeconds: 20 } } },
  { label: 'path trace gpu 256x144', settings: { kind: 'image', width: 256, height: 144, renderer: { type: 'pathTracer', backend: 'gpu', samples: 32, bounces: 3, maxSeconds: 20 } } },
];

function recipeFor({ spheres, segments, rings, pointLights }) {
  const columns = Math.ceil(Math.sqrt(spheres));
  const nodes = [{ id: 'floor', geometry: 'box', material: 'matte', translation: [0, -0.1, 0], scale: [columns * 1.2 + 4, 0.2, columns * 1.2 + 4] }];
  for (let index = 0; index < spheres; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    nodes.push({ id: `ball-${index}`, geometry: 'sphere', material: index % 2 ? 'matte' : 'glow', translation: [(column - columns / 2) * 1.2, 0.5, (row - columns / 2) * 1.2], scale: [0.5, 0.5, 0.5] });
  }
  const span = columns * 0.6 + 4;
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'sphere', type: 'sphere', segments, rings }],
    materials: [{ id: 'matte', color: [0.7, 0.7, 0.7], roughness: 0.6 }, { id: 'glow', color: [0.1, 0.3, 0.9], emission: 1 }],
    nodes,
    environment: { pointLights: Array.from({ length: pointLights }, (_, index) => ({ position: [index - pointLights / 2, 3, 2], intensity: 20, color: [1, 1, 1] })) },
    camera: { eye: [0, span * 0.5, span], target: [0, 0, 0], fov: 40 },
  };
}

const directory = await mkdtemp(join(tmpdir(), 'crucible-estimate-'));
const assetDirectory = join(directory, 'assets');
if (assetFile) {
  await mkdir(assetDirectory);
  await copyFile(assetFile, join(assetDirectory, basename(assetFile)));
}
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('bin/crucible-mcp.mjs'), '--backend', backend, '--memory', '256', '--jobs', join(directory, 'jobs'), ...(assetFile ? ['--assets', assetDirectory] : [])], cwd: directory, stderr: 'pipe' });
const client = new Client({ name: 'crucible-estimate-measure', version: '1' });

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function untilFinished(jobId) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    await delay(100);
  }
  throw new Error('Job did not finish within 300 seconds.');
}

const rows = [];
try {
  await client.connect(transport);
  const scenes = SCENES.map(scene => ({ scene, recipe: recipeFor(scene) }));
  if (assetFile) {
    const catalog = (await call('scene_asset_catalog')).structuredContent;
    const assetId = catalog.assets.find(asset => asset.name === basename(assetFile)).assetId;
    const copies = Array.from({ length: ASSET_COPIES }, (_, index) => ({ id: `copy-${index}`, translation: [index * 2 - ASSET_COPIES, 0, 0], asset: { id: assetId } }));
    scenes.push({ scene: { name: 'asset-heavy', rasterOnly: true }, recipe: {
      format: 'crucible.scene', schemaVersion: 1,
      geometries: [{ id: 'box', type: 'box' }], materials: [{ id: 'matte', color: [0.7, 0.7, 0.7], roughness: 0.6 }],
      nodes: [{ id: 'floor', geometry: 'box', material: 'matte', translation: [0, -0.1, 0], scale: [30, 0.2, 10] }, ...copies],
      camera: { eye: [0, 6, 16], target: [0, 1, 0], fov: 45 },
    } });
  }
  for (const { scene, recipe } of scenes) {
    const created = (await call('scene_create', { recipe }, 300000)).structuredContent;
    for (const job of JOBS.filter(job => !(scene.rasterOnly && job.settings.renderer))) {
      try {
        const started = performance.now();
        const submitted = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: job.settings })).structuredContent;
        const record = await untilFinished(submitted.jobId);
        const wallSeconds = (performance.now() - started) / 1000;
        const result = record.state === 'completed' ? (await call('scene_render_result', { jobId: submitted.jobId, response_format: 'detailed' })).structuredContent : undefined;
        rows.push({ scene: scene.name, job: job.label, state: record.state, reason: record.reason, wallSeconds, estimate: submitted.estimate, report: result?.metrics?.report, metrics: result?.metrics });
        if (result) await call('scene_render_release', { jobId: submitted.jobId });
      } catch (error) {
        rows.push({ scene: scene.name, job: job.label, state: 'error', reason: error.message });
      }
    }
    await call('scene_dispose', { sessionId: created.sessionId });
  }
} finally {
  await client.close();
}

if (printJson) console.log(JSON.stringify(rows, null, 2));
console.log('| scene | job | estimate s | model-only s | measured s | ratio | estimate MiB | measured MiB |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) {
  const measuredSeconds = row.metrics?.elapsedSeconds;
  const measuredMiB = row.report?.measured?.peakMemoryMiB;
  const ratio = row.estimate && measuredSeconds ? (row.estimate.seconds / measuredSeconds).toFixed(2) : '-';
  console.log(`| ${row.scene} | ${row.job} | ${row.estimate?.seconds ?? "-"} | ${row.estimate?.modelSeconds ?? "-"} | ${measuredSeconds?.toFixed(2) ?? row.state + ' ' + (row.reason ?? '')} | ${ratio} | ${row.estimate?.peakMemoryMiB ?? '-'} | ${measuredMiB ?? '-'} |`);
}

// Measures the four `quality` tiers of scene_render_submit on this machine, and checks that two budgets pick different tiers and meet
// them. One scene, one frame size, three runs per tier; the calls differ only in `quality`.
//   node bench/tiers/measure-quality.mjs [--backend gpu|cpu] [--runs 3] [--out bench/tiers/results/quality-tiers.json]
// Run it through the GPU lock (a GPU job lock that waits for a free card) so it waits for a free card.
// VRAM is the rise of the card's used memory over its idle value while a job runs (nvidia-smi, sampled every 100 ms); it counts
// every process on the card, so read it on an idle one. RAM is the job's sampled Node RSS plus browser heap (metrics.report).
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const argumentValue = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const backend = argumentValue('--backend', 'gpu');
const runs = Number(argumentValue('--runs', '3'));
const outputPath = argumentValue('--out', undefined);
const FRAME = { kind: 'image', width: 960, height: 540 };
const TIERS = ['draft', 'realtime', 'realtime-high', 'final'];
const execute = promisify(execFile);

function recipe() {
  const spheres = 120;
  const columns = Math.ceil(Math.sqrt(spheres));
  const nodes = [{ id: 'floor', geometry: 'box', material: 'matte', translation: [0, -0.1, 0], scale: [columns * 1.2 + 4, 0.2, columns * 1.2 + 4] }];
  for (let index = 0; index < spheres; index++) {
    nodes.push({ id: `ball-${index}`, geometry: 'sphere', material: index % 2 ? 'matte' : 'glow', translation: [((index % columns) - columns / 2) * 1.2, 0.5, (Math.floor(index / columns) - columns / 2) * 1.2], scale: [0.5, 0.5, 0.5] });
  }
  const span = columns * 0.6 + 4;
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }, { id: 'sphere', type: 'sphere', segments: 32, rings: 20 }],
    materials: [{ id: 'matte', color: [0.7, 0.7, 0.7], roughness: 0.6 }, { id: 'glow', color: [0.1, 0.3, 0.9], emission: 1 }],
    nodes,
    environment: { pointLights: Array.from({ length: 4 }, (_, index) => ({ position: [index - 2, 3, 2], intensity: 20, color: [1, 1, 1] })) },
    camera: { eye: [0, span * 0.5, span], target: [0, 0, 0], fov: 40 },
  };
}

async function cardMemoryMiB() {
  try {
    const { stdout } = await execute('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']);
    return Number(stdout.trim().split('\n')[0]);
  } catch {
    return undefined;
  }
}

const directory = await mkdtemp(join(tmpdir(), '67js-quality-'));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('bin/67js-mcp.mjs'), '--backend', backend, '--memory', '384', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
const client = new Client({ name: '67js-quality-measure', version: '1' });

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text);
  return result;
}

/** Runs one job, sampling the card while it works. Returns what was submitted, the record and the peak card memory rise. */
async function runJob(created, settings) {
  const idle = await cardMemoryMiB();
  let peak = idle;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const used = await cardMemoryMiB();
      if (used !== undefined && (peak === undefined || used > peak)) peak = used;
      await delay(100);
    }
  })();
  try {
    const submitted = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings })).structuredContent;
    const deadline = Date.now() + 600000;
    let record;
    while (Date.now() < deadline) {
      record = (await call('scene_render_status', { jobId: submitted.jobId })).structuredContent;
      if (['completed', 'cancelled', 'failed'].includes(record.state)) break;
      await delay(50);
    }
    const result = record.state === 'completed' ? (await call('scene_render_result', { jobId: submitted.jobId, response_format: 'detailed' })).structuredContent : undefined;
    if (result) await call('scene_render_release', { jobId: submitted.jobId });
    return { submitted, state: record.state, result, vramRiseMiB: idle === undefined ? undefined : peak - idle };
  } finally {
    sampling = false;
    await sampler;
  }
}

const median = values => {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
};

const output = { backend, frame: FRAME, runs, tiers: [], budgets: [] };
try {
  await client.connect(transport, { timeout: 240000 });
  const created = (await call('scene_create', { recipe: recipe() }, 300000)).structuredContent;
  output.capabilities = (await call('scene_capabilities', { topic: 'jobs' })).structuredContent?.value?.tiers;
  // One untimed final-tier job first, so the path tracer's one-time kernel compile is not counted in any tier.
  await runJob(created, { ...FRAME, quality: 'final' });
  await runJob(created, { ...FRAME, quality: 'realtime' });
  for (const quality of TIERS) {
    const samples = [];
    for (let run = 0; run < runs; run++) {
      const job = await runJob(created, { ...FRAME, quality });
      const measured = job.result?.metrics?.report?.measured;
      samples.push({ state: job.state, picked: job.submitted.quality?.picked, message: job.submitted.quality?.message, seconds: measured?.seconds,
        renderSeconds: job.result?.metrics?.renderSeconds, peakMemoryMiB: measured?.peakMemoryMiB, vramRiseMiB: job.vramRiseMiB });
    }
    output.tiers.push({ quality, samples,
      medianSeconds: median(samples.map(sample => sample.seconds)), medianPeakMemoryMiB: median(samples.map(sample => sample.peakMemoryMiB)),
      medianRenderSeconds: median(samples.map(sample => sample.renderSeconds)),
      peakVramRiseMiB: samples.every(sample => sample.vramRiseMiB !== undefined) ? Math.max(...samples.map(sample => sample.vramRiseMiB)) : undefined });
  }
  // Two budgets on the same scene. 30 frames a second is a render-speed budget over a 60 frame video; 60 s a frame is one still.
  const budgetCases = [
    { label: '30 fps', settings: { kind: 'video', width: 480, height: 270, fps: 30, duration: 2, budget: { framesPerSecond: 30 } }, limitSeconds: 1 / 30 },
    { label: '60 s per frame', settings: { ...FRAME, budget: { secondsPerFrame: 60 } }, limitSeconds: 60 },
  ];
  for (const { label, settings, limitSeconds } of budgetCases) {
    const job = await runJob(created, settings);
    const measured = job.result?.metrics?.report?.measured;
    const frames = measured?.frames ?? 1;
    const perFrameRender = job.result?.metrics?.renderSeconds === undefined ? undefined : (job.result.metrics.renderSeconds + (job.result.metrics.captureSeconds ?? 0)) / frames;
    const perFrame = settings.budget.framesPerSecond ? perFrameRender : measured?.secondsPerFrame;
    output.budgets.push({ label, limitSeconds, picked: job.submitted.budget.picked, fits: job.submitted.budget.fits, state: job.state, measuredSecondsPerFrame: perFrame,
      meetsBudget: perFrame !== undefined && perFrame <= limitSeconds });
  }
  await call('scene_dispose', { sessionId: created.sessionId });
} finally {
  await client.close();
}

const json = JSON.stringify(output, null, 2);
if (outputPath) await writeFile(outputPath, `${json}\n`);
console.log(json);
console.log('\n| tier | ran as | job time (s, median) | frame draw or trace (s, median) | RAM (MiB, median) | VRAM rise (MiB, largest of runs) |\n| --- | --- | --- | --- | --- | --- |');
for (const tier of output.tiers) console.log(`| ${tier.quality} | ${tier.samples[0].picked} | ${tier.medianSeconds} | ${tier.medianRenderSeconds} | ${tier.medianPeakMemoryMiB} | ${tier.peakVramRiseMiB ?? 'n/a'} |`);
console.log('\n| budget | picked tier | measured s per frame | limit | meets |\n| --- | --- | --- | --- | --- |');
for (const budget of output.budgets) console.log(`| ${budget.label} | ${budget.picked?.tier} (${budget.picked?.label}) | ${budget.measuredSecondsPerFrame} | ${budget.limitSeconds.toFixed(4)} | ${budget.meetsBudget} |`);

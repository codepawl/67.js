// Checks that a render budget picks settings that meet it. Builds a small and a medium scene, submits a still with a tight, a
// middle and a loose budget through the MCP runtime, and prints what each budget picked beside the measured time per frame.
//   node scripts/measure-render-budget.mjs [--backend gpu|cpu] [--json]
// On a shared machine run it through your GPU job lock, so it waits for a free card.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backendArgument = process.argv.indexOf('--backend');
const backend = backendArgument > 0 ? process.argv[backendArgument + 1] : 'gpu';
const printJson = process.argv.includes('--json');

const SCENES = [
  { name: 'small', spheres: 3, segments: 16, rings: 10, pointLights: 1 },
  { name: 'medium', spheres: 120, segments: 32, rings: 20, pointLights: 4 },
];
const BUDGETS = [
  { label: 'tight', budget: { secondsPerFrame: 0.8 } },
  { label: 'middle', budget: { secondsPerFrame: 6 } },
  { label: 'loose', budget: { secondsPerFrame: 40 } },
  { label: 'realtime', budget: { framesPerSecond: 30 }, frame: { kind: 'video', width: 480, height: 270, fps: 30, duration: 2 } },
];
const FRAME = { kind: 'image', width: 480, height: 270 };

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

const directory = await mkdtemp(join(tmpdir(), 'crucible-budget-'));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('bin/crucible-mcp.mjs'), '--backend', backend, '--memory', '256', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
const client = new Client({ name: 'crucible-budget-measure', version: '1' });

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
  await client.connect(transport, { timeout: 240000 });
  for (const scene of SCENES) {
    const created = (await call('scene_create', { recipe: recipeFor(scene) }, 300000)).structuredContent;
    for (const { label, budget, frame = FRAME } of BUDGETS) {
      try {
        const submitted = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: { ...frame, budget } })).structuredContent;
        const record = await untilFinished(submitted.jobId);
        const result = record.state === 'completed' ? (await call('scene_render_result', { jobId: submitted.jobId, response_format: 'detailed' })).structuredContent : undefined;
        rows.push({ scene: scene.name, label, budget, limit: submitted.budget.requested.secondsPerFrame, picked: submitted.budget.picked, fits: submitted.budget.fits, reason: submitted.budget.reason, state: record.state, measured: result?.metrics?.report?.measured });
        if (result) await call('scene_render_release', { jobId: submitted.jobId });
      } catch (error) {
        rows.push({ scene: scene.name, label, budget, state: 'error', reason: error.message });
      }
    }
    await call('scene_dispose', { sessionId: created.sessionId });
  }
} finally {
  await client.close();
}

if (printJson) console.log(JSON.stringify(rows, null, 2));
console.log('| scene | budget s/frame | picked | size | expected s | measured s | meets | says fits |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of rows) {
  const measuredSeconds = row.measured?.secondsPerFrame;
  const meets = measuredSeconds === undefined ? row.state : measuredSeconds <= row.limit ? 'yes' : 'no';
  console.log(`| ${row.scene} | ${row.limit} (${row.label}) | ${row.picked?.label ?? row.reason} | ${row.picked ? `${row.picked.width}x${row.picked.height}` : '-'} | ${row.picked?.expected.secondsPerFrame ?? '-'} | ${measuredSeconds ?? '-'} | ${meets} | ${row.fits ?? '-'} |`);
}

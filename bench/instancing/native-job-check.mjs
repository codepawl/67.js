// A real native render job through the MCP runtime and a headless browser, to see which path the scene took.
//   node bench/instancing/native-job-check.mjs run <repeated|distinct> <output folder> [samples] [mcp entry]
//     Starts the MCP server (JS67_NATIVE_INSTANCING in the environment is passed on), creates the scene, submits one
//     native path-traced image job, and writes <scene>.png and <scene>.json (the job report, the PNG digest and the
//     card memory in use before and during the job, from nvidia-smi).
//   node bench/instancing/native-job-check.mjs compare <candidate.png> <reference.png>
//     Mean ratio, relative MSE (epsilon 0.01) and 8x8 tiles within 5 percent between two job images (8-bit, sRGB).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { recipeFor } from './native-job-scenes.mjs';
import { meanRatioRgb, relativeMeanSquaredError, tileMeanRatios } from './image-compare.mjs';

const WIDTH = 160;
const HEIGHT = 120;

function cardMemoryMiB() {
  const answer = spawnSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  return answer.status === 0 ? Number(answer.stdout.split('\n')[0]) : null;
}

async function run(scene, outputFolder, samples, entry) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const workFolder = mkdtempSync(join(tmpdir(), 'crucible-native-job-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(entry), '--backend', 'gpu', '--memory', '192', '--jobs', join(workFolder, 'jobs'), ...(process.env.CHROME_PATH ? ['--browser', process.env.CHROME_PATH] : [])],
    cwd: workFolder, env: { ...process.env }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
  const client = new Client({ name: 'crucible-native-job-check', version: '1' });
  await client.connect(transport);
  const call = async (name, argumentsValue) => {
    const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 60000 });
    if (result.isError) throw new Error(`${name}: ${result.content?.find(item => item.type === 'text')?.text}`);
    return result.structuredContent ?? result;
  };
  try {
    const created = await call('scene_create', { recipe: recipeFor(scene) });
    const baseline = cardMemoryMiB();
    let peak = baseline;
    const sampler = setInterval(() => { peak = Math.max(peak ?? 0, cardMemoryMiB() ?? 0); }, 150);
    const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: {
      kind: 'image', width: WIDTH, height: HEIGHT,
      renderer: { type: 'pathTracer', backend: 'native', samples, bounces: 4, denoise: false, seed: 1, maxSeconds: 300 },
    } });
    let record;
    for (let attempt = 0; attempt < 1200; attempt++) {
      record = await call('scene_render_status', { jobId: submitted.jobId });
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(record.state)) break;
      await delay(500);
    }
    clearInterval(sampler);
    if (record.state !== 'completed') throw new Error(`job ${record.state}: ${record.reason ?? ''} ${diagnostics}`);
    const result = await call('scene_render_result', { jobId: submitted.jobId });
    const artifact = result.artifacts[0];
    const bytes = readFileSync(artifact.path);
    mkdirSync(outputFolder, { recursive: true });
    writeFileSync(join(outputFolder, `${scene}.png`), bytes);
    const summary = { scene, instancingEnvironment: process.env.JS67_NATIVE_INSTANCING ?? 'default', samples,
      pngSha256: createHash('sha256').update(bytes).digest('hex'), cardMemoryMiB: { before: baseline, peak },
      report: result.metrics?.pathTracer };
    writeFileSync(join(outputFolder, `${scene}.json`), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    await client.close();
  }
}

async function compare(candidatePath, referencePath) {
  const { default: sharp } = await import('sharp');
  const decode = async path => {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { pixels: Float32Array.from(data, value => value / 255), width: info.width, height: info.height };
  };
  const candidate = await decode(candidatePath);
  const reference = await decode(referencePath);
  const pixelCount = candidate.width * candidate.height;
  const ratios = tileMeanRatios(candidate.pixels, reference.pixels, candidate.width, candidate.height, 8);
  console.log(JSON.stringify({
    meanRatioRgb: meanRatioRgb(candidate.pixels, reference.pixels, pixelCount).map(value => Number(value.toFixed(4))),
    relativeMse: Number(relativeMeanSquaredError(candidate.pixels, reference.pixels, pixelCount, 0.01).toPrecision(3)),
    tilesWithin5Percent: ratios.filter(ratio => Math.abs(ratio - 1) <= 0.05).length,
    eligibleTiles: ratios.length,
  }));
}

const [command, first, second, third, fourth] = process.argv.slice(2);
if (command === 'run' && (first === 'repeated' || first === 'distinct') && second) {
  await run(first, second, Number(third ?? 1024), fourth ?? 'bin/crucible-mcp.mjs');
} else if (command === 'compare' && first && second) {
  await compare(first, second);
} else {
  throw new RangeError('Usage: run <repeated|distinct> <output folder> [samples] [mcp entry], or compare <candidate.png> <reference.png>.');
}

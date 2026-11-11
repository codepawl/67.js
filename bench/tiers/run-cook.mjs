// Cook (the path tracer) with the cpu, gpu (WebGL2) and webgpu backends on a reference scene, at a ladder of sample counts, in headless Chrome.
//   [bash ~/.agents/tools/gpu-lock.sh] node bench/tiers/run-cook.mjs <output directory> <scene> --backend cpu|gpu|webgpu --samples 16,64,256 [--repetitions 3] [--width 960] [--height 540] [--threads 8]
// Files: <scene>-cook-<backend>-s<samples>-r<n>.npy (linear RGB float32, rows from the top, as the Cycles script writes) and .json (the tracer's report,
// wall time, and the card memory polled around the trace). Settings: 8 bounces, seed 1, no denoiser, fireflyClamp 1e9, noiseThreshold 0.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFloat32Npy } from '../cycles-parity/npy.mjs';

const runFile = promisify(execFile);
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SERVER_PORT = 5350;
const argumentsGiven = process.argv.slice(2);
const valueAfter = (flag, fallback) => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneId = argumentsGiven[1];
const backend = valueAfter('--backend', 'gpu');
const sampleLadder = valueAfter('--samples', '16,64,256').split(',').map(Number);
const repetitions = Number(valueAfter('--repetitions', 3));
const width = Number(valueAfter('--width', 960));
const height = Number(valueAfter('--height', 540));
const threads = Number(valueAfter('--threads', 8));
// A driver that interleaves engines calls this once per repetition with --repetitions 1; this sets the number in the file names.
const firstRepetition = Number(valueAfter('--first-repetition', 1));
const seedGiven = argumentsGiven.includes('--seed');
const seed = Number(valueAfter('--seed', 1));

async function cardState() {
  const { stdout } = await runFile('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits']);
  const [memoryMebibytes, utilizationPercent] = stdout.trim().split(',').map(Number);
  return { memoryMebibytes, utilizationPercent };
}

async function withCardPolling(work) {
  const before = await cardState();
  let peakMemory = before.memoryMebibytes;
  let peakUtilization = before.utilizationPercent;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const state = await cardState();
      peakMemory = Math.max(peakMemory, state.memoryMebibytes);
      peakUtilization = Math.max(peakUtilization, state.utilizationPercent);
    }
  })();
  const result = await work();
  polling = false;
  await poller;
  return { result, card: { beforeMebibytes: before.memoryMebibytes, peakMebibytes: peakMemory, deltaMebibytes: peakMemory - before.memoryMebibytes, utilizationBeforePercent: before.utilizationPercent, utilizationPeakPercent: peakUtilization } };
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: SERVER_PORT, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'],
});
try {
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const samples of sampleLadder) {
      const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
      page.setDefaultTimeout(0);
      page.on('pageerror', error => console.log('PAGE ERROR', error.message));
      await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
      await page.waitForFunction(() => window.referenceInternals, null, { timeout: 180000 });
      await page.addScriptTag({ type: 'module', url: '/bench/tiers/page.js' });
      await page.waitForFunction(() => window.renderCookScene, null, { timeout: 60000 });
      const options = { width, height, samples, backend, threads, seed };
      const { result, card } = await withCardPolling(() => page.evaluate(([id, tracerOptions]) => window.renderCookScene(id, tracerOptions), [sceneId, options]));
      const label = repetition + firstRepetition - 1;
      // One Cook trace is limited in size ("too much ray work" above about 256 samples at 960 by 540 and 8 bounces), so a larger sample
      // count is several traces with different seeds that score-tiers.py averages; those files carry the seed instead of the repetition.
      const prefix = seedGiven ? `${outputDirectory}/${sceneId}-cook-${backend}-s${samples}-seed${seed}` : `${outputDirectory}/${sceneId}-cook-${backend}-s${samples}-r${label}`;
      const bytes = Buffer.from(result.linear, 'base64');
      const pixels = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      await writeFloat32Npy(`${prefix}.npy`, new Float32Array(pixels), [height, width, 3]);
      await writeFile(`${prefix}.json`, JSON.stringify({ sceneId, backend, samples, repetition, width, height, threads, wallSeconds: result.wallSeconds, report: result.report, card }, null, 1));
      console.log(backend, `s${samples}`, `r${repetition}`, `traced ${result.report.tracedSeconds.toFixed(2)} s`, `compile ${(result.report.gpuCompileSeconds ?? 0).toFixed(2)} s`, `card +${card.deltaMebibytes} MiB util ${card.utilizationPeakPercent}%`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

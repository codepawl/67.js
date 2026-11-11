// The experimental real-time path tracer (src/path-tracer-realtime*.js, not reachable from MCP) at rest: median frame time and checkpoints of the
// accumulated picture, to find how long it takes to get under a FLIP bound. This is not the realtime-high tier (#902), which does not exist yet.
//   [bash ~/.agents/tools/gpu-lock.sh] node bench/tiers/run-settle.mjs <output directory> <scene> --backend gpu|webgpu [--width 1920] [--height 1080] [--bounces 2] [--frames 256]
// Files: <scene>-<backend>-<width>.json and <scene>-<backend>-<width>-f<frame>.png, scored by score-tiers.py settle.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const runFile = promisify(execFile);
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SERVER_PORT = 5360;
const argumentsGiven = process.argv.slice(2);
const valueAfter = (flag, fallback) => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneId = argumentsGiven[1];
const backend = valueAfter('--backend', 'webgpu');
const width = Number(valueAfter('--width', 1920));
const height = Number(valueAfter('--height', 1080));
const bounces = Number(valueAfter('--bounces', 2));
const frames = Number(valueAfter('--frames', 256));
const checkpointFrames = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512].filter(frame => frame <= frames);

async function cardState() {
  const { stdout } = await runFile('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits']);
  const [memoryMebibytes, utilizationPercent] = stdout.trim().split(',').map(Number);
  return { memoryMebibytes, utilizationPercent };
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
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.setDefaultTimeout(0);
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.loadTraceSceneFor, null, { timeout: 180000 });
  await page.addScriptTag({ type: 'module', url: '/bench/tiers/page.js' });
  await page.waitForFunction(() => window.settleRealtimeTracer, null, { timeout: 60000 });
  const before = await cardState();
  let peakMemory = before.memoryMebibytes;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      peakMemory = Math.max(peakMemory, (await cardState()).memoryMebibytes);
    }
  })();
  const options = { width, height, bounces, resolutionDivisor: 2, backend };
  const summary = await page.evaluate(([id, tracerOptions, checkpoints]) => window.settleRealtimeTracer(id, tracerOptions, checkpoints), [sceneId, options, checkpointFrames]);
  polling = false;
  await poller;
  const base = `${outputDirectory}/${sceneId}-${backend}-${width}`;
  for (const checkpoint of summary.checkpoints) {
    await writeFile(`${base}-f${checkpoint.frame}.png`, Buffer.from(checkpoint.image, 'base64'));
  }
  const checkpoints = summary.checkpoints.map(({ image: _image, ...rest }) => rest);
  await writeFile(`${base}.json`, JSON.stringify({ ...summary, checkpoints, requestedBackend: backend, options, card: { beforeMebibytes: before.memoryMebibytes, peakMebibytes: peakMemory, deltaMebibytes: peakMemory - before.memoryMebibytes, utilizationBeforePercent: before.utilizationPercent } }, null, 1));
  console.log(backend, `drawn with ${summary.backend}`, summary.fallbackReason ?? '', `median ${summary.medianFrameMilliseconds.toFixed(2)} ms`, checkpoints.map(entry => `f${entry.frame}@${entry.elapsedSeconds.toFixed(2)}s`).join(' '));
} finally {
  await browser.close();
  await server.close();
}

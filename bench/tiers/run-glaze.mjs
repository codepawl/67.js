// Draws reference scenes with the Glaze tiers (draft, realtime) in headless Chrome on the GPU and records frame times, memory and PNGs.
//   [${GPU_LOCK}] node bench/tiers/run-glaze.mjs <output directory> <scene,scene> [--width 960] [--height 540] [--repetitions 3] [--frames 10] [--tiers draft,realtime]
// Each repetition runs every scene and tier once on a fresh page, in an order that alternates between repetitions.
// Files: <scene>-<tier>-r<n>.png and glaze.json. The card's memory is polled with nvidia-smi around each draw (card wide, so it includes other jobs).
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { DIAGNOSTIC_TIERS, DRAFT_TIER, REALTIME_TIER } from './tiers.mjs';

const runFile = promisify(execFile);
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SERVER_PORT = 5340;
const TIERS = { draft: DRAFT_TIER, realtime: REALTIME_TIER, ...DIAGNOSTIC_TIERS };
const argumentsGiven = process.argv.slice(2);
const valueAfter = (flag, fallback) => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneIds = argumentsGiven[1].split(',');
const width = Number(valueAfter('--width', 960));
const height = Number(valueAfter('--height', 540));
const repetitions = Number(valueAfter('--repetitions', 3));
const frameCount = Number(valueAfter('--frames', 10));
const tierNames = valueAfter('--tiers', 'draft,realtime').split(',');
// A driver that interleaves engines calls this once per repetition with --repetitions 1; this sets the number in the file names.
const firstRepetition = Number(valueAfter('--first-repetition', 1));

async function cardState() {
  const { stdout } = await runFile('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits']);
  const [memoryMebibytes, utilizationPercent] = stdout.trim().split(',').map(Number);
  return { memoryMebibytes, utilizationPercent };
}

// Polls the card every 100 ms while `work` runs; returns the work's result with the card memory before and at the peak.
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
const server = await createServer({ server: { host: '127.0.0.1', port: SERVER_PORT, strictPort: false, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-renderer-backgrounding'],
});
const runs = [];
try {
  for (let repetition = firstRepetition; repetition < firstRepetition + repetitions; repetition++) {
    const orderedTiers = repetition % 2 ? tierNames : [...tierNames].reverse();
    for (const sceneId of sceneIds) {
      for (const tierName of orderedTiers) {
        const page = await browser.newPage({ viewport: { width, height } });
        page.on('pageerror', error => console.log('PAGE ERROR', error.message));
        await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
        await page.waitForFunction(() => window.referenceInternals, null, { timeout: 180000 });
        await page.addScriptTag({ type: 'module', url: '/bench/tiers/page.js' });
        await page.waitForFunction(() => window.renderTierScene, null, { timeout: 60000 });
        const { result, card } = await withCardPolling(() => page.evaluate(([id, tier, count]) => window.renderTierScene(id, tier, count), [sceneId, TIERS[tierName], frameCount]));
        await writeFile(`${outputDirectory}/${sceneId}-${tierName}-${width}-r${repetition}.png`, Buffer.from(result.image, 'base64'));
        const { image: _image, ...record } = result;
        runs.push({ repetition, width, height, tierName, card, ...record });
        console.log(sceneId, tierName, `r${repetition}`, `first ${result.firstFrameMilliseconds.toFixed(1)} ms`, `median ${result.medianFrameMilliseconds.toFixed(2)} ms`, `throughput ${result.throughputMilliseconds.toFixed(2)} ms`, `canvas ${result.canvasWidth}x${result.canvasHeight}`, `card +${card.deltaMebibytes} MiB`, `util ${card.utilizationPeakPercent}%`);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
await writeFile(`${outputDirectory}/glaze-${width}.json`, JSON.stringify({ width, height, frameCount, repetitions, runs }, null, 1));

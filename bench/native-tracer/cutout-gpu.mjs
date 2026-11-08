// The cutout scene of cutout.mjs on the browser's gpu (WebGL2) or webgpu backend, for the FLIP comparison with the native render.
//   node bench/native-tracer/cutout-gpu.mjs <output directory> [--backend gpu|webgpu] [--leaves 300] [--samples 64] [--width 640] [--height 360]
// Writes cutout-<backend>.png. Run it through a gpu-lock job.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const backend = valueAfter('--backend', 'gpu');
const leafCount = Number(valueAfter('--leaves', 300));
const options = { width: Number(valueAfter('--width', 640)), height: Number(valueAfter('--height', 360)), samples: Number(valueAfter('--samples', 64)),
  bounces: 4, seed: 0, fireflyClamp: 20, backend };
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.setDefaultTimeout(0);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/bench/reference/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.renderCutoutScene, null, { timeout: 180000 });
  const started = performance.now();
  const { image, report } = await page.evaluate(([count, given]) => window.renderCutoutScene(count, given), [leafCount, options]);
  await writeFile(`${outputDirectory}/cutout-${backend}.png`, Buffer.from(image, 'base64'));
  console.log(JSON.stringify({ backend, seconds: (performance.now() - started) / 1000, report }).slice(0, 400));
} finally {
  await browser.close();
  await server.close();
}

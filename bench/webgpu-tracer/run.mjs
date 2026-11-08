// One timed trace of the demo room with one backend, in a headless Chrome whose profile persists per backend (so the first
// run in a fresh profile is the cold compile and later runs are warm). On a shared card, run it through a GPU job queue.
//   node bench/webgpu-tracer/run.mjs <output directory> <webgl|webgpu> [--samples 64] [--width 1920] [--height 1080] [--label run1]
// Writes <variant>-<label>.png and <variant>-<label>.json; the profile lives in <output directory>/profile-<variant>.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);
const variant = argumentsGiven[1];

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const options = {
  width: Number(valueAfter('--width', 1920)),
  height: Number(valueAfter('--height', 1080)),
  samples: Number(valueAfter('--samples', 64)),
  bounces: 8,
  seed: 0,
  fireflyClamp: 20,
};
const label = valueAfter('--label', 'run1');

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const context = await chromium.launchPersistentContext(`${outputDirectory}/profile-${variant}`, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 960, height: 540 },
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.on('console', message => { if (message.text().startsWith('WEBGPU ERROR')) console.log(message.text()); });
  page.setDefaultTimeout(0);
  await page.goto(`${serverUrl}/bench/webgpu-tracer/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.harnessReady, null, { timeout: 180000 });
  const recipe = JSON.parse(await readFile('tests/fixtures/demo-room.recipe.json', 'utf8'));
  const scene = await page.evaluate(([sceneRecipe, width, height]) => window.prepareScene(sceneRecipe, width, height), [recipe, options.width, options.height]);
  const result = await page.evaluate(([name, tracerOptions]) => (name === 'webgl' ? window.traceWithWebGl(tracerOptions) : window.traceWithWebGpu(tracerOptions)), [variant, options]);
  const { image, ...numbers } = result;
  await writeFile(`${outputDirectory}/${variant}-${label}.png`, Buffer.from(image, 'base64'));
  const record = { variant, label, ...options, ...scene, ...numbers };
  record.pathsPerSecond = (options.width * options.height * options.samples) / record.tracedSeconds;
  await writeFile(`${outputDirectory}/${variant}-${label}.json`, JSON.stringify(record, null, 1));
  console.log(JSON.stringify(record));
} finally {
  await context.close();
  await server.close();
}

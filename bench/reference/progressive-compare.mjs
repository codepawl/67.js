// Draws reference scenes progressively (issue #623) and measures the time against the 64 sample still.
//   node bench/reference/progressive-compare.mjs <output directory> <scene id or recipe.json>,... [--variant random|blue|importance|tree|both]
//     [--checkpoints 1,2,4,8,16,32,64] [--width 960] [--height 540] [--still] [--frames 200]
// Files are <scene>@<variant>-<samples>.png, <scene>@still-64.png and timings.json; bench/reference/progressive-score.py scores them against Cycles.
// With --frames the script also prints the median time of one full size sample (1 sample per pixel) for each scene.
// Run it behind a GPU lock when other jobs share the GPU: it takes the whole GPU for seconds at a time.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneIds = argumentsGiven[1].split(',');
const recipeName = id => id.replace(/^.*[\/]/, '').replace(/\.recipe\.json$|\.json$/, '');

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const VARIANT_OPTIONS = {
  random: {},
  blue: { samplingPattern: 'blue-noise-first' },
  importance: { lightSelection: 'importance' },
  tree: { lightSelection: 'tree' },
  both: { samplingPattern: 'blue-noise-first', lightSelection: 'importance' },
};
const variantNames = valueAfter('--variant', 'random').split(',');
const checkpoints = valueAfter('--checkpoints', '1,2,4,8,16,32,64').split(',').map(Number);
const frameCount = Number(valueAfter('--frames', 0));
const baseOptions = {
  width: Number(valueAfter('--width', 960)),
  height: Number(valueAfter('--height', 540)),
  bounces: Number(valueAfter('--bounces', 8)),
  denoise: !argumentsGiven.includes('--no-denoise'),
  maxSeconds: 1800,
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const timings = {};
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.setDefaultTimeout(0);
  await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.renderProgressiveCheckpoints, null, { timeout: 180000 });
  for (const id of sceneIds) {
    const isRecipe = id.endsWith('.json');
    const source = isRecipe ? JSON.parse(await readFile(id, 'utf8')) : id;
    const name = isRecipe ? recipeName(id) : id;
    if (argumentsGiven.includes('--still')) {
      const still = await page.evaluate(([scene, options]) => (typeof scene === 'string' ? window.renderReferencePathTraced(scene, options) : window.renderRecipePathTraced(scene, options)), [source, { ...baseOptions, samples: 64, backend: 'gpu' }]);
      await writeFile(`${outputDirectory}/${name}@still-64.png`, Buffer.from(still.image, 'base64'));
      timings[`${name}:still-64`] = { seconds: Number(still.report.seconds.toFixed(2)), tracedSeconds: Number(still.report.tracedSeconds.toFixed(2)), compileSeconds: still.report.gpuCompileSeconds };
      console.log(name, 'still-64', JSON.stringify(timings[`${name}:still-64`]));
    }
    for (const variant of variantNames) {
      const options = { ...baseOptions, ...VARIANT_OPTIONS[variant] };
      const { results, report } = await page.evaluate(([scene, tracerOptions, counts]) => window.renderProgressiveCheckpoints(scene, tracerOptions, counts), [source, options, checkpoints]);
      for (const result of results) {
        await writeFile(`${outputDirectory}/${name}@${variant}-${result.samples}.png`, Buffer.from(result.image, 'base64'));
        timings[`${name}:${variant}:${result.samples}`] = { stepSeconds: Number(result.stepSeconds.toFixed(3)), snapshotSeconds: Number(result.snapshotSeconds.toFixed(3)), setupSeconds: Number(report.setupSeconds.toFixed(2)), compileSeconds: Number(report.compileSeconds.toFixed(2)) };
      }
      console.log(name, variant, results.map(result => `${result.samples}:${result.stepSeconds.toFixed(2)}s`).join(' '));
      if (frameCount > 0) {
        const frame = await page.evaluate(([scene, tracerOptions, frames]) => window.measureProgressiveFrameTime(scene, tracerOptions, frames), [source, options, frameCount]);
        timings[`${name}:${variant}:frame`] = frame;
        console.log(name, variant, 'frame', JSON.stringify(frame));
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
let previous = {};
try {
  previous = JSON.parse(await readFile(`${outputDirectory}/timings.json`, 'utf8'));
} catch {
  // first run in this directory
}
await writeFile(`${outputDirectory}/timings.json`, JSON.stringify({ ...previous, ...timings }, null, 1));

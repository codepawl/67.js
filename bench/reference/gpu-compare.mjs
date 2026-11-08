// Draws reference scenes with the path tracer on the CPU and on the GPU, same seed, and writes the images and timings.
//   node bench/reference/gpu-compare.mjs <output directory> <scene id>,<scene id> [--samples 64] [--backend cpu|gpu|webgpu|both]
//     [--width 960] [--height 540] [--bounces 8] [--no-denoise] [--threads 8]
// Files are <scene>-pathtracer-<backend>.png and timings.json. Run it through the GPU lock script (gpu-lock.sh): the GPU
// backend takes the whole GPU for seconds at a time.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneIds = argumentsGiven[1].split(',');
// An id ending in .json is a scene recipe file, drawn like an agent render job (for example tests/fixtures/demo-room.recipe.json).
const recipeName = id => id.replace(/^.*[\/]/, '').replace(/\.recipe\.json$|\.json$/, '');

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const backendChoice = valueAfter('--backend', 'both');
const backends = backendChoice === 'both' ? ['gpu', 'cpu'] : [backendChoice];
const options = {
  width: Number(valueAfter('--width', 960)),
  height: Number(valueAfter('--height', 540)),
  samples: Number(valueAfter('--samples', 64)),
  bounces: Number(valueAfter('--bounces', 8)),
  threads: Number(valueAfter('--threads', 8)),
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
  await page.waitForFunction(() => window.renderReferencePathTraced, null, { timeout: 180000 });
  for (const id of sceneIds) {
    for (const backend of backends) {
      const isRecipe = id.endsWith('.json');
      const recipe = isRecipe ? JSON.parse(await readFile(id, 'utf8')) : null;
      const name = isRecipe ? recipeName(id) : id;
      let result;
      try {
        result = isRecipe
          ? await page.evaluate(([sceneRecipe, tracerOptions]) => window.renderRecipePathTraced(sceneRecipe, tracerOptions), [recipe, { ...options, backend }])
          : await page.evaluate(([sceneId, tracerOptions]) => window.renderReferencePathTraced(sceneId, tracerOptions), [id, { ...options, backend }]);
      } catch (error) {
        // The webgpu backend names the scene features it does not trace; record that and go on with the next scene.
        if (backend !== 'webgpu' || !/does not trace/.test(error.message)) throw error;
        timings[`${name}:${backend}`] = { unsupported: error.message.replace(/^.*Error: /, '') };
        console.log(name, backend, 'unsupported:', error.message.split('\n')[0]);
        continue;
      }
      await writeFile(`${outputDirectory}/${name}-pathtracer-${backend}.png`, Buffer.from(result.image, 'base64'));
      const { seconds, tracedSeconds, samples, triangles, gpu, gpuCompileSeconds } = result.report;
      timings[`${name}:${backend}`] = { seconds: Number(seconds.toFixed(2)), tracedSeconds: Number(tracedSeconds.toFixed(2)), samples, triangles, gpu, compileSeconds: gpuCompileSeconds };
      console.log(name, backend, JSON.stringify(timings[`${name}:${backend}`]));
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

// Runs the OIDN network of the `denoiser` npm package (tensorflow.js) in Chrome on the captures of denoise-capture.mjs and writes
// tfjs.f32 beside them. It uses the GPU, so start it through the shared GPU lock:
//   (cd artifacts/tfjs-denoiser && npm install denoiser)       # not a dependency of Crucible: a scratch install
//   bash ~/.agents/tools/gpu-lock.sh node bench/reference/denoise-browser.mjs [--backend webgl|webgpu] [--samples 8,16] [--scenes a,b]
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const WIDTH = 960;
const HEIGHT = 540;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const rootDirectory = resolve(optionValue('--directory', 'artifacts/denoise'));
const packageDirectory = resolve(optionValue('--package', 'artifacts/tfjs-denoiser/node_modules/denoiser'));
const backend = optionValue('--backend', 'webgl');
const quality = optionValue('--quality', 'high');
const sampleFilter = optionValue('--samples', '').split(',').filter(Boolean);
const sceneFilter = optionValue('--scenes', '').split(',').filter(Boolean);

const server = await createServer({
  root: resolve('bench/reference/denoise-browser'),
  publicDir: packageDirectory,
  resolve: { alias: { denoiser: `${packageDirectory}/dist/index.mjs` } },
  server: { host: '127.0.0.1', port: 0, fs: { strict: false } },
  logLevel: 'warn',
});
await server.listen();
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=d3d11'],
});
const timings = {};
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  page.on('console', message => console.log('PAGE', message.text().slice(0, 200)));
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/index.html`);
  await page.waitForFunction(() => window.denoiseReady);
  for (const scene of await readdir(rootDirectory, { withFileTypes: true })) {
    if (!scene.isDirectory() || (sceneFilter.length && !sceneFilter.includes(scene.name))) continue;
    for (const sample of await readdir(`${rootDirectory}/${scene.name}`, { withFileTypes: true })) {
      if (!sample.isDirectory() || (sampleFilter.length && !sampleFilter.includes(sample.name))) continue;
      const directory = `${rootDirectory}/${scene.name}/${sample.name}`;
      const [color, albedo, normal] = await Promise.all(['color', 'albedo', 'normal'].map(async name => (await readFile(`${directory}/${name}.f32`)).toString('base64')));
      const result = await page.evaluate(input => window.denoiseInBrowser(input), { width: WIDTH, height: HEIGHT, color, albedo, normal, backend, quality, tiling: false });
      await writeFile(`${directory}/tfjs.f32`, Buffer.from(result.output, 'base64'));
      const { output, ...metrics } = result;
      timings[`${scene.name}/${sample.name}`] = metrics;
      console.log(scene.name, sample.name, JSON.stringify(metrics));
    }
  }
} finally {
  await browser.close();
  await server.close();
}
await mkdir(rootDirectory, { recursive: true });
await writeFile(`${rootDirectory}/timings-tfjs-${backend}.json`, JSON.stringify(timings, null, 1));

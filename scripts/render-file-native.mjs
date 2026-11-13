// Path traces a scene.json file scene (GLB + HDRI, as scripts/render-media.mjs --scene file reads it) on Cook, the native
// tracer of packages/render-native. A headless Chrome page loads the GLB with the glTF loader (textures included), packs the
// scene into native tables with the same code the MCP render job uses, and this process traces them.
//   node scripts/render-file-native.mjs --config <scene.json> --out <prefix> [--width 800] [--height 450] [--samples 128]
//     [--bounces 8] [--seed 1] [--denoise oidn|atrous|none] [--max-seconds 600] [--instancing] [--chrome <path>] [--software-gl]
// Writes <prefix>.png (ACES + gamma, 67js tone map), <prefix>.linear.f32 (width*height*3 little-endian floats) and <prefix>.json.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFileScene } from './file-scene.mjs';
import { traceFrameNative } from './agent-native-trace.mjs';

function readOption(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  if (flagIndex === -1) return fallbackValue;
  const value = argumentList[flagIndex + 1];
  if (value === undefined || value.startsWith('--')) throw new RangeError(`Flag ${flagName} requires a value.`);
  return value;
}

function readIntegerOption(argumentList, flagName, fallbackValue) {
  const parsed = Number(readOption(argumentList, flagName, fallbackValue));
  if (!Number.isInteger(parsed) || parsed < 1) throw new RangeError(`Option ${flagName} must be a positive integer, got ${parsed}.`);
  return parsed;
}

function parseArguments(argumentList) {
  const config = readOption(argumentList, '--config');
  const outputPrefix = readOption(argumentList, '--out');
  if (!config || !outputPrefix) throw new RangeError('Usage: node scripts/render-file-native.mjs --config <scene.json> --out <prefix> [--width 800] [--height 450] [--samples 128] [--bounces 8] [--seed 1] [--denoise oidn|atrous|none] [--max-seconds 600] [--instancing] [--chrome <path>] [--software-gl]');
  const denoise = readOption(argumentList, '--denoise', 'oidn');
  if (!['oidn', 'atrous', 'none'].includes(denoise)) throw new RangeError(`Option --denoise must be oidn, atrous or none, got "${denoise}".`);
  return {
    config: resolve(config),
    outputPrefix: resolve(outputPrefix),
    width: readIntegerOption(argumentList, '--width', 800),
    height: readIntegerOption(argumentList, '--height', 450),
    samples: readIntegerOption(argumentList, '--samples', 128),
    bounces: readIntegerOption(argumentList, '--bounces', 8),
    seed: readIntegerOption(argumentList, '--seed', 1),
    maxSeconds: readIntegerOption(argumentList, '--max-seconds', 600),
    denoise,
    instancing: argumentList.includes('--instancing'),
    chrome: readOption(argumentList, '--chrome'),
    softwareGl: argumentList.includes('--software-gl'),
  };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function startViteServer(root) {
  const port = await freePort();
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/render-vite.config.mjs', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  await new Promise((resolveStarted, reject) => {
    const timeout = setTimeout(() => reject(new Error('Render server did not start.')), 30000);
    server.stdout.on('data', data => {
      if (data.toString().replace(/\u001b\[[0-9;]*m/g, '').includes(`127.0.0.1:${port}`)) {
        clearTimeout(timeout);
        resolveStarted();
      }
    });
    server.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Render server exited ${code}.`));
    });
  });
  return { server, port };
}

// Runs in the page: packs the loaded scene into the tables the native tracer reads, like the MCP render job does.
async function exportTablesInPage({ width, height, bounces, seed, instancing, camera }) {
  const [{ createCamera, describeIgnoredFeatures }, { buildTraceScene, refuseLocalVolumes, resolveTexture }, pack, { buildNativeInput }, { buildJobNativeInput, buildFlattenedJobNativeInput }, { exportNativeSceneTables }] = await Promise.all([
    import('/src/path-tracer.js'), import('/src/path-tracer-scene.js'), import('/src/path-tracer-gpu-pack.js'),
    import('/packages/render-native/pack-input.mjs'), import('/packages/render-native/job-input.mjs'), import('/scripts/native-bake-page.js'),
  ]);
  const { parts, environment } = window.__scene;
  const tracerCamera = createCamera(camera, width, height);
  const exported = exportNativeSceneTables({ parts, environment, camera: tracerCamera, options: { width, height, bounces, seed, fireflyClamp: 20, noiseThreshold: 0 }, kernel: 'cycles', instancing,
    modules: { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack } });
  return { ...exported, ignored: describeIgnoredFeatures(parts, environment, 'cpu', { kernelMaterials: exported.wholeMaterials }), partCount: parts.length };
}

async function loadOidnIfAvailable() {
  try {
    const denoiser = await import('../packages/denoise-oidn/index.mjs');
    return denoiser;
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tracer = await import('../packages/render-native/index.mjs');
  if (!tracer.findNativeAddon()) throw new Error('The render-native addon is not built. Run "node build.mjs" in packages/render-native first.');
  const world = prepareFileScene({ configPath: options.config });
  const { description } = world;
  const camera = { eye: description.eye, target: description.target, fov: description.frame?.fov ?? 45 };
  const { server, port } = await startViteServer(root);
  let browser;
  try {
    const launchArguments = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'];
    if (options.softwareGl) launchArguments.push('--use-angle=swiftshader');
    browser = await chromium.launch({ headless: true, ...(options.chrome ? { executablePath: options.chrome } : {}), args: launchArguments });
    const page = await browser.newPage({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => console.error(`PAGE_ERROR ${error.message}`));
    await page.route('**/__file/**', async request => {
      const { pathname } = new URL(request.request().url());
      if (pathname === '/__file/config.json') await request.fulfill({ json: description });
      else if (pathname.startsWith('/__file/asset/')) await request.fulfill({ path: world.assets[Number(pathname.split('/')[3])] });
      else await request.fulfill({ status: 404, body: 'not found' });
    });
    const loadStarted = performance.now();
    await page.goto(`http://127.0.0.1:${port}/file.html?export=1&width=800&height=450&samples=1`);
    await page.waitForFunction(() => window.__fileSceneError || window.__scene?.parts, null, { timeout: 300000 });
    const loadError = await page.evaluate(() => window.__fileSceneError);
    if (loadError) throw new Error(`Scene file failed to load: ${loadError}`);
    const loadSeconds = (performance.now() - loadStarted) / 1000;
    const packStarted = performance.now();
    const exported = await page.evaluate(exportTablesInPage, { width: options.width, height: options.height, bounces: options.bounces, seed: options.seed, instancing: options.instancing, camera });
    const packSeconds = (performance.now() - packStarted) / 1000;
    const denoiser = options.denoise === 'oidn' ? await loadOidnIfAvailable() : null;
    const traced = await traceFrameNative({ tracer, exported, width: options.width, height: options.height, samples: options.samples, bounces: options.bounces, seed: options.seed,
      denoise: options.denoise, denoiser, maxSeconds: options.maxSeconds, kernel: 'cycles' });
    await mkdir(dirname(options.outputPrefix), { recursive: true });
    await writeFile(`${options.outputPrefix}.png`, Buffer.from(traced.data, 'base64'));
    await writeFile(`${options.outputPrefix}.linear.f32`, Buffer.from(traced.linear.buffer, traced.linear.byteOffset, traced.linear.byteLength));
    const report = { ...traced.report, partCount: exported.partCount, loadSeconds, packSeconds, ignored: exported.ignored, materialsReason: exported.materialsReason };
    await writeFile(`${options.outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`FILE_NATIVE ${JSON.stringify(report)}`);
  } finally {
    await browser?.close();
    server.kill();
  }
}

await main();

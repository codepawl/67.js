// Path traces a scene.json file scene (GLB + HDRI, as scripts/render-media.mjs --scene file reads it) on Cook, the native
// tracer in the @codepawlhq/cook package. A headless Chrome page loads the GLB with the glTF loader (textures included), packs the
// scene into native tables with the same code the MCP render job uses, and this process traces them.
//   node scripts/render-file-native.mjs --config <scene.json> --out <prefix> [options]   (--help lists the options)
// Writes <prefix>.png (ACES + gamma, Crucible tone map), <prefix>.linear.f32 (width*height*3 little-endian floats) and <prefix>.json.
// Exit code 2: the native addon is not built. Exit code 1: any other failure.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFileScene } from './file-scene.mjs';
import { traceFrameNative } from './agent-native-trace.mjs';
import { MissingAddonError, USAGE, listIgnoredFrameEffects, parseArguments } from './render-file-native-options.mjs';

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
async function exportTablesInPage({ width, height, bounces, seed, instancing, camera, listParts, hideParts, patchMaterials }) {
  const [{ createCamera, describeIgnoredFeatures }, { buildTraceScene, refuseLocalVolumes, resolveTexture }, pack, { buildNativeInput }, { buildJobNativeInput, buildFlattenedJobNativeInput }, { exportNativeSceneTables }] = await Promise.all([
    import('/src/path-tracer.js'), import('/src/path-tracer-scene.js'), import('/src/path-tracer-gpu-pack.js'),
    import('/node_modules/@codepawlhq/cook/pack-input.mjs'), import('/node_modules/@codepawlhq/cook/job-input.mjs'), import('/scripts/native-bake-page.js'),
  ]);
  const { environment } = window.__scene;
  const describePart = part => ({
    name: part.name,
    position: part.matrix ? [part.matrix[12], part.matrix[13], part.matrix[14]].map(value => Math.round(value * 1000) / 1000) : null,
    material: Object.fromEntries(['name', 'alphaMode', 'alphaCutoff', 'opacity', 'transmission', 'doubleSided', 'color', 'roughness', 'metallic', 'emission', 'ior']
      .map(key => [key, part.material?.[key]]).filter(([, value]) => value !== undefined)),
    hasColorTexture: Boolean(part.material?.map),
  });
  const matchingParts = (pattern, allParts) => (pattern ? allParts.filter(part => new RegExp(pattern, 'i').test(`${part.name ?? ''} material:${part.material?.name ?? ''}`)) : []);
  const listedParts = listParts ? matchingParts(listParts, window.__scene.parts).map(describePart) : null;
  for (const { pattern, patch } of patchMaterials) {
    for (const part of matchingParts(pattern, window.__scene.parts)) Object.assign(part.material, patch);
  }
  const hidden = new Set(matchingParts(hideParts, window.__scene.parts));
  const parts = window.__scene.parts.filter(part => !hidden.has(part));
  const tracerCamera = createCamera(camera, width, height);
  const exported = exportNativeSceneTables({ parts, environment, camera: tracerCamera, options: { width, height, bounces, seed, fireflyClamp: 20, noiseThreshold: 0 }, kernel: 'cycles', instancing,
    modules: { buildTraceScene, refuseLocalVolumes, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack } });
  return { ...exported, ignored: describeIgnoredFeatures(parts, environment, 'cpu', { kernelMaterials: exported.wholeMaterials }), partCount: parts.length, hiddenCount: hidden.size, listedParts };
}

async function loadOidnIfAvailable() {
  try {
    const denoiser = await import('../packages/denoise-oidn/index.mjs');
    return denoiser;
  } catch {
    return null;
  }
}

async function loadNativeTracer() {
  let tracer;
  try {
    tracer = await import('@codepawlhq/cook');
  } catch {
    throw new MissingAddonError();
  }
  if (!tracer.findNativeAddon()) throw new MissingAddonError();
  return tracer;
}

const GPU_POLL_MILLISECONDS = 250;
const GPU_POLL_SETTLE_MILLISECONDS = 300;

/**
 * Follows the used memory of the card while the trace runs. One nvidia-smi child prints a line every 250 ms by itself, because
 * the native trace blocks this process and a timer here would not fire. The number is the whole card, so other processes count.
 * `stop()` kills the child and resolves with { peakMiB, note }; peakMiB is null when nvidia-smi is not available.
 */
function startGpuMemoryPoller() {
  const state = { peakMiB: null, note: null, bufferedText: '' };
  const child = spawn('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits', '-lms', String(GPU_POLL_MILLISECONDS)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', error => {
    state.note = `nvidia-smi could not start (${error.code ?? error.message}), so the peak GPU memory was not measured.`;
  });
  child.stdout.on('data', chunk => {
    state.bufferedText += chunk.toString();
    const lines = state.bufferedText.split('\n');
    state.bufferedText = lines.pop();
    for (const line of lines) {
      const usedMiB = Number(line.trim());
      if (line.trim() !== '' && Number.isFinite(usedMiB)) state.peakMiB = Math.max(state.peakMiB ?? 0, usedMiB);
    }
  });
  return {
    async stop() {
      try {
        await new Promise(resolveSettled => setTimeout(resolveSettled, GPU_POLL_SETTLE_MILLISECONDS));
      } finally {
        child.kill();
      }
      if (state.peakMiB === null && !state.note) state.note = 'nvidia-smi printed no memory reading, so the peak GPU memory was not measured.';
      return { peakMiB: state.peakMiB, note: state.note };
    },
  };
}

async function traceWithGpuMemory(traceOptions) {
  const poller = startGpuMemoryPoller();
  try {
    const traced = await traceFrameNative(traceOptions);
    const peak = await poller.stop();
    return { traced, peak };
  } finally {
    await poller.stop();
  }
}

async function writeRawPicture({ outputPrefix, rawLinear, width, height }) {
  const [{ toneMapToRgba8 }, { encodePng }] = await Promise.all([import('../src/path-tracer.js'), import('../src/export-png.js')]);
  const png = encodePng(toneMapToRgba8(rawLinear, width, height), width, height);
  await writeFile(`${outputPrefix}.raw.png`, Buffer.from(png));
  await writeFile(`${outputPrefix}.raw.linear.f32`, Buffer.from(rawLinear.buffer, rawLinear.byteOffset, rawLinear.byteLength));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tracer = await loadNativeTracer();
  const { chromium } = await import('playwright');
  const world = prepareFileScene({ configPath: options.config });
  const { description } = world;
  const camera = options.camera ?? { eye: description.eye, target: description.target, fov: description.frame?.fov ?? 45 };
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
    const exported = await page.evaluate(exportTablesInPage, { width: options.width, height: options.height, bounces: options.bounces, seed: options.seed, instancing: options.instancing, camera,
      listParts: options.listParts ?? null, hideParts: options.hideParts ?? null, patchMaterials: options.patchMaterials });
    const packSeconds = (performance.now() - packStarted) / 1000;
    const denoiser = options.denoise === 'oidn' ? await loadOidnIfAvailable() : null;
    const { traced, peak } = await traceWithGpuMemory({ tracer, exported, width: options.width, height: options.height, samples: options.samples, bounces: options.bounces, seed: options.seed,
      denoise: options.denoise, denoiser, maxSeconds: options.maxSeconds, kernel: 'cycles' });
    await mkdir(dirname(options.outputPrefix), { recursive: true });
    await writeFile(`${options.outputPrefix}.png`, Buffer.from(traced.data, 'base64'));
    await writeFile(`${options.outputPrefix}.linear.f32`, Buffer.from(traced.linear.buffer, traced.linear.byteOffset, traced.linear.byteLength));
    if (options.writeRaw && traced.report.denoised) await writeRawPicture({ outputPrefix: options.outputPrefix, rawLinear: traced.rawLinear, width: options.width, height: options.height });
    if (exported.listedParts) await writeFile(`${options.outputPrefix}.parts.json`, `${JSON.stringify(exported.listedParts, null, 1)}\n`);
    const report = { ...traced.report, tracerSetupSeconds: traced.report.setupSeconds, partCount: exported.partCount, hiddenCount: exported.hiddenCount,
      loadSeconds, packSeconds, setupSeconds: loadSeconds + packSeconds, samplingSeconds: traced.report.tracedSeconds,
      triangleCount: exported.triangles, instanceCount: exported.instances ?? null,
      peakGpuMemoryMiB: peak.peakMiB, ...(peak.note ? { peakGpuMemoryNote: peak.note } : {}),
      ignoredFrameEffects: listIgnoredFrameEffects(description), ignored: exported.ignored, materialsReason: exported.materialsReason };
    await writeFile(`${options.outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`FILE_NATIVE ${JSON.stringify(report)}`);
  } finally {
    await browser?.close();
    server.kill();
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(error instanceof MissingAddonError ? 2 : 1);
}

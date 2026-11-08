// Compares 67js and three.js on matching scenes: npm run benchmark:runtime
// Use --gpu-only to skip SwiftShader, or --cpu-only to run only SwiftShader. --scene <id>, --engine <name> and --frames <count> run a part, and do not rewrite
// the report.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const WORK_DIRECTORY = resolve('artifacts/runtime');
const REPORT_PATH = resolve('bench/runtime/report.json');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHARED_ARGUMENTS = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', '--enable-precise-memory-info', '--js-flags=--expose-gc'];
const BACKENDS = {
  gpu: { arguments: SHARED_ARGUMENTS, frames: 120 },
  cpu: { arguments: [...SHARED_ARGUMENTS, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], frames: 15 },
};
const ENGINES = ['67js', 'three', 'three-instanced', '67js-no-lod', '67js-no-culling', '67js-ldr', '67js-one-sample', '67js-ldr-one-sample', 'three-one-sample', '67js-light'];
// Ablations of the HDR target and MSAA, which cost something in every scene. They run only when named with --engine.
const FEATURE_ENGINES = new Set(['67js-light', '67js-ldr', '67js-one-sample', '67js-ldr-one-sample', 'three-one-sample']);
const INSTANCED_SCENES = new Set(['instanced-objects']);
// Ablations of this renderer's own culling and level selection, which only a scene that has them can show.
const ABLATION_SCENES = new Set(['large-outdoor']);
const ABLATION_ENGINES = new Set(['67js-no-lod', '67js-no-culling']);

const flags = process.argv.slice(2);
const gpuOnly = flags.includes('--gpu-only');
const cpuOnly = flags.includes('--cpu-only');
const sceneFlag = flags.indexOf('--scene');
const onlyScene = sceneFlag >= 0 ? flags[sceneFlag + 1] : null;
const engineFlag = flags.indexOf('--engine');
const onlyEngine = engineFlag >= 0 ? flags[engineFlag + 1] : null;
const framesFlag = flags.indexOf('--frames');
const framesOverride = framesFlag >= 0 ? Number(flags[framesFlag + 1]) : null;
const isPartialRun = Boolean(onlyScene || onlyEngine || framesOverride);

function enginesFor(sceneId) {
  return ENGINES.filter(engine => {
    if (onlyEngine) return engine === onlyEngine;
    if (FEATURE_ENGINES.has(engine)) return false;
    if (ABLATION_ENGINES.has(engine)) return ABLATION_SCENES.has(sceneId);
    return engine !== 'three-instanced' || INSTANCED_SCENES.has(sceneId);
  });
}

// Each run gets a new browser with an empty profile, so a shader cache from an earlier run can not hide compile time.
async function runOne(backend, serverUrl, sceneId, engine, frames) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: backend.arguments });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${serverUrl}/bench/runtime/harness.html`);
    await page.waitForFunction(() => window.runBenchmark);
    const result = await page.evaluate(([scene, name, count]) => window.runBenchmark(scene, name, count), [sceneId, engine, frames]);
    if (errors.length) throw new Error(errors.join('\n'));
    // Blended scenes already differ between their first and later frames before culling existed, so only the scene that tests culling is held to this.
    if (!result.repeatable && ABLATION_SCENES.has(sceneId) && engine.startsWith('67js')) throw new Error(`${sceneId} on ${engine} drew a different picture for the same time.`);
    if (result.glError !== 0) throw new Error(`${sceneId} on ${engine} gave WebGL error ${result.glError}.`);
    return result;
  } finally {
    await browser.close();
  }
}

async function sceneDescriptions(browser, serverUrl) {
  const page = await browser.newPage();
  await page.goto(`${serverUrl}/bench/runtime/harness.html`);
  await page.waitForFunction(() => window.benchmarkScenes);
  const scenes = await page.evaluate(() => window.benchmarkScenes);
  await page.close();
  return scenes;
}

// Another job on the GPU distorts its timings, so each result records how busy the GPU was just before it ran.
function gpuBusyPercent() {
  const result = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function rounded(value, digits = 2) {
  return value === null ? null : Number(value.toFixed(digits));
}

function summarize({ image: _image, repeatable: _repeatable, glError: _glError, scene: _scene, engine: _engine, ...result }) {
  return {
    firstFrameMilliseconds: rounded(result.firstFrameMilliseconds, 0),
    updateMilliseconds: rounded(result.updateMilliseconds),
    renderCpuMilliseconds: rounded(result.renderCpuMilliseconds),
    gpuMilliseconds: rounded(result.gpuMilliseconds),
    fullFrameMilliseconds: rounded(result.fullFrameMilliseconds),
    drawCalls: rounded(result.drawCalls, 0),
    triangles: rounded(result.triangles, 0),
    gpuMegabytes: rounded(result.gpuBytes / 1048576, 2),
    heapMegabytes: result.heapBytes === null ? null : rounded(result.heapBytes / 1048576, 1),
    renderTargets: result.renderTargets,
  };
}

async function runBackend(backendName, serverUrl, report) {
  const backend = BACKENDS[backendName];
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: backend.arguments });
  try {
    const scenes = await sceneDescriptions(browser, serverUrl);
    report.scenes = scenes;
    const graphicsPage = await browser.newPage();
    report.graphics[backendName] = await graphicsPage.evaluate(() => {
      const context = document.createElement('canvas').getContext('webgl2');
      const debug = context.getExtension('WEBGL_debug_renderer_info');
      return context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER);
    });
    await graphicsPage.close();
    for (const sceneId of Object.keys(scenes)) {
      if (onlyScene && sceneId !== onlyScene) continue;
      for (const engine of enginesFor(sceneId)) {
        const gpuBusyBefore = gpuBusyPercent();
        const result = await runOne(backend, serverUrl, sceneId, engine, framesOverride ?? backend.frames);
        await writeFile(`${WORK_DIRECTORY}/${backendName}-${sceneId}-${engine}.png`, Buffer.from(result.image, 'base64'));
        report.results[backendName][sceneId] ??= {};
        report.results[backendName][sceneId][engine] = { ...summarize(result), gpuBusyBefore };
        const summary = report.results[backendName][sceneId][engine];
        console.log(`${backendName} ${sceneId.padEnd(20)} ${engine.padEnd(16)} first ${summary.firstFrameMilliseconds} ms, update ${summary.updateMilliseconds} ms, render ${summary.renderCpuMilliseconds} ms, frame ${summary.fullFrameMilliseconds} ms, ${summary.drawCalls} draws, ${summary.triangles} tris, gpu mem ${summary.gpuMegabytes} MB, heap ${summary.heapMegabytes} MB, busy ${gpuBusyBefore}%${summary.renderTargets ? `
  targets: ${summary.renderTargets.map(target => `${target.name} ${target.megabytes} MB`).join(", ")}` : ""}`);
      }
    }
  } finally {
    await browser.close();
  }
}

function scorePictures() {
  const result = spawnSync('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/runtime/score-pictures.py', WORK_DIRECTORY,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`uv exited with ${result.status}.`);
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(WORK_DIRECTORY, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const report = { resolution: [960, 540], msaaSamples: 4, graphics: {}, results: { gpu: {}, cpu: {} }, scenes: {} };
try {
  const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  if (!cpuOnly) await runBackend('gpu', serverUrl, report);
  if (!gpuOnly) await runBackend('cpu', serverUrl, report);
} finally {
  await server.close();
}
if (!isPartialRun) scorePictures();
if (!isPartialRun) {
  report.pictureDifference = JSON.parse(await readFile(`${WORK_DIRECTORY}/pictures.json`, 'utf8'));
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  report.threeVersion = manifest.devDependencies.three;
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify(report.pictureDifference, null, 1));
}
process.exit(0);

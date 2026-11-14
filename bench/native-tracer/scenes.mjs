// Draws reference scenes with the native ray query tracer and with the browser's WebGPU megakernel, same seed and no
// denoiser, and writes both images plus their timings. Score each pair with bench/webgpu-tracer/flip.py. Run it through gpu-lock.
//   node bench/native-tracer/scenes.mjs <output directory> [--scenes a,b,c] [--samples 64] [--width 960] [--height 540]
//     [--bounces 8] [--noise-threshold 0]
// Without --scenes it draws every reference scene. Files: <scene>-native.png, <scene>-webgpu.png and scenes.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createNativeTracerLocator, traceFrameNative } from '../../scripts/agent-native-trace.mjs';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);

function valueAfter(flag, fallback) {
  const index = argumentsGiven.indexOf(flag);
  return index >= 0 ? argumentsGiven[index + 1] : fallback;
}

const options = {
  width: Number(valueAfter('--width', 960)),
  height: Number(valueAfter('--height', 540)),
  samples: Number(valueAfter('--samples', 64)),
  bounces: Number(valueAfter('--bounces', 8)),
  seed: 0,
  noiseThreshold: Number(valueAfter('--noise-threshold', 0)),
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const found = await createNativeTracerLocator().find();
if (!found.tracer) throw new Error(found.reason);
const server = await createServer({ server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--enable-webgl', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const records = {};
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.setDefaultTimeout(0);
  await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.loadTraceSceneFor && window.referenceSceneIds, null, { timeout: 180000 });
  const sceneIds = valueAfter('--scenes', null)?.split(',') ?? await page.evaluate(() => window.referenceSceneIds);
  for (const id of sceneIds) {
    try {
      const exported = await page.evaluate(async ([sceneId, tracerOptions]) => {
        const [{ createCamera }, { buildTraceScene }, pack, { buildNativeInput }, { encodeNativeTables }] = await Promise.all([
          import('/src/path-tracer.js'), import('/src/path-tracer-scene.js'), import('/src/path-tracer-gpu-pack.js'),
          import('/node_modules/@codepawlhq/cook/pack-input.mjs'), import('/scripts/native-bake-page.js'),
        ]);
        const source = await window.loadTraceSceneFor(sceneId);
        const traceScene = buildTraceScene(source.parts, source.environment);
        const camera = createCamera(source.camera, tracerOptions.width, tracerOptions.height);
        const input = buildNativeInput(traceScene, camera, { ...tracerOptions, fireflyClamp: 20 }, pack);
        return { tables: encodeNativeTables(input), triangleCount: input.triangleCount, triangles: traceScene.indices.length / 3, ignored: [] };
      }, [id, options]);
      const native = await traceFrameNative({ tracer: found.tracer, exported, width: options.width, height: options.height,
        samples: options.samples, bounces: options.bounces, seed: options.seed, denoise: 'none', noiseThreshold: options.noiseThreshold });
      await writeFile(`${outputDirectory}/${id}-native.png`, Buffer.from(native.data, 'base64'));
      const webgpu = await page.evaluate(async ([sceneId, tracerOptions]) => {
        const { renderPathTracedImage } = await import('/src/path-tracer.js');
        const source = await window.loadTraceSceneFor(sceneId);
        const result = await renderPathTracedImage(source, { ...tracerOptions, backend: 'webgpu', denoise: false });
        const canvas = document.createElement('canvas');
        canvas.width = result.width;
        canvas.height = result.height;
        canvas.getContext('2d').putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
        return { image: canvas.toDataURL('image/png').split(',')[1], report: result.report };
      }, [id, { ...options, threads: 1, maxSeconds: 600 }]);
      await writeFile(`${outputDirectory}/${id}-webgpu.png`, Buffer.from(webgpu.image, 'base64'));
      records[id] = { nativeTracedSeconds: native.report.tracedSeconds, nativeAverageSamples: native.report.averageSamples,
        webgpuTracedSeconds: webgpu.report.tracedSeconds, webgpuAverageSamples: webgpu.report.averageSamples, triangles: native.report.triangles };
      console.log(id, JSON.stringify(records[id]));
    } catch (error) {
      // A reference scene the path tracer cannot take (no parts, for one) is recorded and the run goes on.
      records[id] = { error: error.message.split(String.fromCharCode(10))[0] };
      console.log(id, JSON.stringify(records[id]));
    }
  }
} finally {
  await writeFile(`${outputDirectory}/scenes.json`, JSON.stringify({ options, records }, null, 1));
  await browser.close();
  await server.close();
}

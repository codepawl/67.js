// Where the time of one reference scene goes: scene build, renderer construction (geometry upload), first frame, later frames.
// node bench/reference/profile-scene.mjs [scene-id] [gpu|cpu]
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_LOAD_TIMEOUT = 180000;
const [sceneId = 'mountain-valley', backend = 'gpu'] = process.argv.slice(2);
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });

async function profileOnce(page) {
  return page.evaluate(async id => {
    const { REFERENCE_SCENES } = await import('/bench/reference/scenes.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { applyLightLinks } = await import('/src/light-linking.js');
    const milliseconds = {};
    let started = performance.now();
    const lap = name => {
      milliseconds[name] = Number((performance.now() - started).toFixed(1));
      started = performance.now();
    };
    // Counts what each frame hands to the GPU: draw calls and triangles.
    const drawn = { calls: 0, triangles: 0, instancesByTriangleCount: {} };
    const originalDraw = WebGL2RenderingContext.prototype.drawElementsInstanced;
    WebGL2RenderingContext.prototype.drawElementsInstanced = function (mode, count, type, offset, instances) {
      drawn.calls++;
      drawn.triangles += (count / 3) * instances;
      drawn.instancesByTriangleCount[count / 3] = (drawn.instancesByTriangleCount[count / 3] ?? 0) + instances;
      return originalDraw.call(this, mode, count, type, offset, instances);
    };
    const scene = await REFERENCE_SCENES[id]();
    lap('sceneBuild');
    const linked = applyLightLinks(scene.parts, scene.environment);
    lap('lightLinks');
    const canvas = document.querySelector('canvas');
    const renderer = new CrucibleRenderer(canvas, linked, {
      ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: true,
      environment: scene.environment, shadowBounds: scene.shadow, shadowCascades: null,
    });
    lap('rendererConstruct');
    renderer.resize();
    const gl = renderer.context;
    const pixel = new Uint8Array(4);
    const wait = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const frame = { ...scene.camera, environment: scene.environment, time: 0, exposure: 1, effects: { ambientOcclusion: 0, ambientOcclusionRadius: 0.5 } };
    renderer.render(frame);
    wait();
    lap('firstFrame');
    const firstFrameDrawn = { ...drawn };
    drawn.calls = 0;
    drawn.triangles = 0;
    drawn.instancesByTriangleCount = {};
    renderer.render(frame);
    wait();
    lap('secondFrame');
    const secondFrameDrawn = { ...drawn };
    // The shadow pass is the first frame minus the main pass: instances drawn per triangle count of the geometry.
    const shadowInstancesByTriangleCount = {};
    for (const [triangles, instances] of Object.entries(firstFrameDrawn.instancesByTriangleCount)) {
      const shadowInstances = instances - (secondFrameDrawn.instancesByTriangleCount[triangles] ?? 0);
      if (shadowInstances > 0) shadowInstancesByTriangleCount[triangles] = shadowInstances;
    }
    WebGL2RenderingContext.prototype.drawElementsInstanced = originalDraw;
    renderer.render(frame);
    wait();
    lap('thirdFrame');
    const image = canvas.toDataURL('image/png');
    lap('canvasToPng');
    renderer.dispose();
    return { parts: scene.parts.length, batches: renderer.batches.length, sceneTriangles: renderer.triangles, firstFrameDrawn: { calls: firstFrameDrawn.calls, triangles: firstFrameDrawn.triangles }, secondFrameDrawn: { calls: secondFrameDrawn.calls, triangles: secondFrameDrawn.triangles }, shadowInstancesByTriangleCount, mainInstancesByTriangleCount: secondFrameDrawn.instancesByTriangleCount, pngBytes: image.length, milliseconds };
  }, sceneId);
}

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: PAGE_LOAD_TIMEOUT });
  await page.waitForFunction(() => window.measureReferenceFrameTime, null, { timeout: PAGE_LOAD_TIMEOUT });
  const runs = [];
  for (let run = 0; run < 3; run++) runs.push(await profileOnce(page));
  console.log(JSON.stringify({ sceneId, backend, runs }, null, 1));
} finally {
  await browser.close();
  await server.close();
}

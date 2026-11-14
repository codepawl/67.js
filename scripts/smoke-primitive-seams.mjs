import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const baselineCommit = '61a01023c753b6c58cade24cb9c8c0b32e249f62';
function baselineSource(path) {
  const result = spawnSync('git', ['show', `${baselineCommit}:${path}`], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, `Baseline history is required for this comparison: ${result.stderr}`);
  return result.stdout;
}
await writeFile('artifacts/geometry-before-mesh-query.mjs', baselineSource('src/geometry.js'));
await writeFile('artifacts/model-before-mesh-query.mjs', baselineSource('src/model.js')
  .replace("'./geometry.js'", "'./geometry-before-mesh-query.mjs'")
  .replace("'./assembly.js'", "'/src/assembly.js'"));
const width = Number(process.argv[2] ?? 960);
const height = Number(process.argv[3] ?? 540);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/primitive-seams-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>`,
  }));
  await page.goto('http://127.0.0.1:5173/primitive-seams-smoke.html');
  const report = await page.evaluate(async () => {
    const { CrucibleRenderer, fitPerspectiveDistance } = await import('/src/index.js');
    const { createModel } = await import('/src/model.js');
    const { createModel: createBefore } = await import('/artifacts/model-before-mesh-query.mjs');
    const before = createBefore();
    const after = createModel();
    let maximumGeometryDifference = 0;
    let changedGeometryComponents = 0;
    let indicesUnchanged = true;
    const oldMeshes = [...new Set(before.map(part => part.geometry))];
    const newMeshes = [...new Set(after.map(part => part.geometry))];
    for (let index = 0; index < oldMeshes.length; index++) {
      for (const field of ['positions', 'normals']) {
        oldMeshes[index][field].forEach((value, offset) => {
          const difference = Math.abs(value - newMeshes[index][field][offset]);
          maximumGeometryDifference = Math.max(maximumGeometryDifference, difference);
          if (difference > 0) changedGeometryComponents++;
        });
      }
      indicesUnchanged &&= oldMeshes[index].indices.every((value, offset) => value === newMeshes[index].indices[offset]);
    }
    const canvas = document.querySelector('canvas');
    const camera = { eye: [4, 3, 6], target: [0, 1.45, 0], fov: 35 };
    if (canvas.clientWidth < canvas.clientHeight) {
      const distance = fitPerspectiveDistance({ minimum: [-1.4, 0, -1], maximum: [1.4, 3, 1] }, camera, canvas.clientWidth / canvas.clientHeight);
      const original = Math.hypot(...camera.eye.map((value, axis) => value - camera.target[axis]));
      camera.eye = camera.eye.map((value, axis) => camera.target[axis] + (value - camera.target[axis]) * distance / original);
    }
    function draw(parts) {
      const renderer = new CrucibleRenderer(canvas, parts, {
        world: true, ground: false, transparent: true, hdr: true, samples: 2, pixelRatio: 1, memoryBudgetMiB: 128,
      });
      renderer.render({ ...camera, time: 0, effects: { grain: 0, bloom: { strength: 0 } } });
      const context = renderer.context;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      const info = context.getExtension('WEBGL_debug_renderer_info');
      const result = { pixels, image: canvas.toDataURL('image/png'), error: context.getError(), memory: renderer.memoryPlan,
        gpu: info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unavailable' };
      renderer.dispose();
      return result;
    }
    const original = draw(before);
    const current = draw(after);
    let maximumPixelDifference = 0;
    let changedPixelChannels = 0;
    original.pixels.forEach((value, offset) => {
      const difference = Math.abs(value - current.pixels[offset]);
      maximumPixelDifference = Math.max(maximumPixelDifference, difference);
      if (difference) changedPixelChannels++;
    });
    return { partCount: after.length, geometryCount: newMeshes.length, maximumGeometryDifference, changedGeometryComponents,
      indicesUnchanged, transformsUnchanged: before.every((part, index) => part.matrix.every((value, offset) => value === after[index].matrix[offset])),
      maximumPixelDifference, changedPixelChannels, sourceGlError: original.error, currentGlError: current.error,
      memory: current.memory, gpu: current.gpu, beforeImage: original.image, afterImage: current.image };
  });
  for (const name of ['before', 'after']) {
    await writeFile(`artifacts/primitive-seams-${name}-${width}x${height}.png`, Buffer.from(report[`${name}Image`].split(',')[1], 'base64'));
    delete report[`${name}Image`];
  }
  await writeFile(`artifacts/primitive-seams-${width}x${height}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(report.sourceGlError, 0);
  assert.equal(report.currentGlError, 0);
  assert.equal(report.indicesUnchanged, true);
  assert.equal(report.transformsUnchanged, true);
  assert.ok(report.maximumGeometryDifference < 1e-12);
  assert.equal(report.maximumPixelDifference, 0);
} finally {
  await browser.close();
}

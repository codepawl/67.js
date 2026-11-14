import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const reports = {};
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.route('**/lighting-smoke.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:960px;height:540px;display:block"></canvas>' }));
  await page.goto('http://127.0.0.1:5173/lighting-smoke.html');
  reports.contract = await page.evaluate(async () => {
    const { CrucibleRenderer, box } = await import('/build/67.module.js');
    await import('/build/fog-shader.js');
    const canvas = document.querySelector('canvas');
    const part = { geometry: box(), matrix: new Float32Array([4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 1]), material: { color: [1, 1, 1], metallic: 0, roughness: 1 } };
    const renderer = new CrucibleRenderer(canvas, [part], { ground: false, hdr: true, pixelRatio: 1, samples: 1 });
    const context = renderer.context;
    if (!renderer.hdr) throw new Error('Lighting contract requires a linear HDR target');
    const identity = renderer.lighting.positions;
    const frame = { eye: [0, 0, 5], target: [0, 0, 0], fov: 40, exposure: 1, effects: { grain: 0 }, environment: { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0 } };
    function sample(light) {
      frame.environment.pointLights = Array.isArray(light) ? light : light ? [light] : [];
      renderer.render(frame);
      context.bindFramebuffer(context.FRAMEBUFFER, renderer.resolveFramebuffer);
      const pixel = new Float32Array(4);
      context.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, context.RGBA, context.FLOAT, pixel);
      context.bindFramebuffer(context.FRAMEBUFFER, null);
      return Array.from(pixel);
    }
    const darkness = sample();
    const near = sample({ position: [0, 0, 1.1], radius: 0.01 });
    const far = sample({ position: [0, 0, 2.1], radius: 0.01 });
    const red = sample({ position: [0, 0, 1.1], color: [1, 0, 0], radius: 0.01 });
    const finalSlot = sample(Array.from({ length: 8 }, (_, index) => ({ position: [0, 0, 1.1], color: [1, 0, 0], radius: 0.01, intensity: index === 7 ? 1 : 0 })));
    const outsideRange = sample({ position: [0, 0, 1.1], range: 0.5 });
    const faded = sample({ position: [0, 0, 1.1], range: 2, radius: 0.01 });
    const repeated = sample({ position: [0, 0, 1.1], radius: 0.01 });
    const behind = sample({ position: [0, 0, -1] });
    const proceduralDarkness = {};
    for (const tag of ['water', 'foliage', 'grass', 'terrain']) {
      part.material.tag = tag;
      renderer.updateParts([part]);
      proceduralDarkness[tag] = sample();
    }
    part.material.tag = 'standard';
    renderer.updateParts([part]);
    const peak = sample({ position: [0, 0, 0.101], intensity: 100000, radius: 0.001 });
    const uniformsBeforeError = Array.from(renderer.lighting.positions);
    let rejected = false;
    try {
      renderer.render({ ...frame, environment: { ...frame.environment, pointLights: [{ position: [0, NaN, 0] }] } });
    } catch {
      rejected = true;
    }
    const report = { darkness, near, far, red, finalSlot, outsideRange, faded, repeated, behind, proceduralDarkness, peak, rejected, uniformsPreserved: uniformsBeforeError.every((value, index) => value === renderer.lighting.positions[index]), retained: identity === renderer.lighting.positions, glError: context.getError(), drawBatches: renderer.batches.length, estimatedBytes: renderer.memoryPlan.estimatedBytes };
    renderer.dispose();
    return report;
  });
  await page.close();
  assert.equal(reports.contract.glError, 0);
  assert.ok(reports.contract.darkness.slice(0, 3).every(value => value === 0));
  assert.ok(Math.abs(reports.contract.near[0] / reports.contract.far[0] - 4) < 0.02, 'Inverse-square falloff must match independently read linear pixels');
  assert.ok(reports.contract.red[0] > 0 && reports.contract.red[1] === 0 && reports.contract.red[2] === 0);
  assert.deepEqual(reports.contract.finalSlot, reports.contract.red, 'The final slot must light surfaces through all eight packed GPU uniform entries');
  assert.ok(reports.contract.outsideRange.slice(0, 3).every(value => value === 0));
  assert.ok(Math.abs(reports.contract.faded[0] / reports.contract.near[0] - (1 - 1 / 16) ** 2) < 0.002);
  assert.ok(reports.contract.behind.slice(0, 3).every(value => value === 0));
  for (const pixel of Object.values(reports.contract.proceduralDarkness)) assert.ok(pixel.slice(0, 3).every(value => value === 0));
  assert.deepEqual(reports.contract.near, reports.contract.repeated);
  assert.ok(reports.contract.peak.every(Number.isFinite), 'Strong lights must not overflow half-float render targets');
  assert.equal(reports.contract.retained, true);
  assert.equal(reports.contract.rejected, true);
  assert.equal(reports.contract.uniformsPreserved, true);

  const variants = {
    before: execFileSync('git', ['show', `${process.argv[2] ?? 'fe6a22b'}:src/shaders.js`], { encoding: 'utf8', windowsHide: true }),
    after: await readFile('src/shaders.js', 'utf8'),
  };
  for (const [name, source] of Object.entries(variants)) {
    const scenePage = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await scenePage.route('**/src/shaders.js*', route => route.fulfill({ contentType: 'application/javascript', body: source }));
    await scenePage.route('**/lighting-smoke.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:960px;height:540px;display:block"></canvas>' }));
    await scenePage.goto('http://127.0.0.1:5173/lighting-smoke.html');
    reports[name] = await scenePage.evaluate(async () => {
      const { CrucibleRenderer } = await import('/src/renderer.js');
      const { createFilmScenes, sampleFilm } = await import('/src/film.js');
      const scene = createFilmScenes().laboratory;
      scene.animate(36);
      const canvas = document.querySelector('canvas');
      const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: false, world: true, environment: { ...scene.environment, volumeFog: { density: 0 } }, shadowBounds: scene.shadowBounds, samples: 4, hdr: true, pixelRatio: 1, memoryBudgetMiB: 384 });
      const frame = { ...sampleFilm(36).camera, effects: { grain: 0 }, time: 36 };
      const context = renderer.context;
      const timer = context.getExtension('EXT_disjoint_timer_query_webgl2');
      if (!timer) throw new Error('GPU timer unavailable');
      const samples = [];
      for (let index = 0; index < 10; index++) renderer.render(frame);
      for (let index = 0; index < 40; index++) {
        const query = context.createQuery();
        context.beginQuery(timer.TIME_ELAPSED_EXT, query);
        renderer.render(frame);
        context.endQuery(timer.TIME_ELAPSED_EXT);
        context.flush();
        const started = performance.now();
        while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) {
          if (performance.now() - started > 2000) throw new Error('GPU query timed out');
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        if (context.getParameter(timer.GPU_DISJOINT_EXT)) throw new Error('Disjoint GPU timer');
        samples.push(context.getQueryParameter(query, context.QUERY_RESULT) / 1e6);
        context.deleteQuery(query);
      }
      const sorted = [...samples].sort((first, second) => first - second);
      renderer.render(frame);
      const report = { medianMilliseconds: (sorted[19] + sorted[20]) / 2, p90Milliseconds: sorted[35], samples, glError: context.getError(), estimatedBytes: renderer.memoryPlan.estimatedBytes, drawBatches: renderer.batches.length, image: canvas.toDataURL('image/png') };
      renderer.dispose();
      return report;
    });
    await writeFile(`artifacts/laboratory-lighting-${name}.png`, Buffer.from(reports[name].image.split(',')[1], 'base64'));
    delete reports[name].image;
    assert.equal(reports[name].glError, 0);
    await scenePage.close();
  }
  assert.equal(reports.before.estimatedBytes, reports.after.estimatedBytes);
  assert.equal(reports.before.drawBatches, reports.after.drawBatches);
  await writeFile('artifacts/lighting-gpu.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}

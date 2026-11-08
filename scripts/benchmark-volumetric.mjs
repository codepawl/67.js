import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.route('**/volume-benchmark.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:960px;height:540px;display:block"></canvas>' }));
  await page.goto('http://127.0.0.1:5173/volume-benchmark.html');
  const results = await page.evaluate(async () => {
    const { Renderer67 } = await import('/src/renderer.js');
    await import('/src/fog-shader.js');
    const { createFilmScenes, sampleFilm } = await import('/src/film.js');
    const canvas = document.querySelector('canvas');
    const scene = createFilmScenes().laboratory;
    const sample = sampleFilm(36);
    const frame = { ...sample.camera, time: sample.sceneTime, effects: { grain: 0 } };
    scene.animate(sample.sceneTime);
    const renderer = new Renderer67(canvas, scene.parts, { hdr: true, depth: true, world: true, ground: false, pixelRatio: 1, samples: 4, environment: scene.environment, shadowBounds: scene.shadowBounds });
    const context = renderer.context;
    const timer = context.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!timer) throw new Error('Native GPU timer unavailable');
    const variants = {
      disabled: { volumeFog: { density: 0 } },
      enabled: {},
      tuned: { keyIntensity: 1.3, volumeFog: { ...scene.environment.volumeFog, density: 0.085, anisotropy: 0.6 } },
    };
    const results = {};
    for (const [name, environment] of Object.entries(variants)) {
      frame.environment = environment;
      for (let index = 0; index < 5; index++) renderer.render(frame);
      const samples = [];
      for (let index = 0; index < 20; index++) {
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
      samples.sort((first, second) => first - second);
      renderer.render(frame);
      results[name] = { medianMilliseconds: (samples[9] + samples[10]) / 2, samples, image: canvas.toDataURL('image/png'), glError: context.getError(), estimatedBytes: renderer.memoryPlan.estimatedBytes };
    }
    frame.environment = {};
    renderer.render(frame);
    const first = canvas.toDataURL('image/png');
    renderer.render({ ...frame, time: 4 });
    renderer.render(frame);
    results.deterministicSeek = first === canvas.toDataURL('image/png');
    renderer.dispose();
    return results;
  });
  for (const name of ['disabled', 'enabled', 'tuned']) {
    assert.equal(results[name].glError, 0);
    await writeFile(`artifacts/laboratory-volume-${name}.png`, Buffer.from(results[name].image.split(',')[1], 'base64'));
    delete results[name].image;
  }
  assert.equal(results.deterministicSeek, true);
  await writeFile('artifacts/volumetric-benchmark.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

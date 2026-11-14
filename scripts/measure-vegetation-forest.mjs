// Draws a 5,000-tree forest on rolling terrain at a fixed camera, once with every tree at its full level and once with
// impostor cards from level 3, in headless Chrome (SwiftShader unless `--gpu`). It writes both pictures to
// artifacts/forest-pair and prints, as JSON: triangles and draw calls counted at the WebGL calls, GPU frame time per
// interleaved run (timer queries, else a pixel read), and the impostor bake time per run.
// `--runs N` sets how many interleaved plain/cards pairs and bake repeats run (default 3). `--from L` sets the first card level.
// Score the pair with: uv run --no-project --python 3.12 --with flip-evaluator --with pillow --with numpy python -I scripts/flip-pair.py
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const port = 5188;
const useGpu = process.argv.includes('--gpu');
const optionValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const runs = optionValue('--runs', 3);
const firstCardLevel = optionValue('--from', 3);
const bakeLevel = optionValue('--bake-level', undefined);
const fadeBand = optionValue('--fade', undefined);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`The server exited ${code}.`)));
  });
  const args = useGpu ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
  browser = await chromium.launch({ headless: true, args });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.error(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  let result;
  for (let attempt = 0; attempt < 4 && !result; attempt++) {
    try {
      result = await page.evaluate(async ({ runs, firstCardLevel, bakeLevel, fadeBand }) => {
        const { scatterVegetation, selectLevels, prepareImpostors } = await import('/src/vegetation.js');
        const { createTerrain } = await import('/src/terrain.js');
        const { CrucibleRenderer } = await import('/src/renderer.js');

        // Counts draw calls and triangles at the WebGL calls, so the numbers include the terrain.
        const counters = { drawCalls: 0, triangles: 0 };
        const prototype = WebGL2RenderingContext.prototype;
        const count = (mode, vertices, instances = 1) => {
          counters.drawCalls += 1;
          if (mode === WebGL2RenderingContext.TRIANGLES) counters.triangles += (vertices / 3) * instances;
        };
        const wrap = (name, onCall) => {
          const original = prototype[name];
          prototype[name] = function wrapped(...parameters) {
            onCall(parameters);
            return original.apply(this, parameters);
          };
        };
        wrap('drawElements', ([mode, vertices]) => count(mode, vertices));
        wrap('drawArrays', ([mode, , vertices]) => count(mode, vertices));
        wrap('drawElementsInstanced', ([mode, vertices, , , instances]) => count(mode, vertices, instances));
        wrap('drawArraysInstanced', ([mode, , vertices, instances]) => count(mode, vertices, instances));

        const side = Math.sqrt(5000 / 0.0035);
        const terrain = createTerrain({
          size: 1400, resolution: 32, chunks: 16, levels: 4, seed: 7,
          height: { amplitude: 9, featureSize: 140, octaves: 4, warp: 24, mountainMask: () => 0 },
        });
        const buildForest = () => scatterVegetation({
          area: { minX: -side / 2, maxX: side / 2, minZ: -side / 2, maxZ: side / 2 }, density: 0.0035, terrainHeight: terrain.heightAt, slopeLimit: 38,
          mix: { broadleaf: 3, birch: 1.5, conifer: 2, bush: 2, palm: 0.6 }, seed: 5,
        });
        const forest = buildForest();
        const bakeOptions = bakeLevel === undefined ? {} : { level: bakeLevel };
        const bake = prepareImpostors(forest.variants, bakeOptions);
        const eyeX = 0;
        const eyeZ = -side / 2 + 20;
        const frame = { eye: [eyeX, terrain.heightAt(eyeX, eyeZ) + 4, eyeZ], target: [0, terrain.heightAt(0, 200) + 12, 200], up: [0, 1, 0], fov: 45, near: 0.5, far: 1500, time: 1, wind: 0 };
        terrain.update(frame.eye);

        const canvas = document.createElement('canvas');
        canvas.width = 960;
        canvas.height = 540;
        document.body.append(canvas);
        const views = {
          plain: selectLevels(forest.instances, frame.eye, { hysteresis: 0 }),
          cards: selectLevels(forest.instances, frame.eye, { impostors: { from: firstCardLevel, fadeBand } }),
        };
        const median = values => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];

        // One run: a fresh renderer, 5 warm-up frames, then 30 frames each wrapped in a timer query.
        const measureRun = async (view, keepPicture) => {
          const renderer = new CrucibleRenderer(canvas, [...terrain.parts, ...view.parts], { ground: false, world: true, samples: 1, pixelRatio: 1 });
          const context = renderer.context;
          const timer = context.getExtension('EXT_disjoint_timer_query_webgl2');
          const pixel = new Uint8Array(4);
          const finish = () => context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
          for (let warm = 0; warm < 5; warm++) {
            renderer.render(frame);
            finish();
          }
          counters.drawCalls = 0;
          counters.triangles = 0;
          renderer.render(frame);
          finish();
          const drawCalls = counters.drawCalls;
          const triangles = counters.triangles;
          const milliseconds = [];
          const queries = [];
          for (let sample = 0; sample < 30; sample++) {
            const started = performance.now();
            let query = null;
            if (timer) {
              query = context.createQuery();
              context.beginQuery(timer.TIME_ELAPSED_EXT, query);
            }
            renderer.render(frame);
            if (timer) {
              context.endQuery(timer.TIME_ELAPSED_EXT);
              queries.push(query);
            }
            finish();
            milliseconds.push(performance.now() - started);
          }
          let gpuMilliseconds = null;
          if (timer) {
            const nanoseconds = [];
            for (const query of queries) {
              while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) await new Promise(resolve => setTimeout(resolve, 1));
              if (!context.getParameter(timer.GPU_DISJOINT_EXT)) nanoseconds.push(context.getQueryParameter(query, context.QUERY_RESULT) / 1e6);
              context.deleteQuery(query);
            }
            gpuMilliseconds = nanoseconds.length ? median(nanoseconds) : null;
          }
          renderer.render(frame);
          const picture = keepPicture ? canvas.toDataURL('image/png') : null;
          renderer.dispose?.();
          return { drawCalls, triangles, gpuMilliseconds, frameMilliseconds: median(milliseconds), picture };
        };

        const measurements = { plain: [], cards: [] };
        const pictures = {};
        for (let run = 0; run < runs; run++) {
          for (const mode of run % 2 === 0 ? ['plain', 'cards'] : ['cards', 'plain']) {
            const measurement = await measureRun(views[mode], run === 0);
            if (measurement.picture) pictures[mode] = measurement.picture;
            delete measurement.picture;
            measurements[mode].push(measurement);
          }
        }
        // Each bake repeat starts from fresh variants, because a baked atlas is cached on its variant.
        const bakeMilliseconds = [bake.milliseconds];
        for (let run = 1; run < runs; run++) bakeMilliseconds.push(prepareImpostors(buildForest().variants, bakeOptions).milliseconds);

        return {
          trees: forest.instances.length, counts: forest.counts, bake, bakeMilliseconds,
          selectedTriangles: { plain: views.plain.triangles, cards: views.cards.triangles }, cards: views.cards.impostors,
          measurements, pictures,
        };
      }, { runs, firstCardLevel, bakeLevel, fadeBand });
    } catch (error) {
      if (!/context was destroyed/.test(error.message)) throw error;
      await page.waitForLoadState('load');
    }
  }
  await mkdir('artifacts/forest-pair', { recursive: true });
  for (const [name, picture] of Object.entries(result.pictures)) await writeFile(`artifacts/forest-pair/${name}.png`, Buffer.from(picture.split(',')[1], 'base64'));
  delete result.pictures;
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  server.kill();
}

// Frame-difference pop test: dollies a camera slowly across the level boundary where trees become impostor cards and
// compares the largest single-frame change with a hard switch at the same place.
// It draws in headless Chrome (SwiftShader, no GPU) from the Vite dev server, and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';

// A pop is a single-frame change of the mean RGB value (0 to 1) above this, or above this share of the change a hard switch
// makes in one frame. Measured 2026-11-04 on SwiftShader: the fade's largest step is 0.083, a hard switch is 0.30, and plain
// camera motion over the same dolly changes a frame by 0.006 on average and 0.010 at most.
const POP_THRESHOLD = 0.1;
const HARD_SWITCH_RATIO = 0.4;

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

async function evaluateWithRetry(page, task, argument) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(task, argument);
    } catch (error) {
      if (attempt >= 3 || !/context was destroyed/.test(error.message)) throw error;
      await page.waitForLoadState('load');
    }
  }
}

// Draws one frame per camera distance and returns the mean absolute RGB change (0 to 1) between neighbouring frames.
async function frameChanges(page, settings) {
  return evaluateWithRetry(page, async (options) => {
    const { scatterVegetation, selectLevels, prepareImpostors } = await import('/src/vegetation.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const forest = scatterVegetation({ area: { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }, density: 0.05, mix: { broadleaf: 1 }, seed: 5 });
    const tree = forest.instances.slice(0, 1);
    prepareImpostors(forest.variants, { frameSize: 96 });
    const width = 320;
    const height = 180;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = width;
    copy.height = height;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const changes = [];
    let previous = null;
    for (let step = 0; step <= options.steps; step++) {
      const distance = options.start + (options.end - options.start) * step / options.steps;
      const eye = [tree[0].position[0], 4, tree[0].position[2] + distance];
      const view = selectLevels(tree, eye, { impostors: { from: 3 }, fade: options.fade, distanceScale: options.distanceScale });
      const renderer = new CrucibleRenderer(canvas, view.parts, { ground: true, world: true, samples: 1, pixelRatio: 1 });
      renderer.render({ eye, target: [tree[0].position[0], 6, tree[0].position[2]], up: [0, 1, 0], fov: 50, near: 0.5, far: 1500, time: 1, wind: 0 });
      copyContext.drawImage(canvas, 0, 0);
      const pixels = copyContext.getImageData(0, 0, width, height).data;
      renderer.dispose?.();
      if (previous) {
        let total = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          total += Math.abs(pixels[index] - previous[index]) + Math.abs(pixels[index + 1] - previous[index + 1]) + Math.abs(pixels[index + 2] - previous[index + 2]);
        }
        changes.push(total / (pixels.length / 4 * 3 * 255));
      }
      previous = pixels;
    }
    return changes;
  }, settings);
}

test('a slow dolly across the impostor boundary shows no pop in a frame difference', async (context) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(context, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchChrome(chromium);
    } catch (error) {
      skipOrThrow(context, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    // One tree fills the view. With the switch distances scaled by 0.05 its card begins at 7.5 m, so the dolly from 6 to 9.5 m crosses the whole fade band.
    const crossing = { start: 6, end: 9.5, steps: 40, fade: 0.06, distanceScale: 0.05 };
    const withFade = await frameChanges(page, crossing);
    const hardSwitch = await frameChanges(page, { ...crossing, fade: 0.0001 });
    const largest = values => Math.max(...values);
    console.log(JSON.stringify({ withFade: largest(withFade), hardSwitch: largest(hardSwitch) }));
    assert.ok(largest(withFade) < POP_THRESHOLD, `the fade jumps ${largest(withFade)} in one frame`);
    assert.ok(largest(withFade) < largest(hardSwitch) * HARD_SWITCH_RATIO, `the fade jumps ${largest(withFade)} against ${largest(hardSwitch)} for a hard switch`);
  } finally {
    await browser?.close();
    server.kill();
  }
});

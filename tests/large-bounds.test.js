// A model hundreds of units wide, framed with explicit near and far, must still draw (issue 495).
// It draws in headless Chrome (SwiftShader, no GPU) from the Vite dev server, and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';

const MODEL_SIZES = [4, 26, 65, 400, 4000];
const BACKGROUND = [37, 41, 45];

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

async function drawnPixelCounts(page, sizes) {
  const task = async (options) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = 128;
    copy.height = 128;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const counts = [];
    for (const size of options.sizes) {
      const matrix = new Float32Array([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, -size * 0.1, size * 0.2, size * 0.3, 1]);
      const part = { name: 'model', geometry: box(0, 1), matrix, material: { tag: 'surface', color: [0.8, 0.3, 0.2], metallic: 0, roughness: 0.6, emission: 0 } };
      const renderer = new CrucibleRenderer(canvas, [part], { ground: false, samples: 1, pixelRatio: 1 });
      const distance = size * 3;
      renderer.render({ eye: [distance, distance * 0.6, distance], target: [-size * 0.1, size * 0.2, size * 0.3], near: distance / 100, far: distance * 10 });
      copyContext.drawImage(canvas, 0, 0);
      const pixels = copyContext.getImageData(0, 0, 128, 128).data;
      let drawn = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const difference = Math.abs(pixels[index] - options.background[0]) + Math.abs(pixels[index + 1] - options.background[1]) + Math.abs(pixels[index + 2] - options.background[2]);
        if (difference > 12) drawn++;
      }
      counts.push(drawn);
      renderer.dispose?.();
    }
    return counts;
  };
  return page.evaluate(task, { sizes, background: BACKGROUND });
}

test('a model from 4 to 4000 units wide draws with explicit near and far', async (context) => {
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
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const counts = await drawnPixelCounts(page, MODEL_SIZES);
    counts.forEach((count, index) => assert.ok(count > 500, `a model ${MODEL_SIZES[index]} units wide drew ${count} pixels`));
  } finally {
    await browser?.close();
    server.kill();
  }
});

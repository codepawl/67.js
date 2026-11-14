// Ambient occlusion must leave a flat wall alone (issue #1126): the pass once drew vertical bands on walls seen at a slant,
// because it rebuilt each depth sample's position at the requested uv instead of at the centre of the texel it read.
// It draws in headless Chrome (SwiftShader, no GPU) from the Vite dev server, and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';

const IMAGE_SIZE = 160;
// Differences in 8-bit display values. The blur and the noise leave a flat wall within one level of the pass-free frame.
const FLAT_WALL_TOLERANCE = 1;

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

// One wide wall with nothing near it, seen from a slant, drawn with and without ambient occlusion.
async function drawWall(page) {
  const task = async (imageSize) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = imageSize;
    canvas.height = imageSize;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = imageSize;
    copy.height = imageSize;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const scaled = (sx, sy, sz, x, y, z) => new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
    const wall = { name: 'wall', geometry: box(0, 1), matrix: scaled(20, 6, 0.1, 0, 3, 0), material: { id: 'wall-mat', tag: 'surface', color: [0.8, 0.78, 0.72], metallic: 0, roughness: 0.9 } };
    const renderer = new CrucibleRenderer(canvas, [wall], { ground: false, world: true, samples: 1, pixelRatio: 1, depth: true });
    renderer.resize();
    const camera = { eye: [6, 3, 4], target: [0, 3, 0], fov: 40, up: [0, 1, 0] };
    const frames = {};
    for (const [name, strength] of [['off', 0], ['on', 0.8]]) {
      const frame = { ...camera, time: 0, wind: 0, exposure: 1, effects: { ambientOcclusion: strength, ambientOcclusionRadius: 0.5 } };
      renderer.render(frame);
      renderer.render(frame);
      copyContext.drawImage(canvas, 0, 0, imageSize, imageSize);
      frames[name] = Array.from(copyContext.getImageData(0, 0, imageSize, imageSize).data);
    }
    renderer.dispose();
    return frames;
  };
  return page.evaluate(task, IMAGE_SIZE);
}

test('ambient occlusion leaves a flat wall seen at a slant within one display level of the frame without it', async (context) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    context.skip('playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      const launchArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
      browser = await chromium.launch({ headless: true, args: launchArgs }).catch(() => chromium.launch({ headless: true, channel: 'chrome', args: launchArgs }));
    } catch (error) {
      context.skip(`Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: IMAGE_SIZE, height: IMAGE_SIZE } });
    page.on('pageerror', (error) => { throw error; });
    await page.goto(`http://127.0.0.1:${port}/`, { timeout: 60000 });
    const frames = await drawWall(page);
    // The middle band of rows, away from the wall's edges, where nothing can occlude.
    let compared = 0;
    let largestDifference = 0;
    for (let row = Math.floor(IMAGE_SIZE * 0.35); row < Math.floor(IMAGE_SIZE * 0.65); row++) {
      for (let column = 8; column < IMAGE_SIZE - 8; column++) {
        const index = (row * IMAGE_SIZE + column) * 4;
        for (let channel = 0; channel < 3; channel++) {
          largestDifference = Math.max(largestDifference, Math.abs(frames.on[index + channel] - frames.off[index + channel]));
        }
        compared++;
      }
    }
    assert.ok(compared > 1000, 'the wall region should cover many pixels');
    assert.ok(largestDifference <= FLAT_WALL_TOLERANCE, `ambient occlusion changed a flat wall by up to ${largestDifference} display levels; it must stay within ${FLAT_WALL_TOLERANCE}`);
  } finally {
    await browser?.close();
    server.kill();
  }
});

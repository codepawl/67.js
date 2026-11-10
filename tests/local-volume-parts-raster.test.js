// Mesh volumes in the rasterizer post pass (issue 807): the bounds of a part, carried through its matrix, draw as an oriented box.
// Draws in headless Chrome (SwiftShader, no GPU) from the Vite dev server and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';

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

// A grey wall at z = 0 seen from z = 5, and a hidden unit-box part "room" turned a quarter about y: its local x lies along -z
// (scale 1), local y along y (scale 2) and local z along +x (scale 3), centred on (0, 0, 2), so it fills x -1.5..1.5, y -1..1, z 1.5..2.5.
async function drawInChrome(page, scenarios) {
  const task = async (list) => {
    const { box } = await import('/src/geometry.js');
    const { Renderer67 } = await import('/src/renderer.js');
    await import('/src/fog-shader.js');
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = 64;
    copy.height = 64;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const material = { tag: 'unlit', color: [0.4, 0.4, 0.4], metallic: 0, roughness: 1, emission: 0 };
    const wall = { name: 'wall', geometry: box(0, 1), matrix: new Float32Array([12, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0.2, 0, 0, 0, -0.1, 1]), material };
    const room = { name: 'room', visible: false, geometry: box(0, 1), matrix: new Float32Array([0, 0, -1, 0, 0, 2, 0, 0, 3, 0, 0, 0, 0, 0, 2, 1]), material };
    const results = [];
    for (const localVolumes of list) {
      const renderer = new Renderer67(canvas, [wall, room], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
      const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes };
      let message = null;
      try {
        renderer.render({ eye: [0, 0, 5], target: [0, 0, 0], fov: 40, time: 0, environment });
      } catch (error) {
        message = error.message;
      }
      copyContext.drawImage(canvas, 0, 0, 64, 64);
      results.push({ message, pixels: Array.from(copyContext.getImageData(0, 0, 64, 64).data), glError: renderer.context.getError() });
      renderer.dispose?.();
    }
    return results;
  };
  return page.evaluate(task, scenarios);
}

test('the rasterizer draws a mesh volume as the oriented bounds of its part and refuses a mesh fit', async (context) => {
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
      browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
    } catch (error) {
      context.skip(`Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const smoke = { density: 2, falloff: 0, steps: 24 };
    const [plain, byPart, byBox, wrongFit, unknown] = await drawInChrome(page, [
      [],
      [{ shape: 'mesh', part: 'room', ...smoke }],
      [{ shape: 'box', center: [0, 0, 2], size: [3, 2, 1], ...smoke }],
      [{ shape: 'mesh', part: 'room', fit: 'mesh' }],
      [{ shape: 'mesh', part: 'hall' }],
    ]);
    assert.equal(byPart.message, null);
    assert.equal(byPart.glError, 0);
    assert.notDeepEqual(byPart.pixels, plain.pixels, 'the part fills a volume that dims the wall');
    assert.deepEqual(byPart.pixels, byBox.pixels, 'the oriented bounds of the turned part draw as the box they equal');
    assert.match(wrongFit.message, /environment\.localVolumes\[0\]\.fit "mesh" is traced by the CPU path tracer only/);
    assert.match(unknown.message, /environment\.localVolumes\[0\]\.part "hall" names no part in the scene; parts: wall, room/);
  } finally {
    await browser?.close();
    server.kill();
  }
});

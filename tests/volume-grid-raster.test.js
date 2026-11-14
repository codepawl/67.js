// A grid volume in the rasterizer (#1045), in headless Chrome on SwiftShader from the Vite dev server (skips when Chrome cannot start).
// A grid of constant density and flame must draw like a plain box volume of the same density and emission, and a grid with a hot temperature
// channel must glow with blackbody light.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { encodeVolumeGrid } from '../src/volume-grid.js';

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', data => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

function constantGrid(channels) {
  const voxels = 4 * 4 * 4;
  return Array.from(encodeVolumeGrid({ resolution: [4, 4, 4], channels: Object.fromEntries(Object.entries(channels).map(([name, value]) => [name, new Float32Array(voxels).fill(value)])) }));
}

// Draws each scenario over a grey wall at z = 0 seen from z = 5, with the grids registered by name.
async function drawScenarios(page, grids, scenarios) {
  const task = async ({ grids: gridBytes, scenarios: list }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { decodeVolumeGrid, registerVolumeGrid } = await import('/src/volume-grid.js');
    await import('/src/fog-shader.js');
    for (const [name, bytes] of Object.entries(gridBytes)) registerVolumeGrid(name, decodeVolumeGrid(new Uint8Array(bytes)));
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = 64;
    copy.height = 64;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const wall = { geometry: box(0, 1), matrix: new Float32Array([12, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0.2, 0, 0, 0, -0.1, 1]), material: { tag: 'unlit', color: [0.4, 0.4, 0.4], metallic: 0, roughness: 1, emission: 0 } };
    const results = [];
    for (const localVolumes of list) {
      const renderer = new CrucibleRenderer(canvas, [wall], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
      const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes };
      renderer.render({ eye: [0, 0, 5], target: [0, 0, 0], fov: 40, time: 0, environment });
      copyContext.drawImage(canvas, 0, 0, 64, 64);
      results.push({ center: Array.from(copyContext.getImageData(32, 32, 1, 1).data), corner: Array.from(copyContext.getImageData(2, 2, 1, 1).data), glError: renderer.context.getError() });
      renderer.dispose?.();
    }
    return results;
  };
  return page.evaluate(task, { grids, scenarios });
}

test('a constant grid draws like the box volume of the same density and emission, and a hot grid glows', async context => {
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
    const place = { center: [0, 0, 1.5], steps: 16 };
    const [plain, smokeBox, smokeGrid, glowBox, glowGrid, hot, cold] = await drawScenarios(
      page,
      { smoke: constantGrid({ density: 1 }), flame: constantGrid({ density: 0, flame: 1 }), hot: constantGrid({ density: 0, temperature: 2500 }) },
      [
        undefined,
        [{ shape: 'box', ...place, size: [1.2, 1.2, 1], density: 1.2, falloff: 0 }],
        [{ shape: 'grid', ...place, size: [1.2, 1.2, 1], density: 1.2, grid: 'smoke' }],
        [{ shape: 'box', ...place, size: [1.2, 1.2, 1], density: 0, falloff: 0, emission: [1, 0.4, 0.1], emissionStrength: 1.5 }],
        [{ shape: 'grid', ...place, size: [1.2, 1.2, 1], density: 0, grid: 'flame', emission: [1, 0.4, 0.1], emissionStrength: 1.5 }],
        [{ shape: 'grid', ...place, size: [1.2, 1.2, 1], density: 0, grid: 'hot', blackbodyIntensity: 1, emissionStrength: 0.2 }],
        [{ shape: 'grid', ...place, size: [1.2, 1.2, 1], density: 0, grid: 'hot', blackbodyIntensity: 0, emissionStrength: 0.2 }],
      ],
    );
    for (const result of [plain, smokeBox, smokeGrid, glowBox, glowGrid, hot, cold]) assert.equal(result.glError, 0);
    assert.ok(smokeGrid.center[0] < plain.center[0] - 20, 'the grid density darkens the wall behind it');
    assert.ok(Math.abs(smokeGrid.center[0] - smokeBox.center[0]) <= 3, `grid ${smokeGrid.center[0]} against box ${smokeBox.center[0]}`);
    assert.ok(Math.abs(glowGrid.center[0] - glowBox.center[0]) <= 3, `grid glow ${glowGrid.center[0]} against box glow ${glowBox.center[0]}`);
    assert.deepEqual(smokeGrid.corner, plain.corner, 'pixels outside the volume are untouched');
    assert.deepEqual(cold.center, plain.center, 'blackbodyIntensity 0 draws no temperature glow');
    assert.ok(hot.center[0] > plain.center[0] + 20, 'a hot grid glows');
    assert.ok(hot.center[0] > hot.center[2], 'blackbody light is warm');
  } finally {
    await browser?.close();
    server.kill();
  }
});

// Lighting render passes (issue 601) drawn for real: diffuse + glossy + emission add back to the beauty frame, and shadow, ao and mist read sensibly.
// It draws in headless Chrome (SwiftShader, no GPU) from the Vite dev server, and skips when Chrome cannot start.
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



// Draws the beauty frame and every lighting pass of a floor with a shiny, an emissive and a rough box above it.
async function drawFrames(page, withEnvironment) {
  const task = async (useEnvironment) => {
    const { box } = await import('/src/geometry.js');
    const { Renderer67 } = await import('/src/renderer.js');
    const { installRenderPasses } = await import('/src/render-passes.js');
    const { readFloatPixels } = await import('/src/float-output.js');
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = 64;
    copy.height = 64;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const geometry = box(0, 1);
    const scaled = (sx, sy, sz, x, y, z) => new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
    const parts = [
      { name: 'floor', geometry, matrix: scaled(8, 0.2, 8, 0, -0.1, 0), material: { tag: 'surface', color: [0.25, 0.25, 0.25], metallic: 0, roughness: 0.7, emission: 0 } },
      { name: 'shiny', geometry, matrix: scaled(1.2, 1.2, 1.2, -1.5, 1, 0), material: { tag: 'surface', color: [0.9, 0.2, 0.2], metallic: 0.8, roughness: 0.25, emission: 0 } },
      { name: 'rough', geometry, matrix: scaled(1.2, 1.2, 1.2, 1.5, 1, 0), material: { tag: 'surface', color: [0.2, 0.5, 0.9], metallic: 0, roughness: 0.6, emission: 0.15 } },
    ];
    const renderer = installRenderPasses(new Renderer67(canvas, parts, { ground: false, samples: 1, pixelRatio: 1 }));
    const size = renderer.canvas.width;
    copy.width = size;
    copy.height = size;
    const camera = { eye: [0, 5, 7], target: [0, 0.6, 0] };
    renderer.render(camera);
    copyContext.drawImage(canvas, 0, 0, size, size);
    const beauty = Array.from(copyContext.getImageData(0, 0, size, size).data);
    const passes = {};
    for (const pass of ['diffuse', 'glossy', 'emission', 'shadow', 'ao', 'mist', 'albedo']) {
      renderer.render({ ...camera, pass, passFloat: true });
      passes[pass] = Array.from(readFloatPixels(renderer.context, renderer.passSupport.framebuffer, size, size));
    }
    return { beauty, passes, size };
  };
  return page.evaluate(task, withEnvironment);
}

// The renderer's tone map and gamma, for the lit radiance that the passes add back up to.
function display(value) {
  const mapped = Math.min(Math.max((value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14), 0), 1);
  return Math.round(255 * mapped ** (1 / 2.2));
}

test('diffuse + glossy + emission match the beauty frame, and shadow, ao and mist read as light terms', async (context) => {
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
    const { beauty, passes, size: SIZE } = await drawFrames(page, false);
    let compared = 0;
    let totalError = 0;
    let largeErrors = 0;
    let glossyEnergy = 0;
    let shadowed = 0;
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const beautyIndex = (row * SIZE + column) * 4;
        // Pass rows come bottom to top, the canvas top to bottom.
        const passIndex = ((SIZE - 1 - row) * SIZE + column) * 4;
        if (passes.albedo[passIndex] + passes.albedo[passIndex + 1] + passes.albedo[passIndex + 2] === 0) continue;
        for (let channel = 0; channel < 3; channel++) {
          const sum = passes.diffuse[passIndex + channel] + passes.glossy[passIndex + channel] + passes.emission[passIndex + channel];
          const difference = Math.abs(display(sum) - beauty[beautyIndex + channel]);
          totalError += difference;
          if (difference > 4) largeErrors++;
          compared++;
        }
        glossyEnergy += passes.glossy[passIndex];
        if (passes.shadow[passIndex] < 0.5) shadowed++;
      }
    }
    assert.ok(compared > 3000, `the frame has ${compared} lit samples`);
    assert.ok(totalError / compared < 1.5, `mean difference ${totalError / compared} display levels`);
    assert.ok(largeErrors / compared < 0.02, `${largeErrors} of ${compared} samples differ by more than 4 levels`);
    assert.ok(glossyEnergy > 1, 'the glossy pass holds light');
    assert.ok(shadowed > 20, `the shadow pass marks ${shadowed} shadowed pixels`);
    for (const name of ['shadow', 'ao', 'mist']) {
      for (let index = 0; index < passes[name].length; index += 4) {
        assert.ok(passes[name][index] >= 0 && passes[name][index] <= 1.001, `${name} stays between zero and one`);
      }
    }
  } finally {
    await browser?.close();
    server.kill();
  }
});

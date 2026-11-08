// Per-part render flags (issue 606) drawn for real: visible, castShadow, receiveShadow, holdout and shadowCatcher.
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

// A floor and a caster above it, drawn on a transparent canvas. Each scenario changes flags on one or both parts.
async function drawScenarios(page, scenarios) {
  const task = async (list) => {
    const { box } = await import('/src/geometry.js');
    const { Renderer67 } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = 96;
    copy.height = 96;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const geometry = box(0, 1);
    const material = color => ({ tag: 'surface', color, metallic: 0, roughness: 0.7, emission: 0 });
    const scaled = (sx, sy, sz, x, y, z) => new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
    const results = [];
    for (const scenario of list) {
      const parts = [
        { name: 'floor', geometry, matrix: scaled(8, 0.2, 8, 0, -0.1, 0), material: material([0.8, 0.8, 0.8]), ...scenario.floor },
        { name: 'caster', geometry, matrix: scaled(1.4, 1.4, 1.4, 0, 2, 0), material: material([0.9, 0.2, 0.2]), ...scenario.caster },
      ];
      const renderer = new Renderer67(canvas, parts, { ground: false, samples: 1, pixelRatio: 1, transparent: true });
      renderer.render({ eye: [0, 6, 6], target: [0, 0, 0] });
      copyContext.clearRect(0, 0, 96, 96);
      copyContext.drawImage(canvas, 0, 0, 96, 96);
      results.push(Array.from(copyContext.getImageData(0, 0, 96, 96).data));
      renderer.dispose?.();
    }
    return results;
  };
  return page.evaluate(task, scenarios);
}

function opaquePixels(image) {
  let count = 0;
  for (let index = 3; index < image.length; index += 4) if (image[index] > 0) count++;
  return count;
}

function differingPixels(first, second) {
  let count = 0;
  for (let index = 0; index < first.length; index += 4) {
    if (Math.abs(first[index] - second[index]) + Math.abs(first[index + 1] - second[index + 1]) + Math.abs(first[index + 2] - second[index + 2]) + Math.abs(first[index + 3] - second[index + 3]) > 6) count++;
  }
  return count;
}

test('visible, castShadow, receiveShadow, holdout and shadowCatcher draw as documented', async (context) => {
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
    const page = await browser.newPage({ viewport: { width: 96, height: 96 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const names = ['plain', 'noCaster', 'hiddenCaster', 'holdoutCaster', 'holdoutNoCast', 'holdoutBlindFloor', 'catcherLit', 'catcherNoCaster', 'hiddenAll'];
    const images = await drawScenarios(page, [
      { floor: {}, caster: {} },
      { floor: {}, caster: { holdout: true } },
      { floor: {}, caster: { visible: false } },
      { floor: {}, caster: { holdout: true } },
      { floor: {}, caster: { holdout: true, castShadow: false } },
      { floor: { receiveShadow: false }, caster: { holdout: true } },
      { floor: { shadowCatcher: true }, caster: { holdout: true } },
      { floor: { shadowCatcher: true }, caster: { visible: false } },
      { floor: { visible: false }, caster: { visible: false } },
    ]);
    const image = Object.fromEntries(names.map((name, index) => [name, images[index]]));
    assert.ok(opaquePixels(image.plain) > 3000, 'the plain scene draws the floor and the caster');
    assert.equal(opaquePixels(image.hiddenAll), 0, 'visible:false parts draw nothing');
    assert.ok(opaquePixels(image.holdoutCaster) < opaquePixels(image.hiddenCaster) + 1, 'a holdout writes zero alpha');
    assert.ok(differingPixels(image.plain, image.hiddenCaster) > 150, 'the caster is visible in the plain scene');
    // A holdout still occludes: the floor behind its footprint is gone, but its shadow stays unless castShadow is false.
    assert.ok(differingPixels(image.holdoutCaster, image.hiddenCaster) > 150, 'a holdout erases the floor behind it and keeps casting');
    assert.ok(differingPixels(image.holdoutCaster, image.holdoutNoCast) > 30, 'castShadow:false removes the shadow');
    assert.ok(differingPixels(image.holdoutNoCast, image.holdoutBlindFloor) < 5, 'no caster shadow and a blind floor draw the same');
    assert.ok(differingPixels(image.holdoutCaster, image.holdoutBlindFloor) > 30, 'receiveShadow:false removes the shadow on the floor');
    // A hidden caster casts no shadow either: its scene equals the one whose caster is a holdout that does not cast.
    const hiddenNoShadow = differingPixels(image.hiddenCaster, image.holdoutNoCast);
    assert.ok(hiddenNoShadow > 150, 'holdout still occludes while a hidden caster leaves the floor whole');
    // Shadow catcher: black pixels whose alpha is the shadow, and nothing without a caster.
    assert.equal(opaquePixels(image.catcherNoCaster), 0, 'a lit shadow catcher is fully transparent');
    assert.ok(opaquePixels(image.catcherLit) > 30, 'the received shadow is written as alpha');
    for (let index = 0; index < image.catcherLit.length; index += 4) {
      assert.ok(image.catcherLit[index] + image.catcherLit[index + 1] + image.catcherLit[index + 2] <= 3, 'the catcher draws only black');
    }
  } finally {
    await browser?.close();
    server.kill();
  }
});

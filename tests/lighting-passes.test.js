// Lighting and auxiliary render passes (issues 601 and 706) drawn for real: diffuse + glossy + emission add back to the
// beauty frame, and shadow, ao, mist, position, velocity, uv, transmission, volume, environment, cryptomatte and aov read accurately.
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

// Draws the beauty frame and every lighting and auxiliary pass of a floor with a shiny, a rough/emissive and a glass box.
async function drawFrames(page) {
  const task = async () => {
    const { box, sphere } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
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
    const uvSphere = sphere(16, 12);
    const scaled = (sx, sy, sz, x, y, z) => new Float32Array([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
    const parts = [
      { name: 'floor', geometry, matrix: scaled(8, 0.2, 8, 0, -0.1, 0), material: { id: 'floor-mat', tag: 'surface', color: [0.25, 0.25, 0.25], metallic: 0, roughness: 0.7, emission: 0, aov: [0.1, 0.2, 0.3] } },
      { name: 'shiny', geometry: uvSphere, matrix: scaled(0.8, 0.8, 0.8, -1.5, 1, 0), material: { id: 'shiny-mat', tag: 'surface', color: [0.9, 0.2, 0.2], metallic: 0.8, roughness: 0.25, emission: 0, aov: [0.8, 0.25, 0.5] } },
      { name: 'rough', geometry: uvSphere, matrix: scaled(0.8, 0.8, 0.8, 1.5, 1, 0), material: { id: 'rough-mat', tag: 'surface', color: [0.2, 0.5, 0.9], metallic: 0, roughness: 0.6, emission: 0.15, aov: [0.2, 0.9, 0.4] } },
    ];
    const renderer = installRenderPasses(new CrucibleRenderer(canvas, parts, { ground: false, samples: 1, pixelRatio: 1 }));
    const size = renderer.canvas.width;
    copy.width = size;
    copy.height = size;
    const camera = { eye: [0, 5, 7], target: [0, 0.6, 0] };
    renderer.render(camera);
    copyContext.drawImage(canvas, 0, 0, size, size);
    const beauty = Array.from(copyContext.getImageData(0, 0, size, size).data);
    const passes = {};
    for (const pass of ['diffuse', 'glossy', 'emission', 'shadow', 'ao', 'mist', 'albedo', 'position', 'velocity', 'uv', 'volume', 'environment', 'cryptomatte', 'aov', 'objectId']) {
      renderer.render({ ...camera, pass, passFloat: true });
      passes[pass] = Array.from(readFloatPixels(renderer.context, renderer.passSupport.framebuffer, size, size));
    }
    // Render velocity with a moved camera and moved shiny box:
    renderer.render({
      ...camera,
      pass: 'velocity',
      passFloat: true,
      previousCamera: { eye: [0.8, 5, 7], target: [0, 0.6, 0] },
      previousMatrices: { shiny: scaled(1.2, 1.2, 1.2, -2.2, 1, 0) },
    });
    const movedVelocity = Array.from(readFloatPixels(renderer.context, renderer.passSupport.framebuffer, size, size));
    const manifest = renderer.passSupport.cryptomatteManifest();

    // Also test transmission pass on a transmissive glass part:
    const glassRenderer = installRenderPasses(new CrucibleRenderer(canvas, [
      ...parts,
      { name: 'glass', geometry, matrix: scaled(1.4, 1.4, 1.4, 0, 1.2, 2.0), material: { id: 'glass-mat', tag: 'surface', color: [0.8, 0.95, 1.0], metallic: 0, roughness: 0.1, emission: 0, transmission: 0.85 } },
    ], { ground: false, samples: 1, pixelRatio: 1 }));
    glassRenderer.render({ ...camera, pass: 'transmission', passFloat: true });
    const transmission = Array.from(readFloatPixels(glassRenderer.context, glassRenderer.passSupport.framebuffer, size, size));
    return { beauty, passes, movedVelocity, manifest, transmission, size };
  };
  return page.evaluate(task);
}

// The renderer's tone map and gamma, for the lit radiance that the passes add back up to.
function display(value) {
  const mapped = Math.min(Math.max((value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14), 0), 1);
  return Math.round(255 * mapped ** (1 / 2.2));
}

test('diffuse + glossy + emission match the beauty frame, and auxiliary passes read exact values', async (context) => {
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
    const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
    await page.goto(`http://127.0.0.1:${port}/`, { timeout: 60000 });
    const { beauty, passes, movedVelocity, manifest, transmission, size: SIZE } = await drawFrames(page);
    let compared = 0;
    let totalError = 0;
    let largeErrors = 0;
    let glossyEnergy = 0;
    let shadowed = 0;
    let environmentEnergy = 0;
    let volumeEnergy = 0;
    let uvPositive = 0;
    let leftPositions = 0;
    let rightPositions = 0;
    let cryptoMatched = 0;
    let aovMatched = 0;
    let movingPixels = 0;
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
        environmentEnergy += passes.environment[passIndex] + passes.environment[passIndex + 1] + passes.environment[passIndex + 2];
        volumeEnergy += passes.volume[passIndex] + passes.volume[passIndex + 1] + passes.volume[passIndex + 2];
        if (passes.shadow[passIndex] < 0.5) shadowed++;
        if (passes.uv[passIndex] > 0.01 || passes.uv[passIndex + 1] > 0.01) uvPositive++;
        assert.ok(Math.abs(passes.velocity[passIndex]) < 1e-4 && Math.abs(passes.velocity[passIndex + 1]) < 1e-4, 'still frame has zero velocity');
        if (Math.hypot(movedVelocity[passIndex], movedVelocity[passIndex + 1]) > 0.01) movingPixels++;
        const objectId = Math.round(passes.objectId[passIndex] * 255);
        if (objectId === 2) {
          // shiny box sits around x = -1.5
          if (passes.position[passIndex] < -0.5) leftPositions++;
          if (Math.abs(passes.cryptomatte[passIndex] - manifest.objects.shiny.value) < 0.01
              && Math.abs(passes.cryptomatte[passIndex + 1] - manifest.materials['shiny-mat'].value) < 0.01
              && Math.abs(passes.cryptomatte[passIndex + 2] - 1) < 0.01) cryptoMatched++;
          if (Math.abs(passes.aov[passIndex] - 0.8) < 0.02 && Math.abs(passes.aov[passIndex + 1] - 0.25) < 0.02) aovMatched++;
        } else if (objectId === 3) {
          // rough box sits around x = +1.5
          if (passes.position[passIndex] > 0.5) rightPositions++;
        }
      }
    }
    assert.ok(compared > 3000, `the frame has ${compared} lit samples`);
    assert.ok(totalError / compared < 1.5, `mean difference ${totalError / compared} display levels`);
    assert.ok(largeErrors / compared < 0.02, `${largeErrors} of ${compared} samples differ by more than 4 levels`);
    assert.ok(glossyEnergy > 1, 'the glossy pass holds light');
    assert.ok(environmentEnergy > 1, 'the environment pass holds IBL/sky light');
    assert.ok(volumeEnergy > 0.1, 'the volume pass holds fog scattering');
    assert.ok(shadowed > 20, `the shadow pass marks ${shadowed} shadowed pixels`);
    assert.ok(uvPositive > 50, `the uv pass writes UVs on ${uvPositive} pixels`);
    assert.ok(leftPositions > 40 && rightPositions > 40, `position pass separates -X (${leftPositions}) and +X (${rightPositions})`);
    assert.ok(cryptoMatched > 40, `cryptomatte matches manifest on ${cryptoMatched} shiny pixels`);
    assert.ok(aovMatched > 40, `aov pass matches material.aov on ${aovMatched} shiny pixels`);
    assert.ok(movingPixels > 500, `velocity pass records motion on ${movingPixels} pixels`);
    const transmissionEnergy = transmission.reduce((sum, value, index) => (index % 4 < 3 ? sum + value : sum), 0);
    assert.ok(transmissionEnergy > 1, `transmission pass holds transmitted light (${transmissionEnergy})`);
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

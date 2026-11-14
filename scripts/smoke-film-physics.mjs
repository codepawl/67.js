import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const PORT = 5192;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { windowsHide: true, stdio: 'pipe' });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('The film physics smoke server did not start.')), 30000);
  server.stdout.on('data', bytes => {
    if (bytes.toString().includes(`127.0.0.1:${PORT}`)) {
      clearTimeout(timeout);
      resolve();
    }
  });
  server.on('error', reject);
});
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ ...(existsSync(chrome) ? { executablePath: chrome } : {}), headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const report = {};
try {
  for (const [name, width, height] of [['wide', 960, 540], ['portrait', 540, 960]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/src/film.js', route => route.fulfill({ contentType: 'application/javascript', body: "export * from '/build/film.js';" }));
    await page.route('**/src/renderer.js', route => route.fulfill({ contentType: 'application/javascript', body: "export { CrucibleRenderer } from '/build/67.module.js';" }));
    await page.goto(`http://127.0.0.1:${PORT}/film.html?export=1&width=${width}&height=${height}`);
    await page.waitForFunction(() => window.__filmReady);
    const result = await page.evaluate(() => {
      const scene = window.__film.scenes.apparatus;
      const balls = scene.parts.filter(part => part.name.startsWith('Cradle ball '));
      const renderer = window.__film.renderer;
      const buffers = renderer.batches.map(batch => batch.instanceBuffer);
      const matrices = balls.map(part => part.matrix);
      const canvas = document.querySelector('#film-canvas');
      window.renderAt(1);
      const firstPixels = new Uint8Array(canvas.width * canvas.height * 4);
      renderer.context.readPixels(0, 0, canvas.width, canvas.height, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, firstPixels);
      const first = canvas.toDataURL('image/png');
      const positions = balls.map(part => Array.from(part.matrix));
      const allPositions = scene.parts.map(part => Array.from(part.matrix));
      const instances = renderer.batches.map(batch => Array.from(batch.instanceData));
      window.renderAt(3);
      const different = canvas.toDataURL('image/png');
      window.renderAt(1);
      const repeatedPixels = new Uint8Array(firstPixels.length);
      renderer.context.readPixels(0, 0, canvas.width, canvas.height, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, repeatedPixels);
      const repeated = canvas.toDataURL('image/png');
      let changedChannels = 0;
      let maximumDifference = 0;
      let totalDifference = 0;
      for (let index = 0; index < firstPixels.length; index++) {
        const difference = Math.abs(firstPixels[index] - repeatedPixels[index]);
        if (difference) changedChannels++;
        maximumDifference = Math.max(maximumDifference, difference);
        totalDifference += difference;
      }
      const result = {
        first, different, repeated,
        sameRenderer: renderer === window.__film.renderer,
        buffersRetained: renderer.batches.every((batch, index) => batch.instanceBuffer === buffers[index]),
        matricesRetained: balls.every((part, index) => part.matrix === matrices[index]),
        posesRepeated: balls.every((part, index) => Array.from(part.matrix).every((component, axis) => component === positions[index][axis])),
        allPosesRepeated: scene.parts.every((part, index) => Array.from(part.matrix).every((component, axis) => component === allPositions[index][axis])),
        instancesRepeated: renderer.batches.every((batch, index) => Array.from(batch.instanceData).every((component, axis) => component === instances[index][axis])),
        glError: renderer.context.getError(),
        estimatedBytes: renderer.memoryPlan.estimatedBytes,
        changedChannels, maximumDifference, meanDifference: totalDifference / firstPixels.length,
      };
      renderer.dispose();
      return result;
    });
    assert.deepEqual(errors, []);
    assert.equal(result.glError, 0);
    await writeFile(`artifacts/cradle-${name}-repeat.png`, Buffer.from(result.repeated.split(',')[1], 'base64'));
    // Allow bounded one-byte output rounding; poses and packed instances must match exactly.
    assert.ok(result.maximumDifference <= 1 && result.meanDifference <= 0.00001, JSON.stringify({ changedChannels: result.changedChannels, maximumDifference: result.maximumDifference, meanDifference: result.meanDifference }));
    assert.equal(result.first !== result.different, true);
    for (const field of ['sameRenderer', 'buffersRetained', 'matricesRetained', 'posesRepeated', 'allPosesRepeated', 'instancesRepeated']) assert.equal(result[field], true);
    const image = Buffer.from(result.first.split(',')[1], 'base64');
    await writeFile(`artifacts/cradle-${name}.png`, image);
    delete result.first;
    delete result.different;
    delete result.repeated;
    report[name] = { ...result, sha256: createHash('sha256').update(image).digest('hex'), width, height };
    await page.close();
  }
  await writeFile('artifacts/film-physics-gpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.kill();
}

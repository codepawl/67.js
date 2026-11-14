import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/morph-smoke.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:640px;height:480px;display:block"></canvas>' }));
  await page.goto('http://127.0.0.1:5173/morph-smoke.html');
  const report = await page.evaluate(async () => {
    const { CrucibleRenderer, box, createMorphPose } = await import('/build/67.module.js');
    const { mat4 } = await import('/node_modules/gl-matrix/esm/index.js');
    const geometry = box();
    const deltas = new Float32Array(geometry.positions.length);
    for (let index = 0; index < deltas.length; index += 3) {
      deltas[index] = 0.5;
      deltas[index + 1] = 0.25;
    }
    const targets = Array.from({ length: 64 }, () => ({ positions: new Float32Array(deltas.length) }));
    targets[63] = { positions: deltas };
    geometry.morphTargets = targets;
    const firstPose = createMorphPose(64);
    const secondPose = createMorphPose(64);
    const canvas = document.querySelector('canvas');
    const material = { tag: 'unlit', color: [0.4, 0.6, 0.8], roughness: 0.7, metallic: 0, emission: 0 };
    const first = { name: 'positive blend', geometry, matrix: mat4.create(), material, morph: firstPose };
    const second = { name: 'negative blend', geometry, matrix: mat4.fromTranslation(mat4.create(), [-1.5, 0, 0]), material, morph: secondPose };
    const options = { ground: false, world: true, samples: 1, pixelRatio: 1, memoryBudgetMiB: 64 };
    const frame = { eye: [2, 2, 6], target: [-0.4, 0, 0], fov: 40, time: 0, effects: { grain: 0, bloom: { strength: 0 } } };
    const renderer = new CrucibleRenderer(canvas, [first, second], options);
    const record = renderer.morphTextures.get(geometry);
    const buffers = renderer.batches.map(batch => batch.instanceBuffer);
    const weights = renderer.batches.map(batch => batch.morphWeights);
    function pixels() {
      renderer.render(frame);
      const output = new Uint8Array(canvas.width * canvas.height * 4);
      const context = renderer.context;
      context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, output);
      return output;
    }
    function checksum(values) {
      let result = 2166136261;
      for (const value of values) result = Math.imul(result ^ value, 16777619) >>> 0;
      return result;
    }
    const neutral = pixels();
    firstPose.weights[63] = 1.5;
    secondPose.weights[63] = -0.5;
    const uncommitted = pixels();
    renderer.updateParts([first, second]);
    const blended = pixels();
    const image = canvas.toDataURL('image/png');
    let retained = true;
    for (let index = 0; index < 60; index++) {
      firstPose.weights[63] = index % 2 ? 1.5 : 0;
      renderer.updateParts([first]);
      pixels();
      retained &&= renderer.morphTextures.get(geometry) === record && renderer.batches.every((batch, batchIndex) => batch.instanceBuffer === buffers[batchIndex] && batch.morphWeights === weights[batchIndex]);
    }
    firstPose.weights[63] = 1.5;
    renderer.updateParts([first]);
    const repeated = pixels();
    const committed = renderer.batches.map(batch => Array.from(batch.morphWeights));
    firstPose.weights[63] = NaN;
    let invalidRejected = false;
    try { renderer.updateParts([first]); } catch { invalidRejected = true; }
    const atomic = renderer.batches.every((batch, index) => Array.from(batch.morphWeights).every((value, target) => value === committed[index][target]));
    firstPose.weights[63] = 1.5;
    const glError = renderer.context.getError();
    const targetBytes = record.bytes;
    const textureCount = renderer.morphTextures.size;
    const batches = renderer.batches.length;
    const memory = renderer.memoryPlan;
    const context = renderer.context;
    const texture = record.texture;
    renderer.dispose();
    const released = !context.isTexture(texture);
    const referenceParts = [first, second].map(part => {
      const positions = new Float32Array(geometry.positions);
      const amount = part.morph.weights[63];
      for (let index = 0; index < positions.length; index++) positions[index] = geometry.positions[index] + deltas[index] * amount;
      return { ...part, morph: undefined, geometry: { positions, normals: geometry.normals, indices: geometry.indices } };
    });
    const reference = new CrucibleRenderer(canvas, referenceParts, options);
    reference.render(frame);
    const referencePixels = new Uint8Array(blended.length);
    reference.context.readPixels(0, 0, canvas.width, canvas.height, reference.context.RGBA, reference.context.UNSIGNED_BYTE, referencePixels);
    const referenceError = reference.context.getError();
    reference.dispose();
    return { neutral: checksum(neutral), uncommitted: checksum(uncommitted), blended: checksum(blended), repeated: checksum(repeated), reference: checksum(referencePixels), retained, invalidRejected, atomic, released, glError, referenceError, targetBytes, textureCount, batches, memory, image };
  });
  assert.deepEqual(errors, []);
  assert.equal(report.glError, 0);
  assert.equal(report.referenceError, 0);
  assert.equal(report.neutral, report.uncommitted);
  assert.notEqual(report.neutral, report.blended);
  assert.equal(report.blended, report.repeated);
  assert.equal(report.blended, report.reference, 'GPU relative blend must match the CPU-authored reference image');
  assert.equal(report.textureCount, 1);
  assert.equal(report.batches, 2);
  for (const field of ['retained', 'invalidRejected', 'atomic', 'released']) assert.equal(report[field], true);
  await writeFile('artifacts/morph-gpu.png', Buffer.from(report.image.split(',')[1], 'base64'));
  delete report.image;
  await writeFile('artifacts/morph-gpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

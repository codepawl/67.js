import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/skin-morph-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: '<canvas style="width:640px;height:480px;display:block"></canvas>',
  }));
  await page.goto('http://127.0.0.1:5173/skin-morph-smoke.html');
  const report = await page.evaluate(async () => {
    const { CrucibleRenderer } = await import('/build/67.module.js');
    const { parseGltf } = await import('/build/gltf.js');
    const { skinnedStripAsset } = await import('/tests/fixtures/skinned-strip.js');
    const bytes = skinnedStripAsset((definition, append) => {
      const position = append(new Float32Array([
        -0.2, 0, 0, 0.2, 0, 0, -0.25, 0, 0, 0.25, 0, 0, -0.35, 0, 0, 0.35, 0, 0,
      ]), 'VEC3');
      definition.accessors[position].min = [-0.35, 0, 0];
      definition.accessors[position].max = [0.35, 0, 0];
      const normal = append(new Float32Array(Array.from({ length: 6 }, () => [0.3, 0, -0.05]).flat()), 'VEC3');
      definition.meshes[0].primitives[0].targets = [{ POSITION: position, NORMAL: normal }];
      definition.meshes[0].weights = [0];
      const input = append(new Float32Array([0, 2]), 'SCALAR');
      const output = append(new Float32Array([0, 1]), 'SCALAR');
      definition.animations[0].samplers.push({ input, output, interpolation: 'LINEAR' });
      definition.animations[0].channels.push({ sampler: 1, target: { node: 1, path: 'weights' } });
    });
    const asset = await parseGltf(bytes);
    const part = asset.parts[0];
    const canvas = document.querySelector('canvas');
    const renderer = new CrucibleRenderer(canvas, asset.parts, { samples: 4, pixelRatio: 1, memoryBudgetMiB: 96 });
    const frame = { eye: [1, 3, 6], target: [1, 3, 0], fov: 40, time: 0, effects: { grain: 0 } };
    const palette = part.skin.jointMatrices;
    const weights = part.morph.weights;
    const skinRecord = renderer.skinTextures.get(part.skin);
    const influenceRecord = renderer.influenceTextures.get(part.geometry);
    const morphRecord = renderer.morphTextures.get(part.geometry);
    function pixels() {
      renderer.updateParts(asset.parts);
      renderer.render(frame);
      return canvas.toDataURL('image/png');
    }
    function sample(time) {
      asset.applyAnimation(time, 0);
      return pixels();
    }
    const straight = sample(0);
    const combined = sample(2);
    const finalPalette = Array.from(palette);
    const finalWeights = Array.from(weights);
    weights[0] = 0;
    const skinOnly = pixels();
    sample(0.5);
    const repeated = sample(2);
    let retained = true;
    for (let index = 0; index < 60; index++) {
      sample(index % 3);
      retained &&= part.skin.jointMatrices === palette && part.morph.weights === weights;
      retained &&= renderer.skinTextures.get(part.skin) === skinRecord;
      retained &&= renderer.influenceTextures.get(part.geometry) === influenceRecord;
      retained &&= renderer.morphTextures.get(part.geometry) === morphRecord;
    }
    const memory = renderer.memoryPlan;
    const context = renderer.context;
    const glError = context.getError();
    const textures = [skinRecord.texture, influenceRecord.texture, morphRecord.texture];
    renderer.dispose();
    const released = textures.every(texture => !context.isTexture(texture));
    asset.dispose();
    return { straight, combined, skinOnly, repeated, finalPalette, finalWeights, retained, released, glError, memory };
  });
  assert.deepEqual(errors, []);
  assert.equal(report.glError, 0);
  assert.equal(report.retained, true);
  assert.equal(report.released, true);
  assert.deepEqual(report.finalWeights, [1]);
  assert.notEqual(report.straight, report.combined);
  assert.notEqual(report.skinOnly, report.combined, 'Imported morph must change pixels while the imported skin pose stays fixed.');
  assert.equal(report.combined, report.repeated);
  await writeFile('artifacts/gltf-skin-morph.png', Buffer.from(report.combined.split(',')[1], 'base64'));
  for (const name of ['straight', 'combined', 'skinOnly', 'repeated']) delete report[name];
  await writeFile('artifacts/gltf-skin-morph-gpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

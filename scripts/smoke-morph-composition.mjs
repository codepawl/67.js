import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/morph-composition.html', route => route.fulfill({
    contentType: 'text/html', body: '<canvas style="width:640px;height:480px;display:block"></canvas>',
  }));
  await page.goto('http://127.0.0.1:5173/morph-composition.html');
  const reports = await page.evaluate(async () => {
    const { CrucibleRenderer, box, createMorphPose, createSkinPose } = await import('/build/67.module.js');
    const { mat4, mat3, quat, vec3 } = await import('/node_modules/gl-matrix/esm/index.js');
    const reports = [];
    for (const mode of ['normals', 'cancellation', 'benchmark']) {
      const geometry = box();
      const positions = new Float32Array(geometry.positions.length);
      const normals = new Float32Array(geometry.normals.length);
      for (let offset = 0; offset < positions.length; offset += 3) {
        positions[offset] = 0.3 + geometry.positions[offset + 1] * 0.15;
        positions[offset + 1] = 0.2;
        for (let component = 0; component < 3; component++) {
          normals[offset + component] = mode === 'cancellation'
            ? -geometry.normals[offset + component]
            : component === 0 ? 0.3 : 0;
        }
      }
      geometry.morphTargets = [{ positions, normals }];
      const morph = createMorphPose(1);
      morph.weights[0] = 1;
      const skin = createSkinPose(1);
      mat4.fromRotationTranslationScale(skin.jointMatrices, quat.setAxisAngle(quat.create(), [0, 0, 1], 0.4), [0.1, 0.3, 0], [1.3, 0.8, 1.1]);
      geometry.skinIndices = new Uint16Array(geometry.positions.length / 3 * 4);
      geometry.skinWeights = new Float32Array(geometry.skinIndices.length);
      for (let influence = 0; influence < geometry.skinWeights.length; influence += 4) geometry.skinWeights[influence] = 1;
      const material = { color: [0.45, 0.5, 0.6], metallic: 0, roughness: 0.8, emission: 0 };
      const part = { name: 'combined deformation', geometry, morph, skin, matrix: mat4.fromScaling(mat4.create(), [1.1, 1, 0.9]), material };
      const floor = { name: 'shadow receiver', geometry: box(), matrix: mat4.fromRotationTranslationScale(mat4.create(), quat.create(), [0, -0.6, 0], [6, 0.1, 6]), material: { ...material, tag: 'floor' } };
      const canvas = document.querySelector('canvas');
      const options = { world: true, ground: false, samples: 1, pixelRatio: 1, memoryBudgetMiB: 64, benchmark: mode === 'benchmark', shadowBounds: { eye: [-3, 6, 4], target: [0, 0, 0], extent: 3, near: 0.1, far: 15 } };
      const frame = { eye: [2, 2, 6], target: [0, 0, 0], fov: 40, time: 0, effects: { grain: 0, bloom: { strength: 0 } } };
      function read(renderer) {
        renderer.render(frame);
        const values = new Uint8Array(canvas.width * canvas.height * 4);
        const context = renderer.context;
        context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, values);
        if (context.getError() !== 0) throw new Error('GPU composition generated a GL error');
        return values;
      }
      const renderer = new CrucibleRenderer(canvas, [part, floor], options);
      const gpuPixels = read(renderer);
      renderer.dispose();
      const referencePositions = new Float32Array(geometry.positions.length);
      const referenceNormals = new Float32Array(geometry.normals.length);
      const normalMatrix = mat3.normalFromMat4(mat3.create(), skin.jointMatrices);
      const vector = vec3.create();
      for (let offset = 0; offset < referencePositions.length; offset += 3) {
        for (let component = 0; component < 3; component++) vector[component] = geometry.positions[offset + component] + positions[offset + component];
        vec3.transformMat4(vector, vector, skin.jointMatrices);
        referencePositions.set(vector, offset);
        for (let component = 0; component < 3; component++) vector[component] = geometry.normals[offset + component] + normals[offset + component];
        if (vec3.length(vector) === 0) vector.set(geometry.normals.subarray(offset, offset + 3));
        vec3.normalize(vector, vector);
        vec3.transformMat3(vector, vector, normalMatrix);
        referenceNormals.set(vector, offset);
      }
      const referencePart = { ...part, skin: undefined, morph: undefined, geometry: { positions: referencePositions, normals: referenceNormals, indices: geometry.indices } };
      const reference = new CrucibleRenderer(canvas, [referencePart, floor], options);
      const cpuPixels = read(reference);
      reference.dispose();
      let maximumDifference = 0;
      let totalDifference = 0;
      let changedChannels = 0;
      for (let index = 0; index < gpuPixels.length; index++) {
        const difference = Math.abs(gpuPixels[index] - cpuPixels[index]);
        maximumDifference = Math.max(maximumDifference, difference);
        totalDifference += difference;
        if (difference) changedChannels++;
      }
      reports.push({ mode, maximumDifference, meanDifference: totalDifference / gpuPixels.length, changedChannels });
    }
    return reports;
  });
  assert.deepEqual(errors, []);
  for (const report of reports) {
    assert.ok(report.maximumDifference <= 3, JSON.stringify(report));
    assert.ok(report.meanDifference < 0.01, JSON.stringify(report));
  }
  await writeFile('artifacts/morph-composition.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}

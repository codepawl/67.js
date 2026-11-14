import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.route('**/volume-smoke.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:960px;height:540px;display:block"></canvas>' }));
  await page.goto('http://127.0.0.1:5173/volume-smoke.html');
  const report = await page.evaluate(async () => {
    const { CrucibleRenderer, box } = await import('/build/67.module.js');
    await import('/build/fog-shader.js');
    const canvas = document.querySelector('canvas');
    const part = { geometry: box(), matrix: new Float32Array([4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 1]), material: { tag: 'unlit', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 1, emission: 0 } };
    const renderer = new CrucibleRenderer(canvas, [part], { hdr: true, depth: true, samples: 4, pixelRatio: 1, ground: false });
    const depthTexture = renderer.depthTexture;
    const colorTexture = renderer.frameTexture;
    const frame = { eye: [0, 0, 5], target: [0, 0, 0], fov: 40, time: 0, environment: { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, volumeFog: { density: 0.5, minimum: [-3, -3, 1], maximum: [3, 3, 3], ambient: [0, 0, 0], noiseAmount: 0, steps: 24 } } };
    const context = renderer.context;
    function sample(density, position = 0, steps = 24, projection = 'perspective') {
      frame.environment.volumeFog.density = density;
      frame.environment.volumeFog.steps = steps;
      frame.projection = projection;
      frame.orthographicHeight = 4;
      part.matrix[14] = position;
      renderer.updateParts([part]);
      renderer.render(frame);
      const pixel = new Uint8Array(4);
      context.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
      return Array.from(pixel);
    }
    const clear = sample(0);
    const behind = sample(0.5);
    const foreground = sample(0.5, 4);
    const inside = sample(0.5, 2);
    const lowSteps = sample(0.5, 0, 8);
    const highSteps = sample(0.5, 0, 48);
    const orthographic = sample(0.5, 0, 24, 'orthographic');
    const repeated = sample(0.5);
    frame.far = 1e7;
    const distantFar = sample(0.5);
    frame.far = 1e8;
    const fartherFar = sample(0.5);
    delete frame.far;
    const retained = renderer.depthTexture === depthTexture && renderer.frameTexture === colorTexture;
    const memory = renderer.memoryPlan;
    const ordinaryPlan = (await import('/src/budget.js')).planRenderSize({ width: 960, height: 540, samples: renderer.samples, hdr: true, bloom: true, geometryBytes: renderer.geometryBytes, textureBytes: renderer.textureBytes });
    const glError = context.getError();
    renderer.dispose();
    const released = !context.isTexture(depthTexture) && !context.isTexture(colorTexture);
    function scatteringSample(castShadow) {
      const background = { ...part, material: { ...part.material, color: [0, 0, 0] } };
      const blocker = { ...background, castShadow, matrix: new Float32Array([0.1, 0, 0, 0, 0, 6, 0, 0, 0, 0, 4, 0, 2.5, 0, 2, 1]) };
      const scatteringRenderer = new CrucibleRenderer(canvas, [background, blocker], {
        hdr: true, depth: true, samples: 4, pixelRatio: 1, ground: false,
        shadowBounds: { eye: [10, 0, 2], target: [0, 0, 2], extent: 5, near: 0.1, far: 20 },
      });
      scatteringRenderer.render({ eye: [0, 0, 5], target: [0, 0, 0], fov: 40, time: 0, environment: {
        lightDirection: [1, 0, 0], keyColor: [1, 1, 1], keyIntensity: 1, fillIntensity: 0, ambientIntensity: 0,
        volumeFog: { density: 0.5, minimum: [-1.5, -1.5, 1], maximum: [1.5, 1.5, 3], color: [1, 1, 1], ambient: [0, 0, 0], noiseAmount: 0, anisotropy: 0 },
      } });
      const pixel = new Uint8Array(4);
      context.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
      const error = context.getError();
      scatteringRenderer.dispose();
      return { pixel: Array.from(pixel), error };
    }
    const illuminated = scatteringSample(false);
    const shadowed = scatteringSample(true);
    canvas.style.width = '1px';
    canvas.style.height = '1px';
    const parallelPart = { ...part, matrix: new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.2, 0, 0.0003, 0, -6000, 1]) };
    const parallelRenderer = new CrucibleRenderer(canvas, [parallelPart], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const parallelFrame = { eye: [0, 0, 0], target: [5e-8, 0, -1], projection: 'orthographic', orthographicHeight: 1, near: 0.1, far: 10000,
      environment: { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, volumeFog: {
        density: 0.0005, minimum: [0.0001, -1, -5000], maximum: [0.0002, 1, -2000], ambient: [0, 0, 0], noiseAmount: 0, maxDistance: 10000,
      } },
    };
    parallelRenderer.render(parallelFrame);
    const parallelPixel = new Uint8Array(4);
    context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, parallelPixel);
    const parallelError = context.getError();
    parallelRenderer.dispose();
    return { clear, behind, foreground, inside, lowSteps, highSteps, orthographic, repeated, distantFar, fartherFar, illuminated, shadowed, parallelPixel: Array.from(parallelPixel), parallelError, retained, released, glError, memory, ordinaryPlan };
  });
  function displayByte(linear) {
    const mapped = Math.min(1, Math.max(0, (linear * (2.51 * linear + 0.03)) / (linear * (2.43 * linear + 0.59) + 0.14)));
    return Math.round(mapped ** (1 / 2.2) * 255);
  }
  assert.equal(report.glError, 0);
  assert.ok(Math.abs(report.clear[0] - displayByte(0.5)) <= 1);
  assert.ok(Math.abs(report.behind[0] - displayByte(0.5 * Math.exp(-1))) <= 1, 'GPU fog must match Beer-Lambert extinction over two scene units');
  assert.deepEqual(report.foreground, report.clear, 'Resolved depth must prevent fog behind an opaque foreground surface');
  assert.ok(report.inside[0] > report.behind[0] && report.inside[0] < report.clear[0]);
  assert.deepEqual(report.lowSteps, report.highSteps);
  assert.deepEqual(report.orthographic, report.behind);
  assert.deepEqual(report.repeated, report.behind);
  assert.deepEqual(report.distantFar, report.behind);
  assert.deepEqual(report.fartherFar, report.behind);
  assert.equal(report.illuminated.error, 0);
  assert.equal(report.shadowed.error, 0);
  assert.ok(report.illuminated.pixel[0] > 30, 'Directional light must illuminate the medium');
  assert.ok(report.shadowed.pixel[0] < report.illuminated.pixel[0] / 4, 'Opaque casters must block scattering without covering the camera ray');
  assert.equal(report.parallelError, 0);
  assert.ok(Math.abs(report.parallelPixel[0] - displayByte(0.5 * Math.exp(-1))) <= 2, 'A small nonzero direction must intersect a distant narrow volume');
  assert.equal(report.retained, true);
  assert.equal(report.released, true);
  assert.equal(report.memory.estimatedBytes - report.ordinaryPlan.estimatedBytes, 960 * 540 * 4);
  await writeFile('artifacts/volumetric-gpu.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

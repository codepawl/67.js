// Density as extinction per metre, and the blur of the light seen through a local volume (issue 855). The pure tests check the field and the
// packing; the browser test draws unlit scenes in the rasterizer (headless Chrome, SwiftShader, Vite dev server) and compares them with the CPU
// path tracer, and skips when Chrome cannot start. Set LOCAL_VOLUME_BLUR_ARTIFACTS to a folder to write the measured numbers there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { applyViewTransform } from '../src/view-transform.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, LOCAL_VOLUME_BLUR_PIXELS } from '../src/local-volumes.js';

const SIZE = 128;
const CPU_SIZE = 32;
const LOOKING_DOWN = { eye: [0, 8, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
const SLAB = { shape: 'box', center: [0, 1.5, 0], size: [1.2, 1, 1.2], falloff: 0, scatter: 0 };

test('blur defaults to 1, accepts 0 to 1 and rejects the rest with the field name', () => {
  assert.equal(resolveLocalVolumes([{ ...SLAB }])[0].blur, 1);
  assert.equal(resolveLocalVolumes([{ ...SLAB, blur: 0 }])[0].blur, 0);
  assert.throws(() => resolveLocalVolumes([{ ...SLAB, blur: 1.5 }]), /blur/);
  assert.throws(() => resolveLocalVolumes([{ ...SLAB, blur: 'a lot' }]), /blur/);
});

test('the packed volume carries its blur in the fourth component of steps, and the buffers say whether any volume blurs', () => {
  const buffers = createLocalVolumeBuffers();
  packLocalVolumes(resolveLocalVolumes([{ ...SLAB, blur: 0.25 }, { ...SLAB, blur: 0 }]), buffers);
  assert.equal(buffers.steps[3], 0.25);
  assert.equal(buffers.steps[7], 0);
  assert.equal(buffers.blurred, true);
  packLocalVolumes(resolveLocalVolumes([{ ...SLAB, blur: 0 }, { ...SLAB, density: 0 }]), buffers);
  assert.equal(buffers.blurred, false, 'a volume with blur 0 or no density never reads the frame');
  assert.ok(LOCAL_VOLUME_BLUR_PIXELS > 0 && LOCAL_VOLUME_BLUR_PIXELS <= 32);
});

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

// Draws a white unlit ground, the extra black parts and the volumes; returns the red channel of every pixel, top row first.
async function drawRaster(page, extraParts, volumes) {
  const task = async ({ size, camera, extraParts: extras, volumes: localVolumes }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    await import('/src/fog-shader.js');
    document.body.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.body.append(canvas);
    const unlit = color => ({ tag: 'unlit', color, metallic: 0, roughness: 1, emission: 0 });
    const scaled = ([width, height, depth], [x, y, z]) => new Float32Array([width, 0, 0, 0, 0, height, 0, 0, 0, 0, depth, 0, x, y, z, 1]);
    const parts = [{ name: 'ground', geometry: box(0, 1), matrix: scaled([40, 0.2, 40], [0, -0.1, 0]), material: unlit([1, 1, 1]) }];
    extras.forEach((extra, index) => parts.push({ name: `black${index}`, geometry: box(0, 1), matrix: scaled(extra.size, extra.center), material: unlit([0, 0, 0]) }));
    const renderer = new CrucibleRenderer(canvas, parts, { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes };
    renderer.render({ ...camera, time: 0, environment, outputFramebuffer: output.framebuffer });
    const pixels = Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    const glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return { pixels, glError };
  };
  const { pixels, glError } = await page.evaluate(task, { size: SIZE, camera: LOOKING_DOWN, extraParts, volumes });
  assert.equal(glError, 0);
  const image = new Float64Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row++) for (let column = 0; column < SIZE; column++) image[row * SIZE + column] = pixels[((SIZE - 1 - row) * SIZE + column) * 4];
  return image;
}

// The display shows aces(light) ^ (1 / 2.2); this undoes both, so the ratio of two frames is the light that got through.
function lightOf(displayed) {
  let low = 0;
  let high = 64;
  for (let round = 0; round < 40; round++) {
    const middle = (low + high) / 2;
    if (applyViewTransform('aces', [middle, middle, middle])[0] ** (1 / 2.2) < displayed) low = middle;
    else high = middle;
  }
  return low;
}

async function cpuTransmittance(volume) {
  const material = { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] };
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const { linear } = await renderPathTracedImage(
    { parts: [{ name: 'ground', geometry, material }], environment: { localVolumes: [volume] }, camera: LOOKING_DOWN },
    { width: CPU_SIZE, height: CPU_SIZE, denoise: false, threads: 1, bounces: 1, samples: 4 },
  );
  const result = new Float64Array(CPU_SIZE * CPU_SIZE);
  for (let pixel = 0; pixel < result.length; pixel++) result[pixel] = linear[pixel * 3];
  return result;
}

const centerOf = image => image[(SIZE / 2) * SIZE + SIZE / 2];

function worstRegionDifference(raster, plain, cpu) {
  const cells = SIZE / 8;
  const scale = CPU_SIZE / SIZE;
  let worst = 0;
  for (let cellRow = 0; cellRow < cells; cellRow++) {
    for (let cellColumn = 0; cellColumn < cells; cellColumn++) {
      let rasterTotal = 0;
      let cpuTotal = 0;
      for (let y = cellRow * 8; y < cellRow * 8 + 8; y++) {
        for (let x = cellColumn * 8; x < cellColumn * 8 + 8; x++) {
          rasterTotal += lightOf(raster[y * SIZE + x]) / lightOf(plain[y * SIZE + x]);
          cpuTotal += cpu[Math.floor(y * scale) * CPU_SIZE + Math.floor(x * scale)];
        }
      }
      worst = Math.max(worst, Math.abs(rasterTotal - cpuTotal) / 64);
    }
  }
  return worst;
}

// The steepest step between neighbouring pixels along the centre row, over the whole range of the row: how sharp the black bar's edge is.
function edgeSharpness(image) {
  const row = SIZE / 2;
  let steepest = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let column = 1; column < SIZE; column++) {
    steepest = Math.max(steepest, Math.abs(image[row * SIZE + column] - image[row * SIZE + column - 1]));
    low = Math.min(low, image[row * SIZE + column]);
    high = Math.max(high, image[row * SIZE + column]);
  }
  return steepest / (high - low);
}

test('density is extinction per metre: a slab of density d and thickness t lets exp(-d t) through, in the rasterizer and the CPU path tracer', async (context) => {
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
      const launchArguments = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
      browser = await chromium.launch({ headless: true, args: launchArguments }).catch(() => chromium.launch({ headless: true, channel: 'chrome', args: launchArguments }));
    } catch (error) {
      context.skip(`Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const numbers = {};
    const plain = await drawRaster(page, [], []);
    const blackBar = { size: [0.3, 0.2, 6], center: [0, 0.1, 0] };

    // Thick smoke hides what is behind it; a haze lets about half through. The slab is 1 m thick (the ray runs straight down).
    for (const [name, density, expected] of [['thick', 3.5, Math.exp(-3.5)], ['haze', 0.7, Math.exp(-0.7)]]) {
      const volume = { ...SLAB, size: [6, 1, 6], density };
      const raster = await drawRaster(page, [], [volume]);
      const rasterLight = lightOf(centerOf(raster)) / lightOf(centerOf(plain));
      assert.ok(Math.abs(rasterLight - expected) < 0.01, `${name}: raster let ${rasterLight} through, Beer-Lambert says ${expected}`);
      const cpu = await cpuTransmittance(volume);
      const cpuLight = cpu[(CPU_SIZE / 2) * CPU_SIZE + CPU_SIZE / 2];
      assert.ok(Math.abs(cpuLight - expected) < 0.01, `${name}: CPU let ${cpuLight} through, Beer-Lambert says ${expected}`);
      numbers[name] = { density, expected: +expected.toFixed(4), raster: +rasterLight.toFixed(4), cpu: +cpuLight.toFixed(4), worstRegionRasterAgainstCpu: +worstRegionDifference(raster, plain, cpu).toFixed(4) };
      assert.ok(numbers[name].worstRegionRasterAgainstCpu < 0.01, `${name}: worst 8 by 8 region ${numbers[name].worstRegionRasterAgainstCpu}`);
    }
    assert.ok(numbers.thick.raster < 0.05, 'a thick smoke leaves under 5 percent of the background');

    // Thin smoke blurs the bar behind it: the edge is less sharp with blur than without, and the same with density 0 volume elsewhere.
    const haze = { ...SLAB, density: 1.2, size: [2.4, 1, 2.4] };
    const sharp = await drawRaster(page, [blackBar], [{ ...haze, blur: 0 }]);
    const blurred = await drawRaster(page, [blackBar], [haze]);
    const clearBar = await drawRaster(page, [blackBar], []);
    numbers.sharpness = { clear: +edgeSharpness(clearBar).toFixed(3), blur0: +edgeSharpness(sharp).toFixed(3), blur1: +edgeSharpness(blurred).toFixed(3) };
    assert.ok(numbers.sharpness.blur1 < numbers.sharpness.blur0 * 0.8, `blur must soften the edge: ${JSON.stringify(numbers.sharpness)}`);

    // Nothing outside the volume's footprint changes: the far left column band sees no volume.
    let outsideChange = 0;
    for (let row = 0; row < SIZE; row++) for (let column = 0; column < 8; column++) outsideChange = Math.max(outsideChange, Math.abs(blurred[row * SIZE + column] - sharp[row * SIZE + column]));
    assert.equal(outsideChange, 0, 'blur stays inside the screen footprint of the volume');

    // An object between the camera and the volume is not smeared into it: next to its edge the light is what blur 0 gives.
    const occluder = { size: [0.5, 0.2, 0.5], center: [0, 3, 0] };
    const withoutBlur = await drawRaster(page, [occluder], [{ ...haze, blur: 0 }]);
    const withBlur = await drawRaster(page, [occluder], [haze]);
    let smear = 0;
    for (let offset = 13; offset <= 16; offset++) smear = Math.max(smear, Math.abs(withBlur[(SIZE / 2) * SIZE + SIZE / 2 + offset] - withoutBlur[(SIZE / 2) * SIZE + SIZE / 2 + offset]));
    numbers.smearNextToObjectInFront = +smear.toFixed(5);
    assert.ok(smear < 0.005, `an object in front smeared into the volume by ${smear}`);
    if (process.env.LOCAL_VOLUME_BLUR_ARTIFACTS) {
      mkdirSync(process.env.LOCAL_VOLUME_BLUR_ARTIFACTS, { recursive: true });
      writeFileSync(join(process.env.LOCAL_VOLUME_BLUR_ARTIFACTS, 'blur-test-numbers.json'), `${JSON.stringify(numbers, null, 2)}\n`);
    }
  } finally {
    await browser?.close();
    server.kill();
  }
});

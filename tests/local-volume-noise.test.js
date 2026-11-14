// Noise in local volumes (issue 808): the CPU path tracer reads the same noise field as the rasterizer's post shader. The pure tests
// check the port; the browser test draws one noisy box in both renderers and compares the light that gets through per region, in
// headless Chrome (SwiftShader) from the Vite dev server, and skips when Chrome cannot start. Set LOCAL_VOLUME_NOISE_ARTIFACTS to a
// folder to also write the compare still and the per-region numbers there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { applyViewTransform } from '../src/view-transform.js';
import { encodePng } from '../src/export-png.js';
import { resolveLocalVolumes, localVolumeProfile } from '../src/local-volumes.js';
import { localVolumeNoise, localVolumeNoiseFactor } from '../src/local-volume-noise.js';

const NOISY_BOX = { shape: 'box', center: [0, 1.5, 0], size: [3, 1, 3], density: 1.2, falloff: 0.3, noiseAmount: 0.9, noiseScale: 3, steps: 32 };
const REGION_TOLERANCE = 0.01;
const MEAN_TOLERANCE = 0.005;

test('the noise is deterministic, stays between 0 and 1 and averages about one half', () => {
  let total = 0;
  let lowest = 1;
  let highest = 0;
  const count = 4000;
  for (let index = 0; index < count; index++) {
    const value = localVolumeNoise(index * 0.37 - 20, Math.sin(index) * 9, index * 0.11);
    assert.equal(value, localVolumeNoise(index * 0.37 - 20, Math.sin(index) * 9, index * 0.11));
    total += value;
    lowest = Math.min(lowest, value);
    highest = Math.max(highest, value);
  }
  assert.ok(lowest >= 0 && highest <= 1);
  assert.ok(Math.abs(total / count - 0.5) < 0.03, `mean ${total / count}`);
  assert.equal(localVolumeNoise(1, 2, 3), localVolumeNoise(1 + 0, 2, 3));
  assert.notEqual(localVolumeNoise(0.5, 0.5, 0.5), localVolumeNoise(7.5, 0.5, 0.5));
});

test('the noise is continuous: a tiny step moves the value a tiny amount', () => {
  for (let index = 0; index < 200; index++) {
    const x = index * 0.173;
    assert.ok(Math.abs(localVolumeNoise(x, 0.4, 0.9) - localVolumeNoise(x + 1e-4, 0.4, 0.9)) < 2e-3);
  }
});

test('noiseAmount 0 leaves the profile alone and a positive amount scales it by mix(1, 2 * noise, amount)', () => {
  const [plain] = resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [4, 4, 4], falloff: 0.5 }]);
  const [noisy] = resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [4, 4, 4], falloff: 0.5, noiseAmount: 0.6, noiseScale: 2 }]);
  const point = [0.3, -0.2, 0.7];
  assert.equal(plain.noiseAmount, 0);
  assert.equal(localVolumeProfile(plain, ...point), 1);
  const noise = localVolumeNoise(point[0] * 2, point[1] * 2, point[2] * 2);
  const expected = 1 + (2 * noise - 1) * 0.6;
  assert.ok(Math.abs(localVolumeNoiseFactor(noisy, ...point) - expected) < 1e-12);
  assert.ok(Math.abs(localVolumeProfile(noisy, ...point) - expected) < 1e-12);
  assert.equal(localVolumeProfile(noisy, 3, 0, 0), 0, 'outside the volume stays clear');
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

const SIZE = 64;
const CPU_SIZE = 32;
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };

// Draws the scene with and without the volume in the rasterizer and returns both frames as floats (RGBA, rows bottom to top).
async function rasterFrames(page, volume) {
  const task = async ({ size, localVolume, camera }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    await import('/src/fog-shader.js');
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.body.append(canvas);
    const material = { tag: 'unlit', color: [1, 1, 1], metallic: 0, roughness: 1, emission: 0 };
    const ground = { name: 'ground', geometry: box(0, 1), matrix: new Float32Array([40, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 40, 0, 0, -0.1, 0, 1]), material };
    const renderer = new CrucibleRenderer(canvas, [ground], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const draw = (localVolumes) => {
      const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes };
      renderer.render({ ...camera, time: 0, environment, outputFramebuffer: output.framebuffer });
      return Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    };
    const frames = { plain: draw([]), filled: draw([localVolume]) };
    frames.glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return frames;
  };
  return page.evaluate(task, { size: SIZE, localVolume: volume, camera: LOOKING_DOWN });
}

// The display shows aces(light) ^ (1 / 2.2); this undoes both for a channel, so the ratio of two frames is the light that got through.
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

// One transmittance per pixel, top row first.
function rasterTransmittance({ plain, filled }) {
  const result = new Float64Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const at = ((SIZE - 1 - row) * SIZE + column) * 4;
      result[row * SIZE + column] = plain[at] > 0 ? lightOf(filled[at]) / lightOf(plain[at]) : 1;
    }
  }
  return result;
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

// The mean over a square cell of a square image of `size` pixels, the cell given in the units of a 64 pixel frame.
function cellMean(values, size, column, row, cell) {
  const scale = size / SIZE;
  let total = 0;
  let count = 0;
  for (let y = Math.floor(row * cell * scale); y < Math.floor((row + 1) * cell * scale); y++) {
    for (let x = Math.floor(column * cell * scale); x < Math.floor((column + 1) * cell * scale); x++) {
      total += values[y * size + x];
      count++;
    }
  }
  return total / count;
}

function writeArtifacts(folder, raster, cpu, regions) {
  mkdirSync(folder, { recursive: true });
  const scale = 4;
  const panel = SIZE * scale;
  const width = panel * 3;
  const pixels = new Uint8Array(width * panel * 4);
  for (let y = 0; y < panel; y++) {
    for (let x = 0; x < panel; x++) {
      const rasterValue = raster[Math.floor(y / scale) * SIZE + Math.floor(x / scale)];
      const cpuValue = cpu[Math.floor(y * CPU_SIZE / panel) * CPU_SIZE + Math.floor(x * CPU_SIZE / panel)];
      const difference = Math.min(1, Math.abs(rasterValue - cpuValue) * 4);
      [rasterValue, cpuValue, difference].forEach((value, index) => {
        const at = (y * width + index * panel + x) * 4;
        pixels.fill(Math.round(Math.max(0, Math.min(1, value)) * 255), at, at + 3);
        pixels[at + 3] = 255;
      });
    }
  }
  writeFileSync(join(folder, 'noise-raster-cpu-difference.png'), encodePng(pixels, width, panel));
  writeFileSync(join(folder, 'noise-transmittance.json'), `${JSON.stringify({
    volume: NOISY_BOX,
    note: 'Left to right in the still: rasterizer, CPU path tracer (4 samples), absolute difference times 4. Transmittance of white light looking down through the box.',
    regionTolerance: REGION_TOLERANCE,
    meanTolerance: MEAN_TOLERANCE,
    regions,
  }, null, 2)}\n`);
}

test('the rasterizer and the CPU path tracer let the same light through a noisy box', async (context) => {
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
    const frames = await rasterFrames(page, NOISY_BOX);
    assert.equal(frames.glError, 0);
    const raster = rasterTransmittance(frames);
    const cpu = await cpuTransmittance(NOISY_BOX);

    const cells = 8;
    const cellSize = SIZE / cells;
    const regions = [];
    for (let row = 0; row < cells; row++) {
      for (let column = 0; column < cells; column++) {
        const rasterMean = cellMean(raster, SIZE, column, row, cellSize);
        const cpuMean = cellMean(cpu, CPU_SIZE, column, row, cellSize);
        regions.push({ column, row, raster: +rasterMean.toFixed(4), cpu: +cpuMean.toFixed(4), difference: +Math.abs(rasterMean - cpuMean).toFixed(4) });
      }
    }
    const meanOf = values => values.reduce((total, value) => total + value, 0) / values.length;
    const rasterMean = meanOf(Array.from(raster));
    const cpuMean = meanOf(Array.from(cpu));
    if (process.env.LOCAL_VOLUME_NOISE_ARTIFACTS) {
      writeArtifacts(process.env.LOCAL_VOLUME_NOISE_ARTIFACTS, raster, cpu, { whole: { raster: +rasterMean.toFixed(4), cpu: +cpuMean.toFixed(4) }, cells: regions });
    }
    const worst = regions.reduce((a, b) => (b.difference > a.difference ? b : a));
    assert.ok(Math.abs(rasterMean - cpuMean) < MEAN_TOLERANCE, `whole frame: raster ${rasterMean} against CPU ${cpuMean}`);
    assert.ok(worst.difference < REGION_TOLERANCE, `worst region ${JSON.stringify(worst)}`);
    const spread = Math.max(...regions.map(region => region.cpu)) - Math.min(...regions.map(region => region.cpu));
    assert.ok(spread > 0.3, `the box must actually dim some regions more than others (spread ${spread})`);
  } finally {
    await browser?.close();
    server.kill();
  }
});

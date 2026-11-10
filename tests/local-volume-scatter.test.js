// Scattering local volumes (issue 855): `scatter` lets a volume return a share of the light it extinguishes, lit by the sky and by the
// key light. The pure tests check the field, the packing and the CPU path tracer's lit and shaded sides; the browser test draws one
// smoke box in the rasterizer (headless Chrome on SwiftShader, from the Vite dev server) and in the CPU path tracer and compares the
// radiance per region. It skips when Chrome cannot start. Set LOCAL_VOLUME_SCATTER_ARTIFACTS to a folder to also write the compare still
// and the per-region numbers there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { applyViewTransform } from '../src/view-transform.js';
import { encodePng } from '../src/export-png.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes } from '../src/local-volumes.js';
import { createLocalVolumeCrossing, meanEnvironmentRadiance } from '../src/path-tracer-volume.js';

const REGION_TOLERANCE = 0.01;
const MEAN_TOLERANCE = 0.005;
const SMOKE_BOX = { shape: 'box', center: [0, 1.5, 0], size: [3, 1.5, 3], density: 1.2, falloff: 0.3, absorption: [0.7, 0.8, 1], scatter: 0.8, steps: 32 };
const SUN_DIRECTION = [1, 0.1, 0];
const SUN_COLOR = [3, 3, 3];
const SKY_LEVEL = 0.15;

test('scatter is a number from 0 to 1 that defaults to 0 and an error names the field and the range', () => {
  const [plain] = resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1] }]);
  assert.equal(plain.scatter, 0);
  const [lit] = resolveLocalVolumes([{ shape: 'sphere', center: [0, 0, 0], radius: 1, scatter: 0.8 }]);
  assert.equal(lit.scatter, 0.8);
  for (const bad of [-0.1, 1.5, Number.NaN, '0.5']) {
    assert.throws(() => resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1], scatter: bad }], 'environment.localVolumes'), /environment\.localVolumes\[0\]\.scatter/);
  }
});

test('a volume that fits a closed mesh refuses scatter and a bounds fit accepts it', () => {
  assert.throws(() => resolveLocalVolumes([{ shape: 'mesh', part: 'room', fit: 'mesh', scatter: 0.5 }], 'environment.localVolumes'), /localVolumes\[0\]\.scatter.*fit "bounds"/);
  const [bounded] = resolveLocalVolumes([{ shape: 'mesh', part: 'room', scatter: 0.5 }]);
  assert.equal(bounded.scatter, 0.5);
});

test('the packed steps carry the scatter in their third component and leave the other packed arrays alone', () => {
  const buffers = createLocalVolumeBuffers();
  const volumes = resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1], steps: 12 }, { shape: 'box', center: [0, 0, 0], size: [1, 1, 1], steps: 12, scatter: 0.4 }]);
  packLocalVolumes(volumes, buffers);
  assert.equal(buffers.steps[2], 0);
  assert.ok(Math.abs(buffers.steps[6] - 0.4) < 1e-6);
  assert.equal(buffers.steps[0], 12);
});

const SUN_TOWARD = (() => {
  const length = Math.hypot(...SUN_DIRECTION);
  return SUN_DIRECTION.map(component => component / length);
})();

// Sends one ray straight down through the box at the given x and returns the light it returns, with the throughput left behind.
function downRay(volume, lighting, x) {
  const crossing = createLocalVolumeCrossing(resolveLocalVolumes([volume]), lighting);
  const throughput = new Float64Array([1, 1, 1]);
  const emitted = new Float64Array(3);
  crossing(x, 4, 0, 0, -1, 0, 8, 0.5, throughput, emitted);
  return { emitted: Array.from(emitted), throughput: Array.from(throughput) };
}

const FULL_SUN = { sun: { direction: SUN_TOWARD, color: SUN_COLOR }, ambient: [0, 0, 0], sunVisibility: () => 1 };

test('in sun a scattering box returns more light on its lit side than on its shaded side', () => {
  const lit = downRay(SMOKE_BOX, FULL_SUN, 1.2).emitted[1];
  const shaded = downRay(SMOKE_BOX, FULL_SUN, -1.2).emitted[1];
  assert.ok(lit > 0 && shaded > 0);
  assert.ok(lit > shaded * 1.3, `lit side ${lit} against shaded side ${shaded}`);
});

test('a volume with scatter 0 draws exactly as it did: no light is added and the throughput is the absorbed share', () => {
  const absorbOnly = { ...SMOKE_BOX, scatter: 0 };
  const { scatter, ...withoutField } = SMOKE_BOX;
  const withLighting = downRay(absorbOnly, FULL_SUN, 0.3);
  const withoutLighting = downRay(withoutField, null, 0.3);
  assert.deepEqual(withLighting.emitted, [0, 0, 0]);
  assert.deepEqual(withLighting, withoutLighting);
  assert.ok(withLighting.throughput[0] < 1);
});

// The sky light per unit of what a ray extinguishes, as a share of the open-sky value (scatter times the sky level).
function skyShare(volume) {
  const sky = { sun: null, ambient: [SKY_LEVEL, SKY_LEVEL, SKY_LEVEL], sunVisibility: () => 1 };
  const result = downRay({ ...volume, falloff: 0 }, sky, 0);
  return result.emitted[1] / ((1 - result.throughput[1]) * 0.8 * SKY_LEVEL);
}

test('the sky lights a thin volume at full strength and a thick one less, through its own depth', () => {
  const thin = skyShare({ ...SMOKE_BOX, center: [0, 1.5, 0], size: [0.1, 0.1, 0.1] });
  const thick = skyShare(SMOKE_BOX);
  assert.ok(thin > 0.9 && thin <= 1, `thin volume sky share ${thin}`);
  assert.ok(thick > 0.3 && thick < 0.85 * thin, `thick volume sky share ${thick} against thin ${thin}`);
});

test('a shaded volume with only the sky around it returns less than the open sky and no sun', () => {
  const sky = { sun: null, ambient: [SKY_LEVEL, SKY_LEVEL, SKY_LEVEL], sunVisibility: () => 1 };
  const result = downRay({ ...SMOKE_BOX, falloff: 0 }, sky, 0);
  assert.ok(result.emitted[1] > 0 && result.emitted[1] < 0.8 * (1 - result.throughput[1]) * SKY_LEVEL);
  const blocked = downRay(SMOKE_BOX, { ...FULL_SUN, sunVisibility: () => 0 }, 1.2);
  assert.deepEqual(blocked.emitted, [0, 0, 0]);
});

test('the mean of an environment map weights each row by its solid angle', () => {
  const data = new Float32Array(4 * 2 * 3).fill(0.5);
  assert.deepEqual(meanEnvironmentRadiance({ width: 4, height: 2, channels: 3, data, intensity: 2 }).map(value => +value.toFixed(6)), [1, 1, 1]);
  assert.deepEqual(meanEnvironmentRadiance(null), [0, 0, 0]);
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
const CPU_SAMPLES = 16;
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const LIGHT = { keyColor: SUN_COLOR, lightDirection: SUN_DIRECTION, keyIntensity: 1, fillIntensity: 0, skyTop: [SKY_LEVEL, SKY_LEVEL, SKY_LEVEL], skyBottom: [SKY_LEVEL, SKY_LEVEL, SKY_LEVEL] };

// The rasterizer's frame for each list of volumes, as floats (RGBA, rows bottom to top).
async function rasterFrames(page, volumeLists) {
  const task = async ({ size, lists, camera, light }) => {
    const { box } = await import('/src/geometry.js');
    const { Renderer67 } = await import('/src/renderer.js');
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
    const renderer = new Renderer67(canvas, [ground], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const frames = lists.map((localVolumes) => {
      renderer.render({ ...camera, time: 0, environment: { ...light, localVolumes }, outputFramebuffer: output.framebuffer });
      return Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    });
    const glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return { frames, glError };
  };
  return page.evaluate(task, { size: SIZE, lists: volumeLists, camera: LOOKING_DOWN, light: LIGHT });
}

// The display shows aces(light) ^ (1 / 2.2); this undoes both for a channel.
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

// One linear value per pixel (the green channel), top row first.
function rasterRadiance(frame) {
  const result = new Float64Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) result[row * SIZE + column] = lightOf(frame[((SIZE - 1 - row) * SIZE + column) * 4 + 1]);
  }
  return result;
}

async function cpuRadiance(volume) {
  const material = { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] };
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const map = { width: 4, height: 2, channels: 3, data: new Float32Array(4 * 2 * 3).fill(SKY_LEVEL), intensity: 1, rotation: 0 };
  const { linear } = await renderPathTracedImage(
    { parts: [{ name: 'ground', geometry, material }], environment: { localVolumes: volume ? [volume] : [], keyColor: SUN_COLOR, lightDirection: SUN_DIRECTION, map }, camera: LOOKING_DOWN },
    { width: CPU_SIZE, height: CPU_SIZE, denoise: false, threads: 1, bounces: 1, samples: CPU_SAMPLES },
  );
  const result = new Float64Array(CPU_SIZE * CPU_SIZE);
  for (let pixel = 0; pixel < result.length; pixel++) result[pixel] = linear[pixel * 3 + 1];
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

function writeArtifacts(folder, raster, cpu, summary) {
  mkdirSync(folder, { recursive: true });
  const scale = 4;
  const panel = SIZE * scale;
  const width = panel * 3;
  const pixels = new Uint8Array(width * panel * 4);
  for (let y = 0; y < panel; y++) {
    for (let x = 0; x < panel; x++) {
      const rasterValue = raster[Math.floor(y / scale) * SIZE + Math.floor(x / scale)];
      const cpuValue = cpu[Math.floor(y * CPU_SIZE / panel) * CPU_SIZE + Math.floor(x * CPU_SIZE / panel)];
      const displayOf = value => applyViewTransform('aces', [value, value, value])[0] ** (1 / 2.2);
      const difference = Math.min(1, Math.abs(rasterValue - cpuValue) * 4);
      [displayOf(rasterValue), displayOf(cpuValue), difference].forEach((value, index) => {
        const at = (y * width + index * panel + x) * 4;
        pixels.fill(Math.round(Math.max(0, Math.min(1, value)) * 255), at, at + 3);
        pixels[at + 3] = 255;
      });
    }
  }
  writeFileSync(join(folder, 'scatter-raster-cpu-difference.png'), encodePng(pixels, width, panel));
  writeFileSync(join(folder, 'scatter-radiance.json'), `${JSON.stringify({
    volume: SMOKE_BOX,
    note: 'Left to right in the still: rasterizer, CPU path tracer (16 samples, 32 px), absolute difference times 4. Linear radiance (green) of a sunlit smoke box seen from above, sun from +x (the right half) over an even grey sky.',
    regionTolerance: REGION_TOLERANCE,
    meanTolerance: MEAN_TOLERANCE,
    ...summary,
  }, null, 2)}\n`);
}

test('the rasterizer and the CPU path tracer light a smoke box alike, and the side toward the sun is brighter', async (context) => {
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
    const { frames: [clear, scatteringOff, scattering], glError } = await rasterFrames(page, [[], [{ ...SMOKE_BOX, scatter: 0 }], [SMOKE_BOX]]);
    assert.equal(glError, 0);
    const { scatter, ...withoutField } = SMOKE_BOX;
    const { frames: [omitted] } = await rasterFrames(page, [[withoutField]]);
    assert.deepEqual(scatteringOff, omitted, 'scatter 0 must draw exactly as a volume with no scatter field');
    assert.notDeepEqual(scatteringOff, scattering);

    const raster = rasterRadiance(scattering);
    const rasterClear = rasterRadiance(clear);
    const cpu = await cpuRadiance(SMOKE_BOX);
    const cpuClear = await cpuRadiance(null);
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
    const worst = regions.reduce((a, b) => (b.difference > a.difference ? b : a));
    const halfMean = (values, size, right) => {
      let total = 0;
      let count = 0;
      for (let y = 0; y < size; y++) {
        for (let x = right ? size / 2 : 0; x < (right ? size : size / 2); x++) {
          total += values[y * size + x];
          count++;
        }
      }
      return total / count;
    };
    const summary = {
      whole: { raster: +rasterMean.toFixed(4), cpu: +cpuMean.toFixed(4) },
      clearGround: { raster: +meanOf(Array.from(rasterClear)).toFixed(4), cpu: +meanOf(Array.from(cpuClear)).toFixed(4) },
      litHalf: { raster: +halfMean(raster, SIZE, true).toFixed(4), cpu: +halfMean(cpu, CPU_SIZE, true).toFixed(4) },
      shadedHalf: { raster: +halfMean(raster, SIZE, false).toFixed(4), cpu: +halfMean(cpu, CPU_SIZE, false).toFixed(4) },
      worstRegion: worst,
      cells: regions,
    };
    if (process.env.LOCAL_VOLUME_SCATTER_ARTIFACTS) writeArtifacts(process.env.LOCAL_VOLUME_SCATTER_ARTIFACTS, raster, cpu, summary);
    assert.ok(Math.abs(rasterMean - cpuMean) < MEAN_TOLERANCE, `whole frame: raster ${rasterMean} against CPU ${cpuMean}`);
    assert.ok(worst.difference < REGION_TOLERANCE, `worst region ${JSON.stringify(worst)}`);
    assert.ok(summary.litHalf.raster > summary.shadedHalf.raster + 0.01, `rasterizer: lit half ${summary.litHalf.raster}, shaded half ${summary.shadedHalf.raster}`);
    assert.ok(summary.litHalf.cpu > summary.shadedHalf.cpu + 0.01, `CPU: lit half ${summary.litHalf.cpu}, shaded half ${summary.shadedHalf.cpu}`);
  } finally {
    await browser?.close();
    server.kill();
  }
});

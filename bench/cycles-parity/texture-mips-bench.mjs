// Does a mip chain lower the error of a minified texture at low sample counts, and leave a magnified one alone? (#896)
//   node bench/cycles-parity/texture-mips-bench.mjs <outputDirectory> [--width 320] [--height 180] [--seeds 3] [--reference-samples 2048]
//
// The scene is a fine checker on a floor that runs to the horizon, lit by a uniform sky. It is traced with level 0 only and with
// mip levels, at 16 and 64 samples per pixel, and each picture is scored against a level 0 picture of the same scene at the
// reference sample count. relMSE is the mean squared difference over the rows below the horizon over the mean squared reference value there. A
// second camera looks down at the floor from 30 cm, where one texel covers many pixels: mip levels must change nothing there.
// Writes one .f32 file (float32 rgb, rows from the top) per picture and metrics.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNativeInputV2, traceNative } from '../../packages/render-native/index.mjs';
import { createCamera } from '../../src/path-tracer.js';

export const CHECKER_SIDE = 64;
export const CHECKER_CELL = 4;
const FLOOR_UV_PER_METRE = 0.5;
const SKY_RADIANCE = [0.8, 0.8, 0.8];
const SAMPLE_COUNTS = [16, 64];

export const CAMERAS = Object.freeze({
  receding: { eye: [0, 1.5, 6], target: [0, 1.3, -20], fov: 50 },
  magnified: { eye: [0, 0.3, 0.12], target: [0, 0, 0], fov: 30 },
});

export function checkerImage() {
  const data = new Uint8Array(CHECKER_SIDE * CHECKER_SIDE * 4);
  for (let row = 0; row < CHECKER_SIDE; row++) {
    for (let column = 0; column < CHECKER_SIDE; column++) {
      const isLight = ((Math.floor(column / CHECKER_CELL) + Math.floor(row / CHECKER_CELL)) & 1) === 0;
      data.set(isLight ? [220, 220, 220, 255] : [30, 30, 30, 255], (row * CHECKER_SIDE + column) * 4);
    }
  }
  return { width: CHECKER_SIDE, height: CHECKER_SIDE, data };
}

function floorGeometry() {
  const corners = [[-50, 20], [50, 20], [50, -2000], [-50, -2000]];
  return {
    positions: new Float32Array(corners.flatMap(([x, z]) => [x, 0, z])),
    normals: new Float32Array(corners.flatMap(() => [0, 1, 0])),
    uvs: new Float32Array(corners.flatMap(([x, z]) => [x * FLOOR_UV_PER_METRE, z * FLOOR_UV_PER_METRE])),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

/** Traces the checker floor and returns linear rgb floats (width * height * 3, rows from the top). */
export function renderFloor({ cameraName, textureMips, samples, seed, width, height }) {
  const camera = createCamera(CAMERAS[cameraName], width, height);
  const options = { width, height, samples, seed, bounces: 2, textureMips, backgroundColor: SKY_RADIANCE };
  const input = buildNativeInputV2(
    {
      materials: [{ color: [1, 1, 1], roughness: 1, metallic: 0, map: { image: checkerImage(), colorSpace: 'srgb' } }],
      instances: [{ geometry: floorGeometry(), materialIndex: 0 }],
      lights: {},
    },
    camera,
    options,
  );
  const traced = traceNative(input, { ...options, kernel: 'cycles' });
  const rgb = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgb.set(traced.rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  }
  return rgb;
}

/** Mean squared difference over the rows from `firstRow` down, over the mean squared reference value there. */
export function relativeMeanSquaredError(image, reference, width, height, firstRow) {
  let squaredDifference = 0;
  let squaredReference = 0;
  for (let index = firstRow * width * 3; index < width * height * 3; index++) {
    squaredDifference += (image[index] - reference[index]) ** 2;
    squaredReference += reference[index] ** 2;
  }
  return squaredDifference / squaredReference;
}

export function maxAbsoluteDifference(first, second) {
  let largest = 0;
  for (let index = 0; index < first.length; index++) {
    largest = Math.max(largest, Math.abs(first[index] - second[index]));
  }
  return largest;
}

function parseCommandLine(argumentList) {
  const read = (flagName, fallbackValue) => {
    const flagIndex = argumentList.indexOf(flagName);
    return flagIndex === -1 ? fallbackValue : Number(argumentList[flagIndex + 1]);
  };
  if (argumentList.length === 0 || argumentList[0].startsWith('--')) {
    throw new RangeError('Usage: node bench/cycles-parity/texture-mips-bench.mjs <outputDirectory> [--width 320] [--height 180] [--seeds 3] [--reference-samples 2048]');
  }
  return {
    outputDirectory: resolve(argumentList[0]),
    width: read('--width', 320),
    height: read('--height', 180),
    seedCount: read('--seeds', 3),
    referenceSamples: read('--reference-samples', 2048),
  };
}

async function writePicture(outputDirectory, name, rgb) {
  await writeFile(join(outputDirectory, `${name}.f32`), Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength));
}

async function runCameraSweep(settings, cameraName, metrics) {
  const { outputDirectory, width, height, seedCount, referenceSamples } = settings;
  // The horizon of the receding camera sits a pixel or two above the middle of the picture; the magnified camera sees only floor.
  const firstRow = cameraName === 'receding' ? Math.floor(height / 2) + 2 : 0;
  const reference = renderFloor({ cameraName, textureMips: false, samples: referenceSamples, seed: 4242, width, height });
  await writePicture(outputDirectory, `${cameraName}-reference`, reference);
  metrics[cameraName] = { referenceSamples, firstRow, runs: [] };
  for (const samples of SAMPLE_COUNTS) {
    const errors = { off: [], on: [] };
    let largestDifference = 0;
    for (let seed = 1; seed <= seedCount; seed++) {
      const off = renderFloor({ cameraName, textureMips: false, samples, seed, width, height });
      const on = renderFloor({ cameraName, textureMips: true, samples, seed, width, height });
      errors.off.push(relativeMeanSquaredError(off, reference, width, height, firstRow));
      errors.on.push(relativeMeanSquaredError(on, reference, width, height, firstRow));
      largestDifference = Math.max(largestDifference, maxAbsoluteDifference(off, on));
      if (seed === 1) {
        await writePicture(outputDirectory, `${cameraName}-off-${samples}spp`, off);
        await writePicture(outputDirectory, `${cameraName}-on-${samples}spp`, on);
      }
    }
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    metrics[cameraName].runs.push({
      samples,
      seeds: seedCount,
      relMseOff: mean(errors.off),
      relMseOn: mean(errors.on),
      relMseOffPerSeed: errors.off,
      relMseOnPerSeed: errors.on,
      largestPixelDifferenceOnVsOff: largestDifference,
    });
  }
}

async function runCli() {
  const settings = parseCommandLine(process.argv.slice(2));
  await mkdir(settings.outputDirectory, { recursive: true });
  const metrics = { width: settings.width, height: settings.height };
  await runCameraSweep(settings, 'receding', metrics);
  await runCameraSweep(settings, 'magnified', metrics);
  await writeFile(join(settings.outputDirectory, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli();
}

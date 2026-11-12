// Traces an exported scene JSON on packages/render-native and writes linear RGB float32 (.npy) plus timing JSON.
//   node bench/cycles-parity/trace-native.mjs <sceneJsonPath> <outputPrefix> [--kernel legacy|cycles] [--samples 256] [--bounces 8] [--seed 1]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import { buildTraceScene } from '../../src/path-tracer-scene.js';
import * as renderNative from '../../packages/render-native/index.mjs';
import { writeFloat32Npy } from './npy.mjs';
import { reconstructTraceSceneSource } from './scene-bridge.mjs';

const SUPPORTED_KERNELS = new Set(['legacy', 'cycles']);
const SUPPORTED_FILTERS = new Set(['box', 'blackman-harris']);
const SUPPORTED_SAMPLERS = new Set(['white', 'sobol-burley']);

function readFlagValue(argumentList, flagName, fallbackValue) {
  const flagIndex = argumentList.indexOf(flagName);
  if (flagIndex === -1) {
    return fallbackValue;
  }
  const nextValue = argumentList[flagIndex + 1];
  if (nextValue === undefined || nextValue.startsWith('--')) {
    throw new RangeError(`Flag ${flagName} requires a value.`);
  }
  return nextValue;
}

function parseIntegerOption(argumentList, flagName, fallbackValue, minimumValue) {
  const parsed = Number(readFlagValue(argumentList, flagName, fallbackValue));
  if (!Number.isInteger(parsed) || parsed < minimumValue) {
    throw new RangeError(`Option ${flagName} must be an integer >= ${minimumValue}, got ${parsed}.`);
  }
  return parsed;
}

function parseNumberOption(argumentList, flagName, fallbackValue, minimumValue) {
  const parsed = Number(readFlagValue(argumentList, flagName, fallbackValue));
  if (!Number.isFinite(parsed) || parsed < minimumValue) {
    throw new RangeError(`Option ${flagName} must be a finite number >= ${minimumValue}, got ${parsed}.`);
  }
  return parsed;
}

function parseKernelOption(argumentList) {
  const kernel = String(readFlagValue(argumentList, '--kernel', 'legacy'));
  if (!SUPPORTED_KERNELS.has(kernel)) {
    throw new RangeError(`Option --kernel must be "legacy" or "cycles", got "${kernel}".`);
  }
  return kernel;
}

function parseFilterTypeOption(argumentList) {
  const filterType = String(readFlagValue(argumentList, '--filter-type', 'box'));
  if (!SUPPORTED_FILTERS.has(filterType)) {
    throw new RangeError(`Option --filter-type must be "box" or "blackman-harris", got "${filterType}".`);
  }
  return filterType;
}

function parseSamplerOption(argumentList) {
  const sampler = String(readFlagValue(argumentList, '--sampler', 'sobol-burley'));
  if (!SUPPORTED_SAMPLERS.has(sampler)) {
    throw new RangeError(`Option --sampler must be "white" or "sobol-burley", got "${sampler}".`);
  }
  return sampler;
}

function parseTraceArguments(argumentList) {
  if (argumentList.length < 2 || argumentList[0].startsWith('--') || argumentList[1].startsWith('--')) {
    throw new RangeError('Usage: node bench/cycles-parity/trace-native.mjs <sceneJsonPath> <outputPrefix> [--kernel legacy|cycles] [--samples 256] [--bounces 8] [--seed 1] [--width 960] [--height 540] [--sampler white|sobol-burley] [--filter-type box|blackman-harris] [--filter-width 1.0] [--clamp-direct 0] [--clamp-indirect 0] [--firefly-clamp 1e9] [--noise-threshold 0]');
  }
  return {
    sceneJsonPath: resolve(argumentList[0]),
    outputPrefix: resolve(argumentList[1]),
    kernel: parseKernelOption(argumentList),
    width: parseIntegerOption(argumentList, '--width', 960, 16),
    height: parseIntegerOption(argumentList, '--height', 540, 16),
    samples: parseIntegerOption(argumentList, '--samples', 256, 1),
    bounces: parseIntegerOption(argumentList, '--bounces', 8, 0),
    seed: parseIntegerOption(argumentList, '--seed', 1, 0),
    filterType: parseFilterTypeOption(argumentList),
    sampler: parseSamplerOption(argumentList),
    filterWidth: parseNumberOption(argumentList, '--filter-width', 1.0, 0.01),
    clampDirect: parseNumberOption(argumentList, '--clamp-direct', 0, 0),
    clampIndirect: parseNumberOption(argumentList, '--clamp-indirect', 0, 0),
    filterGlossy: parseNumberOption(argumentList, '--filter-glossy', 1.0, 0),
    fireflyClamp: parseNumberOption(argumentList, '--firefly-clamp', 1e9, 0),
    noiseThreshold: parseNumberOption(argumentList, '--noise-threshold', 0, 0),
    samplesPerDispatch: argumentList.includes('--samples-per-dispatch')
      ? parseIntegerOption(argumentList, '--samples-per-dispatch', 16, 1)
      : undefined,
    maxSeconds: parseNumberOption(argumentList, '--max-seconds', 1800, 1),
  };
}

function packSceneForKernel(traceScene, camera, options) {
  if (options.kernel === 'cycles' && typeof renderNative.buildNativeInputV2 === 'function') {
    return renderNative.buildNativeInputV2(traceScene, camera, options, packModule);
  }
  return renderNative.buildNativeInput(traceScene, camera, options, packModule);
}

function extractLinearRgb(rgbaPixels, pixelCount) {
  const linearRgb = new Float32Array(pixelCount * 3);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const sourceOffset = pixelIndex * 4;
    const targetOffset = pixelIndex * 3;
    linearRgb[targetOffset] = rgbaPixels[sourceOffset];
    linearRgb[targetOffset + 1] = rgbaPixels[sourceOffset + 1];
    linearRgb[targetOffset + 2] = rgbaPixels[sourceOffset + 2];
  }
  return linearRgb;
}

async function runCli() {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const options = parseTraceArguments(process.argv.slice(2));
  if (!renderNative.findNativeAddon()) {
    throw new Error('The render-native addon is missing. Build packages/render-native before running trace-native.mjs.');
  }
  const description = JSON.parse(await readFile(options.sceneJsonPath, 'utf8'));
  await mkdir(dirname(options.outputPrefix), { recursive: true });
  const totalStarted = performance.now();
  const buildStarted = performance.now();
  const traceSource = await reconstructTraceSceneSource(description);
  const traceScene = buildTraceScene(traceSource.parts, traceSource.environment);
  const camera = createCamera(traceSource.camera, options.width, options.height);
  const samplesPerDispatch = options.samplesPerDispatch !== undefined
    ? options.samplesPerDispatch
    : (options.noiseThreshold > 0 ? 8 : undefined);
  const nativeInput = packSceneForKernel(traceScene, camera, { ...options, samplesPerDispatch, parts: traceSource.parts });
  const sceneBuildSeconds = (performance.now() - buildStarted) / 1000;
  const traced = renderNative.traceNative(nativeInput, {
    width: options.width,
    height: options.height,
    samples: options.samples,
    samplesPerDispatch,
    bounces: options.bounces,
    seed: options.seed,
    maxSeconds: options.maxSeconds,
    kernel: options.kernel,
    filterType: options.filterType,
    sampler: options.sampler,
    filterWidth: options.filterWidth,
    clampDirect: options.clampDirect,
    clampIndirect: options.clampIndirect,
    filterGlossy: options.filterGlossy,
  });
  const totalTraceSeconds = (performance.now() - totalStarted) / 1000;
  const postTraceRssMegabytes = process.memoryUsage().rss / (1024 * 1024);
  const pixelCount = options.width * options.height;
  const linearRgb = extractLinearRgb(traced.rgba, pixelCount);
  const npyPath = `${options.outputPrefix}.npy`;
  await writeFloat32Npy(npyPath, linearRgb, [options.height, options.width, 3]);
  const setupSeconds = sceneBuildSeconds + traced.setupSeconds + traced.compileSeconds + traced.uploadSeconds + traced.accelerationBuildSeconds;
  const report = {
    engine: options.kernel === 'cycles' ? 'cook-render-native' : '67js-render-native',
    kernel: traced.kernel ?? options.kernel,
    inputSchemaVersion: nativeInput.schemaVersion ?? 1,
    sceneId: description.id,
    npyPath,
    width: options.width,
    height: options.height,
    samples: options.samples,
    averageSamples: traced.averageSamples,
    samplesPerDispatch: traced.samplesPerDispatch ?? null,
    bounces: options.bounces,
    seed: options.seed,
    filterType: options.filterType,
    sampler: options.sampler,
    filterWidth: options.filterWidth,
    clampDirect: options.clampDirect,
    clampIndirect: options.clampIndirect,
    fireflyClamp: options.fireflyClamp,
    noiseThreshold: options.noiseThreshold,
    triangleCount: nativeInput.triangleCount,
    adapter: traced.adapter,
    backend: traced.backend,
    features: traced.features,
    sceneBuildSeconds: Number(sceneBuildSeconds.toFixed(6)),
    deviceSetupSeconds: Number(traced.setupSeconds.toFixed(6)),
    compileSeconds: Number(traced.compileSeconds.toFixed(6)),
    uploadSeconds: Number(traced.uploadSeconds.toFixed(6)),
    accelerationBuildSeconds: Number(traced.accelerationBuildSeconds.toFixed(6)),
    setupSeconds: Number(setupSeconds.toFixed(6)),
    samplingSeconds: Number(traced.tracedSeconds.toFixed(6)),
    totalTraceSeconds: Number(totalTraceSeconds.toFixed(6)),
    nodeRssMegabytes: Number(postTraceRssMegabytes.toFixed(2)),
  };
  await writeFile(`${options.outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`NATIVE_TRACE ${JSON.stringify(report)}`);
}

await runCli();

// Traces an exported scene JSON on packages/render-native and writes linear RGB float32 (.npy) plus timing JSON.
//   node bench/cycles-parity/trace-native.mjs <sceneJsonPath> <outputPrefix> [--kernel legacy|cycles] [--samples 256] [--bounces 8] [--seed 1]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createCamera } from '../../src/path-tracer.js';
import * as packModule from '../../src/path-tracer-gpu-pack.js';
import { buildTraceSceneWithManyLights } from './trace-scene-many-lights.mjs';
import * as renderNative from '../../packages/render-native/index.mjs';
import { writeFloat32Npy } from './npy.mjs';
import { reconstructTraceSceneSource } from './scene-bridge.mjs';
import { denoiseRadiance } from '../../src/path-tracer-denoise.js';
import { applyGreyDiffuseOverride } from './grey-diffuse-override.mjs';
import { denoiseWithOidn } from '../../packages/denoise-oidn/index.mjs';

const SUPPORTED_KERNELS = new Set(['legacy', 'cycles']);
const SUPPORTED_FILTERS = new Set(['box', 'gaussian', 'blackman-harris']);
const SUPPORTED_SAMPLERS = new Set(['white', 'sobol-burley']);
// Names of the earlier sampler option (#957), kept as aliases.
const SAMPLER_ALIASES = { pcg: 'white', sobol: 'sobol-burley' };
const LIGHT_TREE_ALIASES = { auto: 'auto', on: 'tree', off: 'uniform' };

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

function parseChoiceOption(argumentList, flagName, allowedValues, fallbackValue) {
  const value = String(readFlagValue(argumentList, flagName, fallbackValue));
  if (!allowedValues.includes(value)) {
    throw new RangeError(`Option ${flagName} must be one of ${allowedValues.join(', ')}, got "${value}".`);
  }
  return value;
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
    throw new RangeError(`Option --filter-type must be "box", "gaussian" or "blackman-harris", got "${filterType}".`);
  }
  return filterType;
}

function parseSamplerOption(argumentList) {
  const requested = String(readFlagValue(argumentList, '--sampler', 'sobol-burley'));
  const sampler = SAMPLER_ALIASES[requested] ?? requested;
  if (!SUPPORTED_SAMPLERS.has(sampler)) {
    throw new RangeError(`Option --sampler must be "white" (alias "pcg") or "sobol-burley" (alias "sobol"), got "${requested}".`);
  }
  return sampler;
}

function parseDenoiseOption(argumentList) {
  return parseChoiceOption(argumentList, '--denoise', ['none', 'wavelet', 'atrous'], 'none');
}

function parseOidnDevicesOption(argumentList) {
  const requested = String(readFlagValue(argumentList, '--oidn-devices', ''));
  const devices = requested === '' ? [] : requested.split(',');
  for (const device of devices) {
    if (!['cpu', 'cuda', 'default'].includes(device)) {
      throw new RangeError(`Option --oidn-devices takes a comma list of cpu, cuda or default, got "${device}".`);
    }
  }
  return devices;
}

function parseLightSamplingOption(argumentList) {
  const lightSampling = String(readFlagValue(argumentList, '--light-sampling', 'auto'));
  if (!['auto', 'tree', 'uniform'].includes(lightSampling)) {
    throw new RangeError(`Option --light-sampling must be "auto", "tree" or "uniform", got "${lightSampling}".`);
  }
  const aliasedLightTree = String(readFlagValue(argumentList, '--light-tree', 'auto'));
  if (!Object.hasOwn(LIGHT_TREE_ALIASES, aliasedLightTree)) {
    throw new RangeError(`Option --light-tree (alias of --light-sampling) must be "auto", "on" or "off", got "${aliasedLightTree}".`);
  }
  const aliasedLightSampling = LIGHT_TREE_ALIASES[aliasedLightTree];
  if (aliasedLightSampling !== 'auto' && lightSampling !== 'auto' && aliasedLightSampling !== lightSampling) {
    throw new RangeError(`Options --light-tree ${aliasedLightTree} and --light-sampling ${lightSampling} disagree; pass only one.`);
  }
  return aliasedLightSampling === 'auto' ? lightSampling : aliasedLightSampling;
}

function parseTraceArguments(argumentList) {
  if (argumentList.length < 2 || argumentList[0].startsWith('--') || argumentList[1].startsWith('--')) {
    throw new RangeError('Usage: node bench/cycles-parity/trace-native.mjs <sceneJsonPath> <outputPrefix> [--kernel legacy|cycles] [--samples 256] [--bounces 8] [--transparent-bounces 8] [--seed 1] [--width 960] [--height 540] [--sampler white|sobol-burley] [--light-sampling auto|tree|uniform] [--path-regeneration | --no-path-regeneration] [--env-compensation 0..1] [--filter-type box|gaussian|blackman-harris] [--filter-width 1.0] [--clamp-direct 0] [--clamp-indirect 0] [--firefly-clamp 1e9] [--noise-threshold 0] [--denoise none|wavelet|atrous] [--oidn-devices cpu,cuda] [--grey-diffuse] [--write-depth]');
  }
  return {
    sceneJsonPath: resolve(argumentList[0]),
    outputPrefix: resolve(argumentList[1]),
    kernel: parseKernelOption(argumentList),
    width: parseIntegerOption(argumentList, '--width', 960, 16),
    height: parseIntegerOption(argumentList, '--height', 540, 16),
    samples: parseIntegerOption(argumentList, '--samples', 256, 1),
    bounces: parseIntegerOption(argumentList, '--bounces', 8, 0),
    // Transparent max bounces on its own; undefined keeps the pack default (the larger of --bounces and 8).
    transparentBounces: argumentList.includes('--transparent-bounces')
      ? parseIntegerOption(argumentList, '--transparent-bounces', 8, 0)
      : undefined,
    seed: parseIntegerOption(argumentList, '--seed', 1, 0),
    filterType: parseFilterTypeOption(argumentList),
    sampler: parseSamplerOption(argumentList),
    lightSampling: parseLightSamplingOption(argumentList),
    envCompensation: parseNumberOption(argumentList, '--env-compensation', 0, 0),
    directLighting: String(readFlagValue(argumentList, '--direct-lighting', 'both')),
    lightTreeProbe: argumentList.includes('--light-tree-probe'),
    // On by default; `--path-regeneration` stays accepted for old command lines.
    pathRegeneration: !argumentList.includes('--no-path-regeneration'),
    filterWidth: parseNumberOption(argumentList, '--filter-width', 1.0, 0.01),
    clampDirect: parseNumberOption(argumentList, '--clamp-direct', 0, 0),
    clampIndirect: parseNumberOption(argumentList, '--clamp-indirect', 0, 0),
    filterGlossy: parseNumberOption(argumentList, '--filter-glossy', 1.0, 0),
    fireflyClamp: parseNumberOption(argumentList, '--firefly-clamp', 1e9, 0),
    noiseThreshold: parseNumberOption(argumentList, '--noise-threshold', 0, 0),
    denoise: parseDenoiseOption(argumentList),
    oidnDevices: parseOidnDevicesOption(argumentList),
    samplesPerDispatch: argumentList.includes('--samples-per-dispatch')
      ? parseIntegerOption(argumentList, '--samples-per-dispatch', 16, 1)
      : undefined,
    maxSeconds: parseNumberOption(argumentList, '--max-seconds', 1800, 1),
    greyDiffuse: argumentList.includes('--grey-diffuse'),
    writeDepth: argumentList.includes('--write-depth'),
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

function normalizeNormals(normal) {
  for (let offset = 0; offset < normal.length; offset += 3) {
    const length = Math.hypot(normal[offset], normal[offset + 1], normal[offset + 2]);
    if (length > 1e-6) {
      normal[offset] /= length;
      normal[offset + 1] /= length;
      normal[offset + 2] /= length;
    }
  }
}

/**
 * Runs the existing wavelet filter (src/path-tracer-denoise.js) on the traced guides. Pixels where it returns a value that
 * is not finite (background pixels with zero normal and depth, issue 969) keep their unfiltered colour; the count is reported.
 */
function applyWavelet(traced, linearRgb, width, height) {
  const features = { color: linearRgb, albedo: traced.albedo, normal: traced.normal, depth: traced.depth, variance: traced.variance };
  normalizeNormals(features.normal);
  const started = performance.now();
  const filtered = denoiseRadiance({ width, height, ...features });
  const seconds = (performance.now() - started) / 1000;
  const result = new Float32Array(linearRgb);
  let replacedPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 3;
    if (Number.isFinite(filtered[offset]) && Number.isFinite(filtered[offset + 1]) && Number.isFinite(filtered[offset + 2])) {
      result.set(filtered.subarray(offset, offset + 3), offset);
    } else {
      replacedPixels++;
    }
  }
  return { image: result, seconds, replacedPixels };
}

/**
 * Comparison runs only: runs the OIDN addon (packages/denoise-oidn, the official oidnDenoise tool through PFM files) on the
 * traced colour with the kernel's first-hit albedo and normal guides, once per device, and writes each result to
 * <prefix>.oidn-<device>.npy. The seconds are a second, warm call as the addon is built (PFM write, tool start, weights
 * load, filter, PFM read); the first call is reported apart.
 */
async function runOidnComparison(traced, linearRgb, options, outputPrefix) {
  const albedo = traced.albedo;
  const normal = new Float32Array(traced.normal);
  normalizeNormals(normal);
  const results = {};
  for (const device of options.oidnDevices) {
    const callOidn = () => denoiseWithOidn({ width: options.width, height: options.height, color: linearRgb, albedo, normal, device });
    try {
      const firstStarted = performance.now();
      await callOidn();
      const firstSeconds = (performance.now() - firstStarted) / 1000;
      const started = performance.now();
      const denoised = await callOidn();
      results[device] = {
        seconds: Number(((performance.now() - started) / 1000).toFixed(6)),
        firstCallSeconds: Number(firstSeconds.toFixed(6)),
      };
      await writeFloat32Npy(`${outputPrefix}.oidn-${device}.npy`, denoised, [options.height, options.width, 3]);
    } catch (error) {
      // One failing device (for example CUDA missing in a container) must not lose the other variants of this trace.
      results[device] = { error: String(error.message).slice(0, 600) };
    }
  }
  return results;
}

async function runCli() {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const options = parseTraceArguments(process.argv.slice(2));
  if (!renderNative.findNativeAddon()) {
    throw new Error('The render-native addon is missing. Build packages/render-native before running trace-native.mjs.');
  }
  const loadedDescription = JSON.parse(await readFile(options.sceneJsonPath, 'utf8'));
  const description = options.greyDiffuse ? applyGreyDiffuseOverride(loadedDescription) : loadedDescription;
  await mkdir(dirname(options.outputPrefix), { recursive: true });
  const totalStarted = performance.now();
  const buildStarted = performance.now();
  const traceSource = await reconstructTraceSceneSource(description);
  const traceScene = buildTraceSceneWithManyLights(traceSource.parts, traceSource.environment);
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
    lightSampling: options.lightSampling,
    pathRegeneration: options.pathRegeneration,
    filterWidth: options.filterWidth,
    clampDirect: options.clampDirect,
    clampIndirect: options.clampIndirect,
    filterGlossy: options.filterGlossy,
    denoise: options.denoise === 'atrous' ? 'atrous' : 'none',
  });
  const totalTraceSeconds = (performance.now() - totalStarted) / 1000;
  const postTraceRssMegabytes = process.memoryUsage().rss / (1024 * 1024);
  const pixelCount = options.width * options.height;
  const unfilteredRgb = extractLinearRgb(traced.rgba, pixelCount);
  // A filtered image is a biased, smoothed estimate, never a converged one.
  const wavelet = options.denoise === 'wavelet' ? applyWavelet(traced, unfilteredRgb, options.width, options.height) : null;
  const atrousRgb = options.denoise === 'atrous' ? extractLinearRgb(traced.denoisedRgba, pixelCount) : null;
  const linearRgb = wavelet ? wavelet.image : (atrousRgb ?? unfilteredRgb);
  const npyPath = `${options.outputPrefix}.npy`;
  await writeFloat32Npy(npyPath, linearRgb, [options.height, options.width, 3]);
  // The a-trous filter returns the unfiltered image beside the filtered one; keeping it shows that the filter leaves `rgba` alone.
  const unfilteredNpyPath = atrousRgb ? `${options.outputPrefix}.unfiltered.npy` : null;
  if (unfilteredNpyPath) {
    await writeFloat32Npy(unfilteredNpyPath, unfilteredRgb, [options.height, options.width, 3]);
  }
  const oidnTrial = options.oidnDevices.length > 0 ? await runOidnComparison(traced, unfilteredRgb, options, options.outputPrefix) : null;
  const setupSeconds = sceneBuildSeconds + traced.setupSeconds + traced.compileSeconds + traced.uploadSeconds + traced.accelerationBuildSeconds;
  // The depth buffer is the mean first-hit distance ALONG THE RAY (unit direction), 0 where the ray missed; Cycles' Z is
  // the distance along the view axis. compare-depth.py converts. Cook's film averages over all samples, misses included.
  const depthNpyPath = options.writeDepth ? `${options.outputPrefix}-depth.npy` : null;
  if (depthNpyPath) {
    if (!traced.depth || traced.depth.length !== options.width * options.height) {
      throw new Error(`--write-depth needs the native tracer to return a depth buffer of ${options.width * options.height} floats (kernel "${options.kernel}" returned ${traced.depth?.length ?? 'none'}).`);
    }
    await writeFloat32Npy(depthNpyPath, Float32Array.from(traced.depth), [options.height, options.width]);
  }
  const report = {
    greyDiffuse: options.greyDiffuse,
    depthNpyPath,
    depthConvention: depthNpyPath ? 'ray-distance' : null,
    cameraVerticalFovDegrees: traceSource.camera.fov,
    engine: options.kernel === 'cycles' ? 'cook-render-native' : '67js-render-native',
    kernel: traced.kernel ?? options.kernel,
    inputSchemaVersion: nativeInput.schemaVersion ?? 1,
    sceneId: description.id,
    npyPath,
    unfilteredNpyPath,
    width: options.width,
    height: options.height,
    samples: options.samples,
    averageSamples: traced.averageSamples,
    samplesPerDispatch: traced.samplesPerDispatch ?? null,
    longestDispatchSeconds: traced.longestDispatchSeconds ?? null,
    bounces: options.bounces,
    transparentBounces: options.transparentBounces ?? null,
    seed: options.seed,
    filterType: options.filterType,
    sampler: options.sampler,
    lightSampling: options.lightSampling,
    filterWidth: options.filterWidth,
    clampDirect: options.clampDirect,
    clampIndirect: options.clampIndirect,
    fireflyClamp: options.fireflyClamp,
    noiseThreshold: options.noiseThreshold,
    denoise: options.denoise,
    denoiseSeconds: wavelet ? Number(wavelet.seconds.toFixed(6)) : Number((traced.denoiseSeconds ?? 0).toFixed(6)),
    denoiseGpuSeconds: Number((traced.denoiseGpuSeconds ?? 0).toFixed(6)),
    denoiseCompileSeconds: Number((traced.denoiseCompileSeconds ?? 0).toFixed(6)),
    denoiseNonFinitePixelsReplaced: wavelet ? wavelet.replacedPixels : 0,
    oidnTrial,
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

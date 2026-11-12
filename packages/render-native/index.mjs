// Hardware ray traced stills for 67js: loads the native addon built by `npm run build` and traces a packed scene on the
// GPU with Vulkan ray queries. The addon is not in this package; without it `findNativeAddon()` returns null.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORMAT_V2_MAGIC,
  FORMAT_V2_VERSION,
  STRUCT_STRIDES_V2,
  KERNEL_FLAG_USE_LIGHT_TREE,
  KERNEL_FLAG_WHITE_NOISE_SAMPLER,
  KERNEL_FLAG_PATH_REGENERATION,
  validatePathRegenerationOption,
  resolveSamplingOptions,
  resolveUseLightTree,
  KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET,
  KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET,
  KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET,
  KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET,
  filterTypeCode,
  resolveFilterParameters,
  buildNativeInputV2,
  packMaterialRecordV2,
  upgradeNativeInputV1ToV2,
  validateImagePixelCount,
  validateMaxSeconds,
  validatePackOptions,
} from './pack-input-v2.mjs';

export { buildNativeInput, buildNativeTexelInput } from './pack-input.mjs';
export {
  FORMAT_V2_MAGIC,
  FORMAT_V2_VERSION,
  STRUCT_STRIDES_V2,
  KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET,
  buildNativeInputV2,
  packMaterialRecordV2,
  upgradeNativeInputV1ToV2,
};

const PACKAGE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ADDON_PATH = join(PACKAGE_DIRECTORY, 'build', 'render-native.node');
const VALID_KERNELS = new Set(['legacy', 'cycles']);

/** The path of the built addon, or null when `npm run build` has not run. */
export function findNativeAddon() {
  return existsSync(ADDON_PATH) ? ADDON_PATH : null;
}

/**
 * Resolves and validates the native kernel name from `kernel`, falling back to `JS67_NATIVE_KERNEL` and `'legacy'`.
 */
export function resolveNativeKernel(kernel) {
  const envKernel = process.env.JS67_NATIVE_KERNEL;
  const selectedKernel = kernel !== undefined
    ? kernel
    : (envKernel !== undefined && envKernel !== '' ? envKernel : 'legacy');
  if (typeof selectedKernel !== 'string' || !VALID_KERNELS.has(selectedKernel)) {
    throw new Error(
      `Invalid native kernel ${JSON.stringify(selectedKernel)}: pass "legacy" or "cycles" in options.kernel or JS67_NATIVE_KERNEL.`
    );
  }
  return selectedKernel;
}

// The `cycles` kernel starts a pixel's next sample as soon as a path ends unless the caller passes `pathRegeneration: false`.
const DEFAULT_PATH_REGENERATION = true;

/**
 * Traces the input on the GPU and resolves linear RGBA float data (`rgba`, width * height * 4, rows from the top, the
 * average of `samples` paths) with the adapter name and timings in seconds. `maxSeconds` makes the trace fail once it has
 * run that long. `kernel` selects `"legacy"` (default) or `"cycles"` (falling back to `JS67_NATIVE_KERNEL` when omitted).
 */
export function traceNative(input, options = {}) {
  validatePackOptions(options, 'traceNative', true);
  resolveSamplingOptions(options, 'traceNative');
  validatePathRegenerationOption(options.pathRegeneration, 'traceNative');
  const { width, height, samples, maxSeconds, kernel, samplesPerDispatch, bootstrapKernel, denoise } = options;
  const selectedKernel = resolveNativeKernel(kernel);
  const addon = loadAddon();
  if (selectedKernel === 'legacy') {
    if (denoise === 'atrous') {
      throw new TypeError('traceNative: `denoise: "atrous"` filters the Cycles kernel result; pass kernel "cycles", or call denoiseAtrous with the traced guide buffers.');
    }
    if (input?.schemaVersion === FORMAT_V2_VERSION) {
      throw new TypeError(
        'Cannot pass a FORMAT-v2 scene input to kernel "legacy": pass kernel "cycles" or build a v1 input with buildNativeInput.'
      );
    }
    return addon.traceScene(input, { width, height, samples, maxSeconds, kernel: selectedKernel });
  }
  const v2Input = prepareCyclesInput(input, options);
  return addon.traceSceneCycles(v2Input, {
    width,
    height,
    samples,
    samplesPerDispatch,
    maxSeconds,
    bootstrapKernel,
    denoise,
  });
}

/**
 * Filters a traced image with the edge-avoiding a-trous wavelet filter on the GPU (Dammertz 2010 with SVGF's variance
 * guidance, spatial only). `rgba` holds four floats per pixel; `albedo`, `normal` (any length, zero where nothing was
 * hit), `depth` and `variance` are the guide buffers `traceNative` returns. The result is smoothed and biased: it is not
 * a converged image. Returns `{ rgba, compileSeconds, uploadSeconds, gpuSeconds, readbackSeconds }`.
 */
export function denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance }) {
  const pixelCount = width * height;
  validateImagePixelCount(width, height, 'denoiseAtrous');
  const planes = { rgba: [rgba, 4], albedo: [albedo, 3], normal: [normal, 3], depth: [depth, 1], variance: [variance, 1] };
  for (const [name, [plane, floatsPerPixel]] of Object.entries(planes)) {
    if (!(plane instanceof Float32Array) || plane.length !== pixelCount * floatsPerPixel) {
      throw new TypeError(`denoiseAtrous: \`${name}\` must be a Float32Array of ${pixelCount * floatsPerPixel} floats for a ${width}x${height} image.`);
    }
  }
  return loadAddon().denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance });
}

/**
 * Opens a persistent OIDN device and filter inside the addon. The OIDN shared library is loaded at run time from
 * `libraryPath` (`findOidnLibrary()` of the denoise package), so the addon works without it. Returns the native object
 * with `denoise({ width, height, color, albedo, normal })`, `close()` and `deviceSeconds`. Use
 * `createOidnDenoiser` of the denoise package for the wrapper that jobs call.
 */
export function createNativeOidnDenoiser({ libraryPath, device = 'cpu', quality = 'high', cleanAux = false, threads = 0 }) {
  if (typeof libraryPath !== 'string' || libraryPath === '') {
    throw new TypeError('createNativeOidnDenoiser: pass `libraryPath`, the OIDN shared library (findOidnLibrary() in the denoise package).');
  }
  const addon = loadAddon();
  if (typeof addon.OidnDenoiser !== 'function') {
    throw new Error('The built native tracer has no OIDN support: run `npm run build` in packages/render-native again.');
  }
  return new addon.OidnDenoiser({ libraryPath, device, quality, cleanAux, threads });
}

function hasFilterOptions(options) {
  return options.filterType !== undefined || options.pixelFilter !== undefined || options.filterWidth !== undefined;
}

// A packed input already carries its filter; explicit options replace it. A new type without a width gets that type's
// default width, as the packer does; a width alone keeps the packed type.
// Exported for tests; not part of the public API.
export function withFilterOptions(kernelParams, options) {
  const patchedParams = new Uint8Array(kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const requestedType = options.filterType ?? options.pixelFilter;
  const filterType = requestedType !== undefined
    ? filterTypeCode(requestedType)
    : view.getUint32(KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET, true);
  const filterWidth = options.filterWidth !== undefined || requestedType !== undefined
    ? resolveFilterParameters({ filterType, filterWidth: options.filterWidth }).filterWidth
    : view.getFloat32(KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET, true);
  view.setUint32(KERNEL_PARAMS_V2_FILTER_TYPE_BYTE_OFFSET, filterType, true);
  view.setFloat32(KERNEL_PARAMS_V2_FILTER_WIDTH_BYTE_OFFSET, filterWidth, true);
  return patchedParams;
}

function hasLightTreeEmitterTables(v2Input) {
  return Boolean(v2Input.lightTreeEmitters && v2Input.lightToTree && v2Input.lightTreeEmitterCount !== undefined);
}

// Exported for tests; not part of the public API.
export function withLightSamplingFlag(v2Input, lightSampling) {
  const patchedParams = new Uint8Array(v2Input.kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const flags = view.getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
  const emitterCount = (v2Input.lightCount ?? 0) + (v2Input.emissiveTriangleCount ?? 0);
  let lightTreeNodeCount = v2Input.lightTreeNodeCount ?? 0;
  if (lightTreeNodeCount > 0 && !hasLightTreeEmitterTables(v2Input)) {
    if (lightSampling === 'tree') {
      throw new TypeError(
        'traceNative: lightSampling "tree" needs the emitter tables (lightTreeEmitters, lightTreeEmitterCount, lightToTree), which this packed FORMAT-v2 input lacks. Repack the scene with buildNativeInputV2.'
      );
    }
    lightTreeNodeCount = 0;
  }
  const useTree = resolveUseLightTree(lightSampling, emitterCount, lightTreeNodeCount);
  const patchedFlags = useTree
    ? (flags | KERNEL_FLAG_USE_LIGHT_TREE) >>> 0
    : (flags & ~KERNEL_FLAG_USE_LIGHT_TREE) >>> 0;
  view.setUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, patchedFlags, true);
  return patchedParams;
}

function withSamplerFlag(kernelParams, sampler) {
  const patchedParams = new Uint8Array(kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const flags = view.getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
  const patchedFlags = sampler === 'white'
    ? (flags | KERNEL_FLAG_WHITE_NOISE_SAMPLER) >>> 0
    : (flags & ~KERNEL_FLAG_WHITE_NOISE_SAMPLER) >>> 0;
  view.setUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, patchedFlags, true);
  return patchedParams;
}

/**
 * Builds the FORMAT-v2 input of the `cycles` kernel from a v1 or v2 input and the trace options, patching the kernel flags
 * the options set. Exported for tests; not part of the public API.
 */
export function prepareCyclesInput(input, options = {}) {
  if (input?.schemaVersion === FORMAT_V2_VERSION) {
    return { ...input, kernelParams: patchedCyclesKernelParams(input, input.kernelParams, options, 'traceNative') };
  }
  resolveSamplingOptions(options, 'traceNative');
  const upgradedInput = upgradeNativeInputV1ToV2(input, options);
  const pathRegeneration = options.pathRegeneration ?? DEFAULT_PATH_REGENERATION;
  return { ...upgradedInput, kernelParams: withPathRegenerationFlag(upgradedInput.kernelParams, pathRegeneration) };
}

// Exported for tests; not part of the public API.
export function withPathRegenerationFlag(kernelParams, pathRegeneration) {
  const patchedParams = new Uint8Array(kernelParams);
  const view = new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength);
  const flags = view.getUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, true);
  const patchedFlags = pathRegeneration
    ? (flags | KERNEL_FLAG_PATH_REGENERATION) >>> 0
    : (flags & ~KERNEL_FLAG_PATH_REGENERATION) >>> 0;
  view.setUint32(KERNEL_PARAMS_V2_KERNEL_FLAGS_BYTE_OFFSET, patchedFlags, true);
  return patchedParams;
}

function buildProbeKernelParams({ width, height, mode, seed, sampleOffset, wo, frontFace, materialCount, textureCount }) {
  const buffer = new ArrayBuffer(STRUCT_STRIDES_V2.kernelParams);
  const f32 = new Float32Array(buffer);
  const u32 = new Uint32Array(buffer);
  const length = Math.hypot(wo[0], wo[1], wo[2]);
  if (!(length > 1e-12) || !wo.every(Number.isFinite)) {
    throw new RangeError('probeCyclesLobe option `wo` must be a non-zero finite 3D vector.');
  }
  u32[0] = FORMAT_V2_MAGIC;
  u32[1] = FORMAT_V2_VERSION;
  u32[2] = width >>> 0;
  u32[3] = height >>> 0;
  u32[4] = (sampleOffset ?? 0) >>> 0;
  u32[5] = 1;
  u32[6] = 1;
  u32[7] = (seed ?? 1) >>> 0;
  u32[8] = (mode ?? 0) >>> 0;
  u32[23] = materialCount >>> 0;
  u32[27] = textureCount >>> 0;
  f32[31] = frontFace === false ? -1.0 : 1.0;
  f32[32] = wo[0] / length;
  f32[33] = wo[1] / length;
  f32[34] = wo[2] / length;
  f32[35] = 1e30;
  f32[72] = 1.0;
  return new Uint8Array(buffer);
}

/**
 * Dispatches entry point `"test_lobe_samples"` on the assembled Cycles shader and returns the raw un-divided
 * `Float32Array` of all 4 `film_accumulation` planes (`4 * width * height * 4` floats).
 */
export function probeCyclesLobe(options = {}) {
  const width = options.width ?? 512;
  const height = options.height ?? 512;
  if (!Number.isInteger(width) || width < 1 || width > 16384 || !Number.isInteger(height) || height < 1 || height > 16384) {
    throw new RangeError(`probeCyclesLobe requires integer \`width\` and \`height\` in [1, 16384]; got width=${width}, height=${height}.`);
  }
  validateImagePixelCount(width, height, 'probeCyclesLobe');
  validateMaxSeconds(options.maxSeconds, 'probeCyclesLobe');
  const wo = options.wo ?? [0, 0, 1];
  if (!Array.isArray(wo) && !ArrayBuffer.isView(wo) || wo.length !== 3) {
    throw new TypeError('probeCyclesLobe option `wo` must hold 3 numbers.');
  }

  let materials;
  if (options.materialBytes !== undefined) {
    if (!(options.materialBytes instanceof Uint8Array) || options.materialBytes.byteLength < STRUCT_STRIDES_V2.material || options.materialBytes.byteLength % STRUCT_STRIDES_V2.material !== 0) {
      throw new TypeError(`probeCyclesLobe option \`materialBytes\` must be a Uint8Array of a positive multiple of ${STRUCT_STRIDES_V2.material} bytes.`);
    }
    materials = options.materialBytes;
  } else {
    materials = packMaterialRecordV2(options.material ?? {}, null).bytes;
  }

  const materialCount = materials.byteLength / STRUCT_STRIDES_V2.material;
  const textureDescriptors = options.textureDescriptors;
  const textureCount = textureDescriptors ? Math.floor(textureDescriptors.byteLength / STRUCT_STRIDES_V2.textureDescriptor) : 0;
  const kernelParams = options.kernelParams instanceof Uint8Array
    ? options.kernelParams
    : buildProbeKernelParams({
      width,
      height,
      mode: options.mode ?? 0,
      seed: options.seed ?? 1,
      sampleOffset: options.sampleOffset,
      wo,
      frontFace: options.frontFace ?? true,
      materialCount,
      textureCount,
    });

  return loadAddon().probeCyclesLobe({
    width,
    height,
    kernelParams,
    materials,
    textureDescriptors,
    textureTexels: options.textureTexels,
    maxSeconds: options.maxSeconds,
    bootstrapKernel: options.bootstrapKernel,
  });
}

/**
 * The light bake: traces `samples` cosine weighted paths from every texel of `texels` (`count`, `points`, `normals`) and
 * returns the mean `radiance` (three floats per texel) and the share of first rays that `escaped`. The input comes from
 * `buildNativeTexelInput`.
 */
export function traceNativeTexels(input, texels, { samples, maxSeconds }) {
  validateMaxSeconds(maxSeconds, 'traceNativeTexels');
  return loadAddon().traceTexels(input, texels, { samples, maxSeconds });
}

function loadAddon() {
  const addonPath = findNativeAddon();
  if (!addonPath) throw new Error('The native tracer is not built. Run `npm run build` in packages/render-native.');
  return createRequire(import.meta.url)(addonPath);
}

// ---- Persistent session (issue 896) ----

function requireSessionKernelParams(kernelParams, callerName) {
  if (!(kernelParams instanceof Uint8Array) || kernelParams.byteLength !== STRUCT_STRIDES_V2.kernelParams) {
    throw new TypeError(
      `${callerName}: \`kernelParams\` must be a Uint8Array of ${STRUCT_STRIDES_V2.kernelParams} bytes (the KernelParamsV2 block of buildNativeInputV2).`
    );
  }
}

function requireCyclesKernelOption(kernel, callerName) {
  if (kernel !== undefined && resolveNativeKernel(kernel) !== 'cycles') {
    throw new TypeError(`${callerName}: a native session runs the "cycles" kernel only; got kernel "${kernel}". Use traceNative for the legacy kernel.`);
  }
}

function mergeDefinedOptions(sessionOptions, renderOptions) {
  const merged = { ...sessionOptions };
  for (const [name, value] of Object.entries(renderOptions)) {
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

// The kernel parameters of a FORMAT-v2 input after the sampling, filter and light options of `options`, the one place the patches live (traceNative and sessions share it), in a fixed
// order.
function patchedCyclesKernelParams(v2Input, kernelParams, options, callerName) {
  const { sampler, lightSampling } = resolveSamplingOptions(options, callerName);
  validatePathRegenerationOption(options.pathRegeneration, callerName);
  let patchedParams = new Uint8Array(kernelParams);
  const explicitFilterGlossy = options.filterGlossy ?? options.blurGlossy;
  if (explicitFilterGlossy !== undefined) {
    const rawFilterGlossy = Number(explicitFilterGlossy);
    const resolvedFilterGlossy = Number.isFinite(rawFilterGlossy) && rawFilterGlossy > 0 ? rawFilterGlossy : 0.0;
    new DataView(patchedParams.buffer, patchedParams.byteOffset, patchedParams.byteLength).setFloat32(KERNEL_PARAMS_V2_FILTER_GLOSSY_BYTE_OFFSET, resolvedFilterGlossy, true);
  }
  if (hasFilterOptions(options)) patchedParams = withFilterOptions(patchedParams, options);
  if (sampler !== undefined) patchedParams = withSamplerFlag(patchedParams, sampler);
  patchedParams = withPathRegenerationFlag(patchedParams, options.pathRegeneration ?? DEFAULT_PATH_REGENERATION);
  if (lightSampling !== undefined) patchedParams = withLightSamplingFlag({ ...v2Input, kernelParams: patchedParams }, lightSampling);
  return patchedParams;
}

// Exported for tests; not part of the public API.
export function resolveSessionCreation(input, options) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('createNativeSession: `input` must be a FORMAT-v2 input object from buildNativeInputV2.');
  }
  if (input.schemaVersion !== FORMAT_V2_VERSION) {
    throw new TypeError(
      `createNativeSession: \`input.schemaVersion\` must be ${FORMAT_V2_VERSION} (a FORMAT-v2 input from buildNativeInputV2); got ${JSON.stringify(input.schemaVersion)}. Convert a v1 input with upgradeNativeInputV1ToV2.`
    );
  }
  requireSessionKernelParams(input.kernelParams, 'createNativeSession');
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createNativeSession: `options` must be an object.');
  }
  requireCyclesKernelOption(options.kernel, 'createNativeSession');
  validatePackOptions(options, 'createNativeSession');
  return { ...input, kernelParams: patchedCyclesKernelParams(input, input.kernelParams, options, 'createNativeSession') };
}

// Exported for tests; not part of the public API.
export function resolveSessionFrame(sessionInput, sessionOptions, renderOptions) {
  if (renderOptions === null || typeof renderOptions !== 'object') {
    throw new TypeError('NativeSession.render: `renderOptions` must be an object.');
  }
  const options = mergeDefinedOptions(sessionOptions, renderOptions);
  requireCyclesKernelOption(options.kernel, 'NativeSession.render');
  validatePackOptions(options, 'NativeSession.render', true);
  let baseKernelParams = sessionInput.kernelParams;
  if (renderOptions.kernelParams !== undefined) {
    requireSessionKernelParams(renderOptions.kernelParams, 'NativeSession.render');
    baseKernelParams = renderOptions.kernelParams;
  }
  const kernelParams = patchedCyclesKernelParams(sessionInput, baseKernelParams, options, 'NativeSession.render');
  const { width, height, samples, samplesPerDispatch, maxSeconds, bootstrapKernel, denoise } = options;
  return { width, height, samples, samplesPerDispatch, maxSeconds, bootstrapKernel, denoise, kernelParams };
}

// Exported for tests, which pass a stand-in for the addon's session class; not part of the public API.
export function wrapNativeSession(nativeSession, sessionInput, sessionOptions) {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    render(renderOptions = {}) {
      if (closed) {
        throw new Error('NativeSession.render: this session is closed. Create a new one with createNativeSession(input).');
      }
      const frame = resolveSessionFrame(sessionInput, sessionOptions, renderOptions);
      const { trace, session } = nativeSession.render(frame);
      return { ...trace, ...session };
    },
    close() {
      if (closed) return;
      closed = true;
      nativeSession.close();
    },
  };
}

/**
 * Keeps a FORMAT-v2 scene on the GPU between frames (the `cycles` kernel only). `render(renderOptions)` takes what
 * `traceNative` takes (`width`, `height`, `samples`, `samplesPerDispatch`, `maxSeconds`, `denoise`, the sampling and filter
 * options) and returns what it returns plus `pipelineReused`, `accelerationReused`, `filmReused` and `frameIndex`. A later frame
 * with the same scene compiles no shader (while the specialized kernel text is unchanged) and builds no acceleration structure; a
 * frame at the same size also keeps the film. `renderOptions.kernelParams` brings another camera of the same scene: the
 * `kernelParams` of a second `buildNativeInputV2` call. `options` are defaults for every frame. `close()` frees the card.
 * A frame equals the `traceNative` render of the same input and options byte for byte.
 */
export function createNativeSession(input, options = {}) {
  const sessionInput = resolveSessionCreation(input, options);
  const addon = loadAddon();
  if (typeof addon.NativeCyclesSession !== 'function') {
    throw new Error('The built native addon has no session support. Run `npm run build` in packages/render-native.');
  }
  return wrapNativeSession(new addon.NativeCyclesSession(sessionInput), sessionInput, options);
}

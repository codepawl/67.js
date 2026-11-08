// renderer.backend "native" on render jobs: the optional hardware ray query tracer (packages/render-native) traces the scene
// the job page exported, then the job runner denoises and writes the PNG. The package and its binary are optional: when they,
// or a Vulkan ray query adapter, are missing, the job runs on the gpu or cpu backend and the report says why.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The names sit in variables so the bundler leaves the imports alone; the package resolves from the user's node_modules.
const NATIVE_PACKAGE = '@codepawlhq/67js-render-native';
// A source checkout keeps the package in packages/, beside scripts/ or, from the bundled server, two folders above build/mcp.
const CHECKOUT_PACKAGE_URLS = ['../packages/render-native/index.mjs', '../../packages/render-native/index.mjs']
  .map(relative => new URL(/* @vite-ignore */ relative, import.meta.url));
const TABLE_NAMES = ['triangles', 'materials', 'lights', 'atlas', 'environmentColors', 'environmentTables', 'parameters'];
const TABLE_TYPES = { triangles: Float32Array, materials: Float32Array, lights: Float32Array, atlas: Uint32Array,
  environmentColors: Float32Array, environmentTables: Float32Array, parameters: Uint8Array };

async function importNativePackage(importPackage) {
  try {
    return await importPackage(NATIVE_PACKAGE);
  } catch {
    for (const packageUrl of CHECKOUT_PACKAGE_URLS) {
      if (!existsSync(fileURLToPath(packageUrl))) continue;
      try {
        return await importPackage(packageUrl.href);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * A cached look for the native tracer. Looking costs one import and one file check, done once per process. `markUnusable`
 * records a failure from a real trace (usually no ray query adapter), so later jobs skip the attempt and keep the reason.
 */
export function createNativeTracerLocator({ importPackage = specifier => import(specifier) } = {}) {
  let lookup;
  let unusableReason = null;
  return {
    async find() {
      // JS67_NATIVE_TRACER=off keeps a job on the gpu or cpu backend whatever is installed, which is also how the fallback is tested.
      if (process.env.JS67_NATIVE_TRACER === 'off') return { reason: 'renderer.backend "native" is switched off by JS67_NATIVE_TRACER=off.' };
      lookup ??= importNativePackage(importPackage).then(tracer => {
        if (!tracer) return { reason: `renderer.backend "native" needs ${NATIVE_PACKAGE}.` };
        if (!tracer.findNativeAddon()) return { reason: `renderer.backend "native" needs the built binary of ${NATIVE_PACKAGE} (npm run build in that package).` };
        return { tracer };
      });
      const found = await lookup;
      if (unusableReason) return { reason: unusableReason };
      return found;
    },
    markUnusable(reason) {
      unusableReason = `renderer.backend "native" could not trace (${reason}), which usually means no Vulkan ray query adapter.`;
    },
  };
}

/**
 * Which backend a job's frames run on. "native" falls back to gpu, or to cpu on a runtime without a GPU, and `note` says why.
 * Every other request runs as asked, and the caller still rejects "gpu" on a cpu runtime.
 */
export async function chooseTraceBackend({ requested, runtimeBackend, locator }) {
  if (requested !== 'native') return { backend: requested };
  const found = await locator.find();
  if (found.tracer) return { backend: 'native', tracer: found.tracer };
  const fallback = runtimeBackend === 'cpu' ? 'cpu' : 'gpu';
  return { backend: fallback, note: `${found.reason} The ${fallback} backend ran instead.` };
}

function decodeTables(exported) {
  const input = { triangleCount: exported.triangleCount };
  for (const name of TABLE_NAMES) {
    const bytes = Buffer.from(exported.tables[name], 'base64');
    const View = TABLE_TYPES[name];
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    input[name] = new View(copy.buffer, 0, copy.length / View.BYTES_PER_ELEMENT);
  }
  return input;
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

function withoutAlpha(rgba, pixelCount) {
  const color = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    color.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  }
  return color;
}

/**
 * Traces one frame the page exported and returns the PNG (base64) with the job report. `denoise` is "none", "wavelet" or
 * "oidn"; `denoiser` is the loaded OIDN package for "oidn". Throws when the tracer cannot run, so the caller can fall back.
 */
export async function traceFrameNative({ tracer, exported, width, height, samples, bounces, seed, denoise, denoiser, maxSeconds, noiseThreshold = 0 }) {
  const started = performance.now();
  const traced = tracer.traceNative(decodeTables(exported), { width, height, samples, maxSeconds });
  const tracedSeconds = (performance.now() - started) / 1000;
  const pixelCount = width * height;
  const features = { color: withoutAlpha(traced.rgba, pixelCount), albedo: traced.albedo, normal: traced.normal,
    depth: traced.depth, variance: traced.variance };
  normalizeNormals(features.normal);
  const report = { width, height, samples, bounces, seed, denoised: false, denoiser: 'none', threads: 1, backend: 'native',
    gpu: traced.adapter, nativeBackend: traced.backend, nativeFeatures: traced.features, setupSeconds: traced.setupSeconds, compileSeconds: traced.compileSeconds,
    uploadSeconds: traced.uploadSeconds, accelerationBuildSeconds: traced.accelerationBuildSeconds,
    averageSamples: traced.averageSamples ?? samples, noiseThreshold, triangles: exported.triangles, tracedSeconds, ignored: exported.ignored };
  let linear = features.color;
  const denoiseStarted = performance.now();
  if (denoise === 'oidn') {
    try {
      linear = await denoiser.denoiseWithOidn({ width, height, color: features.color, albedo: features.albedo, normal: features.normal });
      Object.assign(report, { denoised: true, denoiser: 'oidn', oidnVersion: denoiser.OIDN_VERSION });
    } catch (error) {
      report.denoiserNote = `OIDN failed (${error.message}): the wavelet filter ran instead.`;
      denoise = 'wavelet';
    }
  }
  if (denoise === 'wavelet') {
    const { denoiseRadiance } = await import('../src/path-tracer-denoise.js');
    linear = denoiseRadiance({ width, height, ...features });
    Object.assign(report, { denoised: true, denoiser: 'wavelet' });
  }
  if (report.denoised) report.denoiseSeconds = (performance.now() - denoiseStarted) / 1000;
  const [{ toneMapToRgba8 }, { encodePng }] = await Promise.all([import('../src/path-tracer.js'), import('../src/export-png.js')]);
  const png = encodePng(toneMapToRgba8(linear, width, height), width, height);
  report.seconds = (performance.now() - started) / 1000;
  return { data: Buffer.from(png).toString('base64'), report };
}

function floatsToBase64(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

function floatsFromBase64(data) {
  const bytes = Buffer.from(data, 'base64');
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, copy.length / Float32Array.BYTES_PER_ELEMENT);
}

/**
 * Traces the texels of a recipe bake that the page packed, for the page's `__67jsNativeBake` bridge. `request` holds the
 * scene `tables` and `triangleCount` as `exportNativeScene` makes them, plus `texelCount`, `points`, `normals` (base64
 * floats) and `samples`. Resolves with the base64 `radiance` and `escaped` arrays; throws when the tracer cannot run.
 */
export function traceTexelsNative({ tracer, request, maxSeconds }) {
  const texels = { count: request.texelCount, points: floatsFromBase64(request.points), normals: floatsFromBase64(request.normals) };
  const traced = tracer.traceNativeTexels(decodeTables(request), texels, { samples: request.samples, maxSeconds });
  return { radiance: floatsToBase64(traced.radiance), escaped: floatsToBase64(traced.escaped), adapter: traced.adapter,
    compileSeconds: traced.compileSeconds, tracedSeconds: traced.tracedSeconds };
}

/** True for the error the native tracer raises when a trace passes its `maxSeconds`: a clean failure, not a broken adapter. */
export function isNativeTimeLimitError(error) {
  return /passed its time limit/.test(error?.message ?? '');
}

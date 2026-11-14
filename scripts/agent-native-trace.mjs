// renderer.backend "native" on render jobs: the optional hardware ray query tracer (Cook, @codepawlhq/cook) traces the scene
// the job page exported, then the job runner denoises and writes the PNG. The package and its binary are optional: when they,
// or a Vulkan ray query adapter, are missing, the job runs on the gpu or cpu backend and the report says why.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clampLimitsByEngine, requireRenderEngine } from './render-engine.mjs';
import { NATIVE_JOB_MAXIMUM_INSTANCES, NATIVE_JOB_MAXIMUM_TRIANGLES } from './native-bake-page.js';

// The name sits in a variable so the bundler leaves the import alone; the package resolves from the user's node_modules.
const NATIVE_PACKAGE = '@codepawlhq/cook';
const INSTALL_HINT = 'npm install github:codepawl/cook, then npm run build inside it';
const MODULE_NOT_FOUND_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
// The 67js defaults of a job, lowered by the limits the installed engine declares.
const DEFAULT_ENGINE_LIMITS = { triangles: NATIVE_JOB_MAXIMUM_TRIANGLES, instances: NATIVE_JOB_MAXIMUM_INSTANCES };
const TABLE_NAMES = ['triangles', 'materials', 'lights', 'atlas', 'environmentColors', 'environmentTables', 'parameters'];
const TABLE_TYPES = { triangles: Float32Array, materials: Float32Array, lights: Float32Array, atlas: Uint32Array,
  environmentColors: Float32Array, environmentTables: Float32Array, parameters: Uint8Array };

const NOT_INSTALLED_REASON = `renderer.backend "native" needs ${NATIVE_PACKAGE} (${INSTALL_HINT}).`;

function isModuleNotFound(error, specifier) {
  return MODULE_NOT_FOUND_CODES.has(error?.code) && String(error.message).includes(specifier);
}

// COOK_PACKAGE_PATH names a local Cook checkout, whose index.mjs is imported by file URL.
function chooseSpecifier() {
  const checkoutPath = process.env.COOK_PACKAGE_PATH;
  if (!checkoutPath) return { specifier: NATIVE_PACKAGE };
  const indexPath = join(resolve(checkoutPath), 'index.mjs');
  if (!existsSync(indexPath)) return { missingReason: `renderer.backend "native" found no index.mjs in COOK_PACKAGE_PATH (${checkoutPath}); point it at a Cook checkout or unset it.` };
  return { specifier: pathToFileURL(indexPath).href };
}

// Resolves with { module }, { missingReason } for an absent package or { reason } for an install that exists but fails to load.
async function importNativePackage(importPackage) {
  const { specifier, missingReason } = chooseSpecifier();
  if (missingReason) return { missingReason };
  try {
    return { module: await importPackage(specifier) };
  } catch (error) {
    if (isModuleNotFound(error, specifier)) return { missingReason: NOT_INSTALLED_REASON };
    return { reason: `renderer.backend "native" found ${NATIVE_PACKAGE} but it failed to load (${error?.message ?? error}); reinstall it (${INSTALL_HINT}).` };
  }
}

function checkNativePackage(imported) {
  if (imported.missingReason) return { reason: imported.missingReason };
  if (imported.reason) return { reason: imported.reason };
  const checked = requireRenderEngine(imported.module);
  if (checked.reason) return { reason: `renderer.backend "native" cannot use ${NATIVE_PACKAGE}: ${checked.reason}` };
  let addonPath;
  try {
    addonPath = checked.engine.findNativeAddon();
  } catch (error) {
    return { reason: `renderer.backend "native" cannot find the binary of ${NATIVE_PACKAGE}: ${error.message}` };
  }
  if (!addonPath) return { reason: `renderer.backend "native" needs the built binary of ${NATIVE_PACKAGE} (npm run build in that package, or COOK_ADDON_PATH for a build elsewhere).` };
  const limits = clampLimitsByEngine(DEFAULT_ENGINE_LIMITS, checked.description.limits);
  return { tracer: checked.engine, description: checked.description, limits };
}

/**
 * A cached look for the native tracer. Looking costs one import and one file check, done once per process. `markUnusable`
 * records a failure from a real trace (usually no ray query adapter), so later jobs skip the attempt and keep the reason.
 * A found tracer comes with the engine `description` and the job `limits` (67js defaults lowered by the engine's own).
 */
export function createNativeTracerLocator({ importPackage = specifier => import(specifier) } = {}) {
  let lookup;
  let unusableReason = null;
  return {
    async find() {
      // JS67_NATIVE_TRACER=off keeps a job on the gpu or cpu backend whatever is installed, which is also how the fallback is tested.
      if (process.env.JS67_NATIVE_TRACER === 'off') return { reason: 'renderer.backend "native" is switched off by JS67_NATIVE_TRACER=off.' };
      // COOK_DISABLE=1 behaves like an absent package (the test helper and the build honour it too).
      if (process.env.COOK_DISABLE === '1') return { reason: NOT_INSTALLED_REASON };
      lookup ??= importNativePackage(importPackage).then(checkNativePackage);
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

const V2_TABLE_TYPES = { Uint8Array, Uint32Array, Int32Array, Float32Array };

// A table as bytes that start their own buffer, so any typed array can view them: base64 from a one-message export is
// decoded into a fresh buffer, and the bytes a chunked export collected are already one.
function tableBytesFrom(table) {
  if (table instanceof Uint8Array && !Buffer.isBuffer(table) && table.byteOffset === 0) return table;
  const bytes = typeof table === 'string' ? Buffer.from(table, 'base64') : table;
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/**
 * Reads every table of a chunked export (the `manifest` of splitExportForChunks) and returns the export with its `tables` as
 * bytes, which traceFrameNative takes like the base64 of a one-message export. `readChunk(name, offset)` resolves with the
 * base64 of one chunk. No single string holds a whole table, so the scene is bounded by memory, not by a message.
 */
export async function collectExportChunks(manifest, readChunk) {
  const { chunks, ...exported } = manifest;
  if (!chunks || !(chunks.chunkBytes > 0)) {
    throw new TypeError('collectExportChunks: the export carries no `chunks` manifest. Export the scene with transport "chunks".');
  }
  const tables = {};
  for (const [name, byteLength] of Object.entries(chunks.tables)) {
    const bytes = new Uint8Array(byteLength);
    for (let offset = 0; offset < byteLength; offset += chunks.chunkBytes) {
      const chunk = Buffer.from(await readChunk(name, offset), 'base64');
      const expectedLength = Math.min(chunks.chunkBytes, byteLength - offset);
      if (chunk.length !== expectedLength) {
        throw new RangeError(`The native scene export sent ${chunk.length} bytes of table "${name}" at offset ${offset}, expected ${expectedLength}. The page changed the export while it was read.`);
      }
      bytes.set(chunk, offset);
    }
    tables[name] = bytes;
  }
  return { ...exported, tables };
}

/**
 * Exports the scene of a render job from its page in chunks and returns it with byte tables. `input` is what the page's
 * `exportNativeScene` takes. The page lets go of its copy when the read ends, whether it succeeded or not.
 */
export async function fetchNativeExport(page, input) {
  const manifest = await page.evaluate(request => window.__agentPreview.exportNativeScene(request), { ...input, chunked: true });
  try {
    return await collectExportChunks(manifest, (name, offset) => page.evaluate(request => window.__agentPreview.readNativeExportChunk(request), { name, offset }));
  } finally {
    await page.evaluate(() => window.__agentPreview.releaseNativeExport()).catch(() => {});
  }
}

// The FORMAT-v2 input of an instanced scene: the page names each table's array type and sends the record counts.
function decodeTablesV2(exported) {
  const input = { schemaVersion: exported.schemaVersion, ...exported.counts };
  for (const [name, base64] of Object.entries(exported.tables)) {
    const View = V2_TABLE_TYPES[exported.types?.[name]];
    if (!View) throw new TypeError(`The exported native scene table "${name}" has an unknown array type ${JSON.stringify(exported.types?.[name])}.`);
    const bytes = tableBytesFrom(base64);
    input[name] = new View(bytes.buffer, 0, bytes.length / View.BYTES_PER_ELEMENT);
  }
  return input;
}

// The bytes of every table the tracer is handed, which is what it uploads to the card (before alignment).
function tableBytes(tables) {
  return Object.values(tables).reduce((total, value) => total + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);
}

function decodeTables(exported) {
  if (exported.schemaVersion !== undefined) return decodeTablesV2(exported);
  const input = { triangleCount: exported.triangleCount };
  for (const name of TABLE_NAMES) {
    const bytes = tableBytesFrom(exported.tables[name]);
    const View = TABLE_TYPES[name];
    input[name] = new View(bytes.buffer, 0, bytes.length / View.BYTES_PER_ELEMENT);
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
 * The native kernel a job traces with: "cycles" (the Cycles-matching kernel) unless JS67_NATIVE_KERNEL=legacy asks for the
 * older one. Any other value is passed on so `traceNative` rejects it with its own message.
 */
export function chooseNativeKernel(environment = process.env) {
  const requested = environment.JS67_NATIVE_KERNEL;
  return requested === undefined || requested === '' ? 'cycles' : requested;
}

/**
 * Whether a job keeps repeated geometry as instances: on with the "cycles" kernel, off with the legacy kernel and when
 * JS67_NATIVE_INSTANCING=off asks for flattened triangles (to compare the two, or to rule instancing out of a bug).
 */
export function chooseNativeInstancing(environment = process.env) {
  return chooseNativeKernel(environment) === 'cycles' && environment.JS67_NATIVE_INSTANCING !== 'off';
}

/**
 * The traced colour after the GPU a-trous filter, three floats per pixel. The cycles kernel already returned it when the
 * trace asked for `denoise: "atrous"`; otherwise (the legacy kernel, or the filter after OIDN failed) the tracer filters
 * the traced image with its guide buffers. Throws when the installed package cannot filter.
 */
function atrousColor({ tracer, traced, width, height }) {
  let filtered = traced.denoisedRgba;
  if (!filtered) {
    if (typeof tracer.denoiseAtrous !== 'function') throw new Error('the installed @codepawlhq/cook package has no a-trous filter');
    const { rgba, albedo, normal, depth, variance } = traced;
    filtered = tracer.denoiseAtrous({ width, height, rgba, albedo, normal, depth, variance }).rgba;
  }
  return withoutAlpha(filtered, width * height);
}

// One in-process OIDN device per loaded denoiser package, kept for the life of the process so the second and later frames
// skip device creation and the filter commit. `instance` is null when the package, the OIDN library or the addon cannot do it.
const persistentOidnByPackage = new WeakMap();

function persistentOidnFor({ tracer, denoiser }) {
  if (typeof denoiser.createOidnDenoiser !== 'function' || typeof tracer.createNativeOidnDenoiser !== 'function') return { instance: null };
  if (!persistentOidnByPackage.has(denoiser)) {
    try {
      persistentOidnByPackage.set(denoiser, { instance: denoiser.createOidnDenoiser({ createNative: tracer.createNativeOidnDenoiser }) });
    } catch (error) {
      persistentOidnByPackage.set(denoiser, { instance: null, note: error.message });
    }
  }
  return persistentOidnByPackage.get(denoiser);
}

/**
 * Runs OIDN on one frame: in the persistent in-process device when it is available, otherwise (or when that call fails)
 * through the `oidnDenoise` tool. Resolves with the filtered colour and `{ mode, note }`; `mode` is "in-process" or "cli".
 */
export async function denoiseFrameWithOidn({ tracer, denoiser, width, height, color, albedo, normal }) {
  const persistent = persistentOidnFor({ tracer, denoiser });
  let note = persistent.note;
  if (persistent.instance) {
    try {
      return { linear: await persistent.instance.denoise({ width, height, color, albedo, normal }), mode: 'in-process' };
    } catch (error) {
      note = error.message;
    }
  }
  const linear = await denoiser.denoiseWithOidn({ width, height, color, albedo, normal });
  return { linear, mode: 'cli', ...(note ? { note: `The in-process OIDN device was not used (${note}): the oidnDenoise tool ran instead.` } : {}) };
}

// Blends the filtered colour into the job's history and returns the colour to show. A frame that did not go through a
// session (a one-shot fallback) has no kernel parameter block to reproject with, so the history starts again after it.
function blendOverTime({ temporal, color, features, kernelParams, route, report }) {
  if (!kernelParams) {
    temporal.restart('the frame before did not render through a session');
    report.temporal = { historyShare: 0, restarted: 'this frame did not render through a session' };
    return color;
  }
  const started = performance.now();
  const blended = temporal.accumulate({ color, depth: features.depth, normal: features.normal, kernelParams,
    sceneChanged: route.path !== 'reused' });
  report.temporal = { historyShare: blended.historyShare, ...(blended.restarted ? { restarted: blended.restarted } : {}),
    seconds: (performance.now() - started) / 1000 };
  return blended.color;
}

/**
 * Traces one frame the page exported and returns the PNG (base64) with the job report. `denoise` is "none", "wavelet",
 * "atrous" (the tracer's GPU filter, which is also where a missing or failing OIDN lands) or "oidn"; `denoiser` is the
 * loaded OIDN package for "oidn". The result also holds `rawLinear`, the traced colour before any filter (three floats per
 * pixel), which equals `linear` when no filter ran. `sequence` (from createNativeSequence) renders a cycles kernel frame through the job's
 * persistent session and adds `report.nativeSession`, the route the frame took. `temporal` (from createTemporalAccumulator)
 * blends the filtered colour of a session frame into the frames before it and adds `report.temporal`; `linear` is the
 * blended colour and `rawLinear` stays the traced colour of this frame alone. Throws when the tracer cannot run, so the caller can fall back.
 */
export async function traceFrameNative({ tracer, exported, width, height, samples, bounces, seed, denoise, denoiser, maxSeconds, noiseThreshold = 0, kernel = chooseNativeKernel(), sequence, temporal }) {
  const started = performance.now();
  const filtersInTrace = denoise === 'atrous' && kernel === 'cycles';
  const tables = decodeTables(exported);
  const traceOptions = { width, height, samples, maxSeconds, kernel, noiseThreshold, ...(filtersInTrace ? { denoise: 'atrous' } : {}) };
  const { traced, route, kernelParams } = sequence && kernel === 'cycles'
    ? sequence.trace(tables, traceOptions)
    : { traced: tracer.traceNative(tables, traceOptions) };
  const tracedSeconds = (performance.now() - started) / 1000;
  const pixelCount = width * height;
  const features = { color: withoutAlpha(traced.rgba, pixelCount), albedo: traced.albedo, normal: traced.normal,
    depth: traced.depth, variance: traced.variance };
  normalizeNormals(features.normal);
  const report = { width, height, samples, bounces, seed, denoised: false, denoiser: 'none', threads: 1, backend: 'native',
    gpu: traced.adapter, nativeBackend: traced.backend, nativeFeatures: traced.features, setupSeconds: traced.setupSeconds, compileSeconds: traced.compileSeconds,
    uploadSeconds: traced.uploadSeconds, accelerationBuildSeconds: traced.accelerationBuildSeconds,
    kernel, averageSamples: traced.averageSamples ?? samples, noiseThreshold, triangles: exported.triangles, inputBytes: tableBytes(tables), ...(exported.instances === undefined ? {} : { instances: exported.instances }),
    ...(exported.instancing === undefined ? {} : { instancing: exported.instancing, instancingReason: exported.instancingReason }),
    ...(exported.materialsReason === undefined ? {} : { materialsReason: exported.materialsReason }), tracedSeconds, ignored: exported.ignored,
    ...(route ? { nativeSession: route } : {}) };
  const rawLinear = features.color;
  let linear = features.color;
  const denoiseStarted = performance.now();
  if (denoise === 'oidn') {
    try {
      const filtered = await denoiseFrameWithOidn({ tracer, denoiser, width, height, color: features.color, albedo: features.albedo, normal: features.normal });
      linear = filtered.linear;
      Object.assign(report, { denoised: true, denoiser: 'oidn', oidnVersion: denoiser.OIDN_VERSION, oidnMode: filtered.mode, ...(filtered.note ? { denoiserNote: filtered.note } : {}) });
    } catch (error) {
      report.denoiserNote = `OIDN failed (${error.message}): the GPU a-trous filter ran instead.`;
      denoise = 'atrous';
    }
  }
  if (denoise === 'atrous') {
    try {
      linear = atrousColor({ tracer, traced, width, height });
      Object.assign(report, { denoised: true, denoiser: 'atrous' });
    } catch (error) {
      const failure = `The GPU a-trous filter failed (${error.message}): the wavelet filter ran instead.`;
      report.denoiserNote = [report.denoiserNote, failure].filter(Boolean).join(' ');
      denoise = 'wavelet';
    }
  }
  if (denoise === 'wavelet') {
    const { denoiseRadiance } = await import('../src/path-tracer-denoise.js');
    linear = denoiseRadiance({ width, height, ...features });
    Object.assign(report, { denoised: true, denoiser: 'wavelet' });
  }
  if (report.denoised) report.denoiseSeconds = (performance.now() - denoiseStarted) / 1000;
  if (temporal) {
    linear = blendOverTime({ temporal, color: linear, features, kernelParams, route, report });
  }
  const [{ toneMapToRgba8 }, { encodePng }] = await Promise.all([import('../src/path-tracer.js'), import('../src/export-png.js')]);
  const png = encodePng(toneMapToRgba8(linear, width, height), width, height);
  report.seconds = (performance.now() - started) / 1000;
  return { data: Buffer.from(png).toString('base64'), report, linear, rawLinear };
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
  if (error?.code === 'COOK_TIME_LIMIT') return true;
  return /passed its time limit/.test(error?.message ?? '');
}

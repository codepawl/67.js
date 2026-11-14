import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sampleBrowserHeap, exceedsMemoryGuard } from './agent-memory-guard.mjs';
import { lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };
import { VEGETATION_CAPABILITY_NOTE } from '../src/agent-vegetation-notes.js';
import { CROWD_CAPABILITY_NOTE } from '../src/agent-crowd-notes.js';
import { SETTLE_CAPABILITY_NOTE } from '../src/settle-notes.js';
import { USER_PASS_CAPABILITIES } from '../src/user-pass.js';
import { GAME_CAPABILITIES } from '../src/game-setup-notes.js';
import { MESH_BLEND_CAPABILITIES } from '../src/mesh-blend.js';
import { MATERIAL_SNIPPET_CAPABILITIES } from '../src/material-snippet.js';
import { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, RENDER_PASS_NAMES, RENDER_PASS_DEPTH_RANGE, VIDEO_ENCODERS, MAXIMUM_VIDEO_SECONDS, MAXIMUM_JOB_FPS, MAXIMUM_JOB_FRAMES, MAXIMUM_JOB_SIDE, MAXIMUM_JOB_PIXELS, MAXIMUM_MEMORY_MIB, BAKE_WORKER_MAXIMUM_SECONDS } from '../src/agent-scene-capabilities.js';
import { PATH_TRACER_CAPABILITIES } from '../src/path-tracer-capabilities.js';
import { chooseDenoiser, finishWithOidn } from './agent-path-trace-denoise.mjs';
import { createNativeSequence } from './agent-native-sequence.mjs';
import { chooseNativeTemporal, createTemporalAccumulator, temporalFrameSeed } from './agent-native-temporal.mjs';
import { chooseNativeInstancing, chooseNativeKernel, chooseTraceBackend, createNativeTracerLocator, fetchNativeExport, isNativeTimeLimitError, traceFrameNative, traceTexelsNative } from './agent-native-trace.mjs';
import { addonCapabilities, addonFileFor, addonImportMap } from './mcp-addons.mjs';
import { createAgentAssetCatalog } from './agent-asset-catalog.mjs';
import { createPackRegistry } from './agent-packs.mjs';
import { MAXIMUM_INSTALLED_PACKS, MAXIMUM_PACK_BYTES, MAXIMUM_PACK_FILES, MAXIMUM_PACK_FILE_BYTES, MAXIMUM_PACK_JSON_BYTES, MAXIMUM_PACK_ITEMS_PER_KIND, PACK_CONTENT_KINDS } from '../src/pack-manifest.js';
import { geometryOnlyGlb } from './agent-query-asset.mjs';
import { AGENT_ASSET_LIMITS, assertCombinedAssetBytes } from '../src/agent-asset-limits.js';
import { recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { sequenceFrameIds } from '../src/agent-texture-sequence.js';
import { readVolumeGridFiles } from '../src/mcp-volume-grids.js';
import { catalogLookReferences, BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES } from '../src/look-catalog.js';
import { TEXTURE_SEQUENCE_CAPABILITIES } from '../src/texture-sequence-limits.js';
import { writeWebBuild } from './web-export.mjs';
import { gameAssetIds } from '../src/game-assets.js';
import { resolveJobRoot } from './agent-job-root.mjs';
import { createAgentRenderJobs, EXPORT_DIRECTORY_NAME, HIGH_PRECISION_FRAME_FACTOR, RENDER_HISTORY_FILE, normalizeJobSettings } from './agent-render-jobs.mjs';
import { RENDER_QUALITY_NOTE, applyQuality, tierReport } from './agent-render-quality.mjs';
import { RENDER_BUDGET_NOTE, chooseBudgetSettings, parseBudget } from './agent-render-budget.mjs';
import { RENDER_ESTIMATE_NOTE, estimateRenderJob, historyWithJob, parseHistory, renderReport, sceneSizeFrom } from './agent-render-estimate.mjs';
import { encodeRenderOutput, encodeMultilayerExr } from './render-output-encoders.mjs';
import { createFrameEncoder } from './frame-encoder.mjs';
import { DEFAULT_PAGE_ENCODER_QUANTIZER, createFrameReceiver, startVideoEncoderInPage } from './gpu-frame-reader.mjs';
import { audioInputArguments, createAudioLibrary, measureStreamSeconds } from './job-audio.mjs';
import { filmTimelineDuration, filmTimelineShotStarts, sampleFilmTimeline } from '../src/film-timeline.js';
import { isPreviewHost } from './preview-host.mjs';
import { runAnnotateSession } from './annotate-session.mjs';
import { openInDefaultBrowser } from './annotate-open.mjs';
import { ANNOTATE_LIMITS } from '../src/agent-annotate.js';
import { normalizeReview, REVIEW_LIMITS } from './agent-review.mjs';
import { mergeFrameDiagnostics, pathTracerFindingsLimit } from '../src/frame-checks.js';
import { BRANCH_LIMITS, validateBranchName } from '../src/agent-branches.js';
import { sessionProblem, SCENE_STORE_LIMITS } from '../src/agent-errors.js';

const SCENE_LIMITS = AGENT_SCENE_DEFAULT_LIMITS;
const MAXIMUM_IMAGE_BYTES = 1024 * 1024;
const LOOK_STEP_SCALE = 0.75;
const LOOK_MAXIMUM_STEP_DOWNS = 4;
const LOOK_MINIMUM_SIDE = 64;
const MAXIMUM_MOTION_SOURCES = 4;
// A job writes files, not MCP image responses, so a 1920x1080 PNG may be larger than an inline image.
const MAXIMUM_JOB_FRAME_BYTES = 12 * 1024 * 1024;
// The object ID pass lists the part behind each ID in the job metrics; longer lists are cut and flagged.
const MAXIMUM_OBJECT_NAMES = 1000;
// A path trace shares the machine with the person using it, so it takes half of the eight-thread ceiling.
const PATH_TRACER_THREADS = 8;
const MAXIMUM_QUEUED_CALLS = 16;
const MAXIMUM_REMEMBERED_EVICTIONS = 32;
const MAXIMUM_GLB_BYTES = 32 * 1024 * 1024;
const MAXIMUM_KEPT_GLBS = 8;
const MAXIMUM_KEPT_WEB_BUILDS = 4;
const EVALUATION_TIMEOUT_MS = 30000;
const QUERY_ONLY_TIMEOUT_MS = 120000;
/** A bake runs on a worker for up to its own limit, so a call that bakes gets that much more than a plain call. */
const BAKE_EVALUATION_TIMEOUT_MS = EVALUATION_TIMEOUT_MS + BAKE_WORKER_MAXIMUM_SECONDS * 1000;

/** The last set-bake among the operations decides: a bake object adds one, null clears it. Undefined when there is none. */
function bakeAfterOperations(operations) {
  const setBakes = Array.isArray(operations) ? operations.filter(operation => operation?.type === 'set-bake') : [];
  if (setBakes.length === 0) {
    return undefined;
  }
  const lastBake = setBakes[setBakes.length - 1].bake;
  return lastBake !== null && lastBake !== undefined;
}
// Decoded audio and video lengths of a finished file may differ by the encoder delay; more than this fails the job.
const SYNC_TOLERANCE_SECONDS = 0.05;
// The preview page imports engine chunks that sit beside the package entries, one folder above preview.js.
const ENGINE_CHUNK_URL = /^\/[\w.-]+\.js$/;
const pageHtml = importMapScript => '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#182126}canvas{display:block;width:100vw;height:100vh}</style></head><body><canvas></canvas>' + importMapScript + '<script type="module" src="/preview.js"></script></body></html>';

/** Local, serialized browser preview. No browser is launched until scene creation. */
// Optional peer dependencies the page loads from the host's node_modules. Rapier ships its WASM inside rapier.mjs.
const VENDOR_FILES = Object.freeze({
  '/vendor/manifold.js': { resolve: require => require.resolve('manifold-3d/manifold.js'), type: 'application/javascript; charset=utf-8' },
  '/vendor/manifold.wasm': { resolve: require => require.resolve('manifold-3d/manifold.wasm'), type: 'application/wasm' },
  '/vendor/rapier.js': { resolve: require => join(dirname(require.resolve('@dimforge/rapier3d-compat')), 'rapier.mjs'), type: 'application/javascript; charset=utf-8' },
});

export function createAgentRuntime({ kernelWorkers = true, backend = 'gpu', browser: browserPath, memory = 192, assets: assetRoot, packs: packsRoot,
  jobs: jobRoot, ffmpeg = 'ffmpeg', audio: audioRoot, openPage = openInDefaultBrowser, addons: addonSet = { addons: [], skipped: [] },
  previewUrl = new URL(/* @vite-ignore */ '../build/mcp/preview.js', import.meta.url) } = {}) {
  if (!['gpu', 'cpu'].includes(backend)) {
    throw new RangeError('backend must be gpu or cpu.');
  }
  let nativeTracerLocator;
  if (!Number.isInteger(memory) || memory < 32 || memory > MAXIMUM_MEMORY_MIB) {
    throw new RangeError(`memory must be an integer from 32 to ${MAXIMUM_MEMORY_MIB} MiB.`);
  }
  if (browserPath !== undefined && (typeof browserPath !== 'string' || !existsSync(browserPath))) {
    throw new Error('The configured browser executable does not exist.');
  }
  if (assetRoot !== undefined && (typeof assetRoot !== 'string' || !isAbsolute(assetRoot))) {
    throw new TypeError('Asset root must be an explicit absolute directory path.');
  }
  if (packsRoot !== undefined && (typeof packsRoot !== 'string' || !isAbsolute(packsRoot))) {
    throw new TypeError('Packs root must be an explicit absolute directory path.');
  }
  jobRoot = resolveJobRoot(jobRoot);
  const importMapScript = addonSet.addons.length === 0 ? '' : `<script type="importmap">${JSON.stringify(addonImportMap(packageMetadata.exports))}</script>`;
  // The one inline script is the import map; its hash is allowed so script-src stays 'self'. No addons, no hash.
  const importMapHash = addonSet.addons.length === 0 ? '' : ` 'sha256-${createHash('sha256').update(importMapScript.slice(importMapScript.indexOf('>') + 1, -'</script>'.length)).digest('base64')}'`;
  const registeredByAddon = {};
  const refusedAddons = [];
  const audioLibrary = audioRoot === undefined ? undefined : createAudioLibrary(audioRoot);
  if (typeof ffmpeg !== 'string' || !ffmpeg || (ffmpeg !== 'ffmpeg' && (!isAbsolute(ffmpeg) || !existsSync(ffmpeg)))) {
    throw new TypeError('FFmpeg must be on PATH or configured with an existing absolute executable path.');
  }
  let phase = 'idle';
  let browserInstance;
  let httpServer;
  // The job that is capturing video frames, if any. Its socket path is secret and lives only as long as the job.
  let activeFrameReceiver;
  let page;
  let reviewPage;
  let cancelReview;
  // Open scenes, least recently used first; the last one is what a call without a sessionId means.
  const openSessionIds = new Set();
  // Scenes the page closed to stay under the scene cap, so a later call with one of them gets a clear error.
  const evictedSessionIds = [];
  // Scenes that have a bake, so an edit that rebakes gets the longer deadline.
  const bakedSessionIds = new Set();
  let queuedCalls = 0;
  let queue = Promise.resolve();
  let closing;
  let catalogPromise;
  let packsPromise;
  let jobsPromise;
  // Set by submitJob for the one job that may run; runJob takes it. Kept in the job folder, the history never leaves the machine.
  let estimateForNextJob;
  let gpuTracerWarm = false;
  async function readRenderHistory() {
    try {
      return parseHistory(await readFile(join(jobRoot, RENDER_HISTORY_FILE), 'utf8'));
    } catch {
      return [];
    }
  }
  // The history only sharpens later estimates, so a failed write never fails the job that finished.
  async function rememberRenderJob({ settings, estimate, report }) {
    try {
      const history = historyWithJob(await readRenderHistory(), { settings, backend, estimate, report });
      await writeFile(join(jobRoot, RENDER_HISTORY_FILE), JSON.stringify(history), { mode: 0o600 });
    } catch (error) {
      console.error(`Crucible could not save the render history: ${error.message}`);
    }
  }
  const savedGlbPaths = [];
  const savedWebBuildPaths = [];
  // Capabilities must work without the job store: a store that cannot open is reported here, not thrown.
  async function jobRecords() {
    if (!jobRoot) return { records: [] };
    try {
      const records = (await jobs()).list().map(record => ({ jobId: record.jobId, state: record.state,
        sourceRevision: record.sourceRevision, progress: record.progress }));
      return { records };
    } catch (error) {
      return { records: [], unavailable: error.message };
    }
  }
  function jobs() {
    if (!jobRoot) throw new Error('Configure --jobs with an absolute output directory before submitting render jobs.');
    if (!jobsPromise && closing) throw new Error('The agent runtime is closing or closed.');
    // A failed creation is not kept: the next call tries again instead of repeating the first error until restart.
    jobsPromise ??= createAgentRenderJobs({ root: jobRoot, run: runJob }).catch(error => {
      jobsPromise = undefined;
      throw error;
    });
    return jobsPromise;
  }
  // The caller never names a path: files get a server-chosen name in the jobs folder, and only the newest few are kept.
  async function saveGlbExport(bytes) {
    const directory = join(jobRoot, EXPORT_DIRECTORY_NAME);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('The export folder must be a real directory without links.');
    while (savedGlbPaths.length >= MAXIMUM_KEPT_GLBS) await unlink(savedGlbPaths.shift());
    const filename = `${randomUUID()}.glb`;
    const path = join(directory, filename);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    savedGlbPaths.push(path);
    return { path, filename, mimeType: 'model/gltf-binary', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), keptExports: savedGlbPaths.length };
  }
  async function requirePreviewRenderer() {
    if (phase !== 'rendering') return;
    const terminal = ['completed', 'cancelled', 'failed', 'interrupted'];
    if ((await jobs()).list().some(record => !terminal.includes(record.state))) {
      throw new Error('The renderer is leased to a render job. Wait for completion or cancel the job.');
    }
    // A queued job can be cancelled before its runner acquires the renderer.
    phase = 'ready';
  }
  function catalog() {
    if (!assetRoot && !packsRoot) throw new Error('Configure --assets or --packs with an absolute directory before importing GLB assets.');
    catalogPromise ??= packs().then(registry => createAgentAssetCatalog(assetRoot ?? null, registry?.files));
    return catalogPromise;
  }
  // Installed data-only packs (docs/packs.md): checked once per runtime; their GLB, image, look and HDRI files join the catalog.
  function packs() {
    if (!packsRoot) return Promise.resolve(null);
    packsPromise ??= createPackRegistry(packsRoot, { packageVersion: packageMetadata.version });
    return packsPromise;
  }

  /** Bytes of the catalog assets a recipe or edit list places, base64 by asset id, for the page that decodes them. */
  async function placedAssetData(value) {
    const needs = recipeAssetNeeds(value);
    const entries = await Promise.all(needs.map(async ({ id }) => [id, (await (await catalog()).read(id)).toString('base64')]));
    return { ...(needs.length ? { assetData: Object.fromEntries(entries) } : {}), ...(await sequenceFrameData(value)), ...(await lookFileData(value)), ...volumeGridData(value) };
  }

  /**
   * A set-game that animates a node the scene already places needs one more decoded copy of that asset, which the operations alone do not
   * name. Returns the scene's nodes with the new game, which the page and the byte loader read the asset needs from, or undefined.
   */
  async function gameAssetNeeds({ sessionId, operations }) {
    const setGame = (operations ?? []).findLast(operation => operation.type === 'set-game');
    if (!setGame?.game) return undefined;
    const { recipe } = await invoke('exportRecipe', { sessionId });
    const candidate = { nodes: recipe.nodes, game: setGame.game };
    return recipeAssetNeeds(candidate).some(need => need.copies > 1) ? { recipe: candidate } : undefined;
  }

  /** The HDRI and .cube files a recipe names: shipped ones by name from assets/looks, the others by catalog ID. The page decodes them. */
  async function lookFileData(value) {
    const { environments, looks } = catalogLookReferences(value);
    // Derived from previewUrl (build/mcp/preview.js in the repo and the package), not from import.meta.url: the bundler
    // inlines a literal `new URL(..., import.meta.url)` as a data URL, and the bundled server sits two folders below the package root.
    const shippedLooksUrl = new URL('../../assets/looks/', previewUrl);
    const lookData = {};
    for (const [kind, references] of [['environment', environments], ['look', looks]]) {
      for (const reference of references) {
        const shipped = BUNDLED_ENVIRONMENT_NAMES.includes(reference) || BUNDLED_CUBE_LOOK_NAMES.includes(reference);
        const bytes = shipped
          ? await readFile(new URL(`${reference}.${kind === 'environment' ? 'hdr' : 'cube'}`, shippedLooksUrl))
          : await (await catalog()).read(reference);
        lookData[reference] = kind === 'environment' ? { kind, base64: bytes.toString('base64') } : { kind, text: bytes.toString('utf8') };
      }
    }
    return Object.keys(lookData).length ? { lookData } : {};
  }

  /** Bytes of the catalog images a recipe or edit list uses as map sequence frames, base64 by asset id. The page decodes them. */
  async function sequenceFrameData(value) {
    const ids = sequenceFrameIds(value);
    if (!ids.length) return {};
    const entries = await Promise.all(ids.map(async id => [id, (await (await catalog()).read(id)).toString('base64')]));
    return { sequenceData: Object.fromEntries(entries) };
  }

  /** Bytes of the grid files (.67vg) the grid volumes of a recipe or edit list name, base64 by file name, never a path. The page registers them. */
  function volumeGridData(value) {
    const files = readVolumeGridFiles(value);
    if (!files.size) return {};
    return { gridData: Object.fromEntries([...files].map(([name, bytes]) => [name, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')])) };
  }

  // Motion layers can play a clip of another catalog asset (`from.asset`). The page gets those assets' bytes by catalog ID,
  // never a path, and keeps only their clips and nodes.
  async function motionSources(motions) {
    const ids = new Set();
    for (const motion of motions) {
      for (const layer of Array.isArray(motion?.layers) ? motion.layers : []) {
        const id = layer?.from?.asset;
        if (typeof id === 'string' && /^[a-f0-9]{64}$/i.test(id)) ids.add(id.toLowerCase());
      }
    }
    if (ids.size > MAXIMUM_MOTION_SOURCES) throw new RangeError(`Motion layers can retarget clips of at most ${MAXIMUM_MOTION_SOURCES} other assets at once.`);
    if (!ids.size) return {};
    const sources = {};
    for (const id of ids) sources[id] = (await (await catalog()).read(id)).toString('base64');
    return { sources };
  }

  function enqueue(task) {
    if (closing || phase === 'closing' || phase === 'closed' || phase === 'failed') {
      return Promise.reject(new Error(`The agent runtime is ${phase}.`));
    }
    if (queuedCalls >= MAXIMUM_QUEUED_CALLS) {
      return Promise.reject(new Error('The preview call queue is full. Retry after pending calls finish.'));
    }
    queuedCalls++;
    const result = queue.then(() => {
      if (closing || phase === 'closed' || phase === 'failed') {
        throw new Error(`The agent runtime is ${closing ? 'closing' : phase}.`);
      }
      return task();
    });
    queue = result.catch(() => {}).finally(() => {
      queuedCalls--;
    });
    return result;
  }

  async function shutdownResources() {
    try {
      await browserInstance?.close();
    } finally {
      browserInstance = undefined;
      page = undefined;
      if (httpServer?.listening) {
        httpServer.closeAllConnections();
        await new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()));
      }
      httpServer = undefined;
    }
  }

  // The page shares engine chunks with the package entries, so it asks for them by name next to preview.js.
  function serveEngineChunk(url, response) {
    const chunkDirectory = fileURLToPath(new URL('../', previewUrl));
    readFile(join(chunkDirectory, url.slice(1))).then(bytes => {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  }

  // Only files inside an allowlisted addon's own package folder, found by the index it was given at startup.
  function serveAddonFile(url, response) {
    const path = addonFileFor(addonSet.addons, url.split('?')[0]);
    if (path === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    readFile(path).then(bytes => {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  }

  // Loads each allowlisted addon in the page. One that fails is skipped with its reason; the others stay.
  async function loadAddons() {
    for (const [index, addon] of addonSet.addons.entries()) {
      try {
        const added = await page.evaluate(input => window.__agentPreview.loadAddon(input), { url: `/addons/${index}/${addon.entry}`, name: addon.name, extensionPoints: addon.extensionPoints });
        registeredByAddon[addon.name] = added;
      } catch (error) {
        const reason = String(error.message).replace(/^page\.evaluate: /, '').split('\n')[0];
        refusedAddons.push({ name: addon.name, reason });
        console.error(`Crucible addon ${addon.name} skipped: ${reason}`);
      }
    }
  }

  // Mesh booleans load Manifold and recipe physics loads Rapier, both optional peer dependencies, from the host's
  // node_modules. Without one the page gets a 404 and the edit reports the install command.
  function serveVendorFile({ resolve, type }, response) {
    let path;
    try {
      path = resolve(createRequire(import.meta.url));
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    readFile(path).then(bytes => {
      response.setHeader('Content-Type', type);
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  }

  async function boot() {
    if (page) {
      return;
    }
    phase = 'starting';
    try {
      const [{ chromium }, code] = await Promise.all([
        import('playwright-core'),
        readFile(previewUrl, 'utf8'),
      ]);
      httpServer = createServer((request, response) => {
        if (!isPreviewHost(request.headers.host, httpServer.address().port)) {
          response.writeHead(403);
          response.end();
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'${importMapHash}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self' blob:`);
        if (request.method === 'GET' && request.url.startsWith('/addons/')) {
          serveAddonFile(request.url, response);
          return;
        }
        const vendor = request.method === 'GET' ? VENDOR_FILES[request.url] : undefined;
        if (vendor) {
          serveVendorFile(vendor, response);
          return;
        }
        if (request.method === 'GET' && request.url !== '/preview.js' && ENGINE_CHUNK_URL.test(request.url)) {
          serveEngineChunk(request.url, response);
          return;
        }
        if (request.method !== 'GET' || !['/', '/preview.js'].includes(request.url)) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.setHeader('Content-Type', request.url === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8');
        response.end(request.url === '/' ? pageHtml(importMapScript) : code);
      });
      httpServer.on('upgrade', (request, socket, head) => {
        const accepted = isPreviewHost(request.headers.host, httpServer.address().port)
          && activeFrameReceiver?.handleUpgrade(request, socket, head);
        if (!accepted) socket.destroy();
      });
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${httpServer.address().port}`;
      const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
      if (backend === 'cpu') {
        args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
      }
      browserInstance = await chromium.launch({ headless: true, args,
        ...(browserPath ? { executablePath: browserPath } : { channel: 'chrome' }),
      });
      page = await browserInstance.newPage({ viewport: { width: 768, height: 512 }, deviceScaleFactor: 1 });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === origin ? route.continue() : route.abort();
      });
      page.setDefaultTimeout(15000);
      if (backend === 'gpu') await page.exposeFunction('__crucibleNativeBake', answerNativeBake);
      if (!kernelWorkers) {
        await page.addInitScript(() => { globalThis.__crucibleKernelWorkers = 'off'; });
      }
      // A kernel that fell back to the main thread says so on the page console; keep that note in the server's stderr.
      page.on?.('console', message => {
        if (message.text().startsWith('Crucible kernel fallback')) console.error(message.text());
      });
      await page.goto(origin);
      await page.waitForFunction(() => Boolean(window.__agentPreview));
      await loadAddons();
      phase = 'ready';
    } catch (error) {
      phase = 'failed';
      await shutdownResources();
      throw error;
    }
  }

  // The page's bridge to the native tracer for recipe bakes: `probe` says whether it can run, `trace` bakes the texels the page
  // packed. A failure comes back as `{ error }` so the page falls back to its own GPU kernel, and the cause is remembered, so
  // later bakes and render jobs skip the attempt.
  async function answerNativeBake(request) {
    nativeTracerLocator ??= createNativeTracerLocator();
    const found = await nativeTracerLocator.find();
    if (request.action === 'probe') return { available: Boolean(found.tracer) };
    if (!found.tracer) return { error: found.reason };
    try {
      return traceTexelsNative({ tracer: found.tracer, request, maxSeconds: BAKE_WORKER_MAXIMUM_SECONDS });
    } catch (error) {
      if (!isNativeTimeLimitError(error)) nativeTracerLocator.markUnusable(error.message);
      return { error: error.message };
    }
  }

  function lastUsedSessionId() {
    let lastUsed = null;
    for (const sessionId of openSessionIds) lastUsed = sessionId;
    return lastUsed;
  }

  function forgetSession(sessionId) {
    openSessionIds.delete(sessionId);
    bakedSessionIds.delete(sessionId);
  }

  function forgetAllSessions() {
    openSessionIds.clear();
    bakedSessionIds.clear();
  }

  function requireSession(sessionId) {
    if (!openSessionIds.has(sessionId)) {
      throw new Error(sessionProblem(sessionId, lastUsedSessionId(), { openSessionIds: [...openSessionIds], evictedSessionIds }));
    }
    // Re-insert so the Set order stays least to most recently used.
    openSessionIds.delete(sessionId);
    openSessionIds.add(sessionId);
  }

  // The page returns the scenes it closed to make room; the runtime forgets them and remembers why they are gone.
  function registerCreatedScene(sessionId, result, hasBake) {
    for (const evictedSessionId of result.evictedSessions ?? []) {
      forgetSession(evictedSessionId);
      evictedSessionIds.push(evictedSessionId);
    }
    evictedSessionIds.splice(0, Math.max(0, evictedSessionIds.length - MAXIMUM_REMEMBERED_EVICTIONS));
    openSessionIds.add(sessionId);
    if (hasBake) bakedSessionIds.add(sessionId);
  }

  async function invoke(method, input, timeoutMs = EVALUATION_TIMEOUT_MS) {
    requireSession(input.sessionId);
    if (!browserInstance?.isConnected() || page.isClosed()) {
      phase = 'failed';
      throw new Error('The preview browser disconnected. The scene cannot be recovered from this runtime.');
    }
    return evaluate(method, input, page, timeoutMs);
  }

  async function evaluate(method, input, target = page, timeoutMs = EVALUATION_TIMEOUT_MS) {
    assertCombinedAssetBytes(input);
    let timer;
    let timedOut = false;
    try {
      return await Promise.race([
        target.evaluate(({ method, input }) => window.__agentPreview[method](input), { method, input }),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            if (target === page) phase = 'failed';
            reject(new Error(target === page
              ? `The preview operation exceeded ${timeoutMs / 1000} seconds. This runtime must be closed.`
              : `The private render operation exceeded ${timeoutMs / 1000} seconds.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (timedOut) {
        if (target === page) {
          forgetAllSessions();
          await shutdownResources();
        } else {
          await target.close();
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runJob({ jobId, sessionId, directory, snapshot, settings, signal, progress }) {
    let jobPage;
    let session;
    let encoder;
    let frameReceiver;
    // A stills or video job of native frames renders them all through one session; it is closed when the job ends.
    let nativeSequence;
    // A native video job blends each frame into the ones before it, so the noise the denoiser leaves does not shimmer.
    let nativeTemporal;
    let nativeTemporalShotIndex;
    let pageEncodes = false;
    let suspended = false;
    const started = performance.now();
    // One job runs at a time, so the estimate made at submission belongs to the job that starts next.
    const estimate = estimateForNextJob;
    estimateForNextJob = undefined;
    const metrics = { backend, requestedWidth: settings.width, requestedHeight: settings.height,
      renderSeconds: 0, captureSeconds: 0, peakNodeBytes: 0, peakBrowserHeap: 0, maximumPendingFrames: 1 };
    async function recordPeakMemory() {
      metrics.peakNodeBytes = Math.max(metrics.peakNodeBytes, process.memoryUsage().rss);
      metrics.peakBrowserHeap = Math.max(metrics.peakBrowserHeap, await sampleBrowserHeap(session));
      if (exceedsMemoryGuard({ nodeBytes: metrics.peakNodeBytes, browserHeapBytes: metrics.peakBrowserHeap })) {
        throw new Error('Render job exceeded its Node RSS or sampled browser heap guard.');
      }
    }
    const abort = () => { jobPage?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await enqueue(async () => {
        await invoke('suspend', { sessionId });
        suspended = true;
      });
      signal.throwIfAborted();
      jobPage = await browserInstance.newPage({ viewport: { width: settings.width, height: settings.height }, deviceScaleFactor: 1 });
      signal.throwIfAborted();
      const origin = `http://127.0.0.1:${httpServer.address().port}`;
      await jobPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      jobPage.setDefaultTimeout(15000);
      await jobPage.goto(origin);
      await jobPage.waitForFunction(() => Boolean(window.__agentPreview));
      const input = { sessionId: jobId, recipe: snapshot.recipe, memoryBudgetMiB: memory, backend, ...(settings.transparent ? { transparent: true } : {}), ...(settings.quality ? { tier: settings.quality } : {}),
        ...(snapshot.assetBytes ? { data: snapshot.assetBytes.toString('base64'), ...(await motionSources([snapshot.recipe.motion])) } : await placedAssetData(snapshot.recipe)) };
      const created = await jobPage.evaluate(({ method, input }) => window.__agentPreview[method](input),
        { method: snapshot.assetBytes ? 'createAsset' : 'create', input });
      const width = settings.kind === 'video' ? Math.floor(created.render.width / 2) * 2 : created.render.width;
      const height = settings.kind === 'video' ? Math.floor(created.render.height / 2) * 2 : created.render.height;
      if (width < 64 || height < 64) throw new Error('Render budget reduced the job below its minimum output size.');
      await jobPage.setViewportSize({ width, height });
      session = await jobPage.context().newCDPSession(jobPage);
      const region = settings.region;
      if (settings.format && settings.format !== 'png') await jobPage.evaluate(prepareInput => window.__agentPreview.prepareFloatOutput(prepareInput), { sessionId: jobId });
      if (settings.passes?.includes('wireframe')) await jobPage.evaluate(prepareInput => window.__agentPreview.prepareWireframe(prepareInput), { sessionId: jobId });
      // A memory budget can shrink the frame below the size the region was chosen for.
      if (region && (region.x + region.width > width || region.y + region.height > height)) {
        throw new Error(`The region lies outside the rendered frame, which the memory budget reduced to ${width}x${height}.`);
      }
      const outputWidth = region?.width ?? width;
      const outputHeight = region?.height ?? height;
      const format = settings.format ?? 'png';
      const highPrecision = format !== 'png';
      const artifactExtension = format === 'exr' ? 'exr' : 'png';
      const artifactMimeType = format === 'exr' ? 'image/x-exr' : 'image/png';
      // A transparent canvas shows the page behind it in a screenshot, so the page and the browser's default are made clear.
      if (settings.transparent) {
        await session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        await jobPage.evaluate(() => {
          document.documentElement.style.background = 'transparent';
          document.body.style.background = 'transparent';
        });
      }
      const artifacts = [];
      const timeline = settings.timeline ? snapshot.recipe.timeline : undefined;
      const audio = settings.audio ? await prepareAudio(settings) : undefined;
      if (settings.kind === 'video') {
        // With NVENC the page encodes each frame in the browser and sends only the H.264 chunks over a socket on the
        // preview's own port (issue #301). Otherwise, or when the browser cannot encode this size, frames are screenshots.
        frameReceiver = createFrameReceiver({ maximumBytes: width * height * 4 });
        activeFrameReceiver = frameReceiver;
        const frameSocketUrl = `ws://127.0.0.1:${httpServer.address().port}${frameReceiver.path}`;
        // A path traced frame is a PNG made outside the page's drawing buffer, so the browser encoder has nothing to encode.
        if (settings.encoder === 'nvenc' && !settings.renderer && !region) {
          const pageEncoder = await startVideoEncoderInPage(jobPage, frameSocketUrl,
            { width, height, fps: settings.fps, quantizer: DEFAULT_PAGE_ENCODER_QUANTIZER });
          pageEncodes = pageEncoder.supported;
        }
        encoder = createFrameEncoder({ executable: ffmpeg, output: join(directory, 'render.mp4.partial'),
          fps: settings.fps, format: pageEncodes ? 'h264' : settings.renderer ? 'png' : 'jpeg', width: outputWidth, height: outputHeight, signal, maximumFrameBytes: MAXIMUM_JOB_FRAME_BYTES, backend: settings.encoder === 'nvenc' ? 'gpu' : 'cpu',
          audioArguments: settings.audio ? audioInputArguments(audio.path, settings.audio.offset) : [],
          audioCodec: settings.audio?.track === 'pcm' ? 'pcm' : 'aac' });
        if (pageEncodes) frameReceiver.onChunk(chunk => encoder.writeChunk(chunk));
        metrics.videoEncoder = pageEncodes ? 'browser-h264' : settings.encoder === 'nvenc' ? 'h264_nvenc' : 'libx264';
      }
      if (timeline) metrics.shots = filmTimelineShotStarts(timeline);
      for (let frame = 0; frame < settings.frameCount; frame++) {
        signal.throwIfAborted();
        const elapsed = settings.kind === 'video' ? frame / settings.fps
          : settings.kind === 'stills' ? settings.duration * frame / (settings.frameCount - 1) : 0;
        // A timeline job reads one clock for the shot, the motion and the renderer, so a seek matches the frame in a video.
        const timelineTime = timeline ? Math.min(filmTimelineDuration(timeline), settings.timeline.start + elapsed) : undefined;
        const shotSample = timeline ? sampleFilmTimeline(timeline, snapshot.recipe, timelineTime) : undefined;
        const frameInput = { sessionId: jobId, ...(highPrecision ? { floatOutput: true } : {}),
          rendererTime: (settings.rendererTime?.start ?? 0) + (timelineTime ?? elapsed) * (settings.rendererTime?.rate ?? 1),
          ...(settings.motion ? { motionTime: settings.motion.start + elapsed } : {}),
          ...(shotSample?.motionTime == null ? {} : { motionTime: shotSample.motionTime }),
          ...(shotSample?.camera ? { camera: shotSample.camera } : {}),
          ...(shotSample?.depthOfField ? { depthOfField: shotSample.depthOfField } : {}),
          ...(shotSample && shotSample.brightness < 1 ? { brightness: shotSample.brightness } : {}),
          ...(settings.animation ? { animation: { clip: settings.animation.clip, time: settings.animation.start + elapsed } } : {}) };
        const renderStarted = performance.now();
        if (settings.renderer) {
          const { type, ...tracerOptions } = settings.renderer;
          if (settings.renderer.backend === 'gpu' && backend === 'cpu') throw new Error('renderer.backend "gpu" needs a runtime on the GPU backend, and this one runs on SwiftShader.');
          nativeTracerLocator ??= createNativeTracerLocator();
          const trace = await chooseTraceBackend({ requested: settings.renderer.backend, runtimeBackend: backend, locator: nativeTracerLocator });
          // Only a job that really traces on native defaults to OIDN; the cpu, gpu and webgpu defaults do not change.
          let choice = await chooseDenoiser(settings.renderer.denoise, { preferOidn: trace.backend === 'native' });
          const traceOptions = { width, height, ...tracerOptions, backend: trace.backend === 'native' ? 'gpu' : trace.backend, denoise: choice.denoise, threads: PATH_TRACER_THREADS };
          let traced;
          let backendNote = trace.note;
          if (trace.backend === 'native') {
            let exportedScene = false;
            const usesSession = settings.frameCount > 1 && process.env.JS67_NATIVE_SESSIONS !== 'off';
            // Only a video blends over time: the stills of one job are separate pictures, and each must stand alone.
            const blendsOverTime = usesSession && settings.kind === 'video' && chooseNativeKernel() === 'cycles' && chooseNativeTemporal();
            const frameSeed = blendsOverTime ? temporalFrameSeed(tracerOptions.seed, frame) : tracerOptions.seed;
            try {
              const exported = await fetchNativeExport(jobPage, { ...frameInput, options: { width, height, bounces: tracerOptions.bounces, seed: frameSeed, fireflyClamp: 20, noiseThreshold: tracerOptions.noiseThreshold, samples: tracerOptions.samples, instancing: chooseNativeInstancing(), kernel: chooseNativeKernel() } });
              exportedScene = true;
              if (usesSession) nativeSequence ??= createNativeSequence({ tracer: trace.tracer });
              if (blendsOverTime) {
                nativeTemporal ??= createTemporalAccumulator({ width, height });
                if (shotSample && shotSample.shotIndex !== nativeTemporalShotIndex) nativeTemporal.restart('a new shot began');
                nativeTemporalShotIndex = shotSample?.shotIndex;
              }
              traced = await traceFrameNative({ tracer: trace.tracer, sequence: nativeSequence, temporal: nativeTemporal, exported, width, height, samples: tracerOptions.samples, bounces: tracerOptions.bounces,
                seed: frameSeed, denoise: choice.denoise === true ? 'wavelet' : choice.denoise === false ? 'none' : choice.denoise, denoiser: choice.denoiser,
                maxSeconds: tracerOptions.maxSeconds, noiseThreshold: tracerOptions.noiseThreshold });
            } catch (error) {
              // Past maxSeconds the job fails as it does on every backend; falling back would only run it twice as long.
              if (isNativeTimeLimitError(error)) throw error;
              nativeSequence?.close();
              nativeSequence = undefined;
              nativeTemporal?.restart('a frame rendered on another backend');
              // Only a tracer or adapter failure makes the tracer unusable; a scene that failed to export says so for this job alone.
              if (exportedScene) nativeTracerLocator.markUnusable(error.message);
              backendNote = exportedScene ? (await nativeTracerLocator.find()).reason : `renderer.backend "native" could not export the scene (${error.message}).`;
              traceOptions.backend = backend === 'cpu' ? 'cpu' : 'gpu';
              choice = await chooseDenoiser(settings.renderer.denoise);
              traceOptions.denoise = choice.denoise;
              backendNote += ' The ' + traceOptions.backend + ' backend ran instead.';
            }
          }
          if (!traced) {
            traced = await jobPage.evaluate(input => window.__agentPreview.pathTrace(input), { ...frameInput, options: traceOptions });
            if (traced.features) {
              traced = await finishWithOidn({ traced, denoiser: choice.denoiser, drawLinear: input => jobPage.evaluate(drawInput => window.__agentPreview.finishPathTrace(drawInput), input) });
            }
          }
          if (backendNote) traced.report.backendNote = backendNote;
          const denoiserNote = [choice.note, traced.report.denoiserNote].filter(Boolean).join(' ');
          if (denoiserNote) traced.report.denoiserNote = denoiserNote;
          metrics.renderSeconds += (performance.now() - renderStarted) / 1000;
          metrics.width = width;
          metrics.height = height;
          metrics.pathTracer = traced.report;
          if (frame === 0) {
            const looked = await jobPage.evaluate(input => window.__agentPreview.findings(input), frameInput);
            mergeFrameDiagnostics(metrics, [pathTracerFindingsLimit(), ...looked.diagnostics]);
          }
          if (traced.report.nativeSession) (metrics.nativeSessionRoutes ??= []).push(traced.report.nativeSession.path);
          const tracedBytes = Buffer.from(traced.data, 'base64');
          if (tracedBytes.length > MAXIMUM_JOB_FRAME_BYTES) throw new Error('Path traced frame exceeded 12 MiB.');
          if (encoder) {
            await encoder.writeFrame(tracedBytes);
          } else {
            const filename = settings.kind === 'image' ? 'render.png' : `frame-${frame}.png`;
            await writeFile(join(directory, `${filename}.partial`), tracedBytes, { flag: 'wx' });
            artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: 'image/png' });
          }
          await recordPeakMemory();
          await progress({ frames: frame + 1, maximumPendingFrames: 1 });
          continue;
        }
        // A video frame is read in the same task as its draw, because the browser clears the drawing buffer after presenting.
        const rendered = await jobPage.evaluate(async ({ input, encodeIndex }) => {
          const drawStarted = performance.now();
          const result = await window.__agentPreview.frame(input);
          if (encodeIndex === null) return result;
          window.__finishDraw();
          const drawMilliseconds = performance.now() - drawStarted;
          return { ...result, drawMilliseconds, pageEncoded: await window.__encodeFrame(encodeIndex) };
        }, { input: { ...frameInput, diagnose: frame === 0 }, encodeIndex: pageEncodes ? frame : null });
        const roundTripSeconds = (performance.now() - renderStarted) / 1000;
        const drawSeconds = rendered.pageEncoded ? rendered.drawMilliseconds / 1000 : roundTripSeconds;
        metrics.renderSeconds += drawSeconds;
        metrics.captureSeconds += roundTripSeconds - drawSeconds;
        if (backend === 'cpu' && !/swiftshader/i.test(rendered.graphics)) throw new Error('CPU job did not select SwiftShader.');
        metrics.graphics = rendered.graphics;
        metrics.width = width;
        metrics.height = height;
        metrics.estimatedBytes = rendered.estimatedBytes;
        mergeFrameDiagnostics(metrics, rendered.diagnostics);
        async function captureFrameBytes() {
          if (rendered.pageEncoded) {
            signal.throwIfAborted();
            return undefined;
          }
          const captureStarted = performance.now();
          const captured = await session.send('Page.captureScreenshot', { fromSurface: true,
            format: settings.kind === 'video' ? 'jpeg' : 'png',
            ...(region ? { clip: { ...region, scale: 1 } } : {}),
            ...(settings.kind === 'video' ? { quality: 95 } : { optimizeForSpeed: true }) });
          const captureBytes = Buffer.from(captured.data, 'base64');
          metrics.captureSeconds += (performance.now() - captureStarted) / 1000;
          if (captureBytes.length > MAXIMUM_JOB_FRAME_BYTES) throw new Error('Captured job frame exceeded 12 MiB.');
          signal.throwIfAborted();
          return captureBytes;
        }
        // 16-bit PNG and EXR come from a float readback of the same frame (or of its pass), encoded here.
        async function readFloatPass(pass) {
          const read = await jobPage.evaluate(readInput => window.__agentPreview.readFloat(readInput),
            { sessionId: jobId, source: pass ? 'pass' : 'frame', ...(region ? { region } : {}) });
          const readBytes = Buffer.from(read.data, 'base64');
          const pixels = new Float32Array(readBytes.buffer.slice(readBytes.byteOffset, readBytes.byteOffset + readBytes.length));
          return { pixels, width: read.width, height: read.height };
        }
        async function captureHighPrecisionBytes(pass) {
          const captureStarted = performance.now();
          const read = await jobPage.evaluate(readInput => window.__agentPreview.readFloat(readInput),
            { sessionId: jobId, source: pass ? 'pass' : 'frame', ...(region ? { region } : {}) });
          const readBytes = Buffer.from(read.data, 'base64');
          const pixels = new Float32Array(readBytes.buffer.slice(readBytes.byteOffset, readBytes.byteOffset + readBytes.length));
          const encodedBytes = encodeRenderOutput({ format, pixels, width: read.width, height: read.height, pass,
            hasAlpha: settings.transparent === true, depthRange: RENDER_PASS_DEPTH_RANGE });
          metrics.captureSeconds += (performance.now() - captureStarted) / 1000;
          if (encodedBytes.length > MAXIMUM_JOB_FRAME_BYTES * HIGH_PRECISION_FRAME_FACTOR) throw new Error('Rendered frame exceeded the high-precision size limit.');
          signal.throwIfAborted();
          return encodedBytes;
        }
        async function writeArtifact(filename, artifactBytes) {
          await writeFile(join(directory, `${filename}.partial`), artifactBytes, { flag: 'wx' });
          artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: artifactMimeType });
        }
        const bytes = settings.multilayer ? undefined : (highPrecision ? await captureHighPrecisionBytes(undefined) : await captureFrameBytes());
        if (encoder) {
          if (bytes) await encoder.writeFrame(bytes);
        }
        else {
          const stem = settings.kind === 'image' ? 'render' : `frame-${frame}`;
          if (settings.multilayer) {
            const captureStarted = performance.now();
            const beautyRead = await readFloatPass(undefined);
            const passPixels = {};
            for (const pass of settings.passes ?? []) {
              const passInfo = await jobPage.evaluate(input => window.__agentPreview.frame(input),
                { ...frameInput, floatOutput: false, pass, passDepthRange: RENDER_PASS_DEPTH_RANGE, passFloat: true });
              passPixels[pass] = (await readFloatPass(pass)).pixels;
              if (pass === 'depth') metrics.depthRangeMetres = RENDER_PASS_DEPTH_RANGE;
              if (pass === 'objectId') {
                metrics.objectNames = passInfo.objectNames.slice(0, MAXIMUM_OBJECT_NAMES);
                metrics.objectNamesTruncated = passInfo.objectNames.length > MAXIMUM_OBJECT_NAMES;
              }
              if (pass === 'cryptomatte') metrics.cryptomatte = passInfo.cryptomatte;
              if (pass === 'wireframe') metrics.wireframe = passInfo.wireframe;
            }
            const encodedBytes = encodeMultilayerExr({ width: beautyRead.width, height: beautyRead.height, beauty: beautyRead.pixels, passes: passPixels, hasAlpha: settings.transparent === true, depthRange: RENDER_PASS_DEPTH_RANGE });
            metrics.captureSeconds += (performance.now() - captureStarted) / 1000;
            if (encodedBytes.length > MAXIMUM_JOB_FRAME_BYTES * HIGH_PRECISION_FRAME_FACTOR) throw new Error('Rendered frame exceeded the high-precision size limit.');
            await writeArtifact(`${stem}.exr`, encodedBytes);
          } else {
          await writeArtifact(`${stem}.${artifactExtension}`, bytes);
          // Passes follow the lit image of the same instant, so each seek yields every file for that frame.
          for (const pass of settings.passes ?? []) {
            const passInfo = await jobPage.evaluate(input => window.__agentPreview.frame(input),
              { ...frameInput, floatOutput: false, pass, passDepthRange: RENDER_PASS_DEPTH_RANGE, ...(highPrecision ? { passFloat: true } : {}) });
            await writeArtifact(`${stem}-${pass}.${artifactExtension}`, highPrecision ? await captureHighPrecisionBytes(pass) : await captureFrameBytes());
            if (pass === 'cryptomatte') metrics.cryptomatte = passInfo.cryptomatte;
            if (pass === 'wireframe') metrics.wireframe = passInfo.wireframe;
            if (pass === 'depth') metrics.depthRangeMetres = RENDER_PASS_DEPTH_RANGE;
            if (pass === 'objectId') {
              metrics.objectNames = passInfo.objectNames.slice(0, MAXIMUM_OBJECT_NAMES);
              metrics.objectNamesTruncated = passInfo.objectNames.length > MAXIMUM_OBJECT_NAMES;
            }
          }
        }
          }
        await recordPeakMemory();
        await progress({ frames: frame + 1, maximumPendingFrames: 1 });
      }
      if (encoder) {
        if (pageEncodes) await jobPage.evaluate(() => window.__finishVideoEncoder());
        metrics.encoder = await encoder.finish();
        if (audio) metrics.sync = await measureSync(join(directory, 'render.mp4.partial'));
        artifacts.push({ temporary: 'render.mp4.partial', filename: 'render.mp4', mimeType: 'video/mp4' });
      }
      metrics.elapsedSeconds = (performance.now() - started) / 1000;
      metrics.report = renderReport({ estimate, settings, metrics });
      if (settings.renderer?.backend === 'gpu') gpuTracerWarm = true;
      await rememberRenderJob({ settings, estimate, report: metrics.report });
      return { artifacts, metrics };
    } finally {
      signal.removeEventListener('abort', abort);
      nativeSequence?.close();
      activeFrameReceiver = undefined;
      frameReceiver?.close();
      try { await encoder?.close(); }
      finally {
        try {
          if (jobPage && !jobPage.isClosed()) {
            try { await jobPage.evaluate(sessionId => window.__agentPreview.dispose({ sessionId }), jobId); }
            finally { await jobPage.close(); }
          }
        }
        finally {
          if (suspended && !closing) {
            try {
              await enqueue(() => invoke('resume', { sessionId }));
              phase = 'ready';
            } catch (error) {
              phase = 'failed';
              throw new Error(`Preview recovery failed after render job: ${error.message}`);
            }
          } else if (!closing && phase !== 'failed') phase = 'ready';
        }
      }
    }
  }

  // The audio must cover the video from its offset, or ffmpeg would cut the picture short at the end of the sound.
  async function prepareAudio(settings) {
    if (!audioLibrary) throw new Error('Configure --audio with an absolute folder before rendering audio.');
    const path = await audioLibrary.resolve(settings.audio.file);
    const fileSeconds = await measureStreamSeconds(ffmpeg, path, 'audio');
    const videoSeconds = settings.frameCount / settings.fps;
    const availableSeconds = fileSeconds - settings.audio.offset;
    if (availableSeconds + SYNC_TOLERANCE_SECONDS < videoSeconds) {
      throw new RangeError(`Audio has ${availableSeconds.toFixed(2)} s after its offset but the video lasts ${videoSeconds.toFixed(2)} s.`);
    }
    return { path, availableSeconds };
  }

  // Decodes both streams of the finished file; a gap beyond the encoder delay means picture and sound drifted apart.
  async function measureSync(path) {
    const videoSeconds = await measureStreamSeconds(ffmpeg, path, 'video', { format: 'mp4' });
    const audioSeconds = await measureStreamSeconds(ffmpeg, path, 'audio', { format: 'mp4' });
    const differenceSeconds = audioSeconds - videoSeconds;
    if (Math.abs(differenceSeconds) > SYNC_TOLERANCE_SECONDS) {
      throw new Error(`Audio and video lengths differ by ${(differenceSeconds * 1000).toFixed(0)} ms.`);
    }
    return { videoSeconds, audioSeconds, differenceSeconds, toleranceSeconds: SYNC_TOLERANCE_SECONDS };
  }

  return Object.freeze({
    async capabilities() {
      const deviceTiers = async () => {
        nativeTracerLocator ??= createNativeTracerLocator();
        return tierReport({ backend, nativeTracer: Boolean((await nativeTracerLocator.find()).tracer) });
      };
      return {
        scene: { ...AGENT_SCENE_CAPABILITIES, game: GAME_CAPABILITIES, postPasses: USER_PASS_CAPABILITIES, meshBlend: MESH_BLEND_CAPABILITIES, materialSnippet: MATERIAL_SNIPPET_CAPABILITIES, vegetation: VEGETATION_CAPABILITY_NOTE, crowd: CROWD_CAPABILITY_NOTE, settle: SETTLE_CAPABILITY_NOTE, textureSequence: TEXTURE_SEQUENCE_CAPABILITIES },
        sceneLimits: SCENE_LIMITS,
        preview: { backend, memoryBudgetMiB: memory, maximumWidth: 1024, maximumHeight: 1024, maximumImageBytes: MAXIMUM_IMAGE_BYTES, maximumActiveScenes: SCENE_STORE_LIMITS.maxOpenScenes, maximumOpenSceneBytes: SCENE_STORE_LIMITS.maxOpenSceneBytes, maximumQueuedCalls: MAXIMUM_QUEUED_CALLS, evaluationTimeoutMs: EVALUATION_TIMEOUT_MS },
        review: { ...REVIEW_LIMITS, backend, memoryBudgetMiB: memory, evaluationTimeoutMs: EVALUATION_TIMEOUT_MS,
          totalTimeoutMs: EVALUATION_TIMEOUT_MS,
          sourcePreserved: true, defaultMotionTime: null, defaultRendererTime: 0, branches: BRANCH_LIMITS },
        phase: closing && phase !== 'closed' ? 'closing' : phase,
        availableIn: packageMetadata.version,
        assets: {
          configured: Boolean(assetRoot), formats: ['self-contained GLB', 'PNG, JPEG or WebP image (map sequence frame)'],
          maximumBytes: AGENT_ASSET_LIMITS.maxBytes, maximumAssets: AGENT_ASSET_LIMITS.maxAssets, maximumCombinedBytes: AGENT_ASSET_LIMITS.maxCombinedBytes,
          maximumVertices: AGENT_ASSET_LIMITS.maxVertices, maximumParts: AGENT_ASSET_LIMITS.maxParts, maximumTexturePixels: AGENT_ASSET_LIMITS.maxTexturePixels,
          maximumJoints: AGENT_ASSET_LIMITS.maxJoints, maximumClips: AGENT_ASSET_LIMITS.maxClips,
          commands: ['set-root', 'set-asset-node', 'set-motion', 'set-animation', 'set-material', 'set-camera', 'set-environment', 'set-effects', 'set-shadow'],
        },
        packs: {
          configured: Boolean(packsRoot), format: 'crucible.pack', manifest: 'crucible-pack.json', contentKinds: Object.keys(PACK_CONTENT_KINDS),
          extensions: PACK_CONTENT_KINDS, maximumPacks: MAXIMUM_INSTALLED_PACKS, maximumFiles: MAXIMUM_PACK_FILES, maximumBytes: MAXIMUM_PACK_BYTES,
          maximumFileBytes: MAXIMUM_PACK_FILE_BYTES, maximumJsonBytes: MAXIMUM_PACK_JSON_BYTES, maximumItemsPerKind: MAXIMUM_PACK_ITEMS_PER_KIND,
          use: 'scene_asset_catalog lists packs: name, version, license, author, description and item ids. GLBs, images, looks and environments carry assetId values that work in scene_create_asset, look, hdri and texture fields. Materials and recipes are read with scene_asset_catalog { pack, material } or { pack, recipe }: pass a recipe to scene_create, and a material as a materials entry or a scene_apply set-material. Packs are installed by the user (unzip into the --packs folder); a tool call never downloads one. Invalid packs are skipped and listed under packs.rejected with the reason.',
        },
        jobs: { configured: Boolean(jobRoot), kinds: ['image', 'stills', 'video'], passes: RENDER_PASS_NAMES, pathTracer: PATH_TRACER_CAPABILITIES, maximumActiveJobs: 1, estimate: RENDER_ESTIMATE_NOTE, budget: RENDER_BUDGET_NOTE, quality: RENDER_QUALITY_NOTE, tiers: await deviceTiers(),
          maximumWidth: MAXIMUM_JOB_SIDE, maximumHeight: MAXIMUM_JOB_SIDE, maximumPixels: MAXIMUM_JOB_PIXELS,
          maximumDuration: MAXIMUM_VIDEO_SECONDS, maximumFps: MAXIMUM_JOB_FPS, maximumFrames: MAXIMUM_JOB_FRAMES, maximumStills: 8,
          encoder: 'H.264', encoders: VIDEO_ENCODERS, audio: Boolean(audioRoot), timeline: true, previewSuspendedDuringJob: true,
          glbExport: { maximumBytes: MAXIMUM_GLB_BYTES, maximumKept: MAXIMUM_KEPT_GLBS, maximumTextureSize: 4096 },
          ...(await jobRecords()) },
        addons: addonCapabilities({ addons: addonSet.addons.filter(addon => !refusedAddons.some(refused => refused.name === addon.name)), skipped: addonSet.skipped, registered: registeredByAddon, refused: refusedAddons }),
        unsupported: ['remote asset providers', 'arbitrary code execution', 'imported morph track authoring'],
      };
    },
    create({ recipe }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        await boot();
        const sessionId = randomUUID();
        const result = await evaluate('create', { recipe, sessionId, memoryBudgetMiB: memory, backend, ...(await placedAssetData(recipe)) }, page, recipe?.bake ? BAKE_EVALUATION_TIMEOUT_MS : EVALUATION_TIMEOUT_MS);
        registerCreatedScene(sessionId, result, Boolean(recipe?.bake));
        return result;
      });
    },
    /** The catalog with the installed packs; `{ pack, recipe }` or `{ pack, material }` reads one pack item's JSON instead. */
    assetCatalog({ pack, recipe, material } = {}) {
      return enqueue(async () => {
        if (pack !== undefined || recipe !== undefined || material !== undefined) {
          if (!packsRoot) throw new Error('Configure --packs with an absolute directory to read pack items.');
          if (pack === undefined || (recipe === undefined) === (material === undefined)) {
            throw new RangeError('Pass pack with exactly one of recipe or material, such as { "pack": "example-starter", "recipe": "workshop" }; scene_asset_catalog without arguments lists them.');
          }
          const kind = recipe === undefined ? 'materials' : 'recipes';
          return { pack, [kind === 'recipes' ? 'recipe' : 'material']: recipe ?? material, json: (await packs()).read(kind, pack, recipe ?? material) };
        }
        if (!assetRoot && !packsRoot) return { configured: false, assets: [] };
        return { configured: true, ...(await catalog()).list(), ...(packsRoot && { packs: (await packs()).list() }) };
      });
    },
    createAsset({ recipe }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        const bytes = await (await catalog()).read(recipe.assetId);
        await boot();
        const sessionId = randomUUID();
        const result = await evaluate('createAsset', { recipe, data: bytes.toString('base64'), sessionId, memoryBudgetMiB: memory, backend, ...(await motionSources([recipe.motion])) });
        registerCreatedScene(sessionId, result, false);
        return result;
      });
    },
    inspect(input) {
      return enqueue(() => invoke('inspect', input));
    },
    inspectMeshes(input) {
      return enqueue(() => invoke('inspectMeshes', input));
    },
    walkMap({ assetId, ...input }) {
      if (assetId === undefined) return enqueue(() => invoke('walkMap', input));
      if (input.sessionId !== undefined) return Promise.reject(new TypeError('scene_walkmap takes a sessionId or an assetId, not both.'));
      // Query-only: the preview page parses the textureless geometry and queries it, with no scene and no render, so it may
      // pass the render vertex cap. The page keeps one scene and asks for the file only when it does not hold it.
      return enqueue(async () => {
        await boot();
        const request = { ...input, assetId };
        const cached = await evaluate('queryOnlyWalkMap', request, page, QUERY_ONLY_TIMEOUT_MS);
        if (!cached.needsData) return cached;
        const stripped = geometryOnlyGlb(await (await catalog()).read(assetId));
        return evaluate('queryOnlyWalkMap', { ...request, data: stripped.toString('base64') }, page, QUERY_ONLY_TIMEOUT_MS);
      });
    },
    setMeshStack(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('setMeshStack', input);
      });
    },
    editMesh(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('editMesh', input);
      });
    },
    apply(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        if (input.branch !== undefined) {
          const { branch, ...rest } = input;
          return invoke('branchApply', { ...rest, name: validateBranchName(branch) });
        }
        const bakeAfter = bakeAfterOperations(input.operations);
        const hadBake = bakedSessionIds.has(input.sessionId);
        const rebakes = hadBake || bakeAfter === true;
        const motions = (input.operations ?? []).filter(operation => operation.type === 'set-motion').map(operation => operation.motion);
        const gameAssets = await gameAssetNeeds(input);
        const applied = await invoke('apply', { ...input, ...(await motionSources(motions)), ...(await placedAssetData(gameAssets?.recipe ?? input.operations)), ...(gameAssets ? { assetNeeds: gameAssets.recipe } : {}) }, rebakes ? BAKE_EVALUATION_TIMEOUT_MS : EVALUATION_TIMEOUT_MS);
        if (bakeAfter ?? hadBake) bakedSessionIds.add(input.sessionId);
        else bakedSessionIds.delete(input.sessionId);
        return applied;
      });
    },
    look(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(input.sessionId);
        const width = input.width ?? 768;
        const height = input.height ?? 512;
        if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 1024)) {
          throw new RangeError('Preview dimensions must be integers from 64 to 1024.');
        }
        const lookRequest = { sessionId: input.sessionId,
          ...(input.motionTime !== undefined ? { motionTime: input.motionTime } : {}),
          ...(input.labels ? { labels: true } : {}) };
        // A busy picture can encode past the response budget. Render again a step smaller (same aspect, PNG kept) until it fits.
        let result;
        let stepWidth = width;
        let stepHeight = height;
        for (let step = 0; ; step++) {
          await page.setViewportSize({ width: stepWidth, height: stepHeight });
          result = await invoke('look', lookRequest);
          if (Buffer.byteLength(result.data, 'base64') <= MAXIMUM_IMAGE_BYTES) break;
          if (step === LOOK_MAXIMUM_STEP_DOWNS) {
            throw new Error(`The PNG exceeds the 1 MiB image response budget even at ${stepWidth}x${stepHeight}. Simplify the scene's high-frequency textures or request a smaller preview.`);
          }
          stepWidth = Math.max(LOOK_MINIMUM_SIDE, Math.floor(stepWidth * LOOK_STEP_SCALE));
          stepHeight = Math.max(LOOK_MINIMUM_SIDE, Math.floor(stepHeight * LOOK_STEP_SCALE));
        }
        result.metadata.requestedWidth = width;
        result.metadata.requestedHeight = height;
        result.metadata.backend = backend;
        if (stepWidth !== width || stepHeight !== height) {
          result.metadata.returnedWidth = stepWidth;
          result.metadata.returnedHeight = stepHeight;
          result.metadata.note = `The ${width}x${height} PNG was over the 1 MiB image response budget, so this is the ${stepWidth}x${stepHeight} render. Request that size or smaller to skip the retry.`;
        }
        return result;
      });
    },
    // Shows the current view in the person's own browser, waits for their pins and notes, and resolves each pin to a part and a
    // world point. The wait holds no preview queue slot, so other tools keep working while the person marks.
    async askUser(input) {
      const width = input.width ?? 768;
      const height = input.height ?? 512;
      if (![width, height].every(value => Number.isInteger(value) && value >= 64 && value <= 1024)) {
        throw new RangeError('Preview dimensions must be integers from 64 to 1024.');
      }
      const maxMarks = input.maxMarks ?? ANNOTATE_LIMITS.maxMarks;
      const timeoutSeconds = input.timeoutSeconds ?? ANNOTATE_LIMITS.defaultTimeoutSeconds;
      const frame = await enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(input.sessionId);
        await page.setViewportSize({ width, height });
        return invoke('annotateFrame', { sessionId: input.sessionId });
      });
      const session = await runAnnotateSession({ png: frame.data, width: frame.width, height: frame.height, prompt: input.prompt ?? '',
        maxMarks, waitMs: timeoutSeconds * 1000, open: async url => {
          console.error(`Crucible annotate page: ${url}`);
          await openPage(url);
        } });
      const base = { sessionId: input.sessionId, revision: frame.metadata.revision, view: { width: frame.width, height: frame.height, camera: frame.camera } };
      if (session.outcome !== 'sent') {
        return { content: { ...base, outcome: session.outcome, marks: [], message: session.outcome === 'timeout'
          ? `The person did not press Send within ${timeoutSeconds} seconds. Ask in text, or call scene_ask_user again with a longer timeoutSeconds.`
          : 'The person cancelled without sending marks. Ask what they meant in text.' } };
      }
      const picked = await enqueue(() => invoke('pickMarks', { sessionId: input.sessionId, camera: frame.camera, marks: session.marks, width: frame.width, height: frame.height }));
      const sceneChanged = picked.revision !== frame.metadata.revision;
      return { image: session.image, content: { ...base, outcome: 'sent', marks: picked.marks,
        ...(sceneChanged ? { warning: `The scene changed from revision ${frame.metadata.revision} to ${picked.revision} while the person marked; part IDs and points describe revision ${picked.revision}, the picture shows ${frame.metadata.revision}.` } : {}) } };
    },
    checkpoint(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('checkpoint', { ...input, checkpointId: randomUUID() });
      });
    },
    review(input) {
      let settings;
      try { settings = normalizeReview(input); }
      catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        await requirePreviewRenderer();
        requireSession(settings.sessionId);
        const snapshot = await invoke('snapshot', settings);
        const branchRecipes = new Map();
        for (const name of settings.branchNames) {
          branchRecipes.set(name, await invoke('branchRecipe', { sessionId: settings.sessionId, name }));
        }
        const assetBytes = snapshot.recipe.format === 'crucible.asset' ? await (await catalog()).read(snapshot.recipe.assetId) : undefined;
        let privateSessionId;
        const started = performance.now();
        let suspended = false;
        let privateCreated = false;
        let session;
        let output;
        let deadlineExpired = false;
        let cancellationReason;
        const cancellation = new Promise((resolve, reject) => {
          cancelReview = error => {
            cancellationReason ??= error;
            reject(cancellationReason);
            reviewPage?.close().catch(() => {});
          };
        });
        // Cancellation can arrive during source suspension, before acquisition attaches its race.
        cancellation.catch(() => {});
        const deadline = setTimeout(() => {
          deadlineExpired = true;
          cancelReview(new Error('The review exceeded its total 30 second deadline.'));
        }, EVALUATION_TIMEOUT_MS);
        function requireReviewOpen() {
          if (deadlineExpired) throw new Error('The review exceeded its total 30 second deadline.');
          if (closing) throw new Error('The agent runtime is closing.');
        }
        async function reviewEvaluate(method, value) {
          requireReviewOpen();
          const result = await evaluate(method, value, reviewPage);
          requireReviewOpen();
          return result;
        }
        try {
          await invoke('suspend', { sessionId: settings.sessionId });
          suspended = true;
          phase = 'reviewing';
          requireReviewOpen();
          const acquisition = browserInstance.newPage({ viewport: { width: settings.width, height: settings.height }, deviceScaleFactor: 1 })
            .then(async acquired => {
              if (cancellationReason) {
                await acquired.close();
                throw cancellationReason;
              }
              return acquired;
            });
          reviewPage = await Promise.race([acquisition, cancellation]);
          requireReviewOpen();
          const origin = `http://127.0.0.1:${httpServer.address().port}`;
          await reviewPage.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          reviewPage.setDefaultTimeout(15000);
          await reviewPage.goto(origin);
          await reviewPage.waitForFunction(() => Boolean(window.__agentPreview));
          await reviewEvaluate('reviewBegin', { width: settings.gridWidth, height: settings.gridHeight });
          session = await reviewPage.context().newCDPSession(reviewPage);
          const shots = [];
          let peakBrowserHeap = 0;
          let peakNodeBytes = 0;
          for (const group of settings.groups) {
            const branchRecipe = group.branch === undefined ? undefined : branchRecipes.get(group.branch);
            privateSessionId = randomUUID();
            await reviewEvaluate(branchRecipe || !assetBytes ? 'create' : 'createAsset', { sessionId: privateSessionId,
              recipe: branchRecipe ? branchRecipe.recipe : snapshot.recipe, memoryBudgetMiB: memory, backend,
              ...(!branchRecipe && assetBytes ? { data: assetBytes.toString('base64'), ...(await motionSources([snapshot.recipe.motion])) } : {}),
              ...(!assetBytes ? await placedAssetData(branchRecipe ? branchRecipe.recipe : snapshot.recipe) : {}) });
            privateCreated = true;
            for (const index of group.shotIndexes) {
              const rendered = await reviewEvaluate('reviewShot', { sessionId: privateSessionId, shot: settings.shots[index], index,
                width: settings.width, height: settings.height, columns: settings.columns, labels: settings.labels });
              if (backend === 'cpu' && !/swiftshader/i.test(rendered.graphics)) throw new Error('CPU review did not select SwiftShader.');
              peakNodeBytes = Math.max(peakNodeBytes, process.memoryUsage().rss);
              peakBrowserHeap = Math.max(peakBrowserHeap, await sampleBrowserHeap(session));
              if (exceedsMemoryGuard({ nodeBytes: peakNodeBytes, browserHeapBytes: peakBrowserHeap })) {
                throw new Error('Review exceeded its Node RSS or sampled browser heap guard.');
              }
              shots[index] = { ...rendered, ...(group.branch === undefined ? {} : { branch: group.branch, branchStale: branchRecipe.stale }) };
            }
            await reviewEvaluate('dispose', { sessionId: privateSessionId });
            privateCreated = false;
          }
          const result = await reviewEvaluate('reviewResult', { sessionId: privateSessionId });
          if (Buffer.byteLength(result.data, 'base64') > MAXIMUM_IMAGE_BYTES) throw new Error('The review PNG exceeds the 1 MiB image response budget. Request smaller shots.');
          output = { ...result, metadata: { sessionId: settings.sessionId, sourceRevision: snapshot.sourceRevision,
            backend, width: settings.gridWidth, height: settings.gridHeight, shots,
            peakNodeBytes, peakBrowserHeap, maximumPendingFrames: 1 } };
        } catch (error) {
          if (deadlineExpired) throw new Error('The review exceeded its total 30 second deadline.');
          throw error;
        } finally {
          clearTimeout(deadline);
          cancelReview = undefined;
          try {
            if (reviewPage && !reviewPage.isClosed()) {
              try {
                if (privateCreated && !closing) await evaluate('dispose', { sessionId: privateSessionId }, reviewPage);
              } finally {
                try { await reviewPage.close(); }
                catch (error) {
                  phase = 'failed';
                  await shutdownResources();
                  throw error;
                }
              }
            }
          } finally {
            reviewPage = undefined;
            await session?.detach().catch(() => {});
            if (suspended && !closing && phase !== 'failed') {
              try { await invoke('resume', { sessionId: settings.sessionId }); }
              catch (error) {
                phase = 'failed';
                throw new Error(`Preview recovery failed after review: ${error.message}`);
              }
              phase = 'ready';
            }
          }
        }
        output.metadata.elapsedSeconds = (performance.now() - started) / 1000;
        return output;
      });
    },
    restore(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        if (input.branch !== undefined) {
          return invoke('keepBranch', { sessionId: input.sessionId, name: validateBranchName(input.branch), expectedRevision: input.expectedRevision });
        }
        if (input.revision === undefined && input.checkpointId === undefined) throw new TypeError('Restore needs a checkpointId, a revision or a branch.');
        return invoke('restore', input);
      });
    },
    releaseCheckpoint(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        return invoke('releaseCheckpoint', input);
      });
    },
    exportRecipe(input) {
      return enqueue(() => invoke('exportRecipe', input));
    },
    dispose(input) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        const result = await invoke('dispose', input);
        forgetSession(input.sessionId);
        return result;
      });
    },
    exportGlb({ sessionId, clip, motionTime, maxTextureSize }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        await jobs();
        const exported = await invoke('exportGlb', { sessionId, clip, motionTime, maxTextureSize, maximumBytes: MAXIMUM_GLB_BYTES });
        const { data, ...summary } = exported;
        const file = await saveGlbExport(Buffer.from(data, 'base64'));
        return { ...summary, ...file };
      });
    },
    exportWeb({ sessionId, title }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        await jobs();
        const { recipe, revision } = await invoke('exportRecipe', { sessionId });
        // Same name rule as GLB exports: the server picks the folder, and only the newest few are kept.
        const directory = join(jobRoot, EXPORT_DIRECTORY_NAME);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const outputDirectory = join(directory, `web-${randomUUID()}`);
        let summary;
        try {
          const assets = new Map();
          for (const id of gameAssetIds(recipe)) assets.set(id, await (await catalog()).read(id));
          summary = await writeWebBuild({ recipe, buildDirectory: fileURLToPath(new URL('../', previewUrl)), outputDirectory, title, assets });
        } catch (error) {
          // A refused or half-written build never uses up a retention slot or evicts a good one.
          await rm(outputDirectory, { recursive: true, force: true });
          throw error;
        }
        savedWebBuildPaths.push(outputDirectory);
        while (savedWebBuildPaths.length > MAXIMUM_KEPT_WEB_BUILDS) await rm(savedWebBuildPaths.shift(), { recursive: true, force: true });
        return { sessionId, revision, ...summary, entry: join(outputDirectory, 'index.html'), host: 'Serve the folder with any static file server; no server code runs.' };
      });
    },
    submitJob({ sessionId, expectedRevision, settings }) {
      return enqueue(async () => {
        await requirePreviewRenderer();
        const controller = await jobs();
        if (settings?.audio) {
          if (!audioLibrary) throw new Error('Configure --audio with an absolute folder before submitting a job with audio.');
          await audioLibrary.resolve(settings.audio.file);
        }
        const snapshot = await invoke('snapshot', { sessionId, expectedRevision });
        const assetBytes = snapshot.recipe.format === 'crucible.asset' ? await (await catalog()).read(snapshot.recipe.assetId) : undefined;
        phase = 'rendering';
        try {
          // The estimate is made before the job exists, because the job suspends the scene and starts at once.
          const size = sceneSizeFrom(await invoke('inspect', { sessionId, limit: Math.max(1, snapshot.recipe.nodes?.length ?? 1) }), snapshot.recipe);
          const history = await readRenderHistory();
          const estimateOf = rawSettings => estimateRenderJob({ size, settings: normalizeJobSettings(rawSettings, snapshot.clips, snapshot.recipe), backend, memoryBudgetMiB: memory, history, gpuTracerWarm });
          if (settings?.quality !== undefined && settings.budget !== undefined) throw new TypeError('budget picks the tier: leave settings.quality out, or leave settings.budget out.');
          let jobSettings = settings;
          let budgetReport;
          let qualityReport;
          if (settings?.budget !== undefined) {
            const { budget: budgetInput, ...base } = settings;
            if (base.renderer !== undefined) throw new TypeError('budget picks the renderer: leave settings.renderer out, or leave settings.budget out to choose it yourself.');
            const budget = parseBudget(budgetInput);
            const frameCount = normalizeJobSettings(base, snapshot.clips, snapshot.recipe).frameCount;
            ({ settings: jobSettings, report: budgetReport } = chooseBudgetSettings({ base, budget, tracerBackend: backend === 'cpu' ? 'cpu' : 'gpu', frameCount, estimateOf, serverMemoryMiB: memory }));
          }
          if (settings?.quality !== undefined) {
            nativeTracerLocator ??= createNativeTracerLocator();
            const { quality, ...base } = settings;
            ({ settings: jobSettings, report: qualityReport } = applyQuality({ quality, base, backend, nativeTracer: Boolean((await nativeTracerLocator.find()).tracer), estimateOf }));
          }
          const estimate = estimateOf(jobSettings);
          estimateForNextJob = estimate;
          try {
            const submitted = await controller.submit({ sessionId, sourceRevision: snapshot.sourceRevision,
              snapshot: { recipe: snapshot.recipe, clips: snapshot.clips, ...(assetBytes ? { assetBytes } : {}) }, settings: jobSettings });
            return { ...submitted, estimate, ...(budgetReport ? { budget: budgetReport } : {}), ...(qualityReport ? { quality: qualityReport } : {}) };
          } catch (error) {
            if (estimateForNextJob === estimate) estimateForNextJob = undefined;
            throw error;
          }
        } catch (error) {
          phase = 'ready';
          throw error;
        }
      });
    },
    async jobStatus({ jobId }) {
      const record = (await jobs()).status(jobId);
      if (phase === 'rendering' && ['completed', 'cancelled', 'failed', 'interrupted'].includes(record.state)) {
        await requirePreviewRenderer();
      }
      return record;
    },
    async cancelJob({ jobId }) {
      return (await jobs()).cancel(jobId);
    },
    async jobResult({ jobId }) {
      const result = (await jobs()).result(jobId);
      return { ...result, artifacts: result.artifacts.map(artifact => ({
        ...artifact, path: join(jobRoot, result.jobId, artifact.filename),
      })) };
    },
    async releaseJob({ jobId }) {
      return (await jobs()).release(jobId);
    },
    /** The ID of the last used scene, or null. Tools that take a sessionId default to it. */
    activeSessionId() {
      return lastUsedSessionId();
    },
    close() {
      if (!closing) {
        phase = 'closing';
        cancelReview?.(new Error('The agent runtime is closing.'));
        closing = (async () => {
          try {
            // The job store goes first: a client that closes the connection waits only a couple of seconds before it kills this
            // process, and the lock must be given back before the slower browser shutdown.
            if (jobsPromise) await (await jobsPromise).close();
            await reviewPage?.close().catch(() => {});
          } finally {
            await queue;
            await shutdownResources();
          }
        })().finally(() => {
          forgetAllSessions();
          phase = 'closed';
        });
      }
      return closing;
    },
  });
}

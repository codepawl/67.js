import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { isPreviewHost } from '../scripts/preview-host.mjs';
import { addonCapabilities, addonFileFor, addonImportMap } from '../scripts/mcp-addons.mjs';
import { sampleBrowserHeap, exceedsMemoryGuard } from '../scripts/agent-memory-guard.mjs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeWebBuild } from '../scripts/web-export.mjs';
import { EXPORT_DIRECTORY_NAME, RENDER_HISTORY_FILE, normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createContext, Script } from 'node:vm';
import { VEGETATION_CAPABILITY_NOTE } from '../src/agent-vegetation-notes.js';
import { CROWD_CAPABILITY_NOTE } from '../src/agent-crowd-notes.js';
import { SETTLE_CAPABILITY_NOTE } from '../src/settle-notes.js';
import { RENDER_ESTIMATE_NOTE, estimateRenderJob, historyWithJob, parseHistory, renderReport, sceneSizeFrom } from '../scripts/agent-render-estimate.mjs';
import { RENDER_BUDGET_NOTE, chooseBudgetSettings, parseBudget } from '../scripts/agent-render-budget.mjs';
import { GAME_CAPABILITIES } from '../src/game-setup-notes.js';
import { USER_PASS_CAPABILITIES } from '../src/user-pass.js';
import { MESH_BLEND_CAPABILITIES } from '../src/mesh-blend.js';
import { MATERIAL_SNIPPET_CAPABILITIES } from '../src/material-snippet.js';
import { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, RENDER_PASS_NAMES, RENDER_PASS_DEPTH_RANGE, VIDEO_ENCODERS, MAXIMUM_VIDEO_SECONDS, MAXIMUM_JOB_SIDE, MAXIMUM_JOB_PIXELS, MAXIMUM_MEMORY_MIB, BAKE_WORKER_MAXIMUM_SECONDS } from '../src/agent-scene-capabilities.js';
import { recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { gameAssetIds } from '../src/game-assets.js';
import { sequenceFrameIds } from '../src/agent-texture-sequence.js';
import { catalogLookReferences, BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES } from '../src/look-catalog.js';
import { TEXTURE_SEQUENCE_CAPABILITIES } from '../src/texture-sequence-limits.js';
import { AGENT_ASSET_LIMITS, assertCombinedAssetBytes } from '../src/agent-asset-limits.js';
import { PATH_TRACER_CAPABILITIES } from '../src/path-tracer-capabilities.js';
import { audioInputArguments, createAudioLibrary, measureStreamSeconds } from '../scripts/job-audio.mjs';
import { filmTimelineDuration, filmTimelineShotStarts, sampleFilmTimeline } from '../src/film-timeline.js';
import { normalizeReview, REVIEW_LIMITS } from '../scripts/agent-review.mjs';
import { BRANCH_LIMITS, validateBranchName } from '../src/agent-branches.js';
import { sessionProblem, SCENE_STORE_LIMITS } from '../src/agent-errors.js';
import { ANNOTATE_LIMITS } from '../src/agent-annotate.js';
import * as packLimits from '../src/pack-manifest.js';
import { createPackRegistry } from '../scripts/agent-packs.mjs';

test('runtime reports real scene capabilities without launching a browser and closes idempotently', async () => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64 });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.phase, 'idle');
  assert.equal(capabilities.scene.schemaVersion, 1);
  assert.equal(capabilities.preview.maximumActiveScenes, 4);
  assert.equal(capabilities.preview.memoryBudgetMiB, 64);
  assert.equal(capabilities.preview.backend, 'cpu');
  assert.equal(capabilities.review.maximumShots, 4);
  assert.equal(capabilities.review.maximumGridHeight, 1008);
  assert.equal(capabilities.review.maximumPendingFrames, 1);
  assert.equal(capabilities.sceneLimits.maxGeometryBytes, 32 * 1024 * 1024);
  await runtime.close();
  await runtime.close();
  assert.equal((await runtime.capabilities()).phase, 'closed');
  await assert.rejects(runtime.create({ recipe: {} }), /closed/);
});

async function reviewRuntimeHarness({ failShot, blockShot = false, oversize = false, deadlineMs,
  failDispose = false, heapSize = 1024, stallPrivatePage = false, resumeDelayMs = 0, sceneBake, exportedRecipe, runtimeOptions = {}, contextOverrides = {} } = {}) {
  const events = [];
  const deadlines = [];
  let privatePage;
  let sourceRevision = 0;
  let resolveShotStarted;
  const shotStarted = new Promise(resolve => { resolveShotStarted = resolve; });
  let resolveAcquisitionStarted;
  const acquisitionStarted = new Promise(resolve => { resolveAcquisitionStarted = resolve; });
  let resolvePrivatePage;
  const acquiredPage = new Promise(resolve => { resolvePrivatePage = () => resolve(privatePage = new FakePage(true)); });
  const recipe = { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], ...(sceneBake ? { bake: sceneBake } : {}) };
  class FakePage {
    constructor(privateTarget) { this.privateTarget = privateTarget; this.closed = false; }
    route() {}
    setDefaultTimeout() {}
    goto() {}
    waitForFunction() {}
    isClosed() { return this.closed; }
    context() { return { newCDPSession: async () => ({
      send: async () => ({ usedSize: heapSize }), detach: async () => { events.push('detach'); },
    }) }; }
    async evaluate(callback, { method, input }) {
      events.push(`${this.privateTarget ? 'private' : 'source'}:${method}`);
      if (method === 'create') return { sessionId: input.sessionId, revision: 0 };
      if (method === 'exportRecipe') return { recipe: exportedRecipe, revision: 1 };
      if (method === 'snapshot') {
        if (input.expectedRevision !== sourceRevision) throw new Error('Stale revision for render snapshot.');
        return { sourceRevision, recipe };
      }
      if (method === 'reviewShot') {
        resolveShotStarted();
        if (blockShot) return new Promise((resolve, reject) => { this.rejectShot = reject; });
        if (input.index === failShot) throw new Error('Injected partial shot failure');
        return { label: input.shot.label, motionTime: input.shot.motionTime,
          rendererTime: input.shot.rendererTime, graphics: 'SwiftShader', width: 384, height: 384 };
      }
      if (method === 'reviewResult') return { mimeType: 'image/png',
        data: Buffer.alloc(oversize ? 1024 * 1024 + 1 : 16).toString('base64') };
      if (method === 'dispose' && failDispose) throw new Error('Injected disposal failure');
      if (method === 'resume' && resumeDelayMs) await new Promise(resolve => setTimeout(resolve, resumeDelayMs));
      if (method === 'apply') { sourceRevision++; return { revision: sourceRevision }; }
      return {};
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      events.push(`${this.privateTarget ? 'private' : 'source'}:close`);
      this.rejectShot?.(new Error('Review page closed'));
    }
  }
  const sourcePage = new FakePage(false);
  let pageCount = 0;
  const browser = { isConnected: () => true,
    newPage: async () => {
      if (++pageCount === 1) return sourcePage;
      resolveAcquisitionStarted();
      return stallPrivatePage ? acquiredPage : (privatePage = new FakePage(true));
    },
    close: async () => { await privatePage?.close(); await sourcePage.close(); events.push('browser:close'); },
  };
  let source = (await readFile(new URL('../scripts/agent-runtime.mjs', import.meta.url), 'utf8'))
    .replace(/^import .+;\r?$/gm, '')
    .replace('export function createAgentRuntime', 'function createAgentRuntime')
    .replaceAll('import.meta.url', JSON.stringify(import.meta.url))
    .replace("import('playwright-core')", 'Promise.resolve({ chromium: globalThis.chromium })');
  if (deadlineMs) source = source.replace('const EVALUATION_TIMEOUT_MS = 30000;', `const EVALUATION_TIMEOUT_MS = ${deadlineMs};`);
  const context = createContext({ createServer, randomUUID, createHash, addonCapabilities, addonFileFor, addonImportMap, existsSync: () => true,
    readFile: async () => '', packageMetadata: { version: 'test' },
    createRequire: () => ({ resolve: () => { throw new Error('no peer in tests'); } }),
    VEGETATION_CAPABILITY_NOTE, CROWD_CAPABILITY_NOTE, SETTLE_CAPABILITY_NOTE, GAME_CAPABILITIES, USER_PASS_CAPABILITIES, MESH_BLEND_CAPABILITIES, MATERIAL_SNIPPET_CAPABILITIES, AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, RENDER_PASS_NAMES, RENDER_PASS_DEPTH_RANGE, VIDEO_ENCODERS, MAXIMUM_VIDEO_SECONDS, MAXIMUM_JOB_SIDE, MAXIMUM_JOB_PIXELS, MAXIMUM_MEMORY_MIB, BAKE_WORKER_MAXIMUM_SECONDS, PATH_TRACER_CAPABILITIES,
    recipeAssetNeeds, gameAssetIds, sequenceFrameIds, catalogLookReferences, BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES, TEXTURE_SEQUENCE_CAPABILITIES, AGENT_ASSET_LIMITS, assertCombinedAssetBytes,
    audioInputArguments, createAudioLibrary, measureStreamSeconds, filmTimelineDuration, filmTimelineShotStarts, sampleFilmTimeline, normalizeReview, REVIEW_LIMITS, isPreviewHost, BRANCH_LIMITS, validateBranchName, sessionProblem, SCENE_STORE_LIMITS,
    runAnnotateSession: async () => ({ outcome: 'timeout' }), openInDefaultBrowser: async () => {}, ANNOTATE_LIMITS,
    ...packLimits, createPackRegistry,
    sampleBrowserHeap, exceedsMemoryGuard, RENDER_BUDGET_NOTE, chooseBudgetSettings, parseBudget, RENDER_ESTIMATE_NOTE, estimateRenderJob, historyWithJob, parseHistory, renderReport, sceneSizeFrom, RENDER_HISTORY_FILE, normalizeJobSettings,
    chromium: { launch: async () => browser }, URL, Buffer, process, performance, clearTimeout,
    runtimeOptions, mkdir, rm, join, isAbsolute, fileURLToPath, writeWebBuild, EXPORT_DIRECTORY_NAME, createAgentRenderJobs: async () => ({ list: () => [], close: async () => {} }), ...contextOverrides,
    setTimeout: (callback, delay) => { deadlines.push(delay); return setTimeout(callback, delay); },
  });
  new Script(`${source}\nglobalThis.runtime = createAgentRuntime({ backend: 'cpu', ...runtimeOptions });`).runInContext(context);
  const runtime = context.runtime;
  const created = await runtime.create({ recipe });
  return { runtime, sessionId: created.sessionId, deadlines, events, shotStarted, acquisitionStarted, resolvePrivatePage };
}

function boundedResult(promise) {
  let timer;
  return Promise.race([promise.then(() => 'settled', () => 'settled'),
    new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 150); }),
  ]).finally(() => clearTimeout(timer));
}

test('an edit of a scene with a bake, or one that adds a bake, gets the bake deadline; a plain edit keeps 30 s', async () => {
  const plain = await reviewRuntimeHarness();
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-bake', bake: { preset: 'draft' } }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-bake', bake: null }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  const applyDeadlines = plain.deadlines.slice(-5);
  assert.deepEqual(applyDeadlines, [30000, 120000, 120000, 120000, 30000]);
  await plain.runtime.close();
  const baked = await reviewRuntimeHarness({ sceneBake: { preset: 'draft' } });
  assert.equal(baked.deadlines.at(-1), 120000, 'creating a scene with a bake gets the bake deadline');
  await baked.runtime.apply({ sessionId: baked.sessionId, operations: [{ type: 'set-node', id: 'a' }] });
  assert.equal(baked.deadlines.at(-1), 120000, 'moving a part in a baked scene gets the bake deadline');
  await baked.runtime.close();
});

test('review deadline rejects stalled page acquisition and disposes a late page', async () => {
  const { runtime, sessionId, events, acquisitionStarted, resolvePrivatePage } = await reviewRuntimeHarness({
    stallPrivatePage: true, deadlineMs: 40,
  });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  try {
    await acquisitionStarted;
    assert.equal(await boundedResult(pending), 'settled', 'deadline must reject without waiting for newPage');
    await assert.rejects(pending, /deadline/);
    assert.equal((await runtime.capabilities()).phase, 'ready');
    resolvePrivatePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.includes('private:close'));
    assert.ok(!events.includes('private:create'));
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally {
    resolvePrivatePage();
    await pending.catch(() => {});
    await runtime.close();
  }
});

test('close interrupts stalled page acquisition and late resolution cannot resurrect the runtime', async () => {
  const { runtime, sessionId, events, acquisitionStarted, resolvePrivatePage } = await reviewRuntimeHarness({ stallPrivatePage: true });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  pending.catch(() => {});
  await acquisitionStarted;
  const closing = runtime.close();
  try {
    assert.equal(await boundedResult(closing), 'settled', 'close must not wait for newPage');
    await closing;
    await assert.rejects(pending, /closing|closed/);
    assert.ok(events.includes('browser:close'));
    resolvePrivatePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.includes('private:close'));
    assert.ok(!events.includes('private:create'));
    assert.ok(!events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'closed');
  } finally {
    resolvePrivatePage();
    await pending.catch(() => {});
    await closing;
  }
});

test('review queue releases private renderer before source resume, including partial and size failures', async () => {
  for (const options of [{}, { failShot: 1 }, { oversize: true }, { heapSize: 256 * 1024 ** 2 + 1 }]) {
    const { runtime, sessionId, events } = await reviewRuntimeHarness(options);
    try {
      const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{ motionTime: 1 }, {}] });
      if (options.failShot !== undefined || options.oversize || options.heapSize) await assert.rejects(pending, /partial shot|1 MiB|heap guard/);
      else {
        const result = await pending;
        assert.equal(result.metadata.sourceRevision, 0);
        assert.equal(result.metadata.shots[1].motionTime, null);
        assert.equal(result.metadata.maximumPendingFrames, 1);
      }
      assert.ok(events.indexOf('private:dispose') < events.indexOf('private:close'));
      assert.ok(events.indexOf('private:close') < events.indexOf('source:resume'));
      assert.equal(events.filter(event => event === 'source:resume').length, 1);
      assert.equal((await runtime.apply({ sessionId })).revision, 1);
    } finally { await runtime.close(); }
  }
});

test('queued review detaches its request before a caller can mutate shot clocks', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness();
  try {
    const input = { sessionId, expectedRevision: 0, shots: [{ motionTime: 1 }] };
    const pending = runtime.review(input);
    input.shots[0].motionTime = 99;
    input.shots.push({ motionTime: 88 });
    const result = await pending;
    assert.equal(result.metadata.shots.length, 1);
    assert.equal(result.metadata.shots[0].motionTime, 1);
  } finally { await runtime.close(); }
});

test('successful review elapsed time includes source renderer recovery', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness({ resumeDelayMs: 30 });
  try {
    const result = await runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
    assert.ok(result.metadata.elapsedSeconds >= 0.02, 'elapsed must include the delayed source resume');
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

test('total review deadline closes private page and restores the usable source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockShot: true, deadlineMs: 40 });
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{}] }), /total 30 second deadline/);
    assert.ok(events.includes('private:close'));
    assert.ok(events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

test('private disposal failure still closes its page before restoring source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ failDispose: true });
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{}] }), /disposal failure/);
    assert.ok(events.indexOf('private:close') < events.indexOf('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

test('review stale revisions and strict runtime fields reject before leasing source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness();
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 1, shots: [{}] }), /Stale/);
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{ url: 'https://example.com' }] }), /unknown/i);
    assert.ok(!events.includes('source:suspend'));
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

test('runtime close promptly aborts a pending private review and skips source resume', async () => {
  const { runtime, sessionId, events, shotStarted } = await reviewRuntimeHarness({ blockShot: true });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  const rejected = assert.rejects(pending, /closed/);
  await shotStarted;
  assert.equal((await runtime.capabilities()).phase, 'reviewing');
  await runtime.close();
  await rejected;
  assert.ok(events.includes('private:close'));
  assert.ok(events.includes('browser:close'));
  assert.ok(!events.includes('source:resume'));
  assert.equal((await runtime.capabilities()).phase, 'closed');
});

test('invalid preview configuration rejects before any browser or renderer allocation', () => {
  assert.throws(() => createAgentRuntime({ backend: 'fake' }), /backend/);
  for (const memory of [0, 31, 385, 1024, 64.5, NaN]) {
    assert.throws(() => createAgentRuntime({ memory }), /memory/);
  }
  assert.throws(() => createAgentRuntime({ browser: 'does-not-exist-browser.exe' }), /browser/);
  assert.throws(() => createAgentRuntime({ assets: 'relative-path' }), /absolute/);
});

test('requests cannot address an absent session or enter a closing runtime', async () => {
  const runtime = createAgentRuntime();
  await assert.rejects(runtime.inspect({ sessionId: 'missing' }), /Unknown|No scene is active/);
  await assert.rejects(runtime.look({ sessionId: 'missing' }), /Unknown|No scene is active/);
  const closing = runtime.close();
  await assert.rejects(runtime.checkpoint({ sessionId: 'missing' }), /closing|closed/);
  await closing;
});

test('the preview server accepts only its own loopback host', () => {
  assert.equal(isPreviewHost('127.0.0.1:4100', 4100), true);
  assert.equal(isPreviewHost('evil.example:4100', 4100), false);
  assert.equal(isPreviewHost('localhost:4100', 4100), false);
  assert.equal(isPreviewHost('127.0.0.1:4101', 4100), false);
  assert.equal(isPreviewHost(undefined, 4100), false);
});

async function webExportHarness({ exportedRecipe, failCopy = () => false } = {}) {
  const root = await mkdtemp(join(tmpdir(), '67js-web-runtime-'));
  const buildDirectory = join(root, 'build');
  await mkdir(join(buildDirectory, 'mcp'), { recursive: true });
  await writeFile(join(buildDirectory, 'game.js'), 'export {};');
  const jobsDirectory = join(root, 'jobs');
  await mkdir(jobsDirectory);
  const failingWriteWebBuild = async options => {
    if (failCopy()) {
      await mkdir(join(options.outputDirectory, 'engine'), { recursive: true });
      throw new Error('Injected copy failure');
    }
    return writeWebBuild(options);
  };
  const harness = await reviewRuntimeHarness({
    exportedRecipe,
    runtimeOptions: { jobs: jobsDirectory, previewUrl: pathToFileURL(join(buildDirectory, 'mcp', 'preview.js')) },
    contextOverrides: { writeWebBuild: failingWriteWebBuild },
  });
  const keptBuilds = async () => (await readdir(join(jobsDirectory, EXPORT_DIRECTORY_NAME))).filter(name => name.startsWith('web-'));
  after(() => harness.runtime.close());
  return { ...harness, keptBuilds };
}

const PLAYABLE_RECIPE = { format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], game: { player: { node: 'creature' }, physics: false } };

test('exportWeb keeps only the newest four builds and returns a real entry page', async () => {
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  const entries = [];
  for (let index = 0; index < 5; index++) entries.push((await runtime.exportWeb({ sessionId })).entry);
  assert.equal((await keptBuilds()).length, 4);
  await assert.rejects(stat(entries[0]), { code: 'ENOENT' });
  for (const entry of entries.slice(1)) assert.ok((await stat(entry)).isFile());
});

test('a half-written web export is removed and never evicts or uses up a kept build', async () => {
  let breakCopy = false;
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE, failCopy: () => breakCopy });
  const goodEntries = [];
  for (let index = 0; index < 4; index++) goodEntries.push((await runtime.exportWeb({ sessionId })).entry);
  breakCopy = true;
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(runtime.exportWeb({ sessionId }), /Injected copy failure/);
  assert.equal((await keptBuilds()).length, 4);
  for (const entry of goodEntries) assert.ok((await stat(entry)).isFile());
});

test('exportWeb refuses a scene without a game or with physics, and earlier builds stay', async () => {
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  await runtime.exportWeb({ sessionId });
  const refused = [
    [{ ...PLAYABLE_RECIPE, game: undefined }, /no game/],
    [{ ...PLAYABLE_RECIPE, game: { ...PLAYABLE_RECIPE.game, physics: true } }, /game\.physics is true/],
  ];
  for (const [recipe, message] of refused) {
    const refusing = await webExportHarness({ exportedRecipe: recipe });
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(refusing.runtime.exportWeb({ sessionId: refusing.sessionId }), message);
    assert.equal((await refusing.keptBuilds().catch(() => [])).length, 0);
  }
  assert.equal((await keptBuilds()).length, 1);
});

test('exportWeb needs a jobs folder', async () => {
  const harness = await reviewRuntimeHarness({ exportedRecipe: PLAYABLE_RECIPE });
  after(() => harness.runtime.close());
  await assert.rejects(harness.runtime.exportWeb({ sessionId: harness.sessionId }), /--jobs/);
});

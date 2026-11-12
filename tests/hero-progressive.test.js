import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { buildWithFallback, completeDetail } from '../src/hero-lab/loop/detail.js';
import { advanceHold, FIRST_VIEW_COVERS_SECONDS, HOLD_FROM_SECONDS, HOLD_RATE, holdTargetRate } from '../src/hero-lab/loop/hold.js';
import { FAST_LINK_MEGABITS, fetchWorld, hasFirstView, prepareFrameAtLastPose, replaceRendererWorld } from '../src/hero-lab/loop/world.js';

const DESCRIPTION_URL = '/showcase/port/scene.json';
const description = {
  id: 'port',
  glb: '/showcase/port/scene.glb',
  glbFirstView: '/showcase/port/scene.first.glb',
  glbRest: ['/showcase/port/scene.rest.glb'],
  hdriPreview: '/showcase/port/sky.preview.hdr',
  hdri: '/showcase/port/sky.hdr',
};

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
let requested;
let resolveFile;

function fakeBlob(content) {
  return { size: content.length, text: () => Promise.resolve(content) };
}

// Every file answers when the test says so (a held file waits in `resolveFile`), the description at once.
function installFetch({ held = [] } = {}) {
  requested = [];
  resolveFile = {};
  globalThis.fetch = url => {
    requested.push(url);
    const body = url === DESCRIPTION_URL ? JSON.stringify(description) : 'x'.repeat(url.includes('first') ? 4 : 10);
    const answer = { ok: true, blob: async () => fakeBlob(body) };
    if (!held.includes(url)) return Promise.resolve(answer);
    return new Promise(resolve => { resolveFile[url] = () => resolve(answer); });
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  globalThis.window = {};
  installFetch();
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

const slowLink = () => 3;
const fastLink = () => FAST_LINK_MEGABITS + 1;

test('fetchWorld with a first view resolves on the small files and asks for the full world only after them', async () => {
  installFetch({ held: [description.hdriPreview] });
  let resolved = false;
  const fetching = fetchWorld(DESCRIPTION_URL, { firstView: true, measureLink: slowLink }).then(download => {
    resolved = true;
    return download;
  });
  await tick();
  assert.deepEqual(requested, [DESCRIPTION_URL, description.glbFirstView, description.hdriPreview]);
  assert.equal(resolved, false);
  resolveFile[description.hdriPreview]();
  const download = await fetching;
  assert.equal(download.isFirstView, true);
  assert.equal(download.bytes, 14, 'first view model plus preview sky');
  assert.deepEqual(download.paths, [description.glbFirstView]);
  const detail = await download.detail;
  assert.deepEqual(detail.paths, [description.glb, ...description.glbRest]);
  assert.deepEqual(requested.slice(3).sort(), [description.glb, ...description.glbRest, description.hdri].sort());
});

test('fetchWorld on a fast link goes straight to the full world', async () => {
  const download = await fetchWorld(DESCRIPTION_URL, { firstView: true, measureLink: fastLink });
  assert.equal(download.isFirstView, undefined);
  assert.deepEqual(download.paths, [description.glb, ...description.glbRest]);
});

test('fetchWorld stays on the first view when the link speed is unknown or at the limit', async () => {
  assert.equal((await fetchWorld(DESCRIPTION_URL, { firstView: true, measureLink: () => null })).isFirstView, true);
  assert.equal((await fetchWorld(DESCRIPTION_URL, { firstView: true, measureLink: () => FAST_LINK_MEGABITS })).isFirstView, true);
});

test('fetchWorld without the first view option, or for a world that has none, fetches the full world', async () => {
  assert.equal((await fetchWorld(DESCRIPTION_URL, { measureLink: slowLink })).isFirstView, undefined);
  assert.equal(hasFirstView({ ...description, glbFirstView: undefined }), false);
  assert.equal(hasFirstView(description), true);
});

test('fetchWorld keeps the first view when the full world fails to arrive', async () => {
  installFetch();
  const original = globalThis.fetch;
  globalThis.fetch = url => (url === description.hdri ? Promise.resolve({ ok: false, status: 503 }) : original(url));
  const download = await fetchWorld(DESCRIPTION_URL, { firstView: true, measureLink: slowLink });
  await assert.rejects(download.detail, /sky\.hdr is not available \(503\)/);
});

function fakeWorld({ upgrade = async () => true } = {}) {
  const world = { disposed: false, upgrades: [], description };
  world.upgrade = async files => {
    world.upgrades.push(files);
    return upgrade(files, world);
  };
  return world;
}

const noPause = delays => async delay => { delays.push(delay); };

test('the first view is replaced by the full world once it has arrived', async () => {
  const world = fakeWorld();
  const files = { bytes: 99 };
  const outcome = await completeDetail({ world, pendingDetail: Promise.resolve(files), fetchAgain: () => assert.fail('no retry') });
  assert.equal(outcome.state, 'ready');
  assert.equal(outcome.bytes, 99);
  assert.deepEqual(world.upgrades, [files]);
});

test('the full world that arrived before the first view was built is swapped in as soon as the first view is', async () => {
  const world = fakeWorld();
  const arrivedEarly = Promise.resolve({ bytes: 5 });
  await arrivedEarly;
  const outcome = await completeDetail({ world, pendingDetail: arrivedEarly, fetchAgain: () => assert.fail('no retry') });
  assert.equal(outcome.state, 'ready');
  assert.equal(world.upgrades.length, 1);
});

test('the swap waits for the gate it was given', async () => {
  const world = fakeWorld();
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const completing = completeDetail({ world, pendingDetail: Promise.resolve({ bytes: 1 }), gate, fetchAgain: () => assert.fail('no retry') });
  await tick();
  assert.equal(world.upgrades.length, 0);
  open();
  assert.equal((await completing).state, 'ready');
});

test('a full world that fails is asked for again, and the first view stays until a retry works', async () => {
  const world = fakeWorld();
  const delays = [];
  const failures = [];
  let fetches = 0;
  const outcome = await completeDetail({
    world,
    pendingDetail: Promise.reject(new Error('offline')),
    fetchAgain: () => {
      fetches++;
      return fetches < 2 ? Promise.reject(new Error('still offline')) : Promise.resolve({ bytes: 7 });
    },
    retryDelays: [4000, 10000, 20000],
    pause: noPause(delays),
    onFailure: (attempt, error) => failures.push(`${attempt}: ${error.message}`),
  });
  assert.equal(outcome.state, 'ready');
  assert.deepEqual(delays, [4000, 10000]);
  assert.deepEqual(failures, ['0: offline', '1: still offline']);
  assert.equal(world.upgrades.length, 1);
});

test('a full world that never arrives is given up on after the last retry, and the world was never upgraded', async () => {
  const world = fakeWorld();
  const delays = [];
  const outcome = await completeDetail({
    world,
    pendingDetail: Promise.reject(new Error('offline')),
    fetchAgain: () => Promise.reject(new Error('offline')),
    retryDelays: [1, 2, 3],
    pause: noPause(delays),
  });
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(delays, [1, 2, 3]);
  assert.equal(world.upgrades.length, 0);
});

test('a swap that throws is retried like a download that failed', async () => {
  let calls = 0;
  const world = fakeWorld({ upgrade: async () => { if (++calls === 1) throw new Error('out of memory'); return true; } });
  const outcome = await completeDetail({
    world,
    pendingDetail: Promise.resolve({ bytes: 2 }),
    fetchAgain: () => Promise.resolve({ bytes: 2 }),
    pause: noPause([]),
  });
  assert.equal(outcome.state, 'ready');
  assert.equal(calls, 2);
});

test('a world freed before the swap is left alone', async () => {
  const world = fakeWorld();
  world.disposed = true;
  const outcome = await completeDetail({ world, pendingDetail: Promise.resolve({ bytes: 1 }), fetchAgain: () => assert.fail('no retry') });
  assert.equal(outcome.state, 'freed');
  assert.equal(world.upgrades.length, 0);
});

test('a world freed in the middle of the swap ends it as freed, whether the swap answers false or throws', async () => {
  const answersFalse = fakeWorld({ upgrade: async (files, world) => { world.disposed = true; return false; } });
  const first = await completeDetail({ world: answersFalse, pendingDetail: Promise.resolve({ bytes: 1 }), fetchAgain: () => assert.fail('no retry') });
  assert.equal(first.state, 'freed');

  const throws = fakeWorld({ upgrade: async (files, world) => { world.disposed = true; throw new Error('renderer is disposed'); } });
  const failures = [];
  const second = await completeDetail({
    world: throws,
    pendingDetail: Promise.resolve({ bytes: 1 }),
    fetchAgain: () => assert.fail('no retry'),
    onFailure: (attempt, error) => failures.push(error.message),
  });
  assert.equal(second.state, 'freed');
  assert.deepEqual(failures, [], 'a freed world is not a failure to report');
});

test('a world freed while it waits to retry is not asked for again', async () => {
  const world = fakeWorld();
  const outcome = await completeDetail({
    world,
    pendingDetail: Promise.reject(new Error('offline')),
    fetchAgain: () => assert.fail('no retry for a freed world'),
    pause: async () => { world.disposed = true; },
  });
  assert.equal(outcome.state, 'freed');
});

test('the flight slows from the hold start, stops at the end of what the first view holds, and runs free once the detail is in', () => {
  assert.equal(holdTargetRate(HOLD_FROM_SECONDS - 0.1, 'pending'), 1);
  assert.equal(holdTargetRate(HOLD_FROM_SECONDS, 'pending'), HOLD_RATE);
  assert.equal(holdTargetRate(FIRST_VIEW_COVERS_SECONDS, 'pending'), 0);
  for (const state of ['ready', 'failed', 'freed', undefined]) assert.equal(holdTargetRate(FIRST_VIEW_COVERS_SECONDS, state), 1, String(state));
});

test('the flight eases toward its target rate and counts the time it lost', () => {
  const entry = { rate: 1, held: 0 };
  advanceHold(entry, 0.1, 3, 'pending');
  assert.ok(entry.rate < 1 && entry.rate > HOLD_RATE, 'a ramp, not a jump');
  assert.ok(entry.held > 0);
  for (let step = 0; step < 100; step++) advanceHold(entry, 0.1, 3, 'pending');
  assert.equal(entry.rate, HOLD_RATE);
  for (let step = 0; step < 100; step++) advanceHold(entry, 0.1, 3, 'ready');
  assert.equal(entry.rate, 1);
});

test('the first view the port description names exists and stays within its byte budget', () => {
  const published = JSON.parse(readFileSync(new URL('../public/showcase/port/scene.json', import.meta.url), 'utf8'));
  assert.ok(hasFirstView(published));
  const firstViewBytes = statSync(new URL(`../public${published.glbFirstView}`, import.meta.url)).size;
  assert.ok(firstViewBytes <= 2_100_000, `first view is ${firstViewBytes} bytes`);
  assert.ok(existsSync(new URL(`../public${published.hdriPreview}`, import.meta.url)));
});

test('fetchWorld falls back to the full world when the first view model or sky is missing', async () => {
  for (const missing of [description.glbFirstView, description.hdriPreview]) {
    installFetch();
    const original = globalThis.fetch;
    globalThis.fetch = url => (url === missing ? Promise.resolve({ ok: false, status: 404 }) : original(url));
    const download = await fetchWorld(DESCRIPTION_URL, { firstView: true, measureLink: slowLink });
    assert.equal(download.isFirstView, undefined, missing);
    assert.deepEqual(download.paths, [description.glb, ...description.glbRest], missing);
  }
});

test('a first view that fails to build is replaced by the full world, and a full world that fails to build is not hidden', async () => {
  const firstViewDownload = { isFirstView: true, detail: Promise.resolve({ id: 'full' }) };
  const built = [];
  const build = async download => {
    built.push(download);
    if (download.isFirstView) throw new Error('first view does not parse');
    return { world: download.id };
  };
  const result = await buildWithFallback(firstViewDownload, build);
  assert.deepEqual(result.world, { world: 'full' });
  assert.equal(result.builtFrom.isFirstView, undefined);
  assert.equal(built.length, 2);
  await assert.rejects(buildWithFallback({ id: 'full' }, async () => { throw new Error('full does not parse'); }), /full does not parse/);
});

function fakeRenderer(calls) {
  return {
    prepareEnvironmentInSlices: async () => { calls.push('environment'); },
    preloadTextures: async () => { calls.push('preloadTextures'); },
    replaceParts: () => { calls.push('replaceParts'); },
    prepareFrame: async () => { calls.push('prepareFrame'); },
  };
}

const fakeParts = [{ geometry: { indices: [0, 1, 2] } }, { geometry: { indices: [0, 1, 2] } }];

test('the swap prefilters the sky before it replaces the parts, and stops when the world is freed on the way', async () => {
  const calls = [];
  assert.equal(await replaceRendererWorld(fakeRenderer(calls), fakeParts, {}, () => false), true);
  assert.deepEqual(calls.slice(0, 2), ['environment', 'preloadTextures'], 'large textures upload in bands before the parts arrive');
  assert.ok(calls.length > 2 && calls.slice(2).every(name => name === 'replaceParts'));
  const freedCalls = [];
  assert.equal(await replaceRendererWorld(fakeRenderer(freedCalls), fakeParts, {}, () => true), false);
  assert.deepEqual(freedCalls, ['environment']);
  const freedDuringUploadCalls = [];
  const answers = [false, true];
  assert.equal(await replaceRendererWorld(fakeRenderer(freedDuringUploadCalls), fakeParts, {}, () => answers.shift() ?? true), false);
  assert.deepEqual(freedDuringUploadCalls, ['environment', 'preloadTextures']);
});

test('the swap prepares a draw at the last pose, and none when the world was never drawn', async () => {
  const calls = [];
  const frames = [];
  const frameFor = (camera, seconds) => {
    frames.push([camera, seconds]);
    return { camera };
  };
  assert.equal(await prepareFrameAtLastPose(fakeRenderer(calls), null, frameFor), false);
  assert.deepEqual(calls, []);
  assert.equal(frames.length, 0, 'no pose, so no frame is built from a missing eye');
  const camera = { eye: [1, 2, 3], target: [0, 0, 0], fov: 40 };
  assert.equal(await prepareFrameAtLastPose(fakeRenderer(calls), { camera, seconds: 7 }, frameFor), true);
  assert.deepEqual(calls, ['prepareFrame']);
  assert.deepEqual(frames, [[camera, 7]]);
});

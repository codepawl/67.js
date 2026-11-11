import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createPlayOnDemand, PLAY_HANDOFF_MS } from '../src/hero-lab/loop/play-on-demand.js';
import { fetchWorld, takePrefetched } from '../src/hero-lab/loop/world.js';

const DESCRIPTION_URL = '/showcase/port/scene.json';
const description = { id: 'port', glb: '/showcase/port/scene.glb', glbRest: ['/showcase/port/scene.rest.glb'], hdri: '/showcase/port/sky.hdr' };

function fakeBlob(content) {
  return { size: content.length, text: () => Promise.resolve(content) };
}

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
let requested;

// A fetch that answers the description with JSON and every other file with a small blob; a url in `missing` answers 404.
function installFetch(missing = []) {
  requested = [];
  globalThis.fetch = async url => {
    requested.push(url);
    if (missing.includes(url)) return { ok: false, status: 404 };
    return { ok: true, blob: async () => fakeBlob(url === DESCRIPTION_URL ? JSON.stringify(description) : 'x'.repeat(10)) };
  };
}

beforeEach(() => {
  globalThis.window = {};
  installFetch();
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

test('takePrefetched hands out a prefetched file once and forgets it', async () => {
  const blob = fakeBlob('abc');
  window.__heroPrefetch = { '/a.glb': Promise.resolve(blob) };
  assert.equal(await takePrefetched('/a.glb'), blob);
  assert.equal(await takePrefetched('/a.glb'), null);
  assert.deepEqual(window.__heroPrefetch, {});
});

test('takePrefetched answers null for a file nobody prefetched and when there is no prefetch at all', async () => {
  window.__heroPrefetch = {};
  assert.equal(await takePrefetched('/missing.glb'), null);
  delete window.__heroPrefetch;
  assert.equal(await takePrefetched('/missing.glb'), null);
});

test('takePrefetched answers null for a prefetch that failed, so the caller asks again', async () => {
  const failed = Promise.reject(new Error('offline'));
  failed.catch(() => {});
  window.__heroPrefetch = { '/a.glb': failed };
  assert.equal(await takePrefetched('/a.glb'), null);
});

test('takePrefetched waits for the prefetch to be released before it looks', async () => {
  let release;
  window.__heroPrefetchReady = new Promise(resolve => { release = resolve; });
  window.__heroPrefetch = {};
  let answered = false;
  const taking = takePrefetched('/a.glb').then(result => {
    answered = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answered, false, 'still waiting for the poster');
  const blob = fakeBlob('abc');
  window.__heroPrefetch['/a.glb'] = Promise.resolve(blob);
  release();
  assert.equal(await taking, blob);
});

test('fetchWorld uses every prefetched file and makes no request of its own', async () => {
  window.__heroPrefetch = {
    [DESCRIPTION_URL]: Promise.resolve(fakeBlob(JSON.stringify(description))),
    [description.glb]: Promise.resolve(fakeBlob('12345')),
    [description.glbRest[0]]: Promise.resolve(fakeBlob('1234567')),
    [description.hdri]: Promise.resolve(fakeBlob('123')),
  };
  const world = await fetchWorld(DESCRIPTION_URL);
  assert.deepEqual(requested, []);
  assert.equal(world.bytes, 5 + 7 + 3);
  assert.deepEqual(world.paths, [description.glb, ...description.glbRest]);
});

test('fetchWorld falls back to its own request for a file whose prefetch failed or was already taken', async () => {
  const failed = Promise.reject(new Error('offline'));
  failed.catch(() => {});
  window.__heroPrefetch = { [DESCRIPTION_URL]: Promise.resolve(fakeBlob(JSON.stringify(description))), [description.glb]: failed };
  const first = await fetchWorld(DESCRIPTION_URL);
  assert.deepEqual([...requested].sort(), [description.glbRest[0], description.glb, description.hdri].sort());
  assert.equal(first.bytes, 30);

  requested.length = 0;
  const second = await fetchWorld(DESCRIPTION_URL);
  assert.equal(requested.length, 4, 'a world visited again is fetched fresh, because each prefetch is used once');
  assert.equal(second.bytes, 30);
});

test('fetchWorld without any prefetch fetches the four files and reports a missing one', async () => {
  const world = await fetchWorld(DESCRIPTION_URL);
  assert.equal(requested.length, 4);
  assert.equal(world.description.id, 'port');
  installFetch([description.hdri]);
  await assert.rejects(fetchWorld(DESCRIPTION_URL), /sky\.hdr is not available \(404\)/);
});

function fakePlayButton() {
  const label = { textContent: 'Play live 3D' };
  return { hidden: false, disabled: false, dataset: {}, querySelector: () => label, label };
}

function playHarness(beginLive) {
  const button = fakePlayButton();
  const events = [];
  const handoffs = [];
  const play = createPlayOnDemand({
    playButton: button,
    beginLive,
    showError: message => events.push(`error: ${message}`),
    focusTarget: { focus: options => events.push(`focus ${JSON.stringify(options)}`) },
    onLive: () => events.push('live layout'),
    wait: (callback, delay) => handoffs.push({ callback, delay }),
  });
  return { button, events, handoffs, play };
}

test('pressing Play shows a loading mark while the world loads, then hides the button and moves focus', async () => {
  let finish;
  const { button, events, handoffs, play } = playHarness(() => new Promise(resolve => { finish = resolve; }));
  const pressed = play();
  assert.equal(button.disabled, true);
  assert.equal(button.dataset.state, 'loading');
  assert.equal(button.label.textContent, 'Loading 3D');
  finish();
  assert.equal(await pressed, true);
  assert.equal(button.hidden, true);
  assert.deepEqual(events, ['focus {"preventScroll":true}']);
  assert.equal(handoffs[0].delay, PLAY_HANDOFF_MS);
  handoffs[0].callback();
  assert.deepEqual(events.at(-1), 'live layout');
});

test('a failed start shows the error and puts the button back, and the next press retries', async () => {
  let attempts = 0;
  const { button, events, handoffs, play } = playHarness(async () => {
    attempts++;
    if (attempts === 1) throw new Error('sky.hdr is not available (503)');
  });
  assert.equal(await play(), false);
  assert.deepEqual(events, ['error: Live view unavailable: sky.hdr is not available (503)']);
  assert.equal(button.disabled, false);
  assert.equal(button.hidden, false);
  assert.equal(button.dataset.state, undefined);
  assert.equal(button.label.textContent, 'Play live 3D');
  assert.equal(handoffs.length, 0, 'no live layout after a failure');

  assert.equal(await play(), true);
  assert.equal(attempts, 2);
  assert.equal(button.hidden, true);
  assert.equal(events.at(-1), 'focus {"preventScroll":true}');
});

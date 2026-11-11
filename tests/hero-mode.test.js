import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const heroModeScript = indexHtml.match(/<script id="hero-mode">([\s\S]*?)<\/script>/)?.[1];

// Runs the inline script of index.html against a fake browser. Timers are collected, not run: call runTimers() to let POSTER_WAIT_MS pass.
function runHeroMode({ connection, deviceMemory, phone = false, search = '', respond } = {}) {
  const fetched = [];
  const timers = [];
  const documentElement = { dataset: {} };
  const sandbox = {
    navigator: { connection, deviceMemory },
    matchMedia: () => ({ matches: phone }),
    location: { search },
    URLSearchParams,
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    fetch: href => {
      fetched.push(href);
      return Promise.resolve(respond ? respond(href) : { ok: true, blob: () => Promise.resolve({ href }) });
    },
    document: { documentElement },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(heroModeScript, sandbox);
  const runTimers = () => timers.splice(0).forEach(timer => timer.callback());
  return { mode: sandbox.window.__heroMode, attribute: documentElement.dataset.heroMode, fetched, timers, runTimers, window: sandbox.window };
}

test('index.html carries the hero mode script', () => {
  assert.ok(heroModeScript, 'index.html needs <script id="hero-mode">');
});

test('the poster image reports its load and its error to the script, and keeps its high fetch priority', () => {
  const poster = indexHtml.match(/<img class="poster"[^>]*>/)[0];
  assert.match(poster, /fetchpriority="high"/);
  assert.ok(poster.includes('onload="window.__heroPosterSettled&&window.__heroPosterSettled()"'));
  assert.ok(poster.includes('onerror="window.__heroPosterSettled&&window.__heroPosterSettled()"'));
});

test('a desktop on a good connection goes live and starts the first world only once the poster has loaded', async () => {
  const { mode, attribute, fetched, window } = runHeroMode({ connection: { effectiveType: '4g', saveData: false }, deviceMemory: 8 });
  assert.equal(mode, 'live');
  assert.equal(attribute, 'live');
  assert.deepEqual(fetched, [], 'nothing competes with the poster');
  window.__heroPosterSettled();
  assert.ok(fetched.length > 0);
  assert.deepEqual(Object.keys(window.__heroPrefetch), fetched);
  await window.__heroPrefetchReady;
  for (const href of fetched) assert.deepEqual(await window.__heroPrefetch[href], { href });
});

test('a poster that never settles does not hold the world back for ever', () => {
  const { fetched, timers, runTimers } = runHeroMode();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5000);
  assert.deepEqual(fetched, []);
  runTimers();
  assert.ok(fetched.length > 0);
});

test('the prefetch starts once however many times the poster and the timeout report', () => {
  const { fetched, window, runTimers } = runHeroMode();
  window.__heroPosterSettled();
  const count = fetched.length;
  window.__heroPosterSettled();
  runTimers();
  assert.equal(fetched.length, count);
});

test('a scout page goes live but prefetches nothing and sets no timer', () => {
  const { mode, fetched, timers, window } = runHeroMode({ search: '?scout=1' });
  assert.equal(mode, 'live');
  assert.deepEqual(fetched, []);
  assert.equal(timers.length, 0);
  assert.equal(window.__heroPrefetch, undefined);
  assert.equal(window.__heroPrefetchReady, undefined);
});

test('a browser that reports nothing about the connection goes live', () => {
  assert.equal(runHeroMode().mode, 'live');
});

test('the prefetched files are the ones the port description names', () => {
  const description = JSON.parse(readFileSync(new URL('../public/showcase/port/scene.json', import.meta.url), 'utf8'));
  const { fetched, runTimers } = runHeroMode();
  runTimers();
  const expected = ['/showcase/port/scene.json', description.glb, ...description.glbRest, description.hdri];
  assert.deepEqual(fetched, expected);
  for (const href of expected) assert.ok(existsSync(new URL(`../public${href}`, import.meta.url)), `${href} exists`);
});

test('a failed prefetch is a rejected promise that never goes unhandled', async () => {
  const { window, runTimers } = runHeroMode({ respond: () => ({ ok: false, status: 404 }) });
  runTimers();
  await assert.rejects(window.__heroPrefetch['/showcase/port/scene.glb'], /is not available \(404\)/);
});

test('the light path shows the poster and fetches nothing', () => {
  const cases = {
    'save data': { connection: { saveData: true, effectiveType: '4g' } },
    '2g': { connection: { effectiveType: '2g' } },
    'slow 2g': { connection: { effectiveType: 'slow-2g' } },
    '3g': { connection: { effectiveType: '3g' } },
    '4 GB of memory': { connection: { effectiveType: '4g' }, deviceMemory: 4 },
    '2 GB of memory': { deviceMemory: 2 },
    'a phone on 3g': { connection: { effectiveType: '3g' }, phone: true },
  };
  for (const [name, options] of Object.entries(cases)) {
    const { mode, fetched } = runHeroMode(options);
    assert.equal(mode, 'poster', name);
    assert.equal(fetched.length, 0, name);
  }
});

test('a phone on a good connection waits for the poster and fetches nothing yet', () => {
  const { mode, fetched } = runHeroMode({ connection: { effectiveType: '4g' }, deviceMemory: 8, phone: true });
  assert.equal(mode, 'deferred');
  assert.equal(fetched.length, 0);
});

test('capture, measure and scout pages always go live', () => {
  for (const search of ['?capture=1', '?measure=1&samples=2', '?scout=1']) {
    assert.equal(runHeroMode({ connection: { saveData: true }, phone: true, search }).mode, 'live', search);
  }
  assert.equal(runHeroMode({ connection: { saveData: true }, search: '?captured=1' }).mode, 'poster');
});

test('index.html has the Play live 3D button, hidden until the light path shows it', () => {
  assert.match(indexHtml, /<button class="play-live" id="play-live" type="button" hidden>[\s\S]*?Play live 3D<\/span><\/button>/);
});

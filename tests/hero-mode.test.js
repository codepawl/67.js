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

test('the poster keeps its high fetch priority and does not gate the world on its load', () => {
  const poster = indexHtml.match(/<img class="poster"[^>]*>/)[0];
  assert.match(poster, /fetchpriority="high"/);
  assert.ok(!poster.includes('onload'), 'the first world does not wait for the poster');
  assert.ok(!poster.includes('onerror'));
});

test('a desktop on a good connection goes live and starts the first view with the page, the full world after it', async () => {
  const { mode, attribute, fetched, timers, window } = runHeroMode({ connection: { effectiveType: '4g', saveData: false }, deviceMemory: 8 });
  assert.equal(mode, 'live');
  assert.equal(attribute, 'live');
  assert.equal(fetched.length, 3, 'only the 2 MB first view starts at once, beside the poster');
  assert.equal(timers.length, 0, 'no timer holds the world back');
  await window.__heroPrefetchReady;
  for (const href of Object.keys(window.__heroPrefetch)) assert.deepEqual(await window.__heroPrefetch[href], { href });
  assert.equal(fetched.length, 6, 'the full world follows once the first view has settled');
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

test('the prefetched files are the ones the port description names, the first view before the full world', async () => {
  const description = JSON.parse(readFileSync(new URL('../public/showcase/port/scene.json', import.meta.url), 'utf8'));
  const { fetched, runTimers, window } = runHeroMode();
  runTimers();
  const firstView = ['/showcase/port/scene.json', description.glbFirstView, description.hdriPreview];
  const fullWorld = [description.glb, ...description.glbRest, description.hdri];
  assert.deepEqual(fetched, firstView, 'the full world has not started while the first view is in flight');
  await Promise.all(Object.values(window.__heroPrefetch));
  const expected = [...firstView, ...fullWorld];
  assert.deepEqual(fetched, expected);
  for (const href of expected) assert.ok(existsSync(new URL(`../public${href}`, import.meta.url)), `${href} exists`);
});

test('a failed prefetch is a rejected promise that never goes unhandled', async () => {
  const { window, runTimers } = runHeroMode({ respond: () => ({ ok: false, status: 404 }) });
  runTimers();
  await assert.rejects(window.__heroPrefetch['/showcase/port/scene.glb'], /is not available \(404\)/);
  await assert.rejects(window.__heroPrefetch['/showcase/port/scene.first.glb'], /is not available \(404\)/);
});

test('the full world still starts when the first view failed', async () => {
  const { fetched, window, runTimers } = runHeroMode({ respond: href => (href.includes('first') ? { ok: false, status: 503 } : { ok: true, blob: () => Promise.resolve({ href }) }) });
  runTimers();
  await window.__heroPrefetch['/showcase/port/scene.glb'];
  assert.ok(fetched.includes('/showcase/port/sky.hdr'));
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

test('a phone on a good connection is deferred and fetches nothing from the page head', () => {
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

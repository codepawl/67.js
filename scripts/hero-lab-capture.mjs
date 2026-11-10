// Captures and measures the home-hero prototypes (hero-b.html?scene=...) in headless Chrome on the GPU.
//   node scripts/hero-lab-capture.mjs probe   --scene port --cam "x,y,z,tx,ty,tz,fov" --out file.png
//   node scripts/hero-lab-capture.mjs stills  --scene valley --out dir        1440x900 at start, middle, end, plus 375x812
//   node scripts/hero-lab-capture.mjs poster  --scene valley --out dir        writes public/hero-lab/poster-b-<scene>[-mobile].webp-source PNGs
//   node scripts/hero-lab-capture.mjs measure --scene valley --out file.json  bytes, first paint, first live frame, frame times
//   node scripts/hero-lab-capture.mjs frames  --scene valley --out dir        a stepped scroll pass as numbered PNGs (encode with ffmpeg)
// stills also takes --steps "0,0.34,0.5" (scroll progress values). Options: --base http://127.0.0.1:5195  --chrome <path>  --frames 210  --progress 0.5
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [mode, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(rest.reduce((pairs, token, index) => (token.startsWith('--') ? [...pairs, [token.slice(2), rest[index + 1]]] : pairs), []));
const base = options.base ?? 'http://127.0.0.1:5195';
const scene = options.scene ?? 'valley';
const chromePath = options.chrome ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const GPU_ARGUMENTS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'];

async function openHero(browser, { width, height, reducedMotion = false, record = false }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('pageerror', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('console', message.text()); });
  return { context, page };
}

async function waitLive(page, { complete = false } = {}) {
  try {
    await page.waitForFunction(() => (window.__heroB && document.querySelector('#stage').dataset.live === 'true') || window.__hero.error, null, { timeout: 120000 });
  } catch (error) {
    console.error('stage never went live', await page.evaluate(() => window.__hero?.error));
    throw error;
  }
  const failure = await page.evaluate(() => window.__hero.error);
  if (failure) throw new Error(failure);
  if (complete && scene === 'port') await page.waitForFunction(() => window.__heroB.scene.state.complete || window.__heroB.scene.state.error, null, { timeout: 180000 });
}

async function scrollTo(page, progress) {
  await page.evaluate(value => {
    const root = document.querySelector('.hero-b');
    window.scrollTo(0, value * (root.offsetHeight - innerHeight));
  }, progress);
  await page.waitForFunction(() => window.__heroB.state.settled, null, { timeout: 20000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function probe() {
  const browser = await chromium.launch({ executablePath: chromePath, args: GPU_ARGUMENTS });
  const { page } = await openHero(browser, { width: 1440, height: 900 });
  await page.goto(`${base}/hero-b.html?scene=${scene}`);
  await waitLive(page, { complete: !options.early });
  // Several cameras can be probed in one load: --cam "x,y,z,tx,ty,tz,fov;x,y,z,tx,ty,tz,fov" writes <out>-<n>.png.
  for (const [index, spec] of options.cam.split(';').entries()) {
    const [x, y, z, tx, ty, tz, fov] = spec.split(',').map(Number);
    await page.evaluate(([eye, target, field]) => { window.__heroB.state.override = { eye, target, fov: field }; window.__heroB.wake(); }, [[x, y, z], [tx, ty, tz], fov]);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${options.out}-${index}.png` });
  }
  await browser.close();
}

async function stills() {
  fs.mkdirSync(options.out, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromePath, args: GPU_ARGUMENTS });
  const desktop = await openHero(browser, { width: 1440, height: 900 });
  await desktop.page.goto(`${base}/hero-b.html?scene=${scene}`);
  await waitLive(desktop.page, { complete: true });
  const names = { 0: 'start', 0.5: 'middle', 1: 'end' };
  for (const progress of (options.steps ?? '0,0.5,1').split(',').map(Number)) {
    const name = names[progress] ?? `p${progress}`;
    await scrollTo(desktop.page, progress);
    await desktop.page.waitForTimeout(700);
    await desktop.page.screenshot({ path: path.join(options.out, `${scene}-${name}-1440.png`) });
  }
  const mobile = await openHero(browser, { width: 375, height: 812 });
  await mobile.page.goto(`${base}/hero-b.html?scene=${scene}`);
  await waitLive(mobile.page, { complete: true });
  await mobile.page.waitForTimeout(700);
  await mobile.page.screenshot({ path: path.join(options.out, `${scene}-mobile-375.png`) });
  await browser.close();
}

// Posters are the opening frame without any text: hide the chapters, wait for the live canvas, screenshot the stage.
async function poster() {
  fs.mkdirSync(options.out, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromePath, args: GPU_ARGUMENTS });
  for (const [suffix, width, height] of [['', 1440, 900], ['-mobile', 750, 1334]]) {
    const { page } = await openHero(browser, { width: width / (suffix ? 2 : 1), height: height / (suffix ? 2 : 1) });
    await page.setViewportSize({ width: suffix ? 375 : 1440, height: suffix ? 667 : 900 });
    await page.goto(`${base}/hero-b.html?scene=${scene}`);
    await waitLive(page, { complete: true });
    await page.addStyleTag({ content: '.chapter,.cue,.progress,.lab-nav,.stage::after{display:none!important}.poster{display:none!important}' });
    await page.waitForTimeout(800);
    await page.locator('#stage').screenshot({ path: path.join(options.out, `poster-b-${scene}${suffix}.png`) });
    await page.close();
  }
  await browser.close();
}

async function measure() {
  const browser = await chromium.launch({ executablePath: chromePath, args: GPU_ARGUMENTS });
  const { context, page } = await openHero(browser, { width: 1440, height: 900 });
  const client = await context.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  const sizes = new Map();
  client.on('Network.loadingFinished', event => sizes.set(event.requestId, event.encodedDataLength));
  const urls = new Map();
  client.on('Network.requestWillBeSent', event => urls.set(event.requestId, event.request.url));
  await page.addInitScript(() => {
    window.__paints = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__paints.push([entry.name ?? entry.entryType, Math.round(entry.startTime)]); }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__paints.push(['lcp', Math.round(entry.startTime)]); }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  await page.goto(`${base}/hero-b.html?scene=${scene}`);
  await waitLive(page);
  const afterFirstLive = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  await page.waitForTimeout(500);
  const firstLive = await page.evaluate(() => ({ firstLiveFrameMs: window.__hero.firstLiveFrameMs, stageOneReadyMs: window.__hero.stageOneReadyMs ?? null, paints: window.__paints }));
  await waitLive(page, { complete: true });
  await page.waitForTimeout(1500);
  const total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  const completeAt = await page.evaluate(() => Math.round(performance.now()));

  // Method A: GPU readback. Render each scroll position, then read one pixel back so the GPU has finished before the clock stops.
  const readback = await page.evaluate(async frameCount => {
    const { scene: heroScene, canvas } = window.__heroB;
    const context = canvas.getContext('webgl2');
    const pixel = new Uint8Array(4);
    const times = [];
    for (let index = 0; index < frameCount; index++) {
      const started = performance.now();
      heroScene.render(index / (frameCount - 1), index / 60, null);
      context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
      times.push(performance.now() - started);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return times;
  }, 400);
  // Method B: real scroll pass with vsync and the frame limit off; interval between animation frames and CPU time inside draw.
  const interval = await page.evaluate(async () => {
    window.__hero.frameIntervals.length = 0;
    window.__hero.renderMilliseconds.length = 0;
    const root = document.querySelector('.hero-b');
    const travel = root.offsetHeight - innerHeight;
    const started = performance.now();
    await new Promise(resolve => {
      const step = now => {
        const amount = Math.min(1, (now - started) / 5000);
        window.scrollTo(0, amount * travel);
        if (amount < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    return { frameIntervals: [...window.__hero.frameIntervals], renderMilliseconds: [...window.__hero.renderMilliseconds] };
  });
  const quantile = (values, fraction) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(2)) : null; };
  const result = {
    scene,
    transferredBytesAtFirstLiveFrame: afterFirstLive,
    transferredBytesTotal: total,
    firstLiveFrameMs: firstLive.firstLiveFrameMs,
    stageOneReadyMs: firstLive.stageOneReadyMs,
    worldCompleteMs: completeAt,
    paints: firstLive.paints,
    gpuReadbackFrameMs: { median: quantile(readback, 0.5), p95: quantile(readback, 0.95), frames: readback.length },
    scrollPassIntervalMs: { median: quantile(interval.frameIntervals, 0.5), p95: quantile(interval.frameIntervals, 0.95), frames: interval.frameIntervals.length },
    scrollPassDrawCpuMs: { median: quantile(interval.renderMilliseconds, 0.5), p95: quantile(interval.renderMilliseconds, 0.95) },
    biggestFiles: [...sizes.entries()].map(([id, bytes]) => [path.basename(new URL(urls.get(id) ?? 'http://x/?').pathname), bytes]).sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
  fs.writeFileSync(options.out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await browser.close();
}

async function frames() {
  fs.mkdirSync(options.out, { recursive: true });
  const count = Number(options.frames ?? 210);
  const browser = await chromium.launch({ executablePath: chromePath, args: GPU_ARGUMENTS });
  const { page } = await openHero(browser, { width: 1280, height: 720 });
  await page.goto(`${base}/hero-b.html?scene=${scene}`);
  await waitLive(page, { complete: true });
  await page.waitForTimeout(600);
  for (let index = 0; index < count; index++) {
    await scrollTo(page, index / (count - 1));
    await page.screenshot({ path: path.join(options.out, `frame-${String(index).padStart(4, '0')}.png`) });
  }
  await browser.close();
}

// Reduced motion: the canvas must hold one framing while scrolling and not animate on its own; the text chapters still swap.
async function reduced() {
  const browser = await chromium.launch({ executablePath: chromePath, args: GPU_ARGUMENTS });
  const { page } = await openHero(browser, { width: 1440, height: 900, reducedMotion: true });
  await page.goto(`${base}/hero-b.html?scene=${scene}`);
  await waitLive(page, { complete: true });
  await page.addStyleTag({ content: '.chapter,.cue,.progress,.lab-nav,.poster{visibility:hidden!important}' });
  const shots = [];
  for (const progress of [0, 0.5, 1]) {
    await scrollTo(page, progress);
    await page.waitForTimeout(600);
    const buffer = await page.locator('#stage').screenshot(options.out ? { path: `${options.out}-${progress}.png` } : {});
    shots.push(buffer.toString('base64'));
  }
  const chapterTwoOpacityAtEnd = await page.evaluate(() => document.querySelector('#chapter-two').style.opacity);
  console.log(JSON.stringify({ scene, canvasIdenticalAcrossScroll: shots[0] === shots[1] && shots[1] === shots[2], firstTwoEqual: shots[0] === shots[1], lastTwoEqual: shots[1] === shots[2], matches: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), chapterTwoOpacityAtEnd }));
  await browser.close();
}

const commands = { reduced, probe, stills, poster, measure, frames };
if (!commands[mode]) throw new Error(`Unknown mode ${mode}. Use probe, stills, poster, measure or frames.`);
await commands[mode]();

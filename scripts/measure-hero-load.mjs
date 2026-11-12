// Measures how the home hero loads in headless Chrome on the GPU, on a throttled or unthrottled link, from a built site folder.
//
//   node scripts/measure-hero-load.mjs --dist <built site folder> [--label name] [--runs 3] [--conditions fast4g,slow,none]
//        [--viewports desktop,phone] [--out directory]
//        [--cpu 4]            CPU slowdown factor (emulated by the DevTools protocol, not a slow device)
//        [--watch-seconds N]  keep each page open N seconds after the swap (the loop changes worlds) and report the main-thread tasks over 50 ms after first paint
//        [--origin <url>]     measure a deployed site instead of serving --dist (it then needs no folder)
//   node scripts/measure-hero-load.mjs --dist <folder> --stills <directory>      stills before and after the swap, with PSNR
//   node scripts/measure-hero-load.mjs --dist <folder> --video <file.mp4>        CDP screencast of the first 8 s on Fast 4G
//
// Build the folder with `npx vite build --outDir <folder>`. The folder is served by a small static server on a free port from 5280
// up, with brotli for text, as a CDN would. Network time comes from the DevTools throttle, which GPU load does not change.
//   posterEndMs    responseEnd of the poster image
//   firstFrameMs   the first draw on a world canvas (the first live 3D frame)
//   swapMs, swapHeldMs, swapLongestGapMs   how long the swap to the full world took, how long its draws were held (sky prefilter, replaceParts, prepared draw), and the longest gap between animation frames around it
//   detailMs       when the full world is drawn (the 'detailed' loop event); without staged loading it equals firstFrameMs
//   bytesBeforeFirstFrame, bytesTotal   transfer bytes (compressed size on the wire) up to the first live frame, and up to detailMs
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';

// CHROME_PATH and HERO_CHROME_ARGUMENTS (space separated) override these, for a container with Vulkan instead of Direct3D.
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const GPU_ARGUMENTS = process.env.HERO_CHROME_ARGUMENTS ? process.env.HERO_CHROME_ARGUMENTS.split(' ') : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const FIRST_FRAME_MARKER = 'hero-first-world-draw';
const CONDITIONS = {
  fast4g: { label: 'Fast 4G', downloadBitsPerSecond: 9e6, uploadBitsPerSecond: 1.5e6, latency: 60 },
  slow: { label: '1.6 Mbit/s, 150 ms', downloadBitsPerSecond: 1.6e6, uploadBitsPerSecond: 0.75e6, latency: 150 },
  none: { label: 'unthrottled', downloadBitsPerSecond: 0, uploadBitsPerSecond: 0, latency: 0 },
};
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
  phone: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true },
};
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream', '.png': 'image/png', '.woff2': 'font/woff2' };
const TEXT_TYPES = new Set(['.html', '.js', '.css', '.json', '.svg']);

function parseArguments(argv) {
  const options = { dist: null, label: 'build', runs: 3, conditions: ['fast4g', 'slow', 'none'], viewports: ['desktop', 'phone'], out: null, cpu: 1, remoteOrigin: null, stills: null, video: null, timeoutSeconds: 120, watchSeconds: 0 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => argv[++index];
    if (flag === '--dist') options.dist = resolve(value());
    else if (flag === '--label') options.label = value();
    else if (flag === '--runs') options.runs = Number(value());
    else if (flag === '--conditions') options.conditions = value().split(',');
    else if (flag === '--viewports') options.viewports = value().split(',');
    else if (flag === '--cpu') options.cpu = Number(value());
    else if (flag === '--origin') options.remoteOrigin = value().replace(/[/]$/, '');
    else if (flag === '--out') options.out = resolve(value());
    else if (flag === '--stills') options.stills = resolve(value());
    else if (flag === '--video') options.video = resolve(value());
    else if (flag === '--timeout') options.timeoutSeconds = Number(value());
    else if (flag === '--watch-seconds') options.watchSeconds = Number(value());
    else throw new Error(`Unknown argument ${flag}.`);
  }
  if (!options.dist && options.remoteOrigin) return options;
  if (!options.dist || !existsSync(join(options.dist, 'index.html'))) throw new Error('Pass --dist <folder with index.html>.');
  return options;
}

async function startServer(root) {
  const compressed = new Map();
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(root)) return response.writeHead(403).end();
    if (!existsSync(file) || statSync(file).isDirectory()) file = existsSync(`${file}.html`) ? `${file}.html` : null;
    if (!file) return response.writeHead(404).end('not found');
    const extension = extname(file);
    const headers = { 'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream', 'cache-control': 'no-store' };
    let body = readFileSync(file);
    if (TEXT_TYPES.has(extension) && /\bbr\b/.test(request.headers['accept-encoding'] ?? '')) {
      if (!compressed.has(file)) compressed.set(file, brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }));
      body = compressed.get(file);
      headers['content-encoding'] = 'br';
    }
    headers['content-length'] = body.length;
    response.writeHead(200, headers).end(body);
  });
  for (let port = 5280; port < 5400; port++) {
    const listening = await new Promise(resolveListening => {
      server.once('error', () => resolveListening(false));
      server.listen(port, '127.0.0.1', () => resolveListening(true));
    });
    if (listening) return { server, origin: `http://127.0.0.1:${port}` };
  }
  throw new Error('No free port from 5280 to 5399.');
}

// Runs in the page before any script: stamps the moment the page marks the live canvas as shown (data-live on the stage), which is the
// first live 3D frame a visitor sees. The poster fades out only after that.
function installFrameTimer(marker) {
  window.__firstWorldDraw = null;
  window.__largestContentfulPaint = null;
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__largestContentfulPaint = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  window.__layoutShift = 0;
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__layoutShift += entry.value;
  }).observe({ type: 'layout-shift', buffered: true });
  // Gaps between animation frames over 50 ms: the main thread was blocked. The swap to the full world should leave none that is long.
  // Main-thread tasks over 50 ms (the Long Tasks API), kept with their start so a run can count the ones after the first paint.
  window.__longTasks = [];
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__longTasks.push([Math.round(entry.startTime), Math.round(entry.duration)]);
  }).observe({ type: 'longtask', buffered: true });
  window.__frameGaps = [];
  let previousFrameAt = performance.now();
  const watchFrameGaps = now => {
    if (now - previousFrameAt > 50) window.__frameGaps.push([Math.round(previousFrameAt), Math.round(now - previousFrameAt)]);
    previousFrameAt = now;
    requestAnimationFrame(watchFrameGaps);
  };
  requestAnimationFrame(watchFrameGaps);
  new MutationObserver(() => {
    if (window.__firstWorldDraw === null && document.querySelector('#stage')?.dataset.live === 'true') {
      window.__firstWorldDraw = performance.now();
      console.debug(marker);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-live'] });
}

async function openPage(browser, viewport, condition, cpuSlowdown = 1) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor, isMobile: viewport.isMobile });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (cpuSlowdown > 1) await session.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
  if (condition.downloadBitsPerSecond > 0) {
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: condition.latency,
      downloadThroughput: condition.downloadBitsPerSecond / 8,
      uploadThroughput: condition.uploadBitsPerSecond / 8,
    });
  }
  await page.addInitScript(installFrameTimer, FIRST_FRAME_MARKER);
  return { context, page, session };
}

function watchBytes(session, page) {
  const state = { total: 0, atFirstFrame: null, timeline: [], firstRequestAt: null };
  session.on('Network.requestWillBeSent', event => { state.firstRequestAt ??= event.timestamp; });
  session.on('Network.dataReceived', event => {
    state.total += event.encodedDataLength;
    state.timeline.push([(event.timestamp - state.firstRequestAt) * 1000, state.total]);
  });
  page.on('console', message => {
    if (message.text() === FIRST_FRAME_MARKER) state.atFirstFrame = state.total;
  });
  return state;
}

function bytesAt(state, milliseconds) {
  let bytes = 0;
  for (const [at, total] of state.timeline) if (at <= milliseconds) bytes = total;
  return bytes;
}

async function measureOnce(browser, options, viewportName, conditionName) {
  const condition = CONDITIONS[conditionName];
  const { context, page, session } = await openPage(browser, VIEWPORTS[viewportName], condition, options.cpu);
  const bytes = watchBytes(session, page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${options.origin}/`, { waitUntil: 'commit' });
  const finished = async () => page.evaluate(() => {
    const events = window.__loop?.events ?? [];
    const detailed = events.find(event => event.kind === 'detailed');
    const failed = events.find(event => event.kind === 'failed');
    const swapEnd = detailed?.at ?? Infinity;
    const swapGaps = (window.__frameGaps ?? []).filter(([at, gap]) => at + gap > swapEnd - (detailed?.ms ?? 0) - 100 && at < swapEnd + 100);
    const longTasksAfterFirstPaint = (window.__longTasks ?? []).filter(([start]) => window.__firstWorldDraw !== null && start >= window.__firstWorldDraw);
    return { longTaskCount: longTasksAfterFirstPaint.length, longestTaskMs: longTasksAfterFirstPaint.reduce((longest, [, duration]) => Math.max(longest, duration), 0), longTasks: longTasksAfterFirstPaint, lcp: window.__largestContentfulPaint, layoutShift: window.__layoutShift, first: window.__firstWorldDraw, detailed: detailed?.at ?? null, swapMs: detailed?.ms ?? null, swapHeldMs: (window.__phases ?? []).filter(phase => phase[0] === "swap").reduce((total, phase) => total + phase[3] - phase[2], 0), swapLongestGapMs: swapGaps.length ? Math.max(...swapGaps.map(([, gap]) => gap)) : 0, failed: failed?.message ?? null, state: window.__loop?.detail?.() ?? null, mode: window.__heroMode };
  });
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let status = await finished();
  while (Date.now() < deadline && (status.first === null || (status.state === 'pending' && status.detailed === null)) && !status.failed) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    status = await finished();
  }
  if (options.watchSeconds > 0) {
    await new Promise(resolveWait => setTimeout(resolveWait, options.watchSeconds * 1000));
    status = await finished();
  }
  const poster = await page.evaluate(() => {
    const entry = performance.getEntriesByType('resource').find(resource => resource.name.includes('poster-b-port'));
    return entry ? Math.round(entry.responseEnd) : null;
  });
  const firstFrameMs = status.first === null ? null : Math.round(status.first);
  const detailMs = status.detailed ?? firstFrameMs;
  const result = {
    viewport: viewportName,
    condition: condition.label,
    mode: status.mode,
    posterEndMs: poster,
    lcpMs: status.lcp === null ? null : Math.round(status.lcp),
    layoutShift: Number(status.layoutShift.toFixed(4)),
    firstFrameMs,
    detailMs,
    swapMs: status.swapMs,
    swapLongestGapMs: status.swapLongestGapMs,
    longTaskCount: status.longTaskCount,
    longestTaskMs: status.longestTaskMs,
    longTasks: status.longTasks,
    swapHeldMs: status.swapHeldMs,
    bytesBeforeFirstFrame: bytes.atFirstFrame,
    bytesAtDetail: detailMs === null ? null : bytesAt(bytes, detailMs),
    errors: [...errors, ...(status.failed ? [status.failed] : [])],
  };
  await context.close();
  return result;
}

const median = values => {
  const present = values.filter(value => value !== null && value !== undefined).sort((first, second) => first - second);
  return present.length ? present[Math.floor(present.length / 2)] : null;
};

async function runMatrix(browser, options) {
  const rows = [];
  for (const viewportName of options.viewports) {
    for (const conditionName of options.conditions) {
      const runs = [];
      for (let run = 0; run < options.runs; run++) runs.push(await measureOnce(browser, options, viewportName, conditionName));
      const summary = {
        build: options.label,
        viewport: viewportName,
        condition: CONDITIONS[conditionName].label,
        mode: runs[0].mode,
        runs: runs.length,
        cpuSlowdown: options.cpu,
        posterEndMs: median(runs.map(run => run.posterEndMs)),
        lcpMs: median(runs.map(run => run.lcpMs)),
        layoutShift: median(runs.map(run => run.layoutShift)),
        firstFrameMs: median(runs.map(run => run.firstFrameMs)),
        firstFrameRangeMs: [Math.min(...runs.map(run => run.firstFrameMs ?? Infinity)), Math.max(...runs.map(run => run.firstFrameMs ?? 0))],
        detailMs: median(runs.map(run => run.detailMs)),
        swapMs: median(runs.map(run => run.swapMs)),
        swapHeldMs: median(runs.map(run => run.swapHeldMs)),
        swapLongestGapMs: median(runs.map(run => run.swapLongestGapMs)),
        longTasksOver50AfterFirstPaint: runs.map(run => run.longTaskCount),
        longestTaskMs: Math.max(...runs.map(run => run.longestTaskMs)),
        longTasks: runs.map(run => run.longTasks),
        detailRangeMs: [Math.min(...runs.map(run => run.detailMs ?? Infinity)), Math.max(...runs.map(run => run.detailMs ?? 0))],
        bytesBeforeFirstFrame: median(runs.map(run => run.bytesBeforeFirstFrame)),
        bytesAtDetail: median(runs.map(run => run.bytesAtDetail)),
        errors: runs.flatMap(run => run.errors),
      };
      rows.push(summary);
      console.log(JSON.stringify(summary));
    }
  }
  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, `${options.label}.json`), JSON.stringify(rows, null, 2));
  }
}

async function captureStage(page, file) {
  const buffer = await page.screenshot({ clip: await page.evaluate(() => {
    const box = document.querySelector('#stage').getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }) });
  writeFileSync(file, buffer);
  return buffer;
}

async function peakSignalToNoise(firstBuffer, secondBuffer) {
  const [first, second] = await Promise.all([firstBuffer, secondBuffer].map(buffer => sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (first.data.length !== second.data.length) throw new Error('Stills differ in size.');
  let squared = 0;
  for (let index = 0; index < first.data.length; index++) squared += (first.data[index] - second.data[index]) ** 2;
  const meanSquared = squared / first.data.length;
  return meanSquared === 0 ? Infinity : 10 * Math.log10((255 * 255) / meanSquared);
}

// Stills of the first view and the full world at the same pose: capture mode draws exactly the frames the page asks for.
async function captureStills(browser, options) {
  mkdirSync(options.stills, { recursive: true });
  const report = [];
  for (const flightSeconds of [0.5, 2.5, 5]) {
    const { context, page } = await openPage(browser, VIEWPORTS.desktop, CONDITIONS.none);
    await page.goto(`${options.origin}/?capture=1&detail=hold`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__loop?.ready === true, null, { timeout: options.timeoutSeconds * 1000 });
    for (let elapsed = 0; elapsed < flightSeconds - 1e-6; elapsed += 0.05) await page.evaluate(() => window.__loop.step(0.05));
    await page.evaluate(() => window.__loop.step(0));
    await page.waitForTimeout(1500);
    const label = String(flightSeconds).replace('.', '_');
    const before = await captureStage(page, join(options.stills, `before-swap-${label}s.png`));
    const swapState = await page.evaluate(() => window.__loop.releaseDetail());
    await page.evaluate(() => window.__loop.step(0));
    await page.waitForTimeout(500);
    const after = await captureStage(page, join(options.stills, `after-swap-${label}s.png`));
    const psnr = await peakSignalToNoise(before, after);
    report.push({ flightSeconds, swapState, psnrDecibels: Number(psnr.toFixed(2)) });
    console.log(JSON.stringify(report.at(-1)));
    await context.close();
  }
  writeFileSync(join(options.stills, 'psnr.json'), JSON.stringify(report, null, 2));
}

// A CDP screencast of the first 8 s on Fast 4G, encoded with ffmpeg at 960x540 as a preview.
async function recordVideo(browser, options) {
  const frameDirectory = join(options.video, '..', 'frames-temp');
  rmSync(frameDirectory, { recursive: true, force: true });
  mkdirSync(frameDirectory, { recursive: true });
  const { context, page, session } = await openPage(browser, VIEWPORTS.desktop, CONDITIONS.fast4g);
  const frames = [];
  session.on('Page.screencastFrame', async event => {
    frames.push({ at: event.metadata.timestamp, data: event.data });
    await session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 960, maxHeight: 540, everyNthFrame: 1 });
  await page.goto(`${options.origin}/`, { waitUntil: 'commit' });
  await page.waitForTimeout(8000);
  await session.send('Page.stopScreencast');
  await context.close();
  const lines = [];
  frames.forEach((frame, index) => {
    const name = `frame-${String(index).padStart(5, '0')}.jpg`;
    writeFileSync(join(frameDirectory, name), Buffer.from(frame.data, 'base64'));
    const duration = index + 1 < frames.length ? frames[index + 1].at - frame.at : 0.05;
    lines.push(`file '${name}'`, `duration ${Math.max(duration, 0.01).toFixed(4)}`);
  });
  lines.push(`file 'frame-${String(frames.length - 1).padStart(5, '0')}.jpg'`);
  writeFileSync(join(frameDirectory, 'list.txt'), lines.join('\n'));
  const encoded = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', join(frameDirectory, 'list.txt'), '-vf', 'scale=960:540,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '30', '-preset', 'medium', '-movflags', '+faststart', options.video], { encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error(`ffmpeg failed: ${encoded.stderr.slice(-400)}`);
  rmSync(frameDirectory, { recursive: true, force: true });
  console.log(JSON.stringify({ video: options.video, frames: frames.length, bytes: statSync(options.video).size }));
}

const options = parseArguments(process.argv.slice(2));
const { server, origin } = options.remoteOrigin ? { server: null, origin: options.remoteOrigin } : await startServer(options.dist);
options.origin = origin;
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: GPU_ARGUMENTS });
try {
  if (options.stills) await captureStills(browser, options);
  else if (options.video) await recordVideo(browser, options);
  else await runMatrix(browser, options);
} finally {
  await browser.close();
  server?.close();
}

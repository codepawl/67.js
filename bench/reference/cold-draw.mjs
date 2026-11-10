// Splits the first path traced draw of a fresh page into phases (issue #861). One fresh browser page per run, so nothing is warm.
//   node bench/reference/cold-draw.mjs <scene id or recipe.json> [--runs 1] [--width 960] [--height 540]
// Run it behind the GPU lock (the card is held for minutes), for example with GPU_LOCK_WEIGHT=heavy.
import { readFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const sceneId = argumentsGiven[0];
const valueAfter = (flag, fallback) => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const runs = Number(valueAfter('--runs', 1));
const options = { width: Number(valueAfter('--width', 960)), height: Number(valueAfter('--height', 540)), bounces: 8, denoise: false, maxSeconds: 1800 };
const source = sceneId.endsWith('.json') ? JSON.parse(await readFile(sceneId, 'utf8')) : sceneId;

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
try {
  for (let run = 0; run < runs; run++) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', error => console.log('PAGE ERROR', error.message));
    page.setDefaultTimeout(0);
    await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
    await page.waitForFunction(() => window.profileColdFirstDraw, null, { timeout: 180000 });
    const result = await page.evaluate(([scene, tracerOptions]) => window.profileColdFirstDraw(scene, tracerOptions), [source, options]);
    console.log(JSON.stringify(result));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

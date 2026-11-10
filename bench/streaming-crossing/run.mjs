// Crosses the streamed tile world in headless Chrome and records frame time, long tasks and resident bytes:
//   npm run benchmark:streaming [-- --cpu] [--out <folder>] [--label <name>] [--speed <units per second>] [--no-sheet]
// --cpu uses SwiftShader. Writes crossing.json (numbers) and crossing-sheet.png (eight frames along the path) to --out.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { requirePlayerSpeed } from './world.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const flags = process.argv.slice(2);
function flagValue(name, fallback) {
  const index = flags.indexOf(name);
  return index >= 0 ? flags[index + 1] : fallback;
}
const useCpu = flags.includes('--cpu');
const outputFolder = resolve(flagValue('--out', 'artifacts/776'));
const label = flagValue('--label', useCpu ? 'swiftshader' : 'gpu');
const speedText = flagValue('--speed', '30');
const speed = speedText === undefined || speedText.trim() === '' ? Number.NaN : Number(speedText);
requirePlayerSpeed(speed, '--speed (units per second, for example 30)');
const withSheet = !flags.includes('--no-sheet');

const browserArguments = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', '--enable-precise-memory-info'];
browserArguments.push(...(useCpu ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu']));

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = `http://localhost:${server.httpServer.address().port}/bench/streaming-crossing/harness.html`;

async function crossOnce(options) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: browserArguments });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('favicon.ico')) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(url, { timeout: 180000 });
    await page.waitForFunction(() => window.runCrossing);
    const result = await page.evaluate(settings => window.runCrossing(settings), options);
    if (errors.length) throw new Error(errors.join('\n'));
    return result;
  } finally {
    await browser.close();
  }
}

try {
  await mkdir(outputFolder, { recursive: true });
  const world = { playerSpeed: speed };
  const measured = await crossOnce({ world });
  const report = { label, backend: useCpu ? 'swiftshader' : 'gpu', cpuCount: (await import('node:os')).cpus().length, ...measured };
  if (withSheet) {
    const picture = await crossOnce({ world, sheet: true });
    await writeFile(resolve(outputFolder, `crossing-sheet-${label}.png`), Buffer.from(picture.sheet.split(',')[1], 'base64'));
  }
  await writeFile(resolve(outputFolder, `crossing-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await server.close();
}

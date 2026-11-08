// Draws the soft sun, soft area light shadow and IES cases and writes a still and a frame time for each.
// node bench/lighting/soft-lights.mjs [--root=<source tree>] [--out=<folder>] [--rounds=N] [--size=WIDTHxHEIGHT]
// --root draws another checkout's src (for example `git archive origin/main` unpacked in a temporary folder),
// which is how the default pictures are compared byte for byte with main; its cases that need the new code are skipped.
import { constants, setPriority } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE_LOAD_TIMEOUT = 60000;
const argumentValue = (name, fallback) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const root = resolve(argumentValue('root', '.'));
const outputFolder = resolve(argumentValue('out', 'artifacts/soft-lights'));
const rounds = Number(argumentValue('rounds', 3));
const [width, height] = argumentValue('size', '480x270').split('x').map(Number);

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${serverUrl}/bench/lighting/soft-lights.html`, { timeout: PAGE_LOAD_TIMEOUT });
  await page.waitForFunction(() => window.drawCase, null, { timeout: PAGE_LOAD_TIMEOUT });
  const hasLightShapes = await page.evaluate(() => window.hasLightShapes);
  const names = (await page.evaluate(() => window.caseNames)).filter(name => hasLightShapes || !/area-shadow|spot-ies|sun-soft/.test(name));
  await mkdir(outputFolder, { recursive: true });
  const medians = new Map(names.map(name => [name, []]));
  const hashes = {};
  for (let round = 0; round < rounds; round++) {
    for (const name of round % 2 === 0 ? names : [...names].reverse()) {
      const result = await page.evaluate(caseName => window.drawCase(caseName), name);
      if (result.glError !== 0) throw new Error(`${name}: GL error ${result.glError}`);
      medians.get(name).push(result.medianMilliseconds);
      const png = Buffer.from(result.image, 'base64');
      hashes[name] = createHash('sha256').update(png).digest('hex').slice(0, 16);
      await writeFile(resolve(outputFolder, `${name}.png`), png);
    }
  }
  const summary = {};
  for (const [name, values] of medians) {
    const sorted = [...values].sort((first, second) => first - second);
    summary[name] = { medianMilliseconds: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)), rangeMilliseconds: [sorted[0], sorted.at(-1)].map(value => Number(value.toFixed(3))), hash: hashes[name] };
  }
  console.log(JSON.stringify({ size: [width, height], rounds, summary }, null, 1));
} finally {
  await browser.close();
  await server.close();
}

// Render the pictures and loops of the documentation from its own live examples, so they always match the code.
// Usage: node scripts/render-doc-media.mjs [page-id ...]
// Each live example with `poster=<name>` becomes public/docs-media/<name>.webp. When the page also shows
// /docs-media/<name>.webm and the example has `loop=<seconds>`, the example is stepped frame by frame into that WebM.
// Needs Google Chrome and FFmpeg on the PATH (or ~/.local/bin/ffmpeg.exe on Windows).
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const outputFolder = join(root, 'public', 'docs-media');
const framesPerSecond = 30;

function ffmpegPath() {
  const local = join(homedir(), '.local', 'bin', 'ffmpeg.exe');
  return existsSync(local) ? local : 'ffmpeg';
}

async function pagesToRender() {
  const requested = process.argv.slice(2);
  const files = await readdir(join(root, 'docs', 'learn'));
  const pages = files.filter(file => file.endsWith('.md')).map(file => file.slice(0, -3));
  return requested.length ? pages.filter(page => requested.includes(page)) : pages;
}

async function examplesOf(page) {
  const text = await readFile(join(root, 'docs', 'learn', `${page}.md`), 'utf8');
  const examples = [];
  for (const match of text.matchAll(/^```js live([^\n]*)$/gm)) {
    const options = Object.fromEntries(match[1].trim().split(/\s+/).filter(Boolean).map(flag => flag.split('=')));
    if (!options.poster) continue;
    const wantsLoop = text.includes(`/docs-media/${options.poster}.webm`);
    examples.push({ poster: options.poster, loopSeconds: wantsLoop ? Number(options.loop) : 0 });
  }
  return examples;
}

async function stagePicture(stage) {
  return stage.screenshot({ type: 'png' });
}

async function writeStill(stage, name) {
  const picture = await stagePicture(stage);
  await sharp(picture).webp({ quality: 82 }).toFile(join(outputFolder, `${name}.webp`));
}

async function writeLoop(stage, frame, name, seconds) {
  const frameCount = Math.round(seconds * framesPerSecond);
  const step = seconds * 1000 / frameCount;
  const folder = await mkdtemp(join(tmpdir(), 'docs-loop-'));
  try {
    for (let index = 0; index < frameCount; index++) {
      await frame.evaluate(milliseconds => window.__advance(milliseconds), step);
      await writeFile(join(folder, `${String(index).padStart(4, '0')}.png`), await stagePicture(stage));
    }
    const result = spawnSync(ffmpegPath(), [
      '-y', '-loglevel', 'error', '-framerate', String(framesPerSecond), '-i', join(folder, '%04d.png'),
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-pix_fmt', 'yuv420p', '-row-mt', '1',
      join(outputFolder, `${name}.webm`),
    ], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`FFmpeg failed for ${name}.`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function renderPage(browserPage, origin, page) {
  const examples = await examplesOf(page);
  if (!examples.length) return [];
  await browserPage.goto(`${origin}/docs.html?capture#${page}`);
  await browserPage.waitForSelector('.live-example');
  const written = [];
  for (const example of examples) {
    const root = browserPage.locator(`.live-example[data-media="${example.poster}"]`);
    await root.scrollIntoViewIfNeeded();
    await root.evaluate(element => element.liveExample.run());
    await browserPage.waitForFunction(name => document.querySelector(`.live-example[data-media="${name}"]`)?.dataset.ready === 'true', example.poster, { timeout: 30000 });
    const error = await root.locator('.live-status[data-kind=error]').count();
    if (error) throw new Error(`${page}/${example.poster}: ${await root.locator('.live-status').textContent()}`);
    const frame = await (await root.locator('iframe').elementHandle()).contentFrame();
    const stage = root.locator('.live-stage');
    // Let the first frames reach the screen. A loop draws only when the virtual clock advances.
    await frame.evaluate(() => window.__advance(0));
    await browserPage.waitForTimeout(400);
    if (example.loopSeconds) {
      await writeLoop(stage, frame, example.poster, example.loopSeconds);
      written.push(`${example.poster}.webm`);
    }
    await writeStill(stage, example.poster);
    written.push(`${example.poster}.webp`);
    await root.evaluate(element => element.liveExample.stop());
  }
  return written;
}

await mkdir(outputFolder, { recursive: true });
const server = await createServer({ root, configFile: join(root, 'vite.config.js'), logLevel: 'error', server: { port: 0, host: '127.0.0.1', watch: null } });
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  channel: 'chrome',
  // Without a backend for macOS, Chrome falls back to SwiftShader there (issue #507).
  args: [process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const browserPage = await context.newPage();
  browserPage.on('pageerror', error => console.error(`Page error: ${error.message}`));
  for (const page of await pagesToRender()) {
    const written = await renderPage(browserPage, origin, page);
    if (written.length) console.log(`${page}: ${written.join(', ')}`);
  }
} finally {
  await browser.close();
  await server.close();
}

// The real-time path tracer (issue #624): frame time with an orbiting camera, the resting frame after one second, a camera move.
//   [GPU_LOCK="bash <path to gpu-lock.sh>"] ${GPU_LOCK} node bench/realtime-tracer/run.mjs <output directory> <scene id or recipe.json>,...
//     [--mode time|rest|move|all] [--frames 200] [--width 1920] [--height 1080] [--bounces 2] [--repetitions 3]
// Files: <scene>@realtime-rest.png, <scene>@move-<n>.png and timings.json. bench/realtime-tracer/score.py scores the
// resting frames against Cycles, and bench/realtime-tracer/sheet.py puts a camera move on one contact sheet.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const outputDirectory = resolve(argumentsGiven[0]);
const sceneIds = argumentsGiven[1].split(',');
const valueAfter = (flag, fallback) => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : fallback);
const mode = valueAfter('--mode', 'all');
const frames = Number(valueAfter('--frames', 200));
const repetitions = Number(valueAfter('--repetitions', 3));
const options = { width: Number(valueAfter('--width', 1920)), height: Number(valueAfter('--height', 1080)), bounces: Number(valueAfter('--bounces', 2)), resolutionDivisor: Number(valueAfter('--divisor', 2)) };
const recipeName = id => id.replace(/^.*[\/]/, '').replace(/\.recipe\.json$|\.json$/, '');

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, fs: { strict: false } }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'] });
const timings = {};
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('PAGE CONSOLE', message.text()); });
  page.setDefaultTimeout(0);
  await page.goto(`${serverUrl}/bench/reference/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.loadTraceSceneFor, null, { timeout: 180000 });
  await page.addScriptTag({ type: 'module', url: '/bench/realtime-tracer/page.js' });
  await page.waitForFunction(() => window.measureRealtimeFrames, null, { timeout: 60000 });
  for (const id of sceneIds) {
    const name = id.endsWith('.json') ? recipeName(id) : id;
    const source = id.endsWith('.json') ? JSON.parse(await readFile(id, 'utf8')) : id;
    if (mode === 'time' || mode === 'all') {
      for (const degreesPerFrame of [0.5, 0]) {
        const label = degreesPerFrame ? 'orbit' : 'rest';
        const runs = [];
        for (let repetition = 0; repetition < repetitions; repetition++) runs.push(await page.evaluate(([scene, tracerOptions, count, step]) => window.measureRealtimeFrames(scene, tracerOptions, count, step), [source, options, frames, degreesPerFrame]));
        timings[`${name}:${label}`] = { medians: runs.map(run => Number(run.medianMilliseconds.toFixed(2))), compileSeconds: runs.map(run => Number(run.compileSeconds.toFixed(2))), gpu: runs[0].gpu };
        console.log(name, label, JSON.stringify(timings[`${name}:${label}`]));
      }
    }
    if (mode === 'rest' || mode === 'all') {
      const rest = await page.evaluate(([scene, tracerOptions]) => window.renderRestingFrame(scene, tracerOptions, 1), [source, options]);
      await writeFile(`${outputDirectory}/${name}@realtime-rest.png`, Buffer.from(rest.image, 'base64'));
      timings[`${name}:rest-frame`] = { frames: rest.frames, seconds: Number(rest.elapsedSeconds.toFixed(2)) };
      console.log(name, 'resting frame', JSON.stringify(timings[`${name}:rest-frame`]));
    }
    if (mode === 'move' || mode === 'all') {
      const images = await page.evaluate(([scene, tracerOptions]) => window.renderCameraMove(scene, tracerOptions), [source, options]);
      for (const [index, image] of images.entries()) await writeFile(`${outputDirectory}/${name}@move-${index + 1}.png`, Buffer.from(image, 'base64'));
      console.log(name, 'camera move', images.length, 'frames');
    }
  }
} finally {
  await browser.close();
  await server.close();
}
let previous = {};
try {
  previous = JSON.parse(await readFile(`${outputDirectory}/timings.json`, 'utf8'));
} catch {
  // first run in this directory
}
await writeFile(`${outputDirectory}/timings.json`, JSON.stringify({ ...previous, ...timings }, null, 1));

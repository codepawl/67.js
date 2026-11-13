// The default look bench (issue #988): bare scenes drawn by 67js and by three.js, each at its own defaults, scored against Cycles with FLIP.
//   npm run reference -- --default-look [--skip-blender] [--scene <id>,<id>]
// --skip-blender scores against the Cycles images already committed in bench/reference/default-look/ instead of rendering them again.
// Writes bench/reference/default-look.json, bench/reference/default-look/<scene>-cycles.png (the reference) and <scene>-sheet.jpg (all looks side by side).
// Nothing in src/ changes and no default changes: this only measures.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { buildReport, scoreTable } from './default-look-report.mjs';
import { DEFAULT_LOOK_VARIANTS, IMAGE_HEIGHT, IMAGE_WIDTH } from './default-look-variants.js';

const SCENE_IDS = ['shapes', 'corner', 'material-row', 'colonnade'];
const CYCLES_SAMPLES = 128;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BLENDER = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const PAGE_LOAD_TIMEOUT = 180000;
const GPU_ARGUMENTS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu', '--disable-renderer-backgrounding'];

function runChecked(command, commandArguments, environment = {}) {
  const result = spawnSync(command, commandArguments, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...environment } });
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}.`);
  return result.stdout;
}

async function drawScenes(serverUrl, sceneIds, workDirectory) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: GPU_ARGUMENTS });
  const graphics = {};
  try {
    // The Blender description comes from the reference harness, which builds the same scenes.
    const describePage = await browser.newPage({ viewport: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT } });
    await describePage.goto(`${serverUrl}/bench/reference/harness.html?set=defaultlook`, { timeout: PAGE_LOAD_TIMEOUT });
    await describePage.waitForFunction(() => window.renderReferenceScene, null, { timeout: PAGE_LOAD_TIMEOUT });
    for (const sceneId of sceneIds) {
      const result = await describePage.evaluate(id => window.renderReferenceScene(id, { describe: true }), sceneId);
      await writeFile(`${workDirectory}/scenes/${sceneId}.json`, JSON.stringify(result.description));
    }
    await describePage.close();

    for (const sceneId of sceneIds) {
      for (const variantName of Object.keys(DEFAULT_LOOK_VARIANTS)) {
        const page = await browser.newPage({ viewport: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${serverUrl}/bench/reference/default-look.html`, { timeout: PAGE_LOAD_TIMEOUT });
        await page.waitForFunction(() => window.renderDefaultLook, null, { timeout: PAGE_LOAD_TIMEOUT });
        const result = await page.evaluate(([id, name]) => window.renderDefaultLook(id, name), [sceneId, variantName]);
        if (errors.length > 0) throw new Error(`${sceneId} ${variantName}: ${errors.join('; ')}`);
        await writeFile(`${workDirectory}/${sceneId}-${variantName}.png`, Buffer.from(result.image, 'base64'));
        graphics.page = await page.evaluate(() => navigator.userAgent);
        await page.close();
        console.log(`${sceneId} ${variantName} drawn`);
      }
    }
  } finally {
    await browser.close();
  }
  return graphics;
}

export async function runDefaultLook(argumentsGiven) {
  const sceneFlag = argumentsGiven.indexOf('--scene');
  const sceneIds = sceneFlag >= 0 ? argumentsGiven[sceneFlag + 1].split(',') : SCENE_IDS;
  const skipBlender = argumentsGiven.includes('--skip-blender');
  const workDirectory = resolve('artifacts/reference-default-look');
  const outputDirectory = resolve('bench/reference');
  await mkdir(`${workDirectory}/scenes`, { recursive: true });
  await mkdir(`${outputDirectory}/default-look`, { recursive: true });

  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  try {
    await drawScenes(`http://127.0.0.1:${server.httpServer.address().port}`, sceneIds, workDirectory);
  } finally {
    await server.close();
  }

  if (!skipBlender) {
    runChecked(BLENDER, ['-b', '--factory-startup', '-t', '6', '--python', 'bench/reference/render-blender.py', '--', workDirectory, ...sceneIds], {
      REFERENCE_WIDTH: String(IMAGE_WIDTH), REFERENCE_HEIGHT: String(IMAGE_HEIGHT), REFERENCE_CYCLES_SAMPLES: String(CYCLES_SAMPLES),
    });
  }

  const scoreOutput = runChecked('uv', [
    'run', '--no-project', '--python', '3.12', '--with', 'flip-evaluator', '--with', 'pillow', '--with', 'numpy',
    'python', '-I', 'bench/reference/default-look-score.py', workDirectory, `${outputDirectory}/default-look`, sceneIds.join(','), Object.keys(DEFAULT_LOOK_VARIANTS).join(','),
  ]);
  const scores = JSON.parse(scoreOutput.trim().split('\n').at(-1));
  const report = buildReport({
    scores,
    variants: DEFAULT_LOOK_VARIANTS,
    generatedBy: 'npm run reference -- --default-look',
    settings: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, cyclesSamples: CYCLES_SAMPLES, pixelRatio: 1, reference: 'Blender Cycles, view transform applied as 67js applies it (ACES fit, gamma 2.2), 8 bit' },
  });
  const isFullRun = sceneIds.length === SCENE_IDS.length && SCENE_IDS.every((sceneId) => sceneIds.includes(sceneId));
  // A --scene subset must not replace the committed four-scene report, so it goes to the work directory.
  const reportPath = isFullRun ? `${outputDirectory}/default-look.json` : `${workDirectory}/default-look-subset.json`;
  await writeFile(reportPath, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`Report: ${reportPath}`);
  console.log(scoreTable(report));
  console.log(report.proposals.length === 0 ? 'No default change wins on three scenes.' : `Proposals: ${report.proposals.map(({ challenger, wins }) => `${challenger} (${wins.join(', ')})`).join('; ')}`);
}

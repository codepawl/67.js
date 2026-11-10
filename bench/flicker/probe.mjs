// Drives the flicker viewer in headless Chrome on the GPU and prints how many pixels flicker at each camera spot.
//   node bench/flicker/probe.mjs --url http://127.0.0.1:5210 --asset /@fs/D:/path/file.glb --out artifacts/flicker \
//        --spots spots.json --configs "reversed=1,nearFit=1;reversed=0,nearFit=0"
// spots.json: [{ "name": "roofs", "eye": [x, y, z], "target": [x, y, z] }]. Without --spots it prints the scene bounds and exits.
//   node bench/flicker/probe.mjs --traps --configs "reversed=1;reversed=0"   runs every trap scene of traps.js with its own camera.
// Add --assert to exit with code 1 when any trap shows a swapped pixel with the flush pass on (configs without offset=0).
// Each result also carries `truth`, the ground-truth probe of ground-truth.js: the render compared with a float64 ray cast that
// cannot z-fight. `swapped` is the count that matters (a pixel showing the colour of a face behind the visible one), `tied` the
// pixels where the scene itself names no winner (exact coplanar faces with the flush pass off, `offset=0`), and `wrong` also holds
// shading steps within a face. A glTF needs `ids=1` (flat colour per part) or `facets=1` (per triangle) for the truth to read colours.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { failingTraps } from './verdict.js';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baseUrl = argument('url', 'http://127.0.0.1:5210');
const asset = argument('asset');
const outputFolder = argument('out', 'artifacts/flicker');
const spotsFile = argument('spots');
const [width, height] = argument('viewport', '1920x1080').split('x').map(Number);
const configurations = argument('configs', 'reversed=1,nearFit=1').split(';').map(text => Object.fromEntries(text.split(',').map(pair => pair.split('='))));
const prefix = argument('prefix', 'view');
mkdirSync(outputFolder, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.setDefaultTimeout(240000);
page.on('pageerror', error => console.error('pageerror', error.message));
page.on('console', message => { if (message.type() === 'error') console.error('console', message.text()); });
const results = [];

async function open(configuration, trap = null) {
  const query = new URLSearchParams({ ...(trap ? { trap } : { asset }), ...configuration });
  await page.goto(`${baseUrl}/bench/flicker/index.html?${query}`);
  await page.evaluate(() => window.flicker.ready);
}

async function probeTraps() {
  for (const configuration of configurations) {
    const label = Object.entries(configuration).map(([key, value]) => `${key}${value}`).join('-');
    await open(configuration, 'plaque-2m');
    for (const trap of await page.evaluate(() => window.flicker.traps)) {
      await open(configuration, trap);
      await page.waitForTimeout(300);
      const outcome = await page.evaluate(async () => ({ probe: await window.flicker.probe(), info: window.flicker.info, truth: await window.flicker.truth() }));
      await page.screenshot({ path: path.join(outputFolder, `${prefix}-${trap}-${label}.png`) });
      results.push({ trap, configuration: label, clear: outcome.probe.clearOfEdges, changed: outcome.probe.changed, moved: outcome.probe.totalChanged, truth: outcome.truth, ...(outcome.probe.open === undefined ? {} : { open: outcome.probe.open }), depth: outcome.info.depthMode });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  writeFileSync(path.join(outputFolder, `${prefix}-results.json`), JSON.stringify(results, null, 1));
  if (process.argv.includes('--assert')) {
    const failures = failingTraps(results);
    console.log(failures.length === 0 ? 'assert: no swapped pixels with the flush pass on' : `assert: FAILED ${JSON.stringify(failures)}`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

try {
  if (process.argv.includes('--traps')) {
    await probeTraps();
  } else if (!spotsFile) {
    await open(configurations[0]);
    console.log(JSON.stringify(await page.evaluate(() => window.flicker.info), null, 1));
  } else {
    const spots = JSON.parse(readFileSync(spotsFile, 'utf8'));
    for (const configuration of configurations) {
      await open(configuration);
      await page.waitForTimeout(1500);
      console.log(JSON.stringify({ flush: await page.evaluate(() => window.flicker.info.flush) }));
      const label = Object.entries(configuration).map(([key, value]) => `${key}${value}`).join('-');
      for (const spot of spots) {
        const outcome = await page.evaluate(async ({ eye, target }) => {
          window.flicker.setCamera({ eye, target });
          window.flicker.render();
          const probe = await window.flicker.probe();
          const truth = await window.flicker.truth();
          return { probe, truth, info: window.flicker.info };
        }, spot);
        await page.screenshot({ path: path.join(outputFolder, `${prefix}-${spot.name}-${label}.png`) });
        results.push({ spot: spot.name, moved: outcome.probe.totalChanged, configuration: label, truth: outcome.truth, clear: outcome.probe.clearOfEdges, changed: outcome.probe.changed, fraction: outcome.probe.fraction, depth: outcome.info.depthMode, near: outcome.info.near, far: outcome.info.far });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
    writeFileSync(path.join(outputFolder, `${prefix}-results.json`), JSON.stringify(results, null, 1));
  }
} finally {
  await browser.close();
}

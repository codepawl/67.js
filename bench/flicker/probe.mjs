// Drives the flicker viewer in headless Chrome on the GPU and prints how many pixels flicker at each camera spot.
//   node bench/flicker/probe.mjs --url http://127.0.0.1:5210 --asset /@fs/D:/path/file.glb --out artifacts/flicker \
//        --spots spots.json --configs "reversed=1,nearFit=1;reversed=0,nearFit=0"
// spots.json: [{ "name": "roofs", "eye": [x, y, z], "target": [x, y, z] }]. Without --spots it prints the scene bounds and exits.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

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

async function open(configuration) {
  const query = new URLSearchParams({ asset, ...Object.fromEntries(Object.entries(configuration).map(([key, value]) => [key, value])) });
  await page.goto(`${baseUrl}/bench/flicker/index.html?${query}`);
  await page.evaluate(() => window.flicker.ready);
}

try {
  if (!spotsFile) {
    await open(configurations[0]);
    console.log(JSON.stringify(await page.evaluate(() => window.flicker.info), null, 1));
  } else {
    const spots = JSON.parse(readFileSync(spotsFile, 'utf8'));
    for (const configuration of configurations) {
      await open(configuration);
      await page.waitForTimeout(1500);
      const label = Object.entries(configuration).map(([key, value]) => `${key}${value}`).join('-');
      for (const spot of spots) {
        const outcome = await page.evaluate(async ({ eye, target }) => {
          window.flicker.setCamera({ eye, target });
          window.flicker.render();
          const probe = await window.flicker.probe();
          return { probe, info: window.flicker.info };
        }, spot);
        await page.screenshot({ path: path.join(outputFolder, `${prefix}-${spot.name}-${label}.png`) });
        results.push({ spot: spot.name, moved: outcome.probe.totalChanged, configuration: label, changed: outcome.probe.changed, fraction: outcome.probe.fraction, depth: outcome.info.depthMode, near: outcome.info.near, far: outcome.info.far });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
    writeFileSync(path.join(outputFolder, `${prefix}-results.json`), JSON.stringify(results, null, 1));
  }
} finally {
  await browser.close();
}

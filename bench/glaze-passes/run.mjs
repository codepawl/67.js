// Times each Glaze pass on the GPU for scene files: node bench/glaze-passes/run.mjs <out.json> <scene-directory>[,<scene-directory>...] [whole]
// Add '"capture":true' to the overrides to write one full frame per scene to <out.json>.<scene>.rgba (compare two with diff-frames.mjs).
// A scene directory holds scene.json, scene.glb and sky.hdr as written for the Blender demo scenes (see src/file-scene.js).
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// The fourth argument is JSON merged into the page options, e.g. '{"width":64,"height":36,"rendererOverrides":{"samples":1}}'.
const [outputFile, directoryList, mode = 'segmented', overridesJson = '{}'] = process.argv.slice(2);
const overrides = JSON.parse(overridesJson);
if (!outputFile || !directoryList) throw new Error('Pass an output file and a comma separated list of scene directories.');

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-renderer-backgrounding', '--enable-webgl-developer-extensions'],
});
const results = {};
try {
  for (const directory of directoryList.split(',').map(entry => resolve(entry))) {
    const description = JSON.parse(await readFile(`${directory}/scene.json`, 'utf8'));
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', error => console.error('page error:', error.message));
    await page.route('**/__scene/**', async (route, request) => {
      const name = new URL(request.url()).pathname.split('/').pop();
      await route.fulfill({ path: `${directory}/${name}` });
    });
    await page.goto(`${serverUrl}/bench/glaze-passes/harness.html`);
    await page.waitForFunction(() => window.harnessReady, null, { timeout: 120000 });
    results[basename(directory)] = await page.evaluate(
      options => window.measureScene(options),
      { description, glbUrl: `/__scene/${description.glb}`, hdriUrl: `/__scene/${description.hdri}`, segmented: mode !== 'whole', ...overrides },
    );
    const { capturedFrame, ...summary } = results[basename(directory)];
    if (capturedFrame) {
      await writeFile(`${outputFile}.${basename(directory)}.rgba`, Buffer.from(capturedFrame, 'base64'));
      delete results[basename(directory)].capturedFrame;
    }
    console.log(basename(directory), JSON.stringify(summary));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
await writeFile(outputFile, JSON.stringify(results, null, 2));

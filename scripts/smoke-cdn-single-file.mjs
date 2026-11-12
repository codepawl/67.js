// Proves that the packed npm tarball serves a cube from one script tag with no failed request.
// Usage: node scripts/smoke-cdn-single-file.mjs <tarball> [--published-url <url>]
// It unpacks the tarball, serves its package folder under a jsdelivr-like path, loads a page with a single
// <script type="module"> and reads the pixels. With --published-url it loads that real URL instead of the local one.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const tarball = process.argv[2];
const urlFlag = process.argv.indexOf('--published-url');
const publishedUrl = urlFlag > 0 ? process.argv[urlFlag + 1] : null;
const version = JSON.parse(await readFile('package.json', 'utf8')).version;

let moduleUrl = publishedUrl;
let server;
if (!publishedUrl) {
  assert.ok(tarball, 'Pass the packed tarball path.');
  const unpacked = await mkdtemp(join(tmpdir(), '67js-cdn-'));
  const extracted = spawnSync('tar', ['-xzf', resolve(tarball), '-C', unpacked], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const packageFolder = join(unpacked, 'package');
  const mountPath = `/npm/@codepawlhq/67js@${version}/`;
  const standalone = await readFile(join(packageFolder, 'build/67.standalone.js'));
  console.log(`standalone bytes=${standalone.length} gzip=${gzipSync(standalone, { level: 9 }).length}`);
  server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const relative = path.startsWith(mountPath) ? path.slice(mountPath.length) : null;
    const file = relative && !relative.includes('..') ? join(packageFolder, relative) : null;
    if (!file || !existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream', 'access-control-allow-origin': '*' });
    response.end(await readFile(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  moduleUrl = `http://127.0.0.1:${server.address().port}${mountPath}build/67.standalone.js`;
}

const page = `<!doctype html><canvas id="view" width="320" height="240"></canvas>
<script type="module">
  import { Renderer67, box } from ${JSON.stringify(moduleUrl)};
  const parts = [{ name: 'Cube', geometry: box(), matrix: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), material: { color: [0.8, 0.3, 0.2], metallic: 0, roughness: 0.4, emission: 0 } }];
  const renderer = new Renderer67(document.querySelector('#view'), parts, { samples: 4 });
  renderer.render({ eye: [2.5, 2, 3.5], target: [0, 0, 0] });
  const context = renderer.context;
  const pixels = new Uint8Array(320 * 240 * 4);
  context.readPixels(0, 0, 320, 240, context.RGBA, context.UNSIGNED_BYTE, pixels);
  let lit = 0;
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 100 && pixels[index + 2] < 120) lit++;
  window.__result = { lit };
</script>`;

const pageServer = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(page); });
await new Promise((done) => pageServer.listen(0, '127.0.0.1', done));
const chromePath = process.env.CHROME_PATH;
const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan'],
});
try {
  const tab = await browser.newPage();
  const requests = [];
  const failures = [];
  const errors = [];
  tab.on('response', (response) => { requests.push(`${response.status()} ${response.url()}`); if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  tab.on('requestfailed', (request) => failures.push(`failed ${request.url()} ${request.failure()?.errorText}`));
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${pageServer.address().port}/`);
  await tab.waitForFunction(() => window.__result, null, { timeout: 30000 });
  const { lit } = await tab.evaluate(() => window.__result);
  console.log(`requests=${requests.length}`);
  for (const line of requests) console.log(line);
  console.log(`lit cube pixels=${lit} failures=${failures.length} pageErrors=${errors.length}`);
  assert.ok(lit > 500, 'The cube must cover visible pixels.');
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
  const scriptRequests = requests.filter((line) => line.includes('.js')).length;
  console.log(`script requests=${scriptRequests}`);
  if (!publishedUrl) assert.equal(scriptRequests, 1, 'Only the one module file may load.');
  console.log('cdn single file smoke passed');
} finally {
  await browser.close();
  pageServer.close();
  server?.close();
}

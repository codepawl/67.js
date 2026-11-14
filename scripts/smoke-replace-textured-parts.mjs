import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Builds a renderer with one plain grey quad, adds a quad whose texture is solid green with replaceParts, renders and
// counts green pixels, then removes it and counts again. The texture must be drawn after the add, gone after the remove,
// and deleted from the GPU. Runs on SwiftShader unless "gpu" is given; start a GPU run through a GPU lock when the card is shared.
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'cpu';
assert.ok(['cpu', 'gpu'].includes(backend));
await mkdir('artifacts', { recursive: true });
const harness = `<!doctype html><html><head><style>html,body{margin:0}</style></head><body><script type="module">
import {CrucibleRenderer} from '/src/renderer.js';
import '/src/replace-textured-parts.js';
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function quad(left, right) {
  return {
    positions: new Float32Array([left,-1,0, right,-1,0, right,1,0, left,1,0]),
    normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]),
    uvs: new Float32Array([0,0, 1,0, 1,1, 0,1]),
    indices: new Uint32Array([0,1,2, 0,2,3]),
  };
}
function solidImage(red, green, blue) {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let index = 0; index < data.length; index += 4) data.set([red, green, blue, 255], index);
  return new ImageData(data, 4, 4);
}
const material = { tag: 'gltf', color: [1, 1, 1], metallic: 0, roughness: 1, emission: 0, emissiveColor: [0, 0, 0] };
const plain = { name: 'plain', geometry: quad(-2, -0.2), matrix: new Float32Array(identity), material: { ...material, color: [0.5, 0.5, 0.5] } };
const map = { image: solidImage(0, 255, 0), colorSpace: 'srgb' };
const textured = { name: 'textured', geometry: quad(0.2, 2), matrix: new Float32Array(identity), material: { ...material, map } };
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 128;
document.body.append(canvas);
const renderer = new CrucibleRenderer(canvas, [plain], { ground: false, shadows: false, samples: 1, pixelRatio: 1, memoryBudgetMiB: 64 });
const context = renderer.context;
const camera = { eye: [0, 0, 6], target: [0, 0, 0] };
function greenPixels() {
  renderer.render(camera);
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 1] > pixels[offset] + 60 && pixels[offset + 1] > pixels[offset + 2] + 60) count++;
  }
  return count;
}
const results = { before: greenPixels(), textureBytesBefore: renderer.textureBytes };
renderer.replaceParts([plain, textured]);
results.afterAdd = greenPixels();
results.textureBytesAdded = renderer.textureBytes;
results.textureLive = context.isTexture(renderer.textures.get(map));
const texture = renderer.textures.get(map);
renderer.replaceParts([plain]);
results.afterRemove = greenPixels();
results.textureBytesRemoved = renderer.textureBytes;
results.textureKept = renderer.textures.has(map);
results.textureDeleted = !context.isTexture(texture);
results.batchesAfterRemove = renderer.batches.length;
window.__replaceTexturedProof = results;
</script></body></html>`;
await writeFile('artifacts/replace-textured-parts-harness.html', harness);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  await server.listen();
  const args = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'];
  if (backend === 'cpu') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args });
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/artifacts/replace-textured-parts-harness.html`);
  await page.waitForFunction(() => window.__replaceTexturedProof, null, { timeout: 60000 });
  const results = await page.evaluate(() => window.__replaceTexturedProof);
  await writeFile(`artifacts/replace-textured-parts-${backend}.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(results.before, 0, 'no green before the textured part exists');
  assert.ok(results.afterAdd > 500, `the added textured part draws green (${results.afterAdd} pixels)`);
  assert.ok(results.textureLive, 'the added texture is a live GPU texture');
  assert.ok(results.textureBytesAdded > results.textureBytesBefore, 'the texture ledger grows on add');
  assert.equal(results.afterRemove, 0, 'the green is gone after the remove');
  assert.equal(results.textureBytesRemoved, results.textureBytesBefore, 'the texture ledger drops back on remove');
  assert.ok(results.textureDeleted && !results.textureKept, 'the removed part texture is deleted from the GPU and the cache');
  assert.equal(results.batchesAfterRemove, 1);
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  await server.close();
}

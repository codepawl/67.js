import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Renders a quad textured with four coloured quadrants, pushes new pixels into one quadrant, renders again and reads the pixels back.
// The region update must match uploading the finished picture whole. Runs on SwiftShader unless "gpu" is given;
// start a GPU run through `bash ~/.agents/tools/gpu-lock.sh`.
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const backend = process.argv[2] ?? 'cpu';
assert.ok(['cpu', 'gpu'].includes(backend));
await mkdir('artifacts', { recursive: true });
const harness = `<!doctype html><html><head><style>html,body{margin:0}</style></head><body><script type="module">
import {CrucibleRenderer} from '/src/renderer.js';
import '/src/texture-update.js';
const SIZE = 64;
const HALF = SIZE / 2;
const quad = {
  positions: new Float32Array([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0]),
  normals: new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]),
  uvs: new Float32Array([0,0, 1,0, 1,1, 0,1]),
  indices: new Uint32Array([0,1,2, 0,2,3]),
};
// Image quadrants, row 0 first: top left red, top right blue, bottom left grey, bottom right white. topLeft replaces the first one.
function quadrantImage(topLeft) {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const top = row < HALF;
      const left = column < HALF;
      const color = top ? (left ? topLeft : [0, 0, 255]) : (left ? [128, 128, 128] : [255, 255, 255]);
      data.set([...color, 255], (row * SIZE + column) * 4);
    }
  }
  return new ImageData(data, SIZE, SIZE);
}
function letter([red, green, blue]) {
  if (green > red + 60 && green > blue + 60) return 'G';
  if (red > green + 60 && red > blue + 60) return 'R';
  if (blue > red + 60 && blue > green + 60) return 'B';
  return red > 200 && green > 200 && blue > 200 ? 'W' : red > 60 ? 'g' : '.';
}
function create(descriptor) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const part = { name: 'quad', geometry: quad, material: { tag: 'gltf', color: [1, 1, 1], metallic: 0, roughness: 1, emission: 0, emissiveColor: [0, 0, 0], map: descriptor },
    matrix: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]) };
  const renderer = new CrucibleRenderer(canvas, [part], { ground: false, shadows: false, samples: 1, pixelRatio: 1, memoryBudgetMiB: 64 });
  const camera = { eye: [0, 0, 6], target: [0, 0, 0] };
  const context = renderer.context;
  const read = () => {
    renderer.render(camera);
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    let checksum = 2166136261;
    for (const value of pixels) checksum = Math.imul(checksum ^ value, 16777619) >>> 0;
    // WebGL rows start at the bottom, so the grid walks rows downward from the top of the screen. Cells are 8 pixels.
    const rows = [];
    for (let row = 15; row >= 0; row--) {
      let line = '';
      for (let column = 0; column < 16; column++) {
        const offset = ((row * 8 + 4) * canvas.width + column * 8 + 4) * 4;
        line += letter(pixels.slice(offset, offset + 3));
      }
      rows.push(line);
    }
    return { checksum, grid: rows.join('|') };
  };
  return { renderer, read, context };
}
const greenRegion = { x: 0, y: 0, width: HALF, height: HALF, data: new Uint8Array(HALF * HALF * 4).map((value, index) => index % 4 === 1 || index % 4 === 3 ? 255 : 0) };
const results = {};
for (const flipY of [false, true]) {
  for (const colorSpace of ['linear', 'srgb']) {
    const descriptor = { image: quadrantImage([255, 0, 0]), colorSpace, flipY };
    const { renderer, read, context } = create(descriptor);
    // Drawing the hand-built quad raises INVALID_OPERATION on its own (not from the update), so errors are drained before each update and read right after it.
    const updateErrors = [];
    const update = argument => {
      while (context.getError() !== 0);
      renderer.updateTexture(descriptor, argument);
      updateErrors.push(context.getError());
    };
    const before = read();
    update({ region: greenRegion });
    const afterRegion = read();
    const baked = create({ image: quadrantImage([0, 255, 0]), colorSpace, flipY });
    const reference = baked.read();
    baked.renderer.dispose();
    update({ image: quadrantImage([0, 255, 0]) });
    const afterImage = read();
    descriptor.image.data.set(quadrantImage([0, 0, 255]).data);
    update();
    const afterSameImage = read();
    results[flipY + '-' + colorSpace] = { before, afterRegion, reference, afterImage, afterSameImage, updateErrors };
    renderer.dispose();
  }
}
window.__textureUpdateProof = results;
</script></body></html>`;
await writeFile('artifacts/texture-update-harness.html', harness);
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
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/artifacts/texture-update-harness.html`);
  await page.waitForFunction(() => window.__textureUpdateProof, null, { timeout: 60000 });
  const results = await page.evaluate(() => window.__textureUpdateProof);
  await writeFile(`artifacts/texture-update-${backend}.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(errors, []);
  const count = (grid, letter) => [...grid].filter(character => character === letter).length;
  for (const [name, result] of Object.entries(results)) {
    assert.deepEqual(result.updateErrors, [0, 0, 0], `${name} update raised WebGL errors`);
    assert.ok(count(result.before.grid, 'R') > 10, `${name} starts with a red quadrant`);
    assert.equal(count(result.before.grid, 'G'), 0, `${name} starts without green`);
    // The red quadrant becomes green and the other quadrants stay put.
    assert.equal(count(result.afterRegion.grid, 'R'), 0, `${name} region update left red behind`);
    assert.equal(count(result.afterRegion.grid, 'G'), count(result.before.grid, 'R'), `${name} region update changed the wrong area`);
    assert.equal(count(result.afterRegion.grid, 'B'), count(result.before.grid, 'B'), `${name} region update touched another quadrant`);
    assert.equal(result.afterRegion.checksum, result.reference.checksum, `${name} region update differs from uploading the same picture whole`);
    assert.equal(result.afterImage.checksum, result.reference.checksum, `${name} whole image update differs from uploading the same picture first`);
    assert.equal(count(result.afterSameImage.grid, 'B'), count(result.before.grid, 'B') + count(result.before.grid, 'R'), `${name} re-upload of the descriptor image`);
  }
  console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.afterRegion.grid]))));
} finally {
  await browser?.close();
  await server.close();
}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
await mkdir('artifacts', { recursive: true });

function checksum(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ result >>> 1 : result >>> 1;
  }
  return (result ^ 0xffffffff) >>> 0;
}

function png(color) {
  const chunk = (type, bytes) => {
    const name = Buffer.from(type);
    const output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length);
    name.copy(output, 4);
    bytes.copy(output, 8);
    output.writeUInt32BE(checksum(Buffer.concat([name, bytes])), output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(16 * 65);
  for (let row = 0; row < 16; row++) {
    for (let column = 0; column < 16; column++) {
      const offset = row * 65 + 1 + column * 4;
      const light = ((row >> 2) + (column >> 2)) % 2 ? [230, 230, 230] : color;
      light.forEach((value, channel) => { pixels[offset + channel] = value; });
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function fixture() {
  const chunks = [];
  const bufferViews = [];
  let length = 0;
  const add = data => {
    const bytes = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(bytes, Buffer.alloc((4 - bytes.length % 4) % 4));
    length += Math.ceil(bytes.length / 4) * 4;
    return view;
  };
  const positions = add(new Float32Array([-0.8, -0.8, 0, 0.8, -0.8, 0, 0.8, 0.8, 0, -0.8, 0.8, 0]));
  const normals = add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const uvs = add(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  const indices = add(new Uint16Array([0, 1, 2, 0, 2, 3]));
  const times = add(new Float32Array([0, 1, 2]));
  const translation = add(new Float32Array([-1.1, 0, 0, -1.1, 0.5, 0, -1.1, 0, 0]));
  const red = add(png([230, 30, 30]));
  const blue = add(png([30, 90, 230]));
  const accessor = (bufferView, componentType, count, type, extra = {}) => ({ bufferView, componentType, count, type, ...extra });
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Red panel', mesh: 0, translation: [-1.1, 0, 0] }, { name: 'Blue panel', mesh: 1, translation: [1.1, 0, 0] }],
    meshes: [0, 1].map(material => ({ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material }] })),
    materials: [0, 1].map(index => ({ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index }, metallicFactor: 0, roughnessFactor: 0.8 } })),
    textures: [{ source: 0 }, { source: 1 }], images: [{ bufferView: red, mimeType: 'image/png' }, { bufferView: blue, mimeType: 'image/png' }],
    animations: [{ name: 'Panel rise', samplers: [{ input: 4, output: 5, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
    accessors: [accessor(positions, 5126, 4, 'VEC3', { min: [-0.8, -0.8, 0], max: [0.8, 0.8, 0] }), accessor(normals, 5126, 4, 'VEC3'), accessor(uvs, 5126, 4, 'VEC2'), accessor(indices, 5123, 6, 'SCALAR'), accessor(times, 5126, 3, 'SCALAR', { min: [0], max: [2] }), accessor(translation, 5126, 3, 'VEC3')],
    bufferViews, buffers: [{ byteLength: length }],
  };
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const binary = Buffer.concat(chunks);
  const output = Buffer.alloc(28 + padded.length + binary.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(output, 20);
  output.writeUInt32LE(binary.length, 20 + padded.length);
  output.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(output, 28 + padded.length);
  return output;
}

await writeFile('artifacts/textured-animation.glb', fixture());
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const errors = [];
const report = {};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/motion.html`);
  await page.waitForFunction(() => window.__scene?.renderer);
  report.motion = await page.evaluate(() => {
    const scene = window.__scene;
    scene.pause();
    const renderer = scene.renderer;
    const context = renderer.context;
    const counts = { buffer: 0, texture: 0, framebuffer: 0, renderbuffer: 0 };
    for (const [key, method] of Object.entries({ buffer: 'createBuffer', texture: 'createTexture', framebuffer: 'createFramebuffer', renderbuffer: 'createRenderbuffer' })) {
      const original = context[method].bind(context);
      context[method] = (...argumentsList) => { counts[key]++; return original(...argumentsList); };
    }
    const pixels = new Uint8Array(4 * renderer.canvas.width * renderer.canvas.height);
    const checksum = () => {
      context.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      let sum = 0;
      for (let index = 0; index < pixels.length; index += 17) sum = (sum * 31 + pixels[index]) >>> 0;
      return sum;
    };
    scene.renderAt(6);
    const first = checksum();
    for (let index = 0; index < 80; index++) scene.renderAt(index * 0.1);
    scene.renderAt(6);
    const repeated = checksum();
    const sampled = window.__motion.scene.sample(6);
    renderer.render({ ...sampled.camera, time: 6, effects: {} });
    const neutral = checksum();
    renderer.render({ ...sampled.camera, time: 6, effects: { bloom: { strength: 1, threshold: 0.5 } } });
    const bloom = checksum();
    renderer.render({ ...sampled.camera, time: 6, effects: { saturation: 0 } });
    const graded = checksum();
    scene.renderAt(6);
    return { first, repeated, neutral, bloom, graded, counts, error: context.getError(), capabilities: renderer.capabilities, memory: renderer.memoryPlan, draws: renderer.batches.length };
  });
  assert.equal(report.motion.first, report.motion.repeated, 'Seeking must reproduce exact pixels.');
  assert.ok(report.motion.first > 0);
  assert.deepEqual(report.motion.counts, { buffer: 0, texture: 0, framebuffer: 0, renderbuffer: 0 });
  assert.equal(report.motion.error, 0);
  assert.notEqual(report.motion.neutral, report.motion.bloom, 'Bloom must change rendered pixels.');
  assert.notEqual(report.motion.neutral, report.motion.graded, 'Color grading must change rendered pixels.');
  await page.screenshot({ path: 'artifacts/motion-studio.png' });
  await page.goto(`${origin}/view2d.html`);
  await page.waitForFunction(() => window.__scene?.renderer);
  report.view2d = await page.evaluate(() => { window.__scene.renderAt(3); return { error: window.__scene.renderer.context.getError(), draws: window.__scene.renderer.batches.length }; });
  assert.equal(report.view2d.error, 0);
  await page.screenshot({ path: 'artifacts/view2d-studio.png' });
  await page.selectOption('#scene', 'model');
  for (const view of ['front', 'top', 'right', 'perspective']) {
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(60);
    assert.equal(await page.evaluate(() => window.__scene.renderer.context.getError()), 0);
  }
  await page.goto(`${origin}/assets.html`);
  await page.waitForFunction(() => window.__assetViewer?.renderer);
  await page.locator('#file').setInputFiles('artifacts/textured-animation.glb');
  await page.waitForFunction(() => window.__assetViewer?.asset?.animations.length === 1);
  report.asset = await page.evaluate(() => {
    const viewer = window.__assetViewer;
    viewer.renderAt(1);
    const result = { error: viewer.renderer.context.getError(), draws: viewer.renderer.batches.length, parts: viewer.asset.parts.length, textures: viewer.asset.parts.map(part => [part.material.map.image.width, part.material.map.image.height]), position: viewer.asset.parts[0].matrix[13] };
    viewer.renderAt(0);
    viewer.renderAt(1);
    result.repeated = viewer.asset.parts[0].matrix[13];
    return result;
  });
  assert.equal(report.asset.error, 0);
  assert.equal(report.asset.draws, 2, 'Different textures require distinct batches.');
  assert.equal(report.asset.position, 0.5);
  assert.equal(report.asset.repeated, report.asset.position);
  assert.deepEqual(report.asset.textures, [[16, 16], [16, 16]]);
  await page.screenshot({ path: 'artifacts/asset-studio.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['motion.html', 'view2d.html', 'assets.html']) {
      await page.goto(`${origin}/${route}`);
      await page.waitForFunction(() => window.__scene?.renderer || window.__assetViewer?.renderer);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} overflow at ${width}`);
      await page.screenshot({ path: `artifacts/${route}-${width}.png`, fullPage: true });
    }
  }
  report.fallback = await page.evaluate(async () => {
    const { CrucibleRenderer, box } = await import('/src/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:128px';
    document.body.append(canvas);
    const context = canvas.getContext('webgl2');
    const extension = context.getExtension.bind(context);
    context.getExtension = name => name === 'EXT_color_buffer_float' ? null : extension(name);
    const part = { name: 'Fallback cube', geometry: box(), matrix: new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]), material: { color: [0.2,0.5,0.3], metallic: 0, roughness: 0.5 } };
    const renderer = new CrucibleRenderer(canvas, [part], { ground: false, hdr: true, samples: 2, pixelRatio: 1, memoryBudgetMiB: 32 });
    renderer.render({ eye: [3,2,4], target: [0,0,0] });
    const result = { capabilities: renderer.capabilities, error: context.getError() };
    renderer.dispose();
    canvas.remove();
    return result;
  });
  assert.equal(report.fallback.capabilities.hdr, false);
  assert.equal(report.fallback.capabilities.hdrFallbackReason, 'EXT_color_buffer_float is unavailable');
  assert.equal(report.fallback.error, 0);
  assert.deepEqual(errors, []);
  await writeFile('artifacts/enhancement-smoke.json', JSON.stringify(report, null, 2));
  console.log('Deterministic motion, persistent GPU resources, 2D/orthographic views, textured GLB animation and responsive studios passed.');
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const width = Number(process.argv[2] ?? 540);
const height = Number(process.argv[3] ?? 960);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/gltf-morph-smoke.html', route => route.fulfill({
    contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>`,
  }));
  await page.goto('http://127.0.0.1:5173/gltf-morph-smoke.html');
  const report = await page.evaluate(async () => {
    const { CrucibleRenderer, exportGlb } = await import('/build/67.module.js');
    const { createFilmScenes } = await import('/build/film.js');
    const { parseGltf } = await import('/build/gltf.js');
    const source = createFilmScenes().portrait;
    const snapshot = exportGlb(source.parts);
    const snapshotHeader = new DataView(snapshot);
    const jsonLength = snapshotHeader.getUint32(12, true);
    const gltfDocument = JSON.parse(new TextDecoder().decode(new Uint8Array(snapshot, 20, jsonLength)));
    const binaryLength = snapshotHeader.getUint32(20 + jsonLength, true);
    const binary = new Uint8Array(binaryLength + 40);
    binary.set(new Uint8Array(snapshot, 28 + jsonLength, binaryLength));
    const times = new Float32Array([0, 1, 1.12, 1.24, 2]);
    const weights = new Float32Array([0, 0, 1, 0, 0]);
    binary.set(new Uint8Array(times.buffer), binaryLength);
    binary.set(new Uint8Array(weights.buffer), binaryLength + 20);
    const inputView = gltfDocument.bufferViews.length;
    gltfDocument.bufferViews.push({ buffer: 0, byteOffset: binaryLength, byteLength: 20 });
    gltfDocument.bufferViews.push({ buffer: 0, byteOffset: binaryLength + 20, byteLength: 20 });
    const input = gltfDocument.accessors.length;
    gltfDocument.accessors.push({ bufferView: inputView, componentType: 5126, count: 5, type: 'SCALAR', min: [0], max: [2] });
    gltfDocument.accessors.push({ bufferView: inputView + 1, componentType: 5126, count: 5, type: 'SCALAR' });
    gltfDocument.buffers[0].byteLength = binary.length;
    gltfDocument.animations = [{ name: 'Imported blink', samplers: [{ input, output: input + 1, interpolation: 'LINEAR' }], channels: gltfDocument.nodes.flatMap((node, index) => node.weights ? [{ sampler: 0, target: { node: index, path: 'weights' } }] : []) }];
    const json = new TextEncoder().encode(JSON.stringify(gltfDocument));
    const paddedJson = Math.ceil(json.length / 4) * 4;
    const animated = new ArrayBuffer(28 + paddedJson + binary.length);
    const header = new DataView(animated);
    header.setUint32(0, 0x46546c67, true);
    header.setUint32(4, 2, true);
    header.setUint32(8, animated.byteLength, true);
    header.setUint32(12, paddedJson, true);
    header.setUint32(16, 0x4e4f534a, true);
    const bytes = new Uint8Array(animated);
    bytes.fill(32, 20, 20 + paddedJson);
    bytes.set(json, 20);
    header.setUint32(20 + paddedJson, binary.length, true);
    header.setUint32(24 + paddedJson, 0x004e4942, true);
    bytes.set(binary, 28 + paddedJson);
    const asset = await parseGltf(animated);
    const canvas = document.querySelector('canvas');
    const renderer = new CrucibleRenderer(canvas, asset.parts, {
      world: true, ground: false, environment: source.environment, shadowBounds: source.shadowBounds,
      samples: 2, pixelRatio: 1, hdr: true, memoryBudgetMiB: 128,
    });
    const morphParts = asset.parts.filter(part => part.morph);
    const matrices = asset.parts.map(part => part.matrix);
    const weightBuffers = morphParts.map(part => part.morph.weights);
    const textures = [...renderer.morphTextures.values()];
    const frame = { eye: [0, 1.72, 0.72], target: [0, 1.7, 0], fov: 36, time: 0, effects: { grain: 0, bloom: { strength: 0 } } };
    function image(time) {
      renderer.updateParts(asset.applyAnimation(time));
      renderer.render(frame);
      return canvas.toDataURL('image/png');
    }
    const open = image(0);
    const closed = image(1.12);
    image(2);
    const repeated = image(1.12);
    let retained = true;
    for (let index = 0; index < 60; index++) {
      image(index % 2 ? 1.12 : 0);
      retained &&= asset.parts.every((part, partIndex) => part.matrix === matrices[partIndex]);
      retained &&= morphParts.every((part, partIndex) => part.morph.weights === weightBuffers[partIndex]);
      retained &&= [...renderer.morphTextures.values()].every((record, recordIndex) => record === textures[recordIndex]);
    }
    const memory = renderer.memoryPlan;
    const glError = renderer.context.getError();
    const partCount = asset.parts.length;
    const morphCount = morphParts.length;
    renderer.dispose();
    asset.dispose();
    return { open, closed, repeated, retained, memory, glError, partCount, morphCount, clipCount: gltfDocument.animations.length, snapshotBytes: animated.byteLength };
  });
  assert.deepEqual(errors, []);
  assert.equal(report.glError, 0);
  assert.equal(report.morphCount, 2);
  assert.equal(report.clipCount, 1);
  assert.equal(report.retained, true);
  assert.notEqual(report.open, report.closed);
  assert.equal(report.closed, report.repeated);
  for (const name of ['open', 'closed']) {
    await writeFile(`artifacts/gltf-blink-${width}x${height}-${name}.png`, Buffer.from(report[name].split(',')[1], 'base64'));
  }
  delete report.open;
  delete report.closed;
  delete report.repeated;
  await writeFile(`artifacts/gltf-morph-${width}x${height}-gpu.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

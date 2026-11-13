// One scene of the volumes that existed before animated grids, for a before and after pixel diff (#1045): a noisy box, a noisy sphere and a still grid.
// node bench/reference/volume-old-scene.mjs <output png> [size] [rootFolder]
// `rootFolder` is the source tree the page loads (default: this checkout), so the same script draws a build of origin/main.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const [outputPath, sizeText = '512', rootFolder = process.cwd()] = process.argv.slice(2);
if (!outputPath) throw new Error('usage: node bench/reference/volume-old-scene.mjs <output png> [size] [rootFolder]');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_ARGS = (process.env.CHROME_ARGS ?? '--enable-webgl --ignore-gpu-blocklist').split(' ');
const size = Number(sizeText);
const gridBytes = Array.from(readFileSync(resolve(rootFolder, 'tests/fixtures/explosion-32.67vg')));

// Runs in the page.
async function drawOldVolumes({ gridBytes, size }) {
  const { box } = await import('/src/geometry.js');
  const { Renderer67 } = await import('/src/renderer.js');
  const { registerVolumeGrid } = await import('/src/volume-grid.js');
  await import('/src/fog-shader.js');
  registerVolumeGrid('fixture', new Uint8Array(gridBytes));
  const floor = {
    geometry: box(0, 1),
    matrix: new Float32Array([14, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 14, 0, 0, -0.05, 0, 1]),
    material: { tag: 'surface', color: [0.6, 0.55, 0.45], metallic: 0, roughness: 0.9, emission: 0 },
  };
  const localVolumes = [
    { shape: 'box', center: [-3, 1.2, 0], size: [2.4, 2.4, 2.4], density: 1.5, falloff: 0.5, noiseAmount: 0.6, noiseScale: 3, absorption: [1, 1, 1], emission: [0.2, 0.1, 0.05], emissionStrength: 1, scatter: 0.5, steps: 24 },
    { shape: 'sphere', center: [3, 1.2, 0], radius: 1.3, density: 2, falloff: 0.6, noiseAmount: 0.4, noiseScale: 4, absorption: [0.8, 0.9, 1], emission: [1, 0.4, 0.1], emissionStrength: 2, steps: 24 },
    { shape: 'grid', grid: 'fixture', center: [0, 1.2, 0], size: [2.4, 2.4, 2.4], density: 3, emission: [1, 0.45, 0.12], emissionStrength: 3, steps: 64 },
  ];
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  document.body.append(canvas);
  const renderer = new Renderer67(canvas, [floor], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
  renderer.render({ eye: [0, 4, 9], target: [0, 1.2, 0], fov: 40, time: 0, environment: { keyIntensity: 1.1, fillIntensity: 0.25, ambientIntensity: 0.35, localVolumes } });
  const snapshot = document.createElement('canvas');
  snapshot.width = size;
  snapshot.height = size;
  snapshot.getContext('2d').drawImage(canvas, 0, 0);
  return { image: snapshot.toDataURL('image/png').split(',')[1], glError: renderer.context.getError() };
}

const server = await createServer({ root: resolve(rootFolder), server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const result = await page.evaluate(drawOldVolumes, { gridBytes, size });
  writeFileSync(outputPath, Buffer.from(result.image, 'base64'));
  console.log(JSON.stringify({ output: outputPath, size, glError: result.glError }));
  if (result.glError !== 0) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

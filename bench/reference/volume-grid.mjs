// A grid volume (#1045): one converted VDB frame of an explosion over a sandy ground, drawn by the rasterizer, with the frame time.
// node bench/reference/volume-grid.mjs <grid file> <output png> [width] [height] [voxelMetres] [density]
// Chrome comes from CHROME_PATH; on a Linux GPU box pass CHROME_ARGS="--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox".
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const [gridPath, outputPath, widthText = '960', heightText = '540', voxelText = '0.05', densityText = '4'] = process.argv.slice(2);
if (!gridPath || !outputPath) throw new Error('usage: node bench/reference/volume-grid.mjs <grid file> <output png> [width] [height] [voxelMetres] [density]');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_ARGS = (process.env.CHROME_ARGS ?? '--enable-webgl --ignore-gpu-blocklist').split(' ');
const options = { width: Number(widthText), height: Number(heightText), voxelMetres: Number(voxelText), density: Number(densityText), frames: 30 };

// Runs in the page.
async function drawExplosion({ gridBytes, width, height, voxelMetres, density, frames }) {
  const { box } = await import('/src/geometry.js');
  const { Renderer67 } = await import('/src/renderer.js');
  const { decodeVolumeGrid, registerVolumeGrid } = await import('/src/volume-grid.js');
  await import('/src/fog-shader.js');
  const grid = decodeVolumeGrid(new Uint8Array(gridBytes));
  registerVolumeGrid('explosion', grid);
  const size = grid.size.map(extent => extent * voxelMetres);
  const placed = (translation, scale, color) => ({
    geometry: box(0, 1),
    matrix: new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]),
    material: { tag: 'surface', color, metallic: 0, roughness: 0.9, emission: 0 },
  });
  const parts = [placed([0, -0.05, 0], [16, 0.1, 16], [0.62, 0.5, 0.33]), placed([-3.2, 0.3, 2.2], [0.8, 0.6, 0.8], [0.4, 0.42, 0.3]), placed([3.4, 0.4, 1.4], [0.6, 0.8, 0.6], [0.55, 0.15, 0.1])];
  const volume = { shape: 'grid', grid: 'explosion', center: [0, size[1] / 2, 0], size, density, emission: [1, 0.45, 0.12], emissionStrength: 3, absorption: [1, 1, 1], steps: 96 };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const renderer = new Renderer67(canvas, parts, { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
  const frame = { eye: [0, 7.5, 13], target: [0, 2.6, 0], fov: 42, time: 0, environment: { keyIntensity: 1.1, fillIntensity: 0.25, ambientIntensity: 0.35, localVolumes: [volume] } };
  const pixel = new Uint8Array(4);
  const draw = () => {
    renderer.render(frame);
    renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
  };
  for (let index = 0; index < 5; index++) draw();
  const milliseconds = [];
  for (let index = 0; index < frames; index++) {
    const started = performance.now();
    draw();
    milliseconds.push(performance.now() - started);
  }
  milliseconds.sort((first, second) => first - second);
  const snapshot = document.createElement('canvas');
  snapshot.width = width;
  snapshot.height = height;
  snapshot.getContext('2d').drawImage(canvas, 0, 0);
  return { image: snapshot.toDataURL('image/png').split(',')[1], medianMilliseconds: milliseconds[milliseconds.length >> 1], glError: renderer.context.getError(), size };
}

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: options.width, height: options.height } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const result = await page.evaluate(drawExplosion, { ...options, gridBytes: Array.from(readFileSync(gridPath)) });
  writeFileSync(outputPath, Buffer.from(result.image, 'base64'));
  console.log(JSON.stringify({ grid: gridPath, width: options.width, height: options.height, medianMillisecondsPerFrame: Number(result.medianMilliseconds.toFixed(2)), glError: result.glError, sizeMetres: result.size }));
  if (result.glError !== 0) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

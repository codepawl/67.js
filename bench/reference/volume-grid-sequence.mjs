// Playback of an animated grid volume (#1045): a procedural sequence of a rising, swirling blob, drawn by the rasterizer with the frame the time selects.
// node bench/reference/volume-grid-sequence.mjs <output png> [width] [height] [resolution] [frameCount]
// Prints the median milliseconds of a draw that keeps the frame (no upload) and of a draw that changes the frame every time (one texture upload each).
// Chrome comes from CHROME_PATH; on a Linux GPU box pass CHROME_ARGS="--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox".
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const [outputPath, widthText = '1920', heightText = '1080', resolutionText = '128', frameCountText = '32'] = process.argv.slice(2);
if (!outputPath) throw new Error('usage: node bench/reference/volume-grid-sequence.mjs <output png> [width] [height] [resolution] [frameCount]');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_ARGS = (process.env.CHROME_ARGS ?? '--enable-webgl --ignore-gpu-blocklist').split(' ');
const options = { width: Number(widthText), height: Number(heightText), resolution: Number(resolutionText), frameCount: Number(frameCountText), draws: 40 };

// Runs in the page.
async function playSequence({ width, height, resolution, frameCount, draws }) {
  const { box } = await import('/src/geometry.js');
  const { Renderer67 } = await import('/src/renderer.js');
  const { encodeVolumeGrid, registerVolumeGrid } = await import('/src/volume-grid.js');
  await import('/src/fog-shader.js');
  const voxels = resolution ** 3;
  const names = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const progress = frame / frameCount;
    const density = new Float32Array(voxels);
    const flame = new Float32Array(voxels);
    for (let z = 0; z < resolution; z++) {
      for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
          const u = x / resolution - 0.5;
          const v = y / resolution;
          const w = z / resolution - 0.5;
          const centreHeight = 0.2 + 0.5 * progress;
          const wobble = 0.06 * Math.sin(8 * v + 12 * progress * Math.PI) * Math.cos(6 * u);
          const distance = Math.hypot(u + wobble, (v - centreHeight) * 1.2, w + wobble);
          const radius = 0.12 + 0.18 * progress;
          const value = Math.max(0, 1 - distance / radius);
          density[x + y * resolution + z * resolution * resolution] = value * 3;
          flame[x + y * resolution + z * resolution * resolution] = value * (1 - progress) * 4;
        }
      }
    }
    const name = `bench-${frame}`;
    registerVolumeGrid(name, encodeVolumeGrid({ resolution: [resolution, resolution, resolution], size: [4, 4, 4], channels: { density, flame } }));
    names.push(name);
  }
  const placed = (translation, scale, color) => ({
    geometry: box(0, 1),
    matrix: new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]),
    material: { tag: 'surface', color, metallic: 0, roughness: 0.9, emission: 0 },
  });
  const parts = [placed([0, -0.05, 0], [16, 0.1, 16], [0.62, 0.5, 0.33])];
  const volume = { shape: 'grid', frames: names, fps: 24, center: [0, 2, 0], size: [4, 4, 4], density: 2, emission: [1, 0.45, 0.12], emissionStrength: 3, absorption: [1, 1, 1], steps: 96 };
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const renderer = new Renderer67(canvas, parts, { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
  const pixel = new Uint8Array(4);
  const draw = time => {
    renderer.render({ eye: [0, 3.5, 9], target: [0, 2, 0], fov: 40, time, environment: { keyIntensity: 1.1, fillIntensity: 0.25, ambientIntensity: 0.35, localVolumes: [volume] } });
    renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
  };
  const median = values => values.sort((first, second) => first - second)[values.length >> 1];
  const measure = timeOf => {
    for (let index = 0; index < 4; index++) draw(timeOf(index));
    const milliseconds = [];
    for (let index = 0; index < draws; index++) {
      const started = performance.now();
      draw(timeOf(index));
      milliseconds.push(performance.now() - started);
    }
    return median(milliseconds);
  };
  const held = measure(() => 0.5);
  const playing = measure(index => (index % frameCount) / volume.fps);
  draw((frameCount * 0.6) / volume.fps);
  const snapshot = document.createElement('canvas');
  snapshot.width = width;
  snapshot.height = height;
  snapshot.getContext('2d').drawImage(canvas, 0, 0);
  return { image: snapshot.toDataURL('image/png').split(',')[1], held, playing, glError: renderer.context.getError() };
}

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage({ viewport: { width: options.width, height: options.height } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const result = await page.evaluate(playSequence, options);
  writeFileSync(outputPath, Buffer.from(result.image, 'base64'));
  console.log(JSON.stringify({
    width: options.width,
    height: options.height,
    resolution: options.resolution,
    frames: options.frameCount,
    medianMillisecondsHeldFrame: Number(result.held.toFixed(2)),
    medianMillisecondsPlaying: Number(result.playing.toFixed(2)),
    glError: result.glError,
  }));
  if (result.glError !== 0) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

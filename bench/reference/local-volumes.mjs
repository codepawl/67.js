// A smoky room with a glowing puff (issue #710): the picture and the frame time of the room with and without environment.localVolumes.
// node bench/reference/local-volumes.mjs [gpu|cpu]
// Writes bench/reference/images/local-volumes.png (with volumes) and local-volumes-plain.png (without), and prints the frame times.
import { writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BACKEND_ARGUMENTS = {
  gpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding'],
  cpu: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const [backend = 'gpu'] = process.argv.slice(2);
const IMAGE_DIRECTORY = new URL('./images/', import.meta.url);

// Runs in the page. Three rounds of 200 frames per side, the order alternating each round so a drifting machine load favors neither.
async function measureSmokyRoom({ width, height, rounds, warmupFrames, measuredFrames }) {
  const { box } = await import('/src/geometry.js');
  const { CrucibleRenderer } = await import('/src/renderer.js');
  await import('/src/fog-shader.js');

  const placed = (translation, scale, color) => ({
    geometry: box(0, 1),
    matrix: new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]),
    material: { tag: 'surface', color, metallic: 0, roughness: 0.8, emission: 0 },
  });
  const room = [
    placed([0, -0.1, 0], [8, 0.2, 8], [0.55, 0.5, 0.45]),
    placed([0, 2, -4.1], [8, 4.2, 0.2], [0.6, 0.58, 0.55]),
    placed([-4.1, 2, 0], [0.2, 4.2, 8], [0.5, 0.52, 0.6]),
    placed([4.1, 2, 0], [0.2, 4.2, 8], [0.6, 0.5, 0.5]),
    placed([1.8, 0.5, -1.5], [1, 1, 1], [0.3, 0.3, 0.35]),
  ];
  const smoke = { shape: 'box', center: [0, 1.6, -0.5], size: [7, 3, 7], density: 0.18, falloff: 0.6, absorption: [0.7, 0.8, 1], noiseAmount: 0.5, noiseScale: 0.8, steps: 24 };
  const puff = { shape: 'sphere', center: [-0.4, 1.1, -1.2], radius: 0.7, density: 1.5, falloff: 0.5, emission: [1, 0.45, 0.12], emissionStrength: 6, noiseAmount: 0.6, noiseScale: 2, steps: 24 };
  const camera = { eye: [0, 1.6, 3.6], target: [0, 1.1, -1], fov: 55, time: 0 };
  const baseEnvironment = { keyIntensity: 1, fillIntensity: 0.3, ambientIntensity: 0.5 };

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  document.body.append(canvas);
  const snapshot = document.createElement('canvas');
  snapshot.width = width;
  snapshot.height = height;

  const pixel = new Uint8Array(4);
  const runSide = (withVolumes, frames) => {
    const renderer = new CrucibleRenderer(canvas, room, { hdr: true, depth: true, samples: 4, pixelRatio: 1, ground: false });
    const environment = withVolumes ? { ...baseEnvironment, localVolumes: [smoke, puff] } : baseEnvironment;
    const draw = () => {
      renderer.render({ ...camera, environment });
      renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
    };
    for (let index = 0; index < warmupFrames; index++) draw();
    const milliseconds = [];
    for (let index = 0; index < frames; index++) {
      const started = performance.now();
      draw();
      milliseconds.push(performance.now() - started);
    }
    snapshot.getContext('2d').drawImage(canvas, 0, 0);
    const glError = renderer.context.getError();
    renderer.dispose();
    milliseconds.sort((first, second) => first - second);
    return { median: milliseconds[milliseconds.length >> 1], minimum: milliseconds[0], maximum: milliseconds[milliseconds.length - 1], glError };
  };

  const timings = { plain: [], volumes: [] };
  for (let round = 0; round < rounds; round++) {
    for (const withVolumes of round % 2 ? [true, false] : [false, true]) {
      timings[withVolumes ? 'volumes' : 'plain'].push(runSide(withVolumes, measuredFrames));
    }
  }
  runSide(false, 1);
  const plainImage = snapshot.toDataURL('image/png').split(',')[1];
  runSide(true, 1);
  const volumesImage = snapshot.toDataURL('image/png').split(',')[1];
  return { timings, plainImage, volumesImage };
}

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: BACKEND_ARGUMENTS[backend] });
try {
  const options = { width: 960, height: 540, rounds: 3, warmupFrames: 20, measuredFrames: 200 };
  const page = await browser.newPage({ viewport: { width: options.width, height: options.height } });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const result = await page.evaluate(measureSmokyRoom, options);
  writeFileSync(new URL('local-volumes.png', IMAGE_DIRECTORY), Buffer.from(result.volumesImage, 'base64'));
  writeFileSync(new URL('local-volumes-plain.png', IMAGE_DIRECTORY), Buffer.from(result.plainImage, 'base64'));
  const summary = Object.fromEntries(Object.entries(result.timings).map(([side, rounds]) => [side, rounds.map(round => Number(round.median.toFixed(2)))]));
  const glErrors = Object.values(result.timings).flat().filter(round => round.glError !== 0).length;
  console.log(JSON.stringify({ backend, width: options.width, height: options.height, frames: options.measuredFrames, medianMillisecondsPerRound: summary, glErrors }, null, 1));
  if (glErrors > 0) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

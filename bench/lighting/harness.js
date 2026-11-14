// Runs in the page: draws a server hall lit by a chosen number of point and area lights and times the frames.
import { CrucibleRenderer } from '/src/renderer.js';
import { box } from '/src/geometry.js';

const HALL_WIDTH = 24;
const HALL_DEPTH = 16;
const RACK_ROWS = 6;
const RACKS_PER_ROW = 8;

function placed(center, size) {
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
}

function hallParts() {
  const material = { color: [0.6, 0.62, 0.65], metallic: 0, roughness: 0.6 };
  const parts = [{ geometry: box(), matrix: placed([0, -0.1, 0], [HALL_WIDTH, 0.2, HALL_DEPTH]), material }];
  for (let row = 0; row < RACK_ROWS; row++) {
    for (let rack = 0; rack < RACKS_PER_ROW; rack++) {
      const x = (rack - (RACKS_PER_ROW - 1) / 2) * 2.6;
      const z = (row - (RACK_ROWS - 1) / 2) * 2.4;
      parts.push({ geometry: box(), matrix: placed([x, 1.1, z], [0.8, 2.2, 1.2]), material });
    }
  }
  return parts;
}

function spread(count, width, depth, height, lightFor) {
  return Array.from({ length: count }, (_, index) => {
    const x = ((index + 0.5) / count - 0.5) * width;
    const z = ((((index * 5) % count) + 0.5) / count - 0.5) * depth;
    return lightFor([x, height, z], index);
  });
}

function environmentFor(pointCount, areaCount, range) {
  return {
    keyIntensity: 0,
    fillIntensity: 0.2,
    ambientIntensity: 0.2,
    pointLights: spread(pointCount, HALL_WIDTH, HALL_DEPTH, 3, position => ({ position, color: [1, 0.9, 0.8], intensity: 6, radius: 0.1, range })),
    areaLights: spread(areaCount, HALL_WIDTH, HALL_DEPTH, 3.4, position => ({ position, direction: [0, -1, 0], width: 3, height: 0.3, color: [0.8, 0.9, 1], intensity: 40 })),
  };
}

const camera = { eye: [0, 1.7, 7.5], target: [0, 1.2, 0], fov: 60 };

async function measureLightCounts({ pointCount, areaCount, range = 0, warmupFrames = 20, measuredFrames = 200 }) {
  const canvas = document.querySelector('canvas');
  const renderer = new CrucibleRenderer(canvas, hallParts(), { ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024 });
  renderer.resize();
  const frame = { ...camera, environment: environmentFor(pointCount, areaCount, range), time: 0, exposure: 1, effects: { ambientOcclusion: 0 } };
  // Reading one pixel back is what waits for a hardware GPU to finish the frame.
  const pixel = new Uint8Array(4);
  const finishDrawing = () => renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
  for (let index = 0; index < warmupFrames; index++) {
    renderer.render(frame);
    finishDrawing();
  }
  const frameMilliseconds = [];
  for (let index = 0; index < measuredFrames; index++) {
    const started = performance.now();
    renderer.render(frame);
    finishDrawing();
    frameMilliseconds.push(performance.now() - started);
  }
  const glError = renderer.context.getError();
  const uniformVectors = renderer.context.getParameter(renderer.context.MAX_FRAGMENT_UNIFORM_VECTORS);
  const image = canvas.toDataURL('image/png').split(',')[1];
  renderer.dispose();
  frameMilliseconds.sort((first, second) => first - second);
  return { pointCount, areaCount, range, glError, uniformVectors, image, medianMilliseconds: frameMilliseconds[Math.floor(measuredFrames / 2)] };
}

window.measureLightCounts = measureLightCounts;

function framePixels(renderer, canvas, frame) {
  renderer.render(frame);
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  renderer.context.readPixels(0, 0, canvas.width, canvas.height, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixels);
  return pixels;
}

function changedPixelCount(first, second) {
  let changed = 0;
  for (let index = 0; index < first.length; index += 4) {
    const difference = Math.abs(first[index] - second[index]) + Math.abs(first[index + 1] - second[index + 1]) + Math.abs(first[index + 2] - second[index + 2]);
    if (difference > 2) changed++;
  }
  return changed;
}

// Draws the hall with every light, then once more without each light in turn. A light that the shader ignored would leave the
// picture as it was, so each removal has to change some pixels.
async function checkEachLightVisible({ pointCount, areaCount }) {
  const canvas = document.querySelector('canvas');
  const renderer = new CrucibleRenderer(canvas, hallParts(), { ground: false, hdr: true, depth: true, samples: 1, pixelRatio: 1, memoryBudgetMiB: 1024 });
  renderer.resize();
  const environment = environmentFor(pointCount, areaCount, 0);
  const frame = { ...camera, environment, time: 0, exposure: 1, effects: { ambientOcclusion: 0 } };
  const everything = framePixels(renderer, canvas, frame);
  const changedPixels = { pointLights: [], areaLights: [] };
  for (const list of ['pointLights', 'areaLights']) {
    for (let index = 0; index < environment[list].length; index++) {
      const without = { ...environment, [list]: environment[list].filter((light, other) => other !== index) };
      changedPixels[list].push(changedPixelCount(everything, framePixels(renderer, canvas, { ...frame, environment: without })));
    }
  }
  const glError = renderer.context.getError();
  renderer.dispose();
  return { glError, changedPixels };
}

window.checkEachLightVisible = checkEachLightVisible;

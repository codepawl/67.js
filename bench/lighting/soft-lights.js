// Runs in the page: a pillar and a floating cube over a floor, drawn with each soft-light feature off and on.
import { CrucibleRenderer } from '/src/renderer.js';
import { box } from '/src/geometry.js';

// The light-shapes and cascade modules are optional: this harness loads them only when the source tree has them,
// so the same page also draws the default picture of an older tree.
const lightShapesPath = '/src/light-shapes.js';
const lightShapes = await import(/* @vite-ignore */ lightShapesPath).catch(() => null);
const cascades = await import('/src/cascaded-shadows.js');

function placed(center, size) {
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
}

function sceneParts() {
  const material = { color: [0.75, 0.75, 0.78], metallic: 0, roughness: 0.7 };
  return [
    { geometry: box(), matrix: placed([0, -0.05, 0], [8, 0.1, 8]), material },
    { geometry: box(), matrix: placed([0, 0.6, 0], [0.4, 1.2, 0.4]), material },
    { geometry: box(), matrix: placed([-1.1, 0.9, 0.2], [0.35, 0.35, 0.35]), material },
    { geometry: box(), matrix: placed([1.1, 0.12, 0.4], [0.5, 0.24, 0.5]), material },
  ];
}

const baseEnvironment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0.15 };
const CASES = {
  'sun-hard': { environment: { lightDirection: [-3, 6, 4], keyIntensity: 1, fillIntensity: 0, ambientIntensity: 0.15 }, cascadeCount: 0 },
  'sun-soft': { environment: { lightDirection: [-3, 6, 4], keyIntensity: 1, fillIntensity: 0, ambientIntensity: 0.15, sunAngularRadius: 0.05 }, cascadeCount: 1 },
  'area-lit': { environment: { ...baseEnvironment, areaLights: [{ position: [-0.6, 2.6, 0.4], direction: [0.15, -1, -0.05], width: 0.7, height: 0.7, intensity: 30 }] } },
  'area-shadow': { environment: { ...baseEnvironment, areaLights: [{ position: [-0.6, 2.6, 0.4], direction: [0.15, -1, -0.05], width: 0.7, height: 0.7, intensity: 30, castShadow: true }] }, needsShapes: true },
  'spot-plain': { environment: { ...baseEnvironment, spotLights: [{ position: [0, 3, 2.5], direction: [0, -1, -0.6], angle: 1.2, penumbra: 0.1, intensity: 60 }] } },
  'spot-ies': { environment: { ...baseEnvironment, spotLights: [{ position: [0, 3, 2.5], direction: [0, -1, -0.6], angle: 1.2, penumbra: 0.1, intensity: 60, ies: 'narrow-spot' }] }, needsShapes: true },
};

const camera = { eye: [3.4, 2.6, 4.2], target: [0, 0.4, 0], fov: 45 };

async function drawCase(name, { warmupFrames = 10, measuredFrames = 60 } = {}) {
  const definition = CASES[name];
  const canvas = document.querySelector('canvas');
  const options = { ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, environment: definition.environment };
  if (definition.cascadeCount > 0) options.shadowCascades = cascades.createCascadedShadows({ count: definition.cascadeCount });
  const renderer = new CrucibleRenderer(canvas, sceneParts(), options);
  renderer.resize();
  const frame = { ...camera, environment: definition.environment, time: 0, exposure: 1, effects: { ambientOcclusion: 0 } };
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
  renderer.render(frame);
  const glError = renderer.context.getError();
  const image = canvas.toDataURL('image/png').split(',')[1];
  renderer.dispose();
  frameMilliseconds.sort((first, second) => first - second);
  return { name, glError, image, medianMilliseconds: frameMilliseconds[Math.floor(measuredFrames / 2)] };
}

window.hasLightShapes = Boolean(lightShapes);
window.caseNames = Object.keys(CASES);
window.drawCase = drawCase;

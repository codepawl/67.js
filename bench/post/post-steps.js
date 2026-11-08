// Runs in the page: a lit pillar, a bright emissive strip and a row of posts over a floor, drawn with each named post step off and on.
import { Renderer67 } from '/src/renderer.js';
import { box } from '/src/geometry.js';
import { installCameraEffects } from '/src/camera-effects.js';

// The named steps are an optional module: this harness loads it only when the source tree has it, so the same page also
// draws the default picture of an older tree.
const postStepsPath = '/src/post-steps.js';
const postSteps = await import(/* @vite-ignore */ postStepsPath).catch(() => null);

function placed(center, size) {
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
}

function sceneParts() {
  const material = { color: [0.75, 0.75, 0.78], metallic: 0, roughness: 0.7 };
  const lamp = { color: [1, 0.9, 0.7], emissiveColor: [1, 0.9, 0.7], metallic: 0, roughness: 1, emission: 14 };
  const parts = [
    { geometry: box(), matrix: placed([0, -0.05, 0], [10, 0.1, 10]), material },
    { geometry: box(), matrix: placed([0, 0.6, 0], [0.4, 1.2, 0.4]), material },
    { geometry: box(), matrix: placed([-1.2, 1.6, -0.6], [0.9, 0.06, 0.06]), material: lamp },
  ];
  for (let index = 0; index < 5; index++) {
    parts.push({ geometry: box(), matrix: placed([-2.4 + index * 1.2, 0.35, -2 - index * 1.4], [0.3, 0.7, 0.3]), material });
  }
  return parts;
}

const environment = { keyIntensity: 1, fillIntensity: 0.2, ambientIntensity: 0.2, lightDirection: [-3, 6, 4] };
const CASES = {
  default: {},
  defocus: { depthOfField: { blur: 0.8, focusDistance: 4.5 } },
  'color-balance': { colorBalance: { lift: [0.06, 0, -0.06], gamma: [1, 1, 1.2], gain: [1.2, 1, 0.8] } },
  'glare-streaks': { glare: { streaks: 0.8, threshold: 1, size: 0.2 } },
  'glare-streaks-6': { glare: { streaks: 0.8, count: 6, angle: 30, threshold: 1, size: 0.2 } },
  'glare-anamorphic': { glare: { streaks: 0.8, count: 2, angle: 0, threshold: 1, size: 0.35 } },
  'glare-fog': { glare: { fogGlow: 0.6, threshold: 1, size: 0.12 } },
  'lens-distortion': { lensDistortion: { distortion: 0.8 } },
  'lens-dispersion': { lensDistortion: { dispersion: 1 } },
};
const camera = { eye: [3.4, 1.8, 4.6], target: [0, 0.8, -1], fov: 45 };

async function drawCase(name, { warmupFrames = 4, measuredFrames = 20 } = {}) {
  const canvas = document.querySelector('canvas');
  const renderer = installCameraEffects(new Renderer67(canvas, sceneParts(), { ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, environment }));
  if (postSteps) postSteps.installPostSteps(renderer);
  renderer.resize();
  const frame = { ...camera, environment, time: 0, exposure: 1, effects: { ambientOcclusion: 0, ...CASES[name] } };
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

window.hasPostSteps = Boolean(postSteps);
window.caseNames = Object.keys(CASES);
window.drawCase = drawCase;

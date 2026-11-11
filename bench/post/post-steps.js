// Runs in the page: a lit pillar, a bright emissive strip and a row of posts over a floor, drawn with each named post step off and on.
import { Renderer67 } from '/src/renderer.js';
import { box } from '/src/geometry.js';
import { installCameraEffects } from '/src/camera-effects.js';
import { installRenderPasses } from '/src/render-passes.js';
const userPassPath = '/src/user-pass.js';
const userPassModule = await import(/* @vite-ignore */ userPassPath).catch(() => null);

// The named steps are an optional module: this harness loads it only when the source tree has it, so the same page also
// draws the default picture of an older tree.
const postStepsPath = '/src/post-steps.js';
const postSteps = await import(/* @vite-ignore */ postStepsPath).catch(() => null);

function placed(center, size) {
  return new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
}

// The hero is a green screen in the keying cases, so a chroma key has something to remove.
const GREEN_SCREEN = [0.05, 0.8, 0.1];

function sceneParts(greenHero) {
  const material = { color: [0.75, 0.75, 0.78], metallic: 0, roughness: 0.7 };
  const heroMaterial = greenHero ? { color: GREEN_SCREEN, metallic: 0, roughness: 0.7 } : material;
  const lamp = { color: [1, 0.9, 0.7], emissiveColor: [1, 0.9, 0.7], metallic: 0, roughness: 1, emission: 14 };
  const parts = [
    { geometry: box(), matrix: placed([0, -0.05, 0], [10, 0.1, 10]), material },
    { name: 'hero', geometry: box(), matrix: placed([0, 0.6, 0], [0.4, 1.2, 0.4]), material: heroMaterial },
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
  'grade-hero': { colorBalance: { gain: [1.4, 0.8, 0.5], mask: { objects: ['hero'] } } },
  'grade-depth': { colorBalance: { gain: [1.4, 0.8, 0.5], mask: { depth: { near: 6, far: 9, feather: 1 } } } },
  sharpen: { stylize: { sharpen: 1.5 } },
  kuwahara: { stylize: { kuwahara: 3 } },
  posterize: { stylize: { posterize: 4 } },
  pixelate: { stylize: { pixelate: 8 } },
  'pixelate-hero': { stylize: { pixelate: 8, mask: { objects: ['hero'] } } },
  'green-default': {},
  'key-chroma': { composite: { background: { top: [0.9, 0.35, 0.1], bottom: [0.1, 0.2, 0.6] }, key: { chroma: { color: GREEN_SCREEN, tolerance: 0.25, softness: 0.1 } } } },
  'key-chroma-masked': { composite: { background: { color: [0.9, 0.35, 0.1] }, key: { chroma: { color: GREEN_SCREEN, tolerance: 0.25 } }, mask: { depth: { near: 0, far: 3 } } } },
  'key-luma': { composite: { background: { color: [0.1, 0.2, 0.6] }, key: { luma: { low: 0.05, high: 0.3 } } } },
};
// A user pass that reads the object ID pass: it tints only the part it lists, as a snippet would to grade one object.
const USER_PASS_CASES = {
  'user-pass-hero': [{
    name: 'tint-hero',
    objects: ['hero'],
    fragment: [
      'vec4 userPass(vec2 uv) {',
      '  vec4 color = texture(sceneColor, uv);',
      '  return objectSlotAt(uv) == 0 ? vec4(color.r * 1.4, color.g * 0.6, color.b * 0.4, color.a) : color;',
      '}',
    ].join('\n'),
  }],
};
const GREEN_CASES = ['green-default', 'key-chroma', 'key-chroma-masked'];
const camera = { eye: [3.4, 1.8, 4.6], target: [0, 0.8, -1], fov: 45 };

// Mean color of a 6 by 6 pixel patch at a point of the frame (0 to 1, from the lower left), to check where a step changed the picture.
function regionMean(context, x, y) {
  const size = 6;
  const pixels = new Uint8Array(size * size * 4);
  context.readPixels(Math.round(x * context.drawingBufferWidth) - size / 2, Math.round(y * context.drawingBufferHeight) - size / 2, size, size, context.RGBA, context.UNSIGNED_BYTE, pixels);
  const mean = [0, 0, 0];
  for (let index = 0; index < pixels.length; index += 4) for (let channel = 0; channel < 3; channel++) mean[channel] += pixels[index + channel] / (size * size);
  return mean.map(value => Number(value.toFixed(2)));
}

async function drawCase(name, { warmupFrames = 4, measuredFrames = 20 } = {}) {
  const canvas = document.querySelector('canvas');
  const renderer = installRenderPasses(installCameraEffects(new Renderer67(canvas, sceneParts(GREEN_CASES.includes(name)), { ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, environment })));
  if (postSteps) postSteps.installPostSteps(renderer);
  if (USER_PASS_CASES[name] && userPassModule) {
    userPassModule.installUserPasses(renderer);
    renderer.userPasses.set(userPassModule.normalizeUserPasses(USER_PASS_CASES[name]));
  }
  renderer.resize();
  const frame = { ...camera, environment, time: 0, exposure: 1, effects: { ambientOcclusion: 0, ...CASES[name] } };
  const usesObjects = Boolean(USER_PASS_CASES[name]) || (postSteps?.usesObjectMask(postSteps.resolvePostSteps(frame.effects)) ?? false);
  const drawFrame = () => {
    // A mask by parts reads the object ID pass, drawn first.
    if (usesObjects) renderer.render({ ...frame, pass: 'objectId' });
    renderer.render(frame);
  };
  const pixel = new Uint8Array(4);
  const finishDrawing = () => renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
  for (let index = 0; index < warmupFrames; index++) {
    drawFrame();
    finishDrawing();
  }
  const frameMilliseconds = [];
  for (let index = 0; index < measuredFrames; index++) {
    const started = performance.now();
    drawFrame();
    finishDrawing();
    frameMilliseconds.push(performance.now() - started);
  }
  drawFrame();
  const glError = renderer.context.getError();
  const regions = { hero: regionMean(renderer.context, 0.44, 0.44), floor: regionMean(renderer.context, 0.5, 0.06) };
  const image = canvas.toDataURL('image/png').split(',')[1];
  renderer.dispose();
  frameMilliseconds.sort((first, second) => first - second);
  return { name, glError, image, regions, medianMilliseconds: frameMilliseconds[Math.floor(measuredFrames / 2)] };
}

window.hasPostSteps = Boolean(postSteps);
window.caseNames = [...Object.keys(CASES), ...Object.keys(USER_PASS_CASES)];
window.drawCase = drawCase;

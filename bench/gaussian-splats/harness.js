// Page of the Gaussian splat benchmark for Crucible: a recipe part (a plinth with a sphere and a torus) drawn in front of splats.
// window.runCase(options) draws the case, times the frames and returns a picture. run.mjs drives it.
import { CrucibleRenderer } from '/src/renderer.js';
import { createAgentScene } from '/src/agent-scene.js';
import { attachGaussianSplats, createGaussianSplats, parseGaussianSplatPly } from '/src/gaussian-splats.js';
import { millipedeMatrix, syntheticRoom } from './scene-data.js';

const RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'plinth', type: 'box', bevel: 0.02 }, { id: 'ball', type: 'sphere' }, { id: 'ring', type: 'torus', tubeRadius: 0.08 }],
  materials: [{ id: 'stone', color: [0.62, 0.6, 0.56], roughness: 0.8 }, { id: 'metal', color: [0.9, 0.55, 0.2], metallic: 1, roughness: 0.25 }],
  nodes: [
    { id: 'plinth', geometry: 'plinth', material: 'stone', translation: [0, 0.3, 0.6], scale: [1.2, 0.6, 1.2] },
    { id: 'ball', geometry: 'ball', material: 'metal', translation: [0, 0.95, 0.6], scale: [0.7, 0.7, 0.7] },
    { id: 'ring', geometry: 'ring', material: 'metal', translation: [0, 1.45, 0.6], rotation: [0.2588, 0, 0, 0.9659] },
  ],
};

async function loadMillipede(maximumCount) {
  const response = await fetch('/bench/gaussian-splats/data/millipede.ply');
  if (!response.ok) throw new Error('Run node bench/gaussian-splats/fetch-sample.mjs first');
  return parseGaussianSplatPly(await response.arrayBuffer(), { maximumCount });
}

function median(values) {
  return values.slice().sort((first, second) => first - second)[Math.floor(values.length / 2)];
}

async function nextFrame() {
  await new Promise(resolve => requestAnimationFrame(resolve));
}

function cameraAt(angle, source) {
  const radius = source === 'synthetic' ? 3 : 4.2;
  const eye = [Math.sin(angle) * radius, 1.7, Math.cos(angle) * radius];
  const target = source === 'synthetic' ? [0, 1.5, 0] : [0, 1.3, -1];
  return { eye, target, up: [0, 1, 0], fov: 50, near: 0.1, far: 200 };
}

const synchronizationPixel = new Uint8Array(4);

// readPixels waits for the GPU to finish the frame; gl.finish() does not in Chrome.
function timeFrames(renderer, context, frameCount, orbit, source, environment) {
  const times = [];
  for (let index = 0; index < frameCount; index++) {
    const angle = orbit ? index * 0.04 : 0;
    const start = performance.now();
    renderer.render({ ...cameraAt(angle, source), environment, time: 0, exposure: 1 });
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, synchronizationPixel);
    times.push(performance.now() - start);
  }
  return times;
}

const GPU_STAT = 'gpuBytes';

async function runCase({ source = 'synthetic', count = 100000, withPart = true, withSplats = true, hdr = true, frames = 60, width = 960, height = 540, screenshot = true }) {
  const canvas = document.querySelector('canvas');
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const scene = createAgentScene(RECIPE);
  const environment = { ...scene.environment, world: true };
  const renderer = new CrucibleRenderer(canvas, withPart ? scene.parts : [], { ground: false, hdr, depth: true, samples: 4, pixelRatio: 1, world: true, environment });
  renderer.resize();
  const context = renderer.context;
  const heapBefore = performance.memory?.usedJSHeapSize ?? 0;
  const loadStart = performance.now();
  let splats = null;
  if (withSplats) {
    const data = source === 'millipede' ? await loadMillipede(count) : syntheticRoom(count);
    const matrix = source === 'millipede' ? millipedeMatrix(data.bounds) : undefined;
    splats = createGaussianSplats(data, { matrix, maximumCount: Math.max(count, data.count) });
    attachGaussianSplats(renderer, splats);
  }
  const prepareMilliseconds = performance.now() - loadStart;
  await nextFrame();
  timeFrames(renderer, context, 10, true, source, environment);
  const orbitTimes = timeFrames(renderer, context, frames, true, source, environment);
  const stillTimes = timeFrames(renderer, context, frames, false, source, environment);
  const image = screenshot ? (renderer.render({ ...cameraAt(0.25, source), environment, time: 0, exposure: 1 }), canvas.toDataURL('image/png').split(',')[1]) : null;
  const debug = context.getExtension('WEBGL_debug_renderer_info');
  const result = {
    source, count: splats?.count ?? 0, withPart, hdr, width, height,
    orbitMedianMilliseconds: Number(median(orbitTimes).toFixed(2)),
    stillMedianMilliseconds: Number(median(stillTimes).toFixed(2)),
    sortAndUploadMilliseconds: splats ? Number(splats.statistics.sortMilliseconds.toFixed(2)) : 0,
    visibleSplats: splats?.statistics.visibleCount ?? 0,
    gpuMebibytes: splats ? Number((splats.statistics[GPU_STAT] / 1048576).toFixed(1)) : 0,
    cpuMebibytes: splats ? Number((splats.statistics.cpuBytes / 1048576).toFixed(1)) : 0,
    jsHeapDeltaMebibytes: Number((((performance.memory?.usedJSHeapSize ?? 0) - heapBefore) / 1048576).toFixed(1)),
    prepareMilliseconds: Number(prepareMilliseconds.toFixed(0)),
    glError: context.getError(),
    graphics: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER),
    image,
  };
  renderer.dispose();
  return result;
}

window.runCase = runCase;
window.harnessReady = true;

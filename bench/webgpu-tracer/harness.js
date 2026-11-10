// Page side of the issue #625 timing: builds the demo room trace scene once, then traces it with the WebGPU tracer (traceWithWebGpu,
// wavefront or megakernel) or with the WebGL2 kernel (traceWithWebGl), undenoised, and returns timings and a tone mapped PNG.
import { createCamera, toneMapToRgba8 } from '/src/path-tracer.js';
import { buildTraceScene } from '/src/path-tracer-scene.js';

let prepared = null;

async function prepareScene(recipe, width, height) {
  const { createAgentScene, loadAllAgentSceneModules, needsMeshBooleans, loadMeshBooleans, setManifoldModuleLoader } = await import('/src/agent-scene.js');
  const { agentEnvironmentMap } = await import('/src/agent-look.js');
  await loadAllAgentSceneModules();
  if (needsMeshBooleans(recipe)) {
    setManifoldModuleLoader(() => import(/* @vite-ignore */ '/node_modules/manifold-3d/manifold.js'));
    await loadMeshBooleans();
  }
  const agentScene = createAgentScene(recipe);
  const environment = { ...agentScene.environment, map: agentEnvironmentMap(agentScene.environment) };
  const started = performance.now();
  const scene = buildTraceScene(agentScene.parts, environment);
  const camera = createCamera(agentScene.camera, width, height);
  prepared = { scene, camera, width, height };
  return { triangles: scene.indices.length / 3, buildSeconds: (performance.now() - started) / 1000 };
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

async function pngBase64(linear, width, height) {
  const rgba = toneMapToRgba8(linear, width, height, { viewTransform: 'aces', look: null });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// The first call compiles the kernel (its compileSeconds), so tracedSeconds is taken from a second, warm call.
async function traceWithWebGl(options) {
  const { traceOnGpu } = await import('/src/path-tracer-gpu.js');
  const { scene, camera } = prepared;
  const firstStarted = performance.now();
  const first = await traceOnGpu(scene, camera, options, () => {});
  const firstTotalSeconds = (performance.now() - firstStarted) / 1000;
  const started = performance.now();
  const traced = await traceOnGpu(scene, camera, options, () => {});
  const tracedSeconds = (performance.now() - started) / 1000;
  return { gpu: traced.gpu, compileSeconds: first.compileSeconds, firstTotalSeconds, tracedSeconds, image: await pngBase64(traced.color, options.width, options.height) };
}

// The first call compiles the kernel (its compileSeconds), so tracedSeconds is taken from a second, warm call. Upload to the
// card and readback are inside tracedSeconds, as they are for the WebGL2 kernel.
async function traceWithWebGpu(options, kernel) {
  const { traceOnWebGpu } = await import('/src/path-tracer-webgpu.js');
  const { scene, camera } = prepared;
  const firstStarted = performance.now();
  const first = await traceOnWebGpu(scene, camera, { ...options, samples: 1, kernel }, () => {});
  const firstTotalSeconds = (performance.now() - firstStarted) / 1000;
  const started = performance.now();
  const traced = await traceOnWebGpu(scene, camera, { ...options, kernel }, () => {});
  const tracedSeconds = (performance.now() - started) / 1000;
  return { gpu: traced.gpu, kernel, compileSeconds: first.compileSeconds, firstTotalSeconds, tracedSeconds, image: await pngBase64(traced.color, options.width, options.height) };
}

window.prepareScene = prepareScene;
window.traceWithWebGl = traceWithWebGl;
window.traceWithWebGpu = traceWithWebGpu;
window.harnessReady = true;

import { Renderer67 } from './renderer.js';
import { createSharedTextures, loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { createCascadedShadows } from './cascaded-shadows.js';
import { applyWaterReflection, attachWaterReflection } from './water-reflection.js';
import { createCameraSampler } from './camera-track.js';

// Headless twin of the showcase page for scripts/render-media.mjs (--scene file). The export script serves the scene.json
// at /__file/config.json with every asset path already pointing at a file it can read, and an optional camera track at
// /__file/camera.json. The renderer options, sky, exposure and frame effects are read exactly as src/showcase.js reads them.

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} is not available (${response.status})`);
  return response.json();
}

async function start() {
  const description = await readJson('/__file/config.json');
  const cameraResponse = await fetch('/__file/camera.json');
  const camera = cameraResponse.ok ? createCameraSampler(await cameraResponse.json()) : null;
  if (description.glbRest?.length || description.hdriPreview) throw new Error('Staged scene.json files (glbRest, hdriPreview) are not supported by --scene file yet.');
  const [model, map] = await Promise.all([
    fetch(description.glb).then(response => response.blob()),
    loadHdri(description.hdri, description.hdriOptions ?? {}),
  ]);
  const asset = await loadGltf(model, { baseUrl: new URL('.', new URL(description.glb, location.href)).href, sharedTextures: createSharedTextures(), ...(description.gltfOptions ?? {}) });
  const rendererOptions = description.renderer ?? {};
  const shadowCascades = rendererOptions.shadowCascades ? createCascadedShadows(rendererOptions.shadowCascades) : undefined;
  const reflection = description.waterReflection ? applyWaterReflection(asset.parts) : { parts: asset.parts, surface: null };
  const renderer = new Renderer67(document.querySelector('#file-viewport'), reflection.parts, {
    ground: false, hdr: true, samples: 4, memoryBudgetMiB: 384,
    ...rendererOptions,
    shadowCascades,
    environment: { ...(rendererOptions.environment ?? {}), map },
  });
  attachWaterReflection(renderer, reflection.surface, { updateEvery: 1 });
  const frame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}) };
  const renderAt = seconds => {
    const pose = camera ? camera.sample(seconds) : { eye: description.eye, target: description.target };
    renderer.render({ ...frame, ...pose });
  };
  window.__scene = { renderer, duration: camera?.duration, renderAt, pause() {} };
}

start().catch(error => {
  window.__fileSceneError = error.message;
  throw error;
});

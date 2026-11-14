import { Renderer67 } from './renderer.js';
import { createSharedTextures, loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { createCascadedShadows } from './cascaded-shadows.js';
import { applyWaterReflection, attachWaterReflection } from './water-reflection.js';
import { createCameraSampler } from './camera-track.js';
import { inWholeWorldOrder, readPartRanks } from './showcase-download.js';
import { withinDrawnLightLimits } from './drawn-light-lists.js';

// Headless twin of the showcase page for scripts/render-media.mjs (--scene file). The export script serves the scene.json
// at /__file/config.json with every asset path already pointing at a file it can read, and an optional camera track at
// /__file/camera.json. The renderer options, sky, exposure and frame effects are read exactly as src/showcase.js reads them.

// Loads the "glbRest" files with the first file's shared textures and joins every file's parts in the order the showcase page
// uses, so a headless frame matches the page. A scene with no "glbRest" keeps the first file's parts as they are.
async function loadStagedParts(description, asset, model, sharedTextures) {
  const restPaths = description.glbRest ?? [];
  if (!restPaths.length) return asset.parts;
  const files = [{ parts: asset.parts, ranks: await readPartRanks(model) }];
  for (const restPath of restPaths) {
    const restModel = await fetch(restPath).then(response => response.blob());
    const baseUrl = new URL('.', new URL(restPath, location.href)).href;
    const rest = await loadGltf(restModel, { baseUrl, sharedTextures, ...(description.gltfOptions ?? {}) });
    files.push({ parts: rest.parts, ranks: await readPartRanks(restModel) });
  }
  await import('./replace-textured-parts.js');
  return inWholeWorldOrder(files);
}

// The native path tracer takes more lights of one kind than a drawn frame does. With `?traceLights=1` (set by
// scripts/render-file-native.mjs, whose picture is traced from `window.__scene.environment`, not drawn) the renderer of this
// page gets the first lights of each kind that fit, so it starts. Without the parameter the lists are untouched and a list
// that is too long fails as before.
function environmentForRenderer(environment) {
  if (!new URLSearchParams(location.search).has('traceLights')) return environment;
  return withinDrawnLightLimits(environment);
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} is not available (${response.status})`);
  return response.json();
}

async function start() {
  const description = await readJson('/__file/config.json');
  const cameraResponse = await fetch('/__file/camera.json');
  const camera = cameraResponse.ok ? createCameraSampler(await cameraResponse.json()) : null;
  const [model, map] = await Promise.all([
    fetch(description.glb).then(response => response.blob()),
    loadHdri(description.hdri, description.hdriOptions ?? {}),
  ]);
  const sharedTextures = createSharedTextures();
  const gltfOptions = description.gltfOptions ?? {};
  const asset = await loadGltf(model, { baseUrl: new URL('.', new URL(description.glb, location.href)).href, sharedTextures, ...gltfOptions });
  asset.parts = await loadStagedParts(description, asset, model, sharedTextures);
  const rendererOptions = description.renderer ?? {};
  const shadowCascades = rendererOptions.shadowCascades ? createCascadedShadows(rendererOptions.shadowCascades) : undefined;
  const reflection = description.waterReflection ? applyWaterReflection(asset.parts) : { parts: asset.parts, surface: null };
  const renderer = new Renderer67(document.querySelector('#file-viewport'), reflection.parts, {
    ground: false, hdr: true, samples: 4, memoryBudgetMiB: 384,
    ...rendererOptions,
    shadowCascades,
    environment: { ...environmentForRenderer(rendererOptions.environment ?? {}), map },
  });
  attachWaterReflection(renderer, reflection.surface, { updateEvery: 1 });
  const frame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}) };
  const renderAt = seconds => {
    const pose = camera ? camera.sample(seconds) : { eye: description.eye, target: description.target };
    renderer.render({ ...frame, ...pose });
  };
  // `parts` and `environment` let scripts/render-file-native.mjs pack the same scene for the native path tracer.
  window.__scene = { renderer, duration: camera?.duration, renderAt, pause() {}, parts: reflection.parts, environment: { ...(rendererOptions.environment ?? {}), map } };
}

start().catch(error => {
  window.__fileSceneError = error.message;
  throw error;
});

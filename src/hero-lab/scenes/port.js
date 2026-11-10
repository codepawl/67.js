// Scene 3: the container port at dusk. Staged like the showcase page: the first part of the world and a small sky draw the
// opening frame, the other parts stream in behind it and are swapped in whole, then the full sky replaces the small one.
import { Renderer67 } from '../../renderer.js';
import { createSharedTextures, loadGltf } from '../../gltf.js';
import { loadHdri } from '../../hdri.js';
import { createCascadedShadows } from '../../cascaded-shadows.js';
import { applyWaterReflection, attachWaterReflection } from '../../water-reflection.js';
import { readPartRanks } from '../../showcase-download.js';
import { createCameraSpline } from '../camera-spline.js';

const SCENE_URL = '/showcase/port/scene.json';

// A slow arc around the berth from the sea side: high over the ship and cranes, past the crane legs, then low along the quay road into the low sun.
const cameraAt = createCameraSpline([
  { at: 0, eye: [-20, 130, -300], target: [0, -10, 10], fov: 38 },
  { at: 0.35, eye: [-150, 60, -150], target: [0, 20, 20], fov: 40 },
  { at: 0.68, eye: [30, 34, -170], target: [20, 26, 10], fov: 42 },
  { at: 1, eye: [205, 24, -62], target: [0, 22, 0], fov: 45 },
]);

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} is not available (${response.status})`);
  return response.blob();
}

function inWholeWorldOrder(files) {
  if (files.some(file => !file.ranks || file.ranks.length !== file.parts.length)) return files.flatMap(file => file.parts);
  const ranked = files.flatMap(file => file.parts.map((part, index) => ({ part, rank: file.ranks[index] })));
  return ranked.sort((first, second) => first.rank - second.rank).map(entry => entry.part);
}

export async function createScene(canvas) {
  const description = await (await fetch(SCENE_URL)).json();
  const baseUrl = new URL('.', new URL(description.glb, location.href)).href;
  const restDownloads = Promise.all((description.glbRest ?? []).map(path => fetchBlob(path)));
  restDownloads.catch(() => {});
  const fullSkyDownload = fetchBlob(description.hdri);
  fullSkyDownload.catch(() => {});
  const [model, previewSky] = await Promise.all([fetchBlob(description.glb), loadHdri(description.hdriPreview, description.hdriOptions)]);
  const sharedTextures = createSharedTextures();
  const asset = await loadGltf(model, { baseUrl, sharedTextures, ...description.gltfOptions });
  const options = description.renderer;
  const reflection = description.waterReflection ? applyWaterReflection(asset.parts) : { parts: asset.parts, surface: null };
  const renderer = new Renderer67(canvas, reflection.parts, {
    ...options,
    pixelRatio: Math.min(devicePixelRatio, 1.25),
    memoryBudgetMiB: 512,
    shadowCascades: createCascadedShadows(options.shadowCascades),
    environment: { ...options.environment, map: previewSky },
  });
  window.__hero.stageOneReadyMs = Math.round(performance.now());
  let detachReflection = attachWaterReflection(renderer, reflection.surface);
  const frame = { ...description.frame, exposure: description.exposure ?? 1 };
  const state = { complete: false, frame };

  async function finishWorld() {
    const blobs = await restDownloads;
    const files = [{ parts: asset.parts, ranks: await readPartRanks(model) }];
    for (const [index, blob] of blobs.entries()) {
      const restBase = new URL('.', new URL(description.glbRest[index], location.href)).href;
      const remaining = await loadGltf(blob, { baseUrl: restBase, sharedTextures, ...description.gltfOptions });
      files.push({ parts: remaining.parts, ranks: await readPartRanks(blob) });
    }
    await import('../../replace-textured-parts.js');
    const allParts = inWholeWorldOrder(files);
    const whole = description.waterReflection ? applyWaterReflection(allParts) : { parts: allParts, surface: null };
    renderer.replaceParts(whole.parts);
    detachReflection();
    detachReflection = attachWaterReflection(renderer, whole.surface);
    const fullSky = await loadHdri(description.hdri, { ...description.hdriOptions, fetchImplementation: async () => new Response(await fullSkyDownload) });
    state.frame = { ...frame, environment: { map: fullSky } };
    state.complete = true;
    window.dispatchEvent(new Event('hero-scene-complete'));
  }
  const completion = finishWorld().catch(error => { state.error = error; });

  return {
    label: 'A container port at dusk',
    openHref: '/showcase.html?scene=port',
    ambient: false,
    staticProgress: 0.3,
    state,
    completion,
    // The poster stays up until the whole world is in: the first stage alone is a bare hull on open water.
    ready: completion,
    render(progress, seconds, override) {
      renderer.render({ ...state.frame, ...(override ?? cameraAt(progress)), time: seconds });
    },
    resize: () => renderer.resize(),
    dispose: () => renderer.dispose(),
  };
}

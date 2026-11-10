// One showcase world for the hero loop, built in two steps so the next world can be fetched while the current one plays:
//   fetchWorld(descriptionUrl)  network only: the description, every GLB part and the sky, held as blobs.
//   buildWorld(download, canvas) parses the parts, uploads them to the GPU and returns a world that draws on that canvas.
// A world is whole before it is shown: the loop never draws the first part of a split world on its own.
import { Renderer67 } from '../../renderer.js';
import { createSharedTextures, loadGltf } from '../../gltf.js';
import { loadHdri } from '../../hdri.js';
import { createCascadedShadows } from '../../cascaded-shadows.js';
import { applyWaterReflection, attachWaterReflection } from '../../water-reflection.js';
import { readPartRanks } from '../../showcase-download.js';

// The water mirror is off in the loop: once the camera moves between two draws the port world drew only its sky (the same happens
// on hero-b.html?scene=port when the camera is set by hand; with the mirror off every pose draws). Turn it on again when that is fixed.
const WATER_MIRROR_ENABLED = false;

async function fetchBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} is not available (${response.status})`);
  return response.blob();
}

function baseUrlOf(path) {
  return new URL('.', new URL(path, location.href)).href;
}

function inWholeWorldOrder(files) {
  if (files.some(file => !file.ranks || file.ranks.length !== file.parts.length)) return files.flatMap(file => file.parts);
  const ranked = files.flatMap(file => file.parts.map((part, index) => ({ part, rank: file.ranks[index] })));
  return ranked.sort((first, second) => first.rank - second.rank).map(entry => entry.part);
}

export async function fetchWorld(descriptionUrl) {
  const description = await (await fetch(descriptionUrl)).json();
  const paths = [description.glb, ...(description.glbRest ?? [])];
  const [models, sky] = await Promise.all([Promise.all(paths.map(fetchBlob)), fetchBlob(description.hdri)]);
  const bytes = models.reduce((total, model) => total + model.size, sky.size);
  return { description, paths, models, sky, bytes };
}

export async function buildWorld(download, canvas, overrides = {}) {
  const { description, paths, models, sky } = download;
  const sharedTextures = createSharedTextures();
  const files = [];
  for (const [index, model] of models.entries()) {
    const loaded = await loadGltf(model, { baseUrl: baseUrlOf(paths[index]), sharedTextures, ...description.gltfOptions });
    files.push({ parts: loaded.parts, ranks: await readPartRanks(model) });
  }
  const options = description.renderer;
  const environmentMap = await loadHdri(description.hdri, { ...description.hdriOptions, fetchImplementation: async () => new Response(sky) });
  const surfaceOf = parts => (description.waterReflection && WATER_MIRROR_ENABLED ? applyWaterReflection(parts) : { parts, surface: null });
  // The renderer starts on the first file's parts and takes the whole world through replaceParts, the order the showcase page
  // uses: a water mirror attached to a renderer built on the whole world drew nothing after its first frame.
  const firstReflection = surfaceOf(files[0].parts);
  const renderer = new Renderer67(canvas, firstReflection.parts, {
    ...options,
    ...overrides,
    pixelRatio: Math.min(devicePixelRatio, 1.25),
    memoryBudgetMiB: 512,
    ...(options.shadowCascades ? { shadowCascades: createCascadedShadows(options.shadowCascades) } : {}),
    environment: { ...options.environment, map: environmentMap },
  });
  let detachReflection = attachWaterReflection(renderer, firstReflection.surface);
  if (files.length > 1) {
    await import('../../replace-textured-parts.js');
    const whole = surfaceOf(inWholeWorldOrder(files));
    renderer.replaceParts(whole.parts);
    detachReflection();
    detachReflection = attachWaterReflection(renderer, whole.surface);
  }
  const frame = { ...description.frame, exposure: description.exposure ?? 1 };
  return {
    id: description.id,
    title: description.title,
    description,
    canvas,
    render(camera, seconds) {
      renderer.render({ ...frame, eye: camera.eye, target: camera.target, fov: camera.fov, time: seconds });
    },
    resize: () => renderer.resize(),
    dispose() {
      detachReflection();
      renderer.dispose();
      canvas.remove();
    },
  };
}

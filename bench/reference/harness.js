// Runs in the page: draws one reference scene, and describes it as plain data for Blender.
import { useCompactColor } from '/src/compact-color.js';
import { Renderer67 } from '/src/renderer.js';
import { REFERENCE_SCENES, KHRONOS_SCENES, KTX2_SCENES, loadBarnLampVariant, CLOTH_SCENES } from './scenes.js';
import { GRAND_SCENES } from './grand-scenes.js';
import { LOOK_OPTIONS, GRAND_PICKS } from './look-options.js';
import { skinnedGeometry } from '/src/path-tracer-scene.js';
import { boxProjectedGeometry } from '/src/export-box-uv.js';
import '/src/material-layer-shaders.js';
import '/src/view-transform-shader.js';
import '/src/liquid-shader.js';
import '/src/splat-shader.js';
import '/src/subsurface-shader.js';
import '/src/fog-shader.js';
import { skyOpenness } from '/src/closed-room.js';
import { fogSkyVisibility } from '/src/fog-sky-visibility.js';
import { createCascadedShadows } from '/src/cascaded-shadows.js';
import { applyLightLinks } from '/src/light-linking.js';
import { applyWaterReflection, attachWaterReflection } from '/src/water-reflection.js';
import { attachScreenSpaceWater } from './ssr-water.js';
import { groundBounceEnvironment } from '/src/ground-bounce.js';
import { withSunBounce } from '/src/sun-bounce.js';
import { applyDefaultFloorSky, applyFloorSkyVisibility } from '/src/floor-sky-visibility.js';
import { installReversedDepth } from '/src/reversed-depth.js';

// Water reflection is on the way a recipe gets it: found from the materials, no field. ?water=off draws the scenes without it, ?water=ssr with the screen-space reflection it was compared with.
// Ground bounce is on the way a recipe gets it: found from the floor part, no field. ?groundBounce=off draws the scenes without it.
const GROUND_BOUNCE = new URLSearchParams(location.search).get('groundBounce') !== 'off';

// The scene's environment with the light its floor bounces, when it has a plain one and nothing else gives that light (a bake, a closed room).
function withDerivedGroundBounce(scene, drawnParts) {
  const lit = GROUND_BOUNCE ? groundBounceEnvironment(drawnParts, scene.environment) : scene.environment;
  // ?sunBounce=<n> sets environment.sunBounce on every scene (default 1, 0 draws without the sunlit patches' lights).
  const sunBounce = new URLSearchParams(location.search).get('sunBounce');
  const started = performance.now();
  const withLights = withSunBounce(drawnParts, sunBounce === null ? lit : { ...lit, sunBounce: Number(sunBounce) });
  // The time the sunlit patches took to find (the search runs once for these parts; later calls hit the cache), read by render-gpu.mjs.
  window.sunBounceSeconds = Math.max(window.sunBounceSeconds ?? 0, (performance.now() - started) / 1000);
  window.sunBounceLights = (withLights.pointLights ?? []).slice((lit.pointLights ?? []).length);
  return withSunBounceExperiment(withLights, (lit.pointLights ?? []).length);
}

// ?sunBounceRange=<k> cuts each sunlit patch's light off at k times its height above the patch, and ?sunBounceGain=<g> multiplies
// its intensity: switches for fitting the bounce, not used by a recipe.
function withSunBounceExperiment(environment, ownLightCount) {
  const query = new URLSearchParams(location.search);
  const rangeFactor = query.get('sunBounceRange');
  const gain = query.get('sunBounceGain');
  if ((rangeFactor === null && gain === null) || !environment.pointLights || environment.pointLights.length === ownLightCount) return environment;
  const pointLights = environment.pointLights.map((light, index) => (index < ownLightCount ? light : {
    ...light,
    range: rangeFactor === null ? light.range : Number(rangeFactor) * light.radius,
    intensity: light.intensity * (gain === null ? 1 : Number(gain)),
  }));
  return { ...environment, pointLights };
}

// ?reversedDepth=on draws with reversed-Z (issue #310); the scenes draw with the standard depth buffer otherwise.
const COMPACT_COLOR = new URLSearchParams(location.search).get('compactColor') === 'on';
const REVERSED_DEPTH = new URLSearchParams(location.search).get('reversedDepth') === 'on';

const WATER_REFLECTION = { off: false, ssr: 'ssr' }[new URLSearchParams(location.search).get('water')] ?? 'planar';

// The scenes draw with the default of the recipe path: a closed room a sun lights gets the floor sky trace (applyDefaultFloorSky, the same call
// createAgentScene makes), and environment.floorSkyTrace: false turns it off. ?floorSky=0 sets that opt-out on every scene. ?floorSky=<strength>
// is an experiment that traces every floor at that strength instead, and ?floorSkyRooms=1 adds the closed rooms to it.
const FLOOR_SKY_PARAMETER = new URLSearchParams(location.search).get('floorSky');
const FLOOR_SKY_EXPERIMENT = FLOOR_SKY_PARAMETER !== null && FLOOR_SKY_PARAMETER !== '0';
const floorSkyReports = {};
// ?glossy=0 is a measurement switch (issue #506): every material loses its metallic and specular, so the frame shows diffuse light and emission only.
const GLOSSY_OFF = new URLSearchParams(location.search).get('glossy') === '0';

function removeGlossy(scene) {
  for (const part of scene.parts) part.material = { ...part.material, metallic: 0, specular: 0, clearcoat: 0 };
}

function withFloorSky(id, parts, scene) {
  const environment = FLOOR_SKY_PARAMETER === '0' ? { ...scene.environment, floorSkyTrace: false } : scene.environment;
  const result = FLOOR_SKY_EXPERIMENT
    ? applyFloorSkyVisibility(parts, { strength: Number(FLOOR_SKY_PARAMETER), includeClosedRooms: new URLSearchParams(location.search).get('floorSkyRooms') === '1' })
    : applyDefaultFloorSky(parts, environment);
  if (result.report) floorSkyReports[id] = result.report;
  return result.parts;
}

// ?set=khronos draws the Khronos sample assets (npm run reference -- --khronos) and ?set=cloth the cloth scenes
// (npm run reference -- --cloth) instead of the fixed scenes.
const SCENE_SETS = { khronos: KHRONOS_SCENES, ktx2: KTX2_SCENES, cloth: CLOTH_SCENES, grand: { ...GRAND_SCENES, ...GRAND_PICKS }, look: LOOK_OPTIONS };
const SCENES = SCENE_SETS[new URLSearchParams(location.search).get('set')] ?? REFERENCE_SCENES;

function encodeBytes(typedArray) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  let text = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(text);
}

// With an image table, each ImageData is written once into the table and its place holds { imageId }, so a scene with
// thousands of parts that share a leaf texture does not repeat the pixels in every material.
function plainData(value, imageTable = null) {
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, base64: encodeBytes(value) };
  if (value instanceof ImageData) {
    if (!imageTable) return { width: value.width, height: value.height, data: plainData(value.data) };
    if (!imageTable.ids.has(value)) {
      imageTable.ids.set(value, imageTable.images.length);
      imageTable.images.push({ width: value.width, height: value.height, data: plainData(value.data) });
    }
    return { imageId: imageTable.ids.get(value) };
  }
  if (Array.isArray(value)) return value.map(entry => plainData(entry, imageTable));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry !== 'function') result[key] = plainData(entry, imageTable);
    }
    return result;
  }
  return value;
}

// Parts that look the same share one entry of the scene's material list.
function materialTable() {
  const imageTable = { ids: new Map(), images: [] };
  const entries = [];
  const indexByText = new Map();
  function indexOf(material) {
    const described = plainData(material, imageTable);
    const text = JSON.stringify(described);
    if (!indexByText.has(text)) {
      indexByText.set(text, entries.length);
      entries.push(described);
    }
    return indexByText.get(text);
  }
  return { indexOf, entries, images: imageTable.images };
}

// A pattern material is box projected in the shader and has no UVs. Blender gets the same projection written as UVs,
// per part, because the projection depends on the part's scale.
function boxProjectedFor(part, cache) {
  const boxMapScale = part.material.boxMapScale;
  if (!(boxMapScale > 0) || part.geometry.uvs) return part.geometry;
  const { matrix } = part;
  const scale = [0, 1, 2].map(column => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]));
  const key = `${scale.join(',')}|${boxMapScale}|${part.material.boxMapAxis ?? 1}`;
  if (!cache.has(part.geometry)) cache.set(part.geometry, new Map());
  const byScale = cache.get(part.geometry);
  if (!byScale.has(key)) byScale.set(key, boxProjectedGeometry(part.geometry, scale, boxMapScale, part.material.boxMapAxis ?? 1));
  return byScale.get(key);
}

// Blender's glTF importer cannot reproduce this rig's pose (three.js and 67js agree on it), so Blender gets the
// skinned result as plain geometry. A score then measures shading, and not an importer's pose.
function describeScene(id, scene) {
  const { map: _map, ...environment } = scene.environment;
  // A sample asset reaches Blender as its own file, not as parts.
  if (scene.glb) return { id, camera: scene.camera, environment, world: scene.blenderWorld, glb: scene.glb, parts: [], geometries: [] };
  const geometries = new Map();
  const boxProjected = new Map();
  const materials = materialTable();
  const describedParts = scene.parts.map(part => {
    const geometry = part.skin ? skinnedGeometry(part) : boxProjectedFor(part, boxProjected);
    if (!geometries.has(geometry)) geometries.set(geometry, geometries.size);
    return { name: part.name, geometry: geometries.get(geometry), matrix: [...part.matrix], material: materials.indexOf(part.material) };
  });
  return {
    id, camera: scene.camera, environment, world: scene.blenderWorld, blenderCloth: scene.blenderCloth, brightRegion: scene.brightRegion,
    materials: materials.entries, images: materials.images,
    parts: describedParts,
    geometries: [...geometries.keys()].map(({ positions, normals, uvs, colors, indices }) => plainData({ positions, normals, uvs, colors, indices })),
  };
}

// Blender always gets the original parts: the bake is 67js's approximation of what Cycles computes.
async function bakeScene(scene, bakeOptions) {
  if (bakeOptions.preset) {
    return bakeScenePreset(scene, bakeOptions.preset, bakeOptions.irradianceGrid, { bounces: bakeOptions.bounces, gridFog: bakeOptions.gridFog });
  }
  const { bakeLightmapsAsync } = await import('/src/light-bake-gpu.js');
  const { pointLights, keyColor, lightDirection } = scene.environment;
  const started = performance.now();
  // A scene as large as a hall can need its own texel density to stay under the bake's texel limit.
  const baked = await bakeLightmapsAsync(scene.parts, { pointLights, keyColor, lightDirection }, { ...scene.bakeOptions, ...bakeOptions });
  return { parts: baked.parts, report: baked.report, seconds: (performance.now() - started) / 1000 };
}

// The bake an agent gets from `bake: { preset }`: the same settings and budget fit as a recipe. Probes stay out of it and come
// from --probes, as in the other rows.
async function bakeScenePreset(scene, preset, irradianceGrid = false, overrides = {}) {
  const { normalizeAgentBake, bakeAgentParts } = await import('/src/agent-bake.js');
  const settings = normalizeAgentBake({ preset, probes: false, ...(overrides.bounces ? { bounces: overrides.bounces } : {}), ...(irradianceGrid ? { irradianceGrid } : {}), ...(overrides.gridFog ? { gridFog: true } : {}) });
  const started = performance.now();
  let baked;
  try {
    // The recipe path bakes on a kernel worker (90 s); ?kernelWorkers=off keeps the page's thread (20 s) to compare.
    const { buildWithKernels } = await import('/src/kernel-offload.js');
    const available = new URLSearchParams(location.search).get('kernelWorkers') !== 'off';
    baked = await buildWithKernels(() => bakeAgentParts(scene.parts, new Map(scene.parts.map(part => [part.name, part.matrix])), scene.environment, settings), { available: available && typeof Worker === 'function' });
  } catch (error) {
    // A recipe would get this error and no bake: the scene is drawn unbaked and the row says so.
    return { parts: scene.parts, report: { refused: error.message, texels: 0 }, seconds: 0 };
  }
  return { parts: baked.parts, report: baked.report, seconds: (performance.now() - started) / 1000 };
}

// The 67js renderer for a scene: light linking from the lights' affects lists, and cascaded sun shadows when asked for.
function createSceneRenderer(parts, scene, cascades, { water = WATER_REFLECTION } = {}) {
  const reflecting = water === 'planar' ? applyWaterReflection(parts) : { parts, surface: null };
  const renderer = new Renderer67(document.querySelector('canvas'), applyLightLinks(reflecting.parts, scene.environment), {
    ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: true,
    environment: scene.environment, shadowBounds: scene.shadow, shadowCascades: cascades ? createCascadedShadows({ count: cascades }) : null, skyOpenness, fogSkyVisibility,
  });
  if (COMPACT_COLOR) useCompactColor(renderer);
  if (REVERSED_DEPTH) installReversedDepth(renderer, true);
  attachWaterReflection(renderer, reflecting.surface);
  if (water === 'ssr') {
    attachScreenSpaceWater(renderer, parts);
  }
  return renderer;
}

// Probes are traced from the original parts and placed on whichever parts the scene draws (baked or not). An open scene has
// no automatic probe, so these name one by hand.
const PROBE_SPECIFICATIONS = { 'material-spheres': [{ position: [0, 1.6, 0] }], metal: [{ position: [0.2, 1, 0.9] }] };

async function probeScene(scene, id, drawnParts, mode) {
  const { placeProbes, traceObjectProbes, traceProbes } = await import('/src/reflection-probes.js');
  const { pointLights, keyColor, lightDirection, map } = scene.environment;
  const started = performance.now();
  const lighting = { pointLights, keyColor, lightDirection };
  const options = { environment: scene.environment, environmentMap: map, rotation: map?.rotation ?? 0 };
  const trace = mode === 'objects' ? traceObjectProbes(scene.parts, lighting, options) : traceProbes(scene.parts, lighting, PROBE_SPECIFICATIONS[id] ?? 'room', options);
  const placed = placeProbes(drawnParts, trace, { rotation: map?.rotation ?? 0 });
  return { parts: placed.parts, report: placed.report, seconds: (performance.now() - started) / 1000 };
}

async function renderReferenceScene(id, { describe, ambientOcclusion = 0, ambientOcclusionRadius = 0.5, bake = null, cascades = 0, backgroundOnly = false, probes = false, ambient = null, fill = null, key = null, viewTransform = null, bloom = null, volumeFog = null }) {
  const scene = await SCENES[id]();
  if (GLOSSY_OFF) removeGlossy(scene);
  // A view transform (agx, neutral) replaces the ACES fit in the shaders, as environment.viewTransform does in a recipe.
  if (viewTransform) scene.environment = { ...scene.environment, viewTransform };
  // A measurement switch: 0 removes the world's light from every surface, to show how much of a picture comes from it.
  if (ambient !== null) scene.environment = { ...scene.environment, ambientIntensity: ambient };
  if (fill !== null) scene.environment = { ...scene.environment, fillIntensity: fill };
  if (key !== null) scene.environment = { ...scene.environment, keyIntensity: key };
  // Fields merged into the scene's volumeFog, to compare fog controls on the same scene.
  if (volumeFog) scene.environment = { ...scene.environment, volumeFog: { ...scene.environment.volumeFog, ...volumeFog } };
  const baked = bake ? await bakeScene(scene, bake) : null;
  const probed = probes ? await probeScene(scene, id, baked ? baked.parts : scene.parts, probes) : null;
  scene.environment = withDerivedGroundBounce(scene, probed ? probed.parts : baked ? baked.parts : scene.parts);
  const canvas = document.querySelector('canvas');
  // backgroundOnly draws the sky alone, so a score can be limited to the pixels the asset covers.
  const renderer = createSceneRenderer(backgroundOnly ? [] : withFloorSky(id, probed ? probed.parts : baked ? baked.parts : scene.parts, scene), scene, cascades);
  renderer.resize();
  // Blender draws a still scene. The renderer's default wind (0.3) would move the leaf cards by up to four pixels at time 0.
  const frame = { ...scene.camera, environment: scene.environment, time: 0, wind: 0, exposure: 1, effects: { ambientOcclusion, ambientOcclusionRadius, ...(bloom ? { bloom } : {}) } };
  renderer.render(frame);
  renderer.render(frame);
  const debug = renderer.context.getExtension('WEBGL_debug_renderer_info');
  const result = {
    image: canvas.toDataURL('image/png').split(',')[1],
    glError: renderer.context.getError(),
    graphics: renderer.context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : renderer.context.RENDERER),
    description: describe ? describeScene(id, scene) : null,
    bake: baked ? { seconds: baked.seconds, report: baked.report } : null,
    probes: probed ? { seconds: probed.seconds, report: probed.report } : null,
    floorSky: floorSkyReports[id] ?? null,
    bounce: scene.environment.map?.bounce ?? null,
  };
  renderer.dispose();
  return result;
}

// Frame time of one scene with and without the light bake: a bake only adds an emissive map to each part, so this shows what it costs to draw.
async function measureReferenceFrameTime(id, { bake, probes = false, cascades = 0, orbit = false, water = WATER_REFLECTION, glowMipChain = true, warmupFrames = 20, measuredFrames = 200 }) {
  const scene = await SCENES[id]();
  const baked = bake ? await bakeScene(scene, {}) : null;
  const probed = probes ? await probeScene(scene, id, baked ? baked.parts : scene.parts, probes) : null;
  scene.environment = withDerivedGroundBounce(scene, probed ? probed.parts : baked ? baked.parts : scene.parts);
  const renderer = createSceneRenderer(withFloorSky(id, probed ? probed.parts : baked ? baked.parts : scene.parts, scene), scene, cascades, { water });
  renderer.resize();
  const frame = { ...scene.camera, environment: scene.environment, time: 0, exposure: 1, effects: { ambientOcclusion: 0, ambientOcclusionRadius: 0.5 } };
  // With orbit the camera moves a little every frame, so cascaded maps have to be redrawn each time, as in a camera move.
  const orbitedEye = index => [scene.camera.eye[0] + Math.sin(index * 0.05) * 0.5, scene.camera.eye[1], scene.camera.eye[2]];
  // finish() returns before a hardware GPU is done, so reading one pixel back is what waits for the frame.
  const pixel = new Uint8Array(4);
  const finishDrawing = () => renderer.context.readPixels(0, 0, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
  for (let index = 0; index < warmupFrames; index++) {
    renderer.render(orbit ? { ...frame, eye: orbitedEye(index) } : frame);
    finishDrawing();
  }
  // glowMipChain false stops the fog from rebuilding the frame's mip chain after warm-up. The mips stay as the last warm-up frame
  // left them, so sampling costs the same and the difference is the cost of generating them.
  if (!glowMipChain) {
    renderer.context.generateMipmap = () => {};
  }
  const frameMilliseconds = [];
  for (let index = 0; index < measuredFrames; index++) {
    const started = performance.now();
    renderer.render(orbit ? { ...frame, eye: orbitedEye(index) } : frame);
    finishDrawing();
    frameMilliseconds.push(performance.now() - started);
  }
  renderer.dispose();
  frameMilliseconds.sort((first, second) => first - second);
  const total = frameMilliseconds.reduce((sum, value) => sum + value, 0);
  return { baked: Boolean(bake), probes: Boolean(probes), water, glowMipChain, frames: measuredFrames, meanMilliseconds: total / measuredFrames,
    medianMilliseconds: frameMilliseconds[Math.floor(measuredFrames / 2)], p95Milliseconds: frameMilliseconds[Math.floor(measuredFrames * 0.95)] };
}

// The light each baked part holds, in linear radiance: the lightmap bytes decoded from sRGB and multiplied by the map's peak.
function lightmapRadiance(part) {
  const texture = part.material.lightMap ?? part.material.emissiveMap;
  if (!texture) return null;
  const peak = part.material.lightMap ? part.material.lightMapScale : part.material.emission;
  const bytes = texture.image.data;
  const radiance = new Float32Array((bytes.length / 4) * 3);
  for (let texel = 0; texel < bytes.length / 4; texel++) {
    for (let channel = 0; channel < 3; channel++) {
      const encoded = bytes[texel * 4 + channel] / 255;
      radiance[texel * 3 + channel] = (encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4) * peak;
    }
  }
  return radiance;
}

// Bakes a scene once per named variant of options (each may set `backend`) and compares every lightmap with the first variant's:
// seconds, and the mean of the gaps between lightmaps as a share of the first one's light. The GPU kernel is compiled by a
// one-sample bake before the first GPU variant, so the seconds measured are the trace.
async function compareBakeBackends(id, variants) {
  const scene = await SCENES[id]();
  const results = {};
  let reference = null;
  for (const [name, bakeOptions] of Object.entries(variants)) {
    if (bakeOptions.backend === 'gpu') await bakeScene(scene, { ...bakeOptions, samples: 1 });
    const baked = await bakeScene(scene, bakeOptions);
    const radiance = baked.parts.map(lightmapRadiance);
    reference ??= radiance;
    let referenceSum = 0;
    let bakedSum = 0;
    let differenceSum = 0;
    radiance.forEach((partRadiance, index) => {
      if (!partRadiance || !reference[index]) return;
      for (let value = 0; value < partRadiance.length; value++) {
        referenceSum += reference[index][value];
        bakedSum += partRadiance[value];
        differenceSum += Math.abs(partRadiance[value] - reference[index][value]);
      }
    });
    const { texels, rayWork, used, gpu, gpuCompileSeconds } = baked.report;
    results[name] = { seconds: baked.seconds, texels, rayWork, used, gpu, gpuCompileSeconds, meanRatioToFirst: bakedSum / referenceSum, meanGapShareOfFirst: differenceSum / referenceSum };
  }
  return results;
}

window.measureReferenceFrameTime = measureReferenceFrameTime;
window.compareBakeBackends = compareBakeBackends;

async function renderReferencePathTraced(id, options) {
  const scene = await REFERENCE_SCENES[id]();
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const result = await renderPathTracedImage({ parts: applyLightLinks(scene.parts, scene.environment), environment: scene.environment, camera: scene.camera }, options);
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  canvas.getContext('2d').putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  return { image: canvas.toDataURL('image/png').split(',')[1], report: result.report };
}

function floatsToBase64(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

// The untouched tracer output (no denoiser) with its feature images, so denoisers can be compared on the same noisy pixels.
async function renderReferencePathTracedFeatures(id, options) {
  const scene = await REFERENCE_SCENES[id]();
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const result = await renderPathTracedImage({ parts: applyLightLinks(scene.parts, scene.environment), environment: scene.environment, camera: scene.camera }, { ...options, denoise: false });
  const features = {};
  for (const [name, values] of Object.entries(result.features)) features[name] = floatsToBase64(values);
  return { features, report: result.report };
}

window.renderReferencePathTracedFeatures = renderReferencePathTracedFeatures;

// Builds the parts, environment and camera of a scene recipe the way an agent render job does.
async function loadRecipeTraceScene(recipe) {
  const { createAgentScene, loadAllAgentSceneModules, needsMeshBooleans, loadMeshBooleans, setManifoldModuleLoader } = await import('/src/agent-scene.js');
  const { agentEnvironmentMap } = await import('/src/agent-look.js');
  await loadAllAgentSceneModules();
  if (needsMeshBooleans(recipe)) {
    setManifoldModuleLoader(() => import(/* @vite-ignore */ '/node_modules/manifold-3d/manifold.js'));
    await loadMeshBooleans();
  }
  const scene = createAgentScene(recipe);
  const environment = scene.environment;
  return { parts: scene.parts, environment: { ...environment, map: agentEnvironmentMap(environment) }, camera: scene.camera };
}

// Traces a scene recipe the way an agent render job does (parts, environment map and camera of the agent scene).
async function renderRecipePathTraced(recipe, options) {
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const result = await renderPathTracedImage(await loadRecipeTraceScene(recipe), options);
  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  canvas.getContext('2d').putImageData(new ImageData(result.rgba, result.width, result.height), 0, 0);
  return { image: canvas.toDataURL('image/png').split(',')[1], report: result.report };
}

window.renderRecipePathTraced = renderRecipePathTraced;
window.renderReferenceScene = renderReferenceScene;
window.loadBarnLampVariant = loadBarnLampVariant;
window.renderReferencePathTraced = renderReferencePathTraced;
window.referenceSceneIds = Object.keys(SCENES);

async function loadTraceSceneFor(source) {
  if (typeof source === 'string') {
    const scene = await REFERENCE_SCENES[source]();
    return { parts: applyLightLinks(scene.parts, scene.environment), environment: scene.environment, camera: scene.camera };
  }
  return loadRecipeTraceScene(source);
}

function rgbaToBase64Png(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

const median = values => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];

// Draws a scene progressively (issue #623) and saves the image after each count in `checkpoints` (samples at full size).
// `stepSeconds` is the time of the drawing steps alone (reduced sizes included), `snapshotSeconds` one read back and filter.
async function renderProgressiveCheckpoints(source, options, checkpoints) {
  const scene = await loadTraceSceneFor(source);
  const { createProgressiveTracer } = await import('/src/path-tracer-progressive.js');
  const setupStarted = performance.now();
  const tracer = await createProgressiveTracer(scene, options);
  const setupSeconds = (performance.now() - setupStarted) / 1000;
  const results = [];
  let stepSeconds = 0;
  for (let stepIndex = 0; results.length < checkpoints.length; stepIndex++) {
    const started = performance.now();
    const drawn = await tracer.step();
    stepSeconds += (performance.now() - started) / 1000;
    const fullSamples = drawn.divisor === 1 ? drawn.samples : 0;
    if (fullSamples !== checkpoints[results.length]) continue;
    const snapshotStarted = performance.now();
    const snapshot = tracer.snapshot();
    const snapshotSeconds = (performance.now() - snapshotStarted) / 1000;
    results.push({ samples: fullSamples, stepSeconds, snapshotSeconds, image: rgbaToBase64Png(snapshot.rgba, snapshot.width, snapshot.height) });
  }
  const report = { gpu: tracer.gpu, compileSeconds: tracer.compileSeconds, setupSeconds };
  tracer.dispose();
  return { results, report };
}

// Time of one sample of every pixel at full size, `frames` times (the first `warmup` frames are not counted).
async function measureProgressiveFrameTime(source, options, frames = 200, warmup = 5) {
  const scene = await loadTraceSceneFor(source);
  const { createProgressiveTracer } = await import('/src/path-tracer-progressive.js');
  const tracer = await createProgressiveTracer(scene, options, { resolutionDivisors: [1] });
  const times = [];
  for (let frame = 0; frame < frames + warmup; frame++) {
    const started = performance.now();
    await tracer.step();
    if (frame >= warmup) times.push(performance.now() - started);
  }
  tracer.dispose();
  return { frames, medianMilliseconds: median(times), minimumMilliseconds: Math.min(...times), maximumMilliseconds: Math.max(...times) };
}

window.renderProgressiveCheckpoints = renderProgressiveCheckpoints;
window.measureProgressiveFrameTime = measureProgressiveFrameTime;

window.loadTraceSceneFor = loadTraceSceneFor;

import { encodeNativeTables, nativeTexelTracerIfAvailable } from './native-bake-page.js';
import { buildWithKernels, kernelWorkersAvailable, kernelStats, resetKernelStats } from '../src/kernel-offload.js';
import { createAgentScene, applyCameraFields, loadAllAgentSceneModules, allAgentSceneModulesLoaded, needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, setManifoldModuleLoader, needsPhysics, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader } from '../src/agent-scene.js';
import { Renderer67 } from '../src/renderer.js';
import { skyOpenness } from '../src/closed-room.js';
import { fogSkyVisibility } from '../src/fog-sky-visibility.js';
import { installCameraEffects, effectsWithFStop } from '../src/camera-effects.js';
import { installRenderPasses } from '../src/render-passes.js';
import { installMeshBlend, normalizeBlend } from '../src/mesh-blend.js';
import { installDepthPrecision } from '../src/reversed-depth.js';
import { applyProjection } from '../src/camera.js';
import { mat4 } from 'gl-matrix';
import { resolveAgentShadow, agentEnvironmentMap } from '../src/agent-look.js';
import { agentSceneModule, agentSceneModuleLoaded } from '../src/agent-scene-modules.js';
import { agentGroundPlacement, createAgentGround, placeAgentGround, FLOOR_COLOR } from '../src/agent-ground.js';
import { groundBounceEnvironment } from '../src/ground-bounce.js';
import { createAgentAssetScene } from '../src/agent-asset.js';
import { parseGltf } from '../src/gltf.js';
import { assetCopyKey, recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { exportGlb } from '../src/export.js';
import '../src/texture-update.js';
import { updatePartVertices } from '../src/update-part-vertices.js';
import { hasPatternTextures } from './agent-preview-textures.js';
import { TEXTURE_SEQUENCE_LIMITS } from '../src/texture-sequence-limits.js';
import { registerCatalogEnvironment, registerCatalogLook } from '../src/look-catalog.js';
import { parseRadianceHdr } from '../src/hdri.js';
import { parseCube } from '../src/view-transform.js';
import { weightTracksFromGltfAnimation } from '../src/export-skeleton.js';
import { clipFromGltfAnimation } from '../src/skeleton-pose.js';
import { sessionProblem } from '../src/agent-errors.js';
import { BRANCH_LIMITS, createBranchStore, printableLabel } from '../src/agent-branches.js';
import { agentAssetDecodeOptions, withCatalogLimitAdvice } from '../src/agent-asset-limits.js';
import { sceneQueryFor, summarizeWalkMap, walkOptionsFor, createQueryOnlyCache } from './agent-walkmap.js';

let active = null;
let canvas = document.querySelector('canvas');

function requireSession(sessionId) {
  if (!active || active.sessionId !== sessionId) {
    throw new Error(sessionProblem(sessionId, active?.sessionId));
  }
  return active;
}

function bytesFromBase64(data) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Other catalog assets whose clips a motion layer retargets: only their clips and nodes are kept, so the decoded
// meshes and textures are released at once.
async function decodeMotionSources(encoded = {}) {
  const decoded = {};
  for (const [assetId, data] of Object.entries(encoded)) {
    const source = await parseCatalogAsset(bytesFromBase64(data).buffer);
    decoded[assetId] = { animations: source.animations, nodes: source.nodes };
    source.dispose();
  }
  return decoded;
}

function validatePreviewCamera(camera) {
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  for (const aspect of [1 / 16, 16]) {
    const projection = applyProjection(mat4.create(), camera, aspect);
    const viewProjection = mat4.multiply(mat4.create(), projection, view);
    if (![projection, viewProjection].every(matrix => matrix.every(Number.isFinite))) {
      throw new RangeError('Camera matrices must remain finite for all supported preview aspect ratios.');
    }
  }
}

function candidateCamera(record, operations) {
  const camera = record.scene.exportRecipe().camera;
  for (const operation of operations) {
    if (operation.type === 'set-camera') {
      applyCameraFields(camera, operation);
    }
  }
  return createAgentScene({ format: '67js.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], camera }).camera;
}

function renderInfo(renderer) {
  const context = renderer.context;
  const debug = context.getExtension('WEBGL_debug_renderer_info');
  return {
    graphics: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER),
    estimatedBytes: renderer.memoryPlan.estimatedBytes,
    width: canvas.width,
    height: canvas.height,
    samples: renderer.capabilities.samples,
    hdr: renderer.capabilities.hdr,
    depth: renderer.depth,
    geometryBuffers: renderer.geometryBuffers?.size ?? 0,
    materialTextures: renderer.textures ? [...renderer.textures.keys()].filter(Boolean).length : 0,
    skinTextures: renderer.skinTextures?.size ?? 0,
    morphTextures: renderer.morphTextures?.size ?? 0,
    gpuBuffers: renderer.buffers?.length ?? 0,
    drawBatches: renderer.batches?.length ?? 0,
    ...(renderer.diagnostics?.length ? { diagnostics: renderer.diagnostics } : {}),
  };
}

// Sequence frames arrive as catalog image bytes keyed by asset id. They are decoded here, without colour conversion or
// premultiplication, so the same file gives the same pixels in a preview and in a render job.
async function decodeSequenceFrame(id, base64) {
  const bitmap = await createImageBitmap(new Blob([bytesFromBase64(base64)]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width > TEXTURE_SEQUENCE_LIMITS.maxSide || bitmap.height > TEXTURE_SEQUENCE_LIMITS.maxSide) {
      throw new RangeError(`Sequence frame ${id.slice(0, 12)} is ${bitmap.width}x${bitmap.height}; frames are at most ${TEXTURE_SEQUENCE_LIMITS.maxSide} pixels on a side.`);
    }
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    bitmap.close();
  }
}

// HDRI and .cube files a recipe names, by bundled name or catalog ID: { kind: 'environment', base64 } or { kind: 'look', text }.
function registerLookData(lookData) {
  for (const [reference, entry] of Object.entries(lookData ?? {})) {
    if (entry.kind === 'environment') registerCatalogEnvironment(reference, parseRadianceHdr(bytesFromBase64(entry.base64)));
    else registerCatalogLook(reference, parseCube(entry.text));
  }
}

async function loadSequenceFrames(pool, sequenceData) {
  for (const [id, base64] of Object.entries(sequenceData ?? {})) {
    if (pool.has(id)) continue;
    try {
      pool.set(id, await decodeSequenceFrame(id, base64));
    } catch (error) {
      if (error instanceof RangeError) throw error;
      throw new Error(`Sequence frame ${id.slice(0, 12)} is not a PNG, JPEG or WebP image the browser can decode.`);
    }
    const decodedBytes = [...pool.values()].reduce((total, frame) => total + frame.data.length, 0);
    if (decodedBytes > TEXTURE_SEQUENCE_LIMITS.maxDecodedBytes) {
      pool.delete(id);
      throw new RangeError(`Sequence frames decode to more than ${TEXTURE_SEQUENCE_LIMITS.maxDecodedBytes / 1048576} MiB. Use fewer or smaller frames.`);
    }
  }
  return pool;
}

// Each frame change is one updateTexture per renderer. A renderer starts on frame 0, the image its descriptor holds.
const uploadedFrames = new WeakMap();
function syncSequenceTextures(record) {
  const uploaded = uploadedFrames.get(record.renderer) ?? new Map();
  uploadedFrames.set(record.renderer, uploaded);
  for (const { descriptor, index, image } of record.scene.sequenceTextures?.() ?? []) {
    if ((uploaded.get(descriptor) ?? 0) === index) continue;
    if (!record.renderer.textures.has(descriptor)) continue;
    record.renderer.updateTexture(descriptor, { image });
    uploaded.set(descriptor, index);
  }
}

function sceneIsTextured(scene) {
  // A material snippet adds code to the colour and shadow programs, which only a new renderer compiles.
  return hasPatternTextures(scene.parts) || (scene.sequenceTextures?.().length ?? 0) > 0 || scene.parts.some(part => part.material.snippet);
}

// replaceParts streams only untextured parts, so a topology change around pattern textures takes a new renderer.
// A material snippet is compiled alone first, so a compile error names the snippet's own lines and the running renderer stays.
function probeSnippets(scene) {
  if (agentSceneModuleLoaded('materialSnippet')) agentSceneModule('materialSnippet').probeMaterialSnippets(scene.parts);
}

function rebuildRenderer(record) {
  probeSnippets(record.scene);
  record.renderer.dispose();
  record.renderer = null;
  resetCanvas();
  record.renderer = initializeRenderer(record.scene, record.options);
  record.shadowKey = null;
}

// The automatic floor (src/agent-ground.js) follows the scene's lowest geometry. A renderer gains or loses it only
// through a new renderer, so a floor that appears or disappears (a part now forms one, or environment.ground changed) rebuilds.
function syncAutomaticGround(record) {
  const placement = agentGroundPlacement(record.scene.parts, record.scene.environment);
  if (Boolean(placement) !== Boolean(record.renderer.groundPart)) {
    rebuildRenderer(record);
    record.renderer.resize();
    return;
  }
  if (placement) {
    placeAgentGround(record.renderer.groundPart, placement);
    record.renderer.updateParts([...record.scene.parts, record.renderer.groundPart]);
  }
}

// The scene's environment lit by the sky map, with the light its floor bounces (src/ground-bounce.js): a floor part of the
// recipe gives its own colour, and the automatic floor gives its own.
function litEnvironment(parts, environment, hasAutomaticGround) {
  const lit = groundBounceEnvironment(parts, { ...environment, map: agentEnvironmentMap(environment) }, { automaticAlbedo: hasAutomaticGround ? FLOOR_COLOR : null });
  // A closed room a sun lights gets the lights of its sunlit patches (src/sun-bounce.js), once a recipe that names a sun has loaded the module.
  return agentSceneModuleLoaded('floorSky') ? agentSceneModule('floorSky').withSunBounce(parts, lit) : lit;
}

// A renderer takes its cascades at construction, so a change of the count (or of the extent that picks it) rebuilds.
function syncShadowCascades(record) {
  const count = cascadeCountFor(record.scene);
  if (count !== (record.renderer.shadowCascades?.count ?? 0)) {
    rebuildRenderer(record);
    record.renderer.resize();
  }
}

function draw(record, time = 0, camera = record.scene.camera, frameOptions = {}) {
  if (!record.renderer) throw new Error('The scene renderer is leased to a render job.');
  if (record.renderer.context.isContextLost()) {
    throw new Error('The render context was lost. Export the recipe and dispose this session.');
  }
  // Shrink the existing target first so a smaller look can recover a staging-budget failure.
  record.renderer.resize();
  if (record.rendererTopology !== record.scene.topologyRevision) {
    const textured = sceneIsTextured(record.scene);
    // replaceParts refuses skinned and morphed parts, so an edited imported part takes a new renderer as well.
    if (textured || record.rendererTextured || record.asset) {
      rebuildRenderer(record);
    } else {
      record.renderer.replaceParts(record.scene.parts);
    }
    record.rendererTextured = textured;
    record.rendererTopology = record.scene.topologyRevision;
    record.renderer.resize();
  } else {
    record.renderer.updateParts(record.scene.parts);
  }
  // Cloth rewrites its geometry in place, so a seek only uploads the new positions and normals.
  if (agentSceneModuleLoaded('cloth')) {
    const { isLiveClothGeometry } = agentSceneModule('cloth');
    for (const part of record.scene.parts) {
      if (isLiveClothGeometry(part.geometry)) updatePartVertices(record.renderer, part, part.geometry.positions, part.geometry.normals);
    }
  }
  syncAutomaticGround(record);
  syncShadowCascades(record);
  syncSequenceTextures(record);
  const environment = record.scene.environment;
  const effects = record.scene.effects;
  const shadow = record.scene.shadow;
  const shadowKey = JSON.stringify([environment.lightDirection, shadow]);
  if (record.shadowKey !== shadowKey) {
    record.renderer.shadowBounds = resolveAgentShadow(shadow, environment.lightDirection);
    record.renderer.shadowsDirty = true;
    record.shadowKey = shadowKey;
  }
  record.renderer.world = environment.world;
  syncMeshBlend(record);
  record.renderer.userPasses?.set(record.scene.postPasses ?? []);
  applyRecipeWindHeading(record.renderer, environment);
  record.renderer.render({ ...camera, environment: litEnvironment(record.scene.parts, environment, Boolean(record.renderer.groundPart)), effects, exposure: effects.exposure, time, lines: environment.lines, ...windFrame(environment), ...frameOptions, effects: effectsWithFStop(frameOptions.effects ?? effects, camera) });
  const error = record.renderer.context.getError();
  if (error !== 0) {
    throw new Error(`WebGL render failed with error ${error}.`);
  }
}

// The radius of each node's `blend`, by part name. Checked again only when the scene revision changes; a bad value throws here
// with the field's message, which the render reports.
function syncMeshBlend(record) {
  if (record.blendRevision === record.scene.revision && record.blendRenderer === record.renderer) return;
  record.blendRevision = record.scene.revision;
  record.blendRenderer = record.renderer;
  const radii = new Map();
  for (const node of record.scene.exportRecipe().nodes ?? []) {
    if (node.blend !== undefined) radii.set(node.id, normalizeBlend(node.blend).radius);
  }
  record.renderer.meshBlend.radii = radii;
}

function status(record) {
  const render = renderInfo(record.renderer);
  record.lastRender = render;
  return {
    sessionId: record.sessionId,
    revision: record.scene.revision,
    topologyRevision: record.scene.topologyRevision,
    inspection: record.scene.inspect(),
    render,
  };
}

function mutationStatus(record) {
  try {
    draw(record);
    return { ...status(record), committed: true, renderSucceeded: true };
  } catch (error) {
    return {
      sessionId: record.sessionId,
      revision: record.scene.revision,
      inspection: record.scene.inspect(),
      render: record.lastRender ?? null,
      committed: true,
      renderSucceeded: false,
      renderError: error.message,
    };
  }
}

// Draw the part labels onto a copy of the frame, so the preview canvas itself stays unmarked.
function labeledPng(labels) {
  if (!labels) return canvas.toDataURL('image/png').split(',')[1];
  const composed = document.createElement('canvas');
  composed.width = canvas.width;
  composed.height = canvas.height;
  const context = composed.getContext('2d');
  context.drawImage(canvas, 0, 0);
  paintLabels(context, labels, 0, 0);
  return composed.toDataURL('image/png').split(',')[1];
}

function resetCanvas() {
  canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  const replacement = document.createElement('canvas');
  canvas.replaceWith(replacement);
  canvas = replacement;
}

// The cascade code is a loaded module, so a scene with one shadow map never runs it.
function cascadeCountFor(scene) {
  return agentSceneModule('cascades').effectiveShadowCascades(scene.environment, scene.shadow);
}

// Wind strength of the recipe; absent keeps the renderer default. The heading is applied by applyRecipeWindHeading.
function windFrame(environment) {
  if (!environment.wind) return {};
  return { wind: environment.wind.strength };
}

// The heading lives in the on-demand world material code, so the core renderer carries nothing for it.
function applyRecipeWindHeading(renderer, environment) {
  if (!agentSceneModuleLoaded('worldMaterials') || (!environment.wind && !renderer.windHeading)) return;
  agentSceneModule('worldMaterials').applyWindHeading(renderer, (environment.wind?.direction ?? 0) * Math.PI / 180);
}

function cascadesFor(scene) {
  const count = cascadeCountFor(scene);
  return count > 0 ? agentSceneModule('cascades').createCascadedShadows({ count }) : null;
}

function initializeRenderer(scene, { memoryBudgetMiB, backend, transparent = false }) {
  probeSnippets(scene);
  const placement = agentGroundPlacement(scene.parts, scene.environment);
  const renderer = installDepthPrecision(installRenderPasses(installCameraEffects(new Renderer67(canvas, scene.parts, {
    ground: placement ? createAgentGround(placement) : false,
    hdr: true,
    depth: true,
    world: scene.environment.world,
    environment: litEnvironment(scene.parts, scene.environment, Boolean(placement)),
    shadowBounds: resolveAgentShadow(scene.shadow, scene.environment.lightDirection),
    shadowCascades: cascadesFor(scene),
    skyOpenness,
    fogSkyVisibility,
    pixelRatio: 1,
    samples: backend === 'cpu' ? 1 : 4,
    memoryBudgetMiB,
    transparent,
  }))));
  // Outlines, toon light and polylines draw only for a frame that carries environment.lines; user passes run last, on the finished frame.
  // Mesh blend installs before line art, so its stage runs first and the lines draw over the blended colour; it blends only the
  // parts whose nodes carry `blend` (syncMeshBlend), so a recipe without it draws as before.
  return agentSceneModule('userPass').installUserPasses(agentSceneModule('lineArt').installLineArt(installMeshBlend(renderer)));
}

// Camera fields from a timeline shot on top of the sampled camera, checked with the scene's own camera rules.
function withCameraOverrides(camera, overrides) {
  const merged = createAgentScene({ format: '67js.scene', schemaVersion: 1,
    geometries: [], materials: [], nodes: [], camera: { ...camera, ...overrides } }).camera;
  validatePreviewCamera(merged);
  return merged;
}

// The camera at the start of the shutter interval, sampled from time so the same seek always gives the same blur.
function previousCameraFor(record, motionTime) {
  const shutter = record.scene.effects.motionBlur.shutter;
  if (shutter <= 0 || motionTime === undefined || record.asset) return undefined;
  record.scene.sampleMotion(Math.max(0, motionTime - shutter));
  const previousCamera = record.scene.camera;
  record.scene.sampleMotion(motionTime);
  return previousCamera;
}

function createPreview(scene, { sessionId, memoryBudgetMiB, backend, transparent = false }, asset, placedAssets, sequenceFrames) {
  if (active) {
    throw new Error('Dispose the current scene before creating another.');
  }
  validatePreviewCamera(scene.camera);
  let renderer;
  try {
    renderer = initializeRenderer(scene, { memoryBudgetMiB, backend, transparent });
    const record = { scene, renderer, asset, placedAssets, sessionId, options: { memoryBudgetMiB, backend, transparent },
      checkpoints: new Map(), branches: createBranchStore(), rendererTopology: scene.topologyRevision, rendererTextured: sceneIsTextured(scene), sequenceFrames };
    draw(record);
    const result = status(record);
    if (backend === 'gpu' && /swiftshader|llvmpipe|software/i.test(result.render.graphics)) {
      throw new Error('Hardware GPU rendering was requested, but the browser selected a software renderer.');
    }
    active = record;
    return result;
  } catch (error) {
    renderer?.dispose();
    // A throwing constructor may already own GPU objects without returning an instance.
    resetCanvas();
    throw error;
  }
}

// Manifold is an optional peer dependency; the runtime serves it from the host's node_modules on this origin.
setManifoldModuleLoader(() => import(/* @vite-ignore */ new URL('/vendor/manifold.js', location.href).href));
// Rapier is the same kind of optional peer: its WASM travels inside the module served from /vendor/rapier.js.
setPhysicsModuleLoader(() => import(/* @vite-ignore */ new URL('/vendor/rapier.js', location.href).href));

// The preview bundle is one file, so the on-demand scene modules load together on the first call and later calls stay
// synchronous. The boolean engine is WebAssembly and loads asynchronously, once, only for calls that need it.

let queryOnly;
const ASSET_DECODE_LIMITS = agentAssetDecodeOptions();

// An agent cannot pass loadGltf options, so a limit error names the catalog limits instead of "Fix: pass { ... }".
async function parseCatalogAsset(buffer) {
  try {
    return await parseGltf(buffer, ASSET_DECODE_LIMITS);
  } catch (error) {
    throw withCatalogLimitAdvice(error);
  }
}

function disposePlacedAssets(pool) {
  for (const asset of pool?.values() ?? []) asset.dispose();
  pool?.clear();
}

// A recipe that places catalog assets arrives with their bytes, keyed by asset id. Copy 0 serves every still placement and
// each placement that plays a clip takes a copy of its own, since a pose is state of one decoded asset.
async function loadPlacedAssets(pool, value, assetData) {
  for (const { id, copies } of recipeAssetNeeds(value)) {
    for (let copy = 0; copy < copies; copy++) {
      const key = assetCopyKey(id, copy);
      if (pool.has(key)) continue;
      if (!assetData?.[id]) throw new Error(`Asset ${id.slice(0, 12)} was not supplied. Check asset_catalog for its id.`);
      pool.set(key, await parseCatalogAsset(bytesFromBase64(assetData[id]).buffer));
    }
  }
}

function afterMeshBooleans(value, run) {
  if (!allAgentSceneModulesLoaded()) return loadAllAgentSceneModules().then(() => afterMeshBooleans(value, run));
  const loads = [];
  if (!meshBooleansLoaded() && needsMeshBooleans(value)) loads.push(loadMeshBooleans());
  if (!physicsEngineLoaded() && needsPhysics(value)) loads.push(loadPhysicsEngine());
  if (!loads.length) return run();
  return Promise.all(loads).then(run);
}

// Heavy kernels (light bake, cloth, uv_unwrap, pattern textures) compute on a worker while the page stays responsive;
// the scene is built from the same bytes as on one thread. Reading each part's maps here makes pattern bakes run in the
// same pass, so the renderer later finds them baked.
// Where the work ran, for scene_inspect: kernels served by the worker and run inline (with the reason for any
// fallback), the time of the last scene build, and the longest main-thread task the browser reported since then.
// Long tasks are those over 50 ms, so 0 means none that long.
const longTaskObserver = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ? new PerformanceObserver(() => {})
  : null;
longTaskObserver?.observe({ type: 'longtask' });
const buildReport = { buildMilliseconds: 0, longestBlockMilliseconds: 0, longestLongTaskMilliseconds: 0, longTasks: 0 };

// The long task API skips work run by a remote-debugging call, so a timer also measures how long the page stayed
// unresponsive: the longest delay of a 20 ms tick is the longest stretch the main thread was busy.
const HEARTBEAT_MILLISECONDS = 20;
let lastHeartbeat = performance.now();
setInterval(() => {
  const now = performance.now();
  buildReport.longestBlockMilliseconds = Math.max(buildReport.longestBlockMilliseconds, Math.round(now - lastHeartbeat - HEARTBEAT_MILLISECONDS));
  lastHeartbeat = now;
}, HEARTBEAT_MILLISECONDS);

function drainLongTasks() {
  for (const entry of longTaskObserver?.takeRecords() ?? []) {
    buildReport.longTasks++;
    buildReport.longestLongTaskMilliseconds = Math.max(buildReport.longestLongTaskMilliseconds, Math.round(entry.duration));
  }
}

function startBuildReport() {
  drainLongTasks();
  Object.assign(buildReport, { buildMilliseconds: 0, longestBlockMilliseconds: 0, longestLongTaskMilliseconds: 0, longTasks: 0 });
  lastHeartbeat = performance.now();
  resetKernelStats();
}

function finishBuildReport(startedAt) {
  buildReport.buildMilliseconds = Math.round(performance.now() - startedAt);
}

function kernelReport() {
  drainLongTasks();
  return { ...kernelStats(), ...buildReport };
}

// The runtime can switch workers off (createAgentRuntime kernelWorkers: false) to measure what they buy.
function useKernelWorkers() {
  return kernelWorkersAvailable() && globalThis.__67jsKernelWorkers !== 'off';
}

// A recipe bake runs on the native tracer when the host offers it, on the GPU when the page has float render targets, and on
// the CPU everywhere else.
async function pageKernelsFor(recipe, backend) {
  if (!recipe.bake || backend !== 'gpu') return undefined;
  const { gpuBakeKernels } = await import('../src/agent-bake-gpu.js');
  return gpuBakeKernels({ texelTracer: await nativeTexelTracerIfAvailable() });
}

async function buildSceneOffMainThread(recipe, options, backend) {
  const pageKernels = await pageKernelsFor(recipe, backend);
  return buildWithKernels(() => {
    const scene = createAgentScene(recipe, {}, options);
    for (const part of scene.parts) {
      void part.material.map;
    }
    return scene;
  }, { pageKernels });
}

function seekForExport(record, motionTime) {
  if (record.asset) record.scene.sampleFrame({ motionTime });
  else record.scene.sampleMotion(motionTime);
}

// The scene's parts already carry the current pose, including IK and node overrides, so skinned parts export it as is.
function posedExport(record) {
  const rig = record.scene.rigExport?.() ?? { nodes: [], clips: [] };
  return { parts: record.scene.parts.map(withoutRoundoffShear), options: rig.nodes.length ? rig : {} };
}

// Chains of bone transforms leave world matrices with Float32 roundoff that the exporter reads as shear. Real shear
// (dot products above the tolerance) still reaches the exporter and fails there.
const ROUNDOFF_SHEAR_LIMIT = 1e-3;

function withoutRoundoffShear(part) {
  if (part.skin) return part;
  const columns = [0, 4, 8].map(offset => {
    const column = [part.matrix[offset], part.matrix[offset + 1], part.matrix[offset + 2]];
    const length = Math.hypot(...column);
    return length === 0 ? column : column.map(value => value / length);
  });
  const dots = [[0, 1], [0, 2], [1, 2]].map(([first, second]) => Math.abs(columns[first].reduce((sum, value, axis) => sum + value * columns[second][axis], 0)));
  if (Math.max(...dots) > ROUNDOFF_SHEAR_LIMIT) return part;
  const scale = mat4.getScaling([0, 0, 0], part.matrix);
  const rotation = mat4.getRotation([0, 0, 0, 1], part.matrix);
  const translation = mat4.getTranslation([0, 0, 0], part.matrix);
  return { ...part, matrix: mat4.fromRotationTranslationScale(mat4.create(), rotation, translation, scale) };
}

// A source clip animates the source skeleton, so the scene must not carry a pose of its own that the clip would fight.
function clipExport(record, clipIndex) {
  const { asset, scene } = record;
  if (!asset) throw new Error('clip needs an imported asset scene. Recipe scenes export their current pose.');
  const animation = asset.animations[clipIndex];
  if (!animation) throw new RangeError(`clip ${clipIndex} does not exist. The asset has ${asset.animations.length} clips.`);
  const recipe = scene.exportRecipe();
  if (recipe.animation || recipe.nodeOverrides.length || recipe.motion) {
    throw new Error('Exporting a clip needs the unposed asset: remove animation, node overrides and motion first, or export without clip for the current pose.');
  }
  const sourceClip = clipFromGltfAnimation(animation);
  const name = String(animation.name || `clip ${clipIndex}`);
  const clip = { ...sourceClip, name, tracks: [...sourceClip.tracks, ...weightTracksFromGltfAnimation(animation)] };
  // Edited parts export their edited geometry on the source part's own matrix, skin and morph.
  const parts = asset.parts.map((part, index) => scene.parts[index].geometry === part.geometry ? part : { ...part, geometry: scene.parts[index].geometry });
  return { parts, options: { nodes: asset.nodes, clips: [clip] } };
}

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// The feature images of the last denoise "oidn" trace, kept until finishPathTrace draws it.
let tracedFeatures;

function encodeTracedPng(rgba, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL('image/png').split(',')[1];
}

// The review grid outlives the private scenes drawn into it, because each branch in a review is its own scene.
let reviewGrid;

function projectToScreen(matrix, point, width, height) {
  const [x, y, z] = point;
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!(clipW > 0)) return null;
  const normalizedX = clipX / clipW;
  const normalizedY = clipY / clipW;
  if (Math.abs(normalizedX) > 1 || Math.abs(normalizedY) > 1) return null;
  return { x: Math.round((normalizedX * 0.5 + 0.5) * width), y: Math.round((1 - (normalizedY * 0.5 + 0.5)) * height) };
}

function meshProblemsByGeometry(scene, geometryIds) {
  const result = new Map();
  if (typeof scene.inspectMeshes !== 'function' || geometryIds.length === 0) return result;
  const { meshes } = scene.inspectMeshes({ geometries: geometryIds.slice(0, 16) });
  for (const mesh of meshes) {
    const faceTags = Array.isArray(mesh.tags) ? mesh.tags : Object.keys(mesh.tags ?? {});
    result.set(mesh.geometry, { problems: mesh.problems.map(problem => problem.kind), faceTags: faceTags.slice(0, 6) });
  }
  return result;
}

/** Name, material tag, face tags and lint problems of the visible parts, with the pixel they project to. */
function collectLabels(record, camera, width, height) {
  const { scene } = record;
  // Mesh reports of an imported asset are keyed by part ID (mesh-0); a recipe's are keyed by geometry ID.
  const meshKeyOf = node => record.asset ? node.id : node.geometry;
  const nodes = scene.inspect({ includeBounds: true }).nodes.filter(node => node.bounds);
  // An imported asset's recipe has no materials list: its parts carry no tags.
  const materialTags = new Map((scene.exportRecipe().materials ?? []).map(material => [material.id, material.tag]));
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  const matrix = mat4.multiply(mat4.create(), applyProjection(mat4.create(), camera, width / height), view);
  const geometryIds = [...new Set(nodes.map(meshKeyOf))];
  const meshInfo = meshProblemsByGeometry(scene, geometryIds);
  const labels = [];
  for (const node of nodes) {
    const center = [0, 1, 2].map(axis => (node.bounds.min[axis] + node.bounds.max[axis]) / 2);
    const position = projectToScreen(matrix, center, width, height);
    if (!position || labels.length >= BRANCH_LIMITS.maximumLabels) continue;
    const mesh = meshInfo.get(meshKeyOf(node));
    labels.push({ id: node.id, name: printableLabel(node.label), tag: materialTags.get(node.material) ?? null,
      faceTags: mesh?.faceTags ?? [], problems: mesh?.problems ?? [], x: position.x, y: position.y });
  }
  return labels;
}

function paintLabels(context, labels, offsetX, offsetY) {
  context.font = '11px sans-serif';
  context.textBaseline = 'middle';
  for (const label of labels) {
    const text = [label.name, label.tag === 'surface' ? null : label.tag,...(label.problems.length ? [`! ${label.problems.join(',')}`] : [])].filter(Boolean).join(' ');
    const x = offsetX + label.x;
    const y = offsetY + label.y;
    context.fillStyle = label.problems.length ? '#ff8a65' : '#ffe082';
    context.fillRect(x - 2, y - 2, 4, 4);
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(16,20,22,0.85)';
    context.strokeText(text, x + 5, y);
    context.fillText(text, x + 5, y);
  }
}

window.__agentPreview = {
  reviewBegin({ width, height }) {
    reviewGrid = document.createElement('canvas');
    reviewGrid.width = width;
    reviewGrid.height = height;
    const context = reviewGrid.getContext('2d');
    context.fillStyle = '#202428';
    context.fillRect(0, 0, width, height);
    return { width, height };
  },
  reviewShot({ sessionId, shot, index, width, height, columns, labels: withLabels = false }) {
    const record = requireSession(sessionId);
    const recipe = record.scene.exportRecipe();
    const animation = shot.animation ?? recipe.animation ?? null;
    if (record.asset) {
      record.scene.sampleFrame({ animation, motionTime: shot.motionTime });
    } else {
      if (shot.animation !== undefined) throw new RangeError('Imported animation requires an asset scene.');
      record.scene.sampleMotion(shot.motionTime);
    }
    const camera = createAgentScene({ format: '67js.scene', schemaVersion: 1,
      geometries: [], materials: [], nodes: [], camera: { ...record.scene.camera, ...shot.camera } }).camera;
    validatePreviewCamera(camera);
    draw(record, shot.rendererTime, camera);
    const render = renderInfo(record.renderer);
    if (render.width < 64 || render.height < 64) throw new Error('Render budget reduced review below its minimum output size.');
    const context = reviewGrid.getContext('2d');
    const x = index % columns * width;
    const y = Math.floor(index / columns) * (height + 24);
    context.drawImage(canvas, x, y + 24, width, height);
    context.fillStyle = '#e4e7e9';
    context.font = '12px sans-serif';
    context.textBaseline = 'middle';
    context.fillText(shot.label.replace(/[\r\n\t]/g, ' '), x + 8, y + 12, width - 16);
    const labels = withLabels ? collectLabels(record, camera, width, height) : undefined;
    if (labels) paintLabels(context, labels, x, y + 24);
    return { label: shot.label, camera, animation: record.asset ? animation : null,
      motionTime: record.scene.motionTime ?? null, rendererTime: shot.rendererTime,
      requestedWidth: width, requestedHeight: height, ...render, ...(labels ? { labels } : {}) };
  },
  reviewResult() {
    return { data: reviewGrid.toDataURL('image/png').split(',')[1], mimeType: 'image/png' };
  },
  snapshot({ sessionId, expectedRevision }) {
    const record = requireSession(sessionId);
    if (record.scene.revision !== expectedRevision) throw new Error('Stale revision for render snapshot.');
    return { sourceRevision: record.scene.revision, recipe: record.scene.exportRecipe(),
      clips: record.asset?.animations.map(clip => ({ duration: clip.duration })) ?? [] };
  },
  suspend({ sessionId }) {
    const record = requireSession(sessionId);
    if (!record.renderer) throw new Error('Scene renderer is already suspended.');
    record.renderer.dispose();
    record.renderer = null;
    resetCanvas();
    return { sessionId, revision: record.scene.revision, suspended: true };
  },
  resume({ sessionId }) {
    const record = requireSession(sessionId);
    if (record.renderer) throw new Error('Scene renderer is already active.');
    try {
      record.renderer = initializeRenderer(record.scene, record.options);
      record.rendererTopology = record.scene.topologyRevision;
      record.rendererTextured = sceneIsTextured(record.scene);
      record.shadowKey = null;
      draw(record);
      return status(record);
    } catch (error) {
      record.renderer?.dispose();
      record.renderer = null;
      resetCanvas();
      throw error;
    }
  },
  // `pass` draws one render pass instead of the lit image. Object ID frames also list the part behind each ID.
  // `camera` overrides camera fields and `depthOfField` the blur and focus distance (a timeline shot); `brightness` scales exposure for a dip through black.
  frame({ sessionId, animation, motionTime, rendererTime = 0, pass, passDepthRange, passFloat = false, floatOutput = false, camera: cameraOverrides, depthOfField: depthOfFieldOverrides, brightness = 1 }) {
    const record = requireSession(sessionId);
    if (!Number.isFinite(brightness) || brightness < 0 || brightness > 1) throw new RangeError('Invalid frame brightness.');
    if (!Number.isFinite(rendererTime) || rendererTime < 0 || rendererTime > 3600) throw new RangeError('Invalid render time.');
    if (record.asset && (animation !== undefined || motionTime !== undefined)) {
      record.scene.sampleFrame({ ...(animation === undefined ? {} : { animation }),
        ...(motionTime === undefined ? {} : { motionTime }) });
    } else if (motionTime !== undefined) {
      record.scene.sampleMotion(motionTime);
    }
    const shotCamera = cameraOverrides ? withCameraOverrides(record.scene.camera, cameraOverrides) : undefined;
    const sampledPreviousCamera = pass ? undefined : previousCameraFor(record, motionTime);
    const previousCamera = sampledPreviousCamera && cameraOverrides ? withCameraOverrides(sampledPreviousCamera, cameraOverrides) : sampledPreviousCamera;
    const exposure = record.scene.effects.exposure * brightness;
    const shotEffects = depthOfFieldOverrides
      ? { ...record.scene.effects, depthOfField: { ...record.scene.effects.depthOfField, ...depthOfFieldOverrides } }
      : undefined;
    const outputFramebuffer = floatOutput && !pass ? record.floatModule.outputFor(record, canvas).framebuffer : undefined;
    draw(record, rendererTime, shotCamera, { pass, passDepthRange, passFloat, previousCamera, outputFramebuffer,
      ...(brightness === 1 ? {} : { exposure }), ...(shotEffects ? { effects: shotEffects } : {}) });
    const info = renderInfo(record.renderer);
    return pass === 'objectId' ? { ...info, objectNames: record.renderer.passSupport.objectNames() } : info;
  },
  // Reads the last frame as RGBA float32, rows bottom to top, cropped to `region` (pixels from the top left): the lit image
  // when it was drawn with floatOutput, a pass when it was drawn with passFloat. Base64 of the float bytes.
  // 16-bit PNG and EXR output load their module here, so a scene that never asks for them does not carry it.
  async prepareFloatOutput({ sessionId }) {
    requireSession(sessionId).floatModule = await import('../src/float-output.js');
  },
  readFloat({ sessionId, source, region }) {
    const record = requireSession(sessionId);
    return record.floatModule.readFrame(record, canvas, source, region);
  },
  // Offline path trace of the scene at one instant. The tracer loads here, on first use, and not with the preview.
  async pathTrace({ sessionId, animation, motionTime, options }) {
    const record = requireSession(sessionId);
    if (record.asset && (animation !== undefined || motionTime !== undefined)) {
      record.scene.sampleFrame({ ...(animation === undefined ? {} : { animation }),
        ...(motionTime === undefined ? {} : { motionTime }) });
    } else if (motionTime !== undefined) {
      record.scene.sampleMotion(motionTime);
    }
    const { renderPathTracedImage } = await import('../src/path-tracer.js');
    const environment = record.scene.environment;
    const result = await renderPathTracedImage({
      parts: record.scene.parts,
      environment: { ...environment, map: agentEnvironmentMap(environment) },
      camera: record.scene.camera,
    }, options);
    // An external denoiser (denoise "oidn") works on the traced features outside the page; finishPathTrace then draws its result.
    if (result.report.denoiser === 'oidn') {
      tracedFeatures = result.features;
      const features = {};
      for (const name of ['color', 'albedo', 'normal']) {
        const values = result.features[name];
        features[name] = bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      }
      return { features, report: result.report };
    }
    return { data: encodeTracedPng(result.rgba, result.width, result.height), report: result.report };
  },
  // The scene at one instant packed into the tables the native ray query tracer reads (renderer.backend "native"). The job
  // runner traces them outside the page; each table comes back as base64 bytes.
  async exportNativeScene({ sessionId, animation, motionTime, options }) {
    const record = requireSession(sessionId);
    if (record.asset && (animation !== undefined || motionTime !== undefined)) {
      record.scene.sampleFrame({ ...(animation === undefined ? {} : { animation }),
        ...(motionTime === undefined ? {} : { motionTime }) });
    } else if (motionTime !== undefined) {
      record.scene.sampleMotion(motionTime);
    }
    const [{ createCamera, describeIgnoredFeatures }, { buildTraceScene }, pack, { buildNativeInput }] = await Promise.all([
      import('../src/path-tracer.js'), import('../src/path-tracer-scene.js'), import('../src/path-tracer-gpu-pack.js'),
      import('../packages/render-native/pack-input.mjs'),
    ]);
    const environment = { ...record.scene.environment, map: agentEnvironmentMap(record.scene.environment) };
    const traceScene = buildTraceScene(record.scene.parts, environment);
    const camera = createCamera(record.scene.camera, options.width, options.height);
    const input = buildNativeInput(traceScene, camera, options, pack);
    const tables = encodeNativeTables(input);
    const ignored = describeIgnoredFeatures(record.scene.parts, environment);
    return { tables, triangleCount: input.triangleCount, triangles: traceScene.indices.length / 3, ignored };
  },
  // The PNG of linear pixels (three floats each, base64) that a denoiser outside the page returned, or of the wavelet
  // filter over the kept features when none came back.
  async finishPathTrace({ width, height, linear }) {
    const { toneMapToRgba8 } = await import('../src/path-tracer.js');
    let pixels;
    if (linear) {
      const binary = atob(linear);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      pixels = new Float32Array(bytes.buffer);
    } else {
      const { denoiseRadiance } = await import('../src/path-tracer-denoise.js');
      pixels = denoiseRadiance({ width, height, ...tracedFeatures });
    }
    tracedFeatures = undefined;
    return { data: encodeTracedPng(toneMapToRgba8(pixels, width, height), width, height) };
  },
  async createWithAssets(input) {
    const pool = new Map();
    try {
      await loadAllAgentSceneModules();
      await loadPlacedAssets(pool, input.recipe, input.assetData);
      const sequenceFrames = await loadSequenceFrames(new Map(), input.sequenceData);
      // Placed assets are decoded on this thread, so the scene is built here and not on the kernel worker.
      return await afterMeshBooleans(input.recipe, () => {
        startBuildReport();
        const startedAt = performance.now();
        const scene = createAgentScene(input.recipe, {}, { assets: pool, sequenceFrames });
        finishBuildReport(startedAt);
        return createPreview(scene, input, undefined, pool, sequenceFrames);
      });
    } catch (error) {
      disposePlacedAssets(pool);
      throw error;
    }
  },
  create(input) {
    registerLookData(input.lookData);
    if (active)throw new Error('Dispose the current scene before creating another.');
    if (recipeAssetNeeds(input.recipe).length) return this.createWithAssets(input);
    // Only a recipe with image sequences waits for its frames to decode; any other create stays synchronous.
    const build = sequenceFrames => {
      startBuildReport();
      const startedAt = performance.now();
      if (!useKernelWorkers()) {
        const scene = createAgentScene(input.recipe, {}, { sequenceFrames });
        finishBuildReport(startedAt);
        return createPreview(scene, input, undefined, undefined, sequenceFrames);
      }
      return buildSceneOffMainThread(input.recipe, { sequenceFrames }, input.backend).then(scene => {
        finishBuildReport(startedAt);
        return createPreview(scene, input, undefined, undefined, sequenceFrames);
      });
    };
    return afterMeshBooleans(input.recipe, () => (input.sequenceData ? loadSequenceFrames(new Map(), input.sequenceData).then(build) : build(new Map())));
  },
  async createAsset(input) {
    if (active) throw new Error('Dispose the current scene before creating another.');
    const bytes = bytesFromBase64(input.data);
    let asset;
    try {
      // Labels, mesh reports and motion read the on-demand modules on any asset, not only one with mesh edits.
      await loadAllAgentSceneModules();
      asset = await parseCatalogAsset(bytes.buffer);
      return createPreview(createAgentAssetScene(asset, input.recipe, { sources: await decodeMotionSources(input.sources) }), input, asset);
    } catch (error) {
      asset?.dispose();
      throw error;
    }
  },
  inspect({ sessionId, ...options }) {
    return { sessionId, ...requireSession(sessionId).scene.inspect(options), kernels: kernelReport() };
  },
  inspectMeshes({ sessionId, ...options }) {
    const scene = requireSession(sessionId).scene;
    if (typeof scene.inspectMeshes !== 'function') {
      throw new TypeError('mesh_inspect needs a procedural recipe scene or an imported asset scene.');
    }
    if (!allAgentSceneModulesLoaded()) return loadAllAgentSceneModules().then(() => this.inspectMeshes({ sessionId, ...options }));
    return { sessionId, ...scene.inspectMeshes(options) };
  },
  async queryOnlyWalkMap({ data, ...input }) {
    queryOnly ??= createQueryOnlyCache(parseGltf);
    return queryOnly.walkMap({ ...input, bytes: data === undefined ? undefined : bytesFromBase64(data) });
  },
  async walkMap({ sessionId, clearance = 2, groundRange, keepOut, streetY, includeCells = false, ...options }) {
    const record = requireSession(sessionId);
    if (!allAgentSceneModulesLoaded()) await loadAllAgentSceneModules();
    const started = performance.now();
    const query = sceneQueryFor(record);
    const map = query.walkMap(walkOptionsFor(options, keepOut, streetY));
    return { sessionId, revision: record.scene.revision, ...summarizeWalkMap(map, { clearance, groundRange, keepOut, includeCells }), skippedParts: query.skipped.length, milliseconds: Math.round(performance.now() - started) };
  },
  apply(input) {
    registerLookData(input.lookData);
    if (input.sequenceData) {
      const { sequenceFrames } = requireSession(input.sessionId);
      if (!sequenceFrames) throw new Error('This scene was created from an imported asset and has no image sequences.');
      return loadSequenceFrames(sequenceFrames, input.sequenceData).then(() => this.apply({ ...input, sequenceData: undefined }));
    }
    if (input.sources) {
      const { scene } = requireSession(input.sessionId);
      return decodeMotionSources(input.sources).then(decoded => {
        scene.provideMotionSources?.(decoded);
        return afterMeshBooleans(input.operations, () => this.applyLoaded(input));
      });
    }
    if (recipeAssetNeeds(input.operations).length) return this.applyWithAssets(input);
    return afterMeshBooleans(input.operations, () => this.applyLoaded(input));
  },
  async applyWithAssets(input) {
    const record = requireSession(input.sessionId);
    if (!record.placedAssets) {
      throw new Error('This scene was created without placed assets. Recreate it with an asset node in scene_create, then add more.');
    }
    await loadAllAgentSceneModules();
    await loadPlacedAssets(record.placedAssets, input.operations, input.assetData);
    return afterMeshBooleans(input.operations, () => this.applyLoaded(input));
  },
  applyLoaded({ sessionId, operations, expectedRevision }) {
    const record = requireSession(sessionId);
    validatePreviewCamera(candidateCamera(record, operations));
    let fogDensity = record.scene.environment.volumeFog.density;
    for (const operation of operations) {
      if (operation.type === 'set-environment' && Object.hasOwn(operation.environment?.volumeFog ?? {}, 'density')) {
        fogDensity = operation.environment.volumeFog.density;
      }
    }
    if (fogDensity > 0 && !record.renderer.capabilities.hdr) {
      throw new Error('Volumetric fog requires HDR support; this preview cannot enable it.');
    }
    record.scene.apply(operations, { expectedRevision });
    return mutationStatus(record);
  },
  editMesh({ sessionId, expectedRevision, geometry, edits, replace }) {
    const record = requireSession(sessionId);
    if (typeof record.scene.inspectMeshes !== 'function') {
      throw new TypeError('mesh_edit needs a procedural recipe scene or an imported asset scene.');
    }
    const operation = { type: 'edit-mesh', geometry, edits, ...(replace === undefined ? {} : { replace }) };
    return afterMeshBooleans(edits, () => {
      const status = this.applyLoaded({ sessionId, operations: [operation], expectedRevision });
      const [mesh] = record.scene.inspectMeshes({ geometries: [geometry] }).meshes;
      return { ...status, mesh };
    });
  },
  setMeshStack({ sessionId, expectedRevision, geometry, stack, apply }) {
    const record = requireSession(sessionId);
    if (typeof record.scene.inspectMeshes !== 'function' || record.asset) {
      throw new TypeError('mesh_stack supports procedural recipe scenes. Imported parts take mesh_edit with a mesh ID such as mesh-0.');
    }
    const operation = { type: 'set-mesh-stack', geometry, ...(stack === undefined ? {} : { stack }), ...(apply === undefined ? {} : { apply }) };
    const status = this.applyLoaded({ sessionId, operations: [operation], expectedRevision });
    const [mesh] = record.scene.inspectMeshes({ geometries: [geometry] }).meshes;
    return { ...status, mesh };
  },
  look({ sessionId, motionTime, labels: withLabels = false }) {
    const record = requireSession(sessionId);
    if (motionTime !== undefined) {
      if (typeof record.scene.sampleMotion !== 'function') {
        throw new RangeError('Procedural motion time is unavailable for imported assets.');
      }
      record.scene.sampleMotion(motionTime);
    }
    draw(record);
    const render = renderInfo(record.renderer);
    record.lastRender = render;
    const labels = withLabels ? collectLabels(record, record.scene.camera, canvas.width, canvas.height) : undefined;
    return {
      data: labeledPng(labels),
      mimeType: 'image/png',
      metadata: { sessionId, revision: record.scene.revision, topologyRevision: record.scene.topologyRevision,
        motionTime: record.scene.motionTime ?? null, ...render, ...(labels ? { labels } : {}) },
    };
  },
  checkpoint({ sessionId, checkpointId }) {
    const record = requireSession(sessionId);
    const handle = record.scene.checkpoint();
    record.checkpoints.set(checkpointId, { handle, fogDensity: record.scene.environment.volumeFog.density });
    return { sessionId, checkpointId, revision: record.scene.revision };
  },
  restore({ sessionId, checkpointId, expectedRevision }) {
    const record = requireSession(sessionId);
    if (!record.checkpoints.has(checkpointId)) {
      throw new Error('Unknown or released checkpoint.');
    }
    const checkpoint = record.checkpoints.get(checkpointId);
    if (checkpoint.fogDensity > 0 && !record.renderer.capabilities.hdr) {
      throw new Error('Volumetric fog requires HDR support; this preview cannot restore it.');
    }
    record.scene.restore(checkpoint.handle, { expectedRevision });
    return mutationStatus(record);
  },
  releaseCheckpoint({ sessionId, checkpointId }) {
    const record = requireSession(sessionId);
    if (!record.checkpoints.has(checkpointId)) {
      throw new Error('Unknown or released checkpoint.');
    }
    record.scene.releaseCheckpoint(record.checkpoints.get(checkpointId).handle);
    record.checkpoints.delete(checkpointId);
    return { sessionId, checkpointId, released: true };
  },
  /** Apply operations to a scratch copy and store the result as a branch. The source scene and its revision stay as they are. */
  branchApply({ sessionId, name, operations, expectedRevision }) {
    return afterMeshBooleans(operations, () => {
      const record = requireSession(sessionId);
      if (record.asset) throw new TypeError('Branches support procedural recipe scenes.');
      if (record.scene.revision !== expectedRevision) throw new Error('Stale revision for branch.');
      const baseRecipe = record.scene.exportRecipe();
      const scratch = createAgentScene(baseRecipe);
      validatePreviewCamera(candidateCamera(record, operations));
      scratch.apply(operations, { expectedRevision: scratch.revision });
      const { shared } = record.branches.fork(name, { recipe: scratch.exportRecipe(), baseRecipe, operations, baseRevision: expectedRevision });
      return { sessionId, branch: name, sourceRevision: record.scene.revision, shared,
        branches: record.branches.names(), snapshots: record.branches.snapshotCount() };
    });
  },
  branchRecipe({ sessionId, name }) {
    const record = requireSession(sessionId);
    const branch = record.branches.get(name);
    return { recipe: branch.recipe, stale: branch.baseKey !== JSON.stringify(record.scene.exportRecipe()) };
  },
  /** Keep one branch: replay its operations on the live scene (one revision), then drop every branch. */
  keepBranch({ sessionId, name, expectedRevision }) {
    const record = requireSession(sessionId);
    const branch = record.branches.get(name);
    if (branch.baseKey !== JSON.stringify(record.scene.exportRecipe())) {
      throw new Error(`The scene changed since branch ${name} was forked. Fork it again from the current revision.`);
    }
    const status = this.applyLoaded({ sessionId, operations: branch.operations, expectedRevision });
    record.branches.clear();
    return { ...status, kept: name };
  },
  exportRecipe({ sessionId }) {
    const record = requireSession(sessionId);
    return { sessionId, revision: record.scene.revision, recipe: record.scene.exportRecipe() };
  },
  exportGlb({ sessionId, clip, motionTime, maxTextureSize, maximumBytes }) {
    const record = requireSession(sessionId);
    if (motionTime !== undefined) seekForExport(record, motionTime);
    const { parts, options } = clip === undefined ? posedExport(record) : clipExport(record, clip);
    const binary = exportGlb(parts, { ...options, ...(maxTextureSize === undefined ? {} : { maxTextureSize }) });
    if (binary.byteLength > maximumBytes) {
      throw new RangeError(`The GLB is ${binary.byteLength} bytes, above the ${maximumBytes} byte limit. Lower maxTextureSize or simplify the scene.`);
    }
    return { sessionId, revision: record.scene.revision, bytes: binary.byteLength,
      parts: parts.length, clips: options.clips?.length ?? 0, data: bytesToBase64(new Uint8Array(binary)) };
  },
  dispose({ sessionId }) {
    const record = requireSession(sessionId);
    try {
      record.renderer?.dispose();
    } finally {
      record.asset?.dispose();
      disposePlacedAssets(record.placedAssets);
    }
    record.checkpoints.clear();
    record.branches.clear();
    active = null;
    return { sessionId, disposed: true };
  },
};

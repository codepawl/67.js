// Code that most recipes never run loads on demand, so the agent scene entry stays small. A recipe that uses mesh
// editing, procedural modeling, motion, material patterns, terrain, light linking, cascaded shadows or the anisotropy and iridescence layers needs its module loaded before createAgentScene runs:
// call `await loadAgentSceneModules(recipe)` (or `loadAllAgentSceneModules()` in a host that does not mind the
// size). createAgentScene is still synchronous; when a needed module is missing it says which call to make.

const MODULE_LOADERS = {
  mesh: () => import('./agent-mesh-engine.js'),
  modeling: () => import('./modeling.js'),
  text: () => import('./text-geometry.js'),
  motion: () => import('./agent-motion.js'),
  motionBake: () => import('./agent-motion-bake.js'),
  settle: () => import('./agent-settle.js'),
  drive: () => import('./agent-drive.js'),
  physics: () => import('./agent-physics.js'),
  fracture: () => import('./agent-fracture.js'),
  cloth: () => import('./agent-cloth.js'),
  particles: () => import('./agent-particles.js'),
  bake: () => import('./agent-bake.js'),
  reflections: () => import('./agent-reflections.js'),
  patterns: () => import('./material-patterns.js'),
  relations: () => import('./agent-relations.js'),
  timeline: () => import('./film-timeline.js'),
  layerShaders: () => import('./material-layer-shaders.js'),
  liquidShader: () => import('./liquid-shader.js'),
  subsurfaceShader: () => import('./subsurface-shader.js'),
  fogShader: () => import('./fog-shader.js'),
  worldMaterials: () => import('./world-material-shader.js'),
  terrain: () => import('./agent-terrain.js'),
  navigation: () => import('./agent-navigation.js'),
  lightLinking: () => import('./light-linking.js'),
  cascades: () => import('./light-modules.js'),
  assets: () => import('./agent-scene-assets.js'),
  vegetation: () => import('./agent-vegetation.js'),
  crowd: () => import('./agent-crowd.js'),
  lineArt: () => import('./line-art.js'),
  viewTransform: () => import('./view-transform-shader.js'),
  coplanar: () => import('./coplanar-overlap.js'),
  physicalSky: () => import('./physical-sky.js'),
  floorSky: () => import('./floor-sky-visibility.js'),
  userPass: () => import('./user-pass.js'),
  game: () => import('./game-setup.js'),
  objectMotionBlur: () => import('./object-motion-blur.js'),
  postSteps: () => import('./post-steps.js'),
  materialSnippet: () => import('./material-snippet.js'),
};

const loadedModules = {};
const pendingLoads = {};
let manifoldLoader = null;
let physicsLoader = null;

// Each test errs on the side of loading: a false positive costs a chunk, a false negative a clear error.
const MODULE_MARKERS = {
  mesh: ['"type":"mesh"', '"instances"'],
  modeling: ['"type":"lathe"', '"type":"extrude"', '"type":"tube"', '"type":"curve"', '"type":"sdf"'],
  text: ['"type":"text"'],
  motion: ['"motion":{', '"bake-motion"'],
  motionBake: ['"bake-motion"'],
  settle: ['"type":"settle"'],
  drive: ['"drive":{'],
  physics: ['"physics":{', '"fracture-node"'],
  fracture: ['"type":"fragment"', '"fracture-node"'],
  cloth: ['"cloth":{'],
  particles: ['"particles":{'],
  bake: ['"bake":{'],
  // A metallic value of 0.5 or more may make a part reflective; the module skips a scene that has no smooth one.
  reflections: [/"metallic":(0\.[5-9]|1(?![0-9]))/],
  patterns: ['"pattern"'],
  relations: ['"relations":'],
  timeline: ['"timeline":{'],
  layerShaders: ['"anisotropy"', '"iridescence"', '"fresnel"'],
  liquidShader: ['"transmission"', '"liquid"', '"foam"'],
  subsurfaceShader: ['"subsurface"'],
  // Any mention loads it, because an edit can set the density through a path or the environment of an operation.
  fogShader: ['volumeFog', 'localVolumes'],
  worldMaterials: ['"tag":"water"', '"waterPreset"', '"absorption"', '"turbidity"', '"vegetation":{', '"tag":"foliage"', '"tag":"grass"', '"tag":"terrain"', '"tag":"fire"', '"tag":"smoke"', '"moss"'],
  terrain: ['"type":"terrain"'],
  // No recipe text asks for it, only the path option of scene_inspect does, so a host loads it with loadAllAgentSceneModules.
  navigation: [],
  lightLinking: ['"affects"', '"keyAffects"'],
  // The cascade module also loads light-shapes (soft area shadows, IES profiles), so these markers bring both.
  cascades: [/"(?:shadowCascades|sunAngularRadius|ies)"|"areaLights":\[\{/],
  assets: ['"asset":{', '"sequence":{'],
  vegetation: ['"vegetation":{', '"wind":{'],
  crowd: ['"crowd":{'],
  lineArt: ['"lines":{', '"toon":'],
  viewTransform: ['"viewTransform":"agx"', '"viewTransform":"neutral"', '"look":"'],
  // Flush faces are ranked whenever this is loaded (issue #751): the MCP preview registers it, loadAllAgentSceneModules loads it,
  // and so does a recipe that names resolveCoplanar or places an asset, since glTF models nest facades a few millimetres apart.
  // A recipe of plain primitives in a host without it stays free of the 85 KB of flush code, so it needs no on-demand module.
  coplanar: ['"resolveCoplanar"', '"asset":{'],
  // A closed room a sun lights gets the floor sky trace by default. The recipe text can not say whether a room is closed, so a recipe that names its sun loads it and the module skips an open scene.
  floorSky: ['"keyColor"', '"keyIntensity"'],
  physicalSky: ['"type":"physical"'],
  userPass: ['"postPasses"'],
  game: ['"game":{', '"set-game"'],
  materialSnippet: ['"snippet":{'],
  // Only a motionBlur object that sets a non-zero `objects` loads it; the common `"shutter":0` look does not.
  objectMotionBlur: [/"motionBlur":\{[^}]*"objects":(?!0[,}])/],
  postSteps: [/"(?:colorBalance|glare|lensDistortion|stylize|composite)"|"(?:distortion|flash)":[\[{]/],
};

/** Whether a recipe, operation list or edit list contains a boolean edit, which needs loadMeshBooleans() first. */
export function needsMeshBooleans(value) {
  return JSON.stringify(value ?? null).includes('"op":"boolean"');
}

/** True when a recipe or an operation list carries a physics section or a settle operation, so the host loads the solver first. */
export function needsPhysics(value) {
  const text = JSON.stringify(value ?? null);
  return text.includes('"physics":{') || text.includes('"fracture-node"') || text.includes('"type":"settle"');
}

/** Names of the on-demand modules a recipe, or a list of edit operations, needs. */
export function agentSceneModulesNeeded(value) {
  let text;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return Object.keys(MODULE_LOADERS);
  }
  const compact = text.replace(/"\s*:\s*/g, '":');
  return Object.keys(MODULE_MARKERS).filter(name => MODULE_MARKERS[name].some(marker => (marker instanceof RegExp ? marker.test(compact) : compact.includes(marker))));
}

function loadModule(name) {
  if (loadedModules[name]) return Promise.resolve(loadedModules[name]);
  pendingLoads[name] ??= MODULE_LOADERS[name]().then(module => {
    loadedModules[name] = module;
    if (name === 'mesh' && manifoldLoader) module.setManifoldModuleLoader(manifoldLoader);
    if (name === 'physics' && physicsLoader) module.setPhysicsModuleLoader(physicsLoader);
    return module;
  });
  return pendingLoads[name];
}

/** Load the modules a recipe (or a list of edit operations) needs. Safe to call repeatedly. */
export async function loadAgentSceneModules(value) {
  await Promise.all(agentSceneModulesNeeded(value).map(loadModule));
}

/** Load every on-demand module, for hosts that run any recipe an agent writes. */
export async function loadAllAgentSceneModules() {
  await Promise.all(Object.keys(MODULE_LOADERS).map(loadModule));
}

/** Entries that import a module statically register it here, so createAgentScene finds it without a load call. */
export function registerAgentSceneModule(name, module) {
  loadedModules[name] ??= module;
}

/** The loaded module, or an error that names the call that loads it. */
export function agentSceneModule(name) {
  const module = loadedModules[name];
  if (!module) {
    throw new Error(`This recipe needs the ${name} code, which loads on demand: await loadAgentSceneModules(recipe) before createAgentScene or apply.`);
  }
  return module;
}

export function allAgentSceneModulesLoaded() {
  return Object.keys(MODULE_LOADERS).every(name => loadedModules[name]);
}

export function agentSceneModuleLoaded(name) {
  return Boolean(loadedModules[name]);
}

/** Add a font table that recipes can name in a text geometry. Loads the text code first. */
export async function registerAgentSceneFont(name, fontData) {
  const module = await loadModule('text');
  module.registerFont(name, fontData);
}

/** Replace how the Manifold module is imported. Applied when the mesh code loads, if it has not yet. */
export function setManifoldModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The Manifold loader must be a function returning a module promise.');
  manifoldLoader = loader;
  loadedModules.mesh?.setManifoldModuleLoader(loader);
}

export async function loadMeshBooleans(options) {
  const mesh = await loadModule('mesh');
  return mesh.loadMeshBooleans(options);
}

export function meshBooleansLoaded() {
  return loadedModules.mesh?.meshBooleansLoaded() ?? false;
}

/** Replace how the Rapier module is imported. Applied when the physics code loads, if it has not yet. */
export function setPhysicsModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The physics loader must be a function returning a module promise.');
  physicsLoader = loader;
  loadedModules.physics?.setPhysicsModuleLoader(loader);
}

export async function loadPhysicsEngine(options) {
  const physics = await loadModule('physics');
  return physics.loadPhysicsEngine(options);
}

export function physicsEngineLoaded() {
  return loadedModules.physics?.physicsEngineLoaded() ?? false;
}

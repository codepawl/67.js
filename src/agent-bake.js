import { planLightmaps, estimateBake, traceLightmaps } from './light-bake.js';
import { runKernel } from './kernel-offload.js';
import { motionEnvironment } from './agent-motion.js';
import { normalizeProbeList, traceProbes } from './probe-trace.js';
import { placeProbes } from './reflection-probes.js';
import { normalizeIrradianceGrid, placeIrradianceGrid, traceIrradianceGrid, withMeanRadiance } from './irradiance-grid.js';
import { meanSkyRadiance } from './grid-medium.js';
import { knownKeys, finiteNumber } from './agent-recipe-checks.js';
import { BAKE_PRESETS, BAKE_RANGES, BAKE_MAXIMUM_SECONDS, BAKE_WORKER_MAXIMUM_SECONDS, BAKE_PRESET_PATH_WORK, BAKE_EXPLICIT_PATH_WORK_LIMIT } from './agent-scene-capabilities.js';

const PRESET_SAMPLES_FLOOR = 16;

// Recipe `bake`: bounced light written into lightmaps when the scene builds. This module loads on demand, so scenes
// without a bake never download the ray tracer.

const BAKE_FIELDS = ['preset', 'samples', 'bounces', 'texelsPerUnit', 'probes', 'irradianceGrid', 'gridFog', 'rebake'];
const BAKED_MATERIAL_FIELDS = ['emission', 'emissiveColor', 'emissiveMap', 'lightMap', 'lightMapScale', 'occlusionMap', 'occlusionStrength'];

/** Validates a recipe bake section and returns the plain, resolved form stored in the recipe (null clears it). */
export function normalizeAgentBake(input) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, BAKE_FIELDS, 'bake');
  if (input.preset !== undefined && !Object.hasOwn(BAKE_PRESETS, input.preset)) {
    throw new RangeError(`Bake preset must be one of ${Object.keys(BAKE_PRESETS).join(', ')}.`);
  }
  const resolved = { ...BAKE_PRESETS[input.preset ?? 'standard'] };
  for (const [field, [minimum, maximum]] of Object.entries(BAKE_RANGES)) {
    if (input[field] === undefined) {
      continue;
    }
    resolved[field] = finiteNumber(input[field], `Bake ${field}`, minimum, maximum);
  }
  // Absent means 'room', one probe in the middle of an enclosed room (an open scene gets none). false opts out; a list places them.
  // Measured against Cycles, a probe lowered the FLIP score of every baked room, so a bake brings one along.
  if (input.probes === undefined) {
    resolved.probes = 'room';
  } else {
    resolved.probes = input.probes === false || input.probes === 'room' ? input.probes : normalizeProbeList(input.probes);
  }
  // Opt in: a grid of diffuse light for every part, traced instead of lightmaps (src/irradiance-grid.js). Not stored when off, so a recipe without it keeps its bytes.
  const irradianceGrid = normalizeIrradianceGrid(input.irradianceGrid);
  if (irradianceGrid) {
    resolved.irradianceGrid = irradianceGrid;
  }
  // Opt in on top of the grid: the grid's paths scatter in the scene's volume fog. Not stored when off, so the default bake keeps its bytes.
  if (input.gridFog !== undefined && typeof input.gridFog !== 'boolean') {
    throw new RangeError('bake.gridFog must be a boolean.');
  }
  if (input.gridFog === true) {
    if (!irradianceGrid) {
      throw new RangeError('bake.gridFog needs bake.irradianceGrid.');
    }
    resolved.gridFog = true;
  }
  // Not stored when off, so the default bake keeps its bytes.
  if (input.rebake !== undefined && typeof input.rebake !== 'boolean') {
    throw new RangeError('bake.rebake must be a boolean.');
  }
  if (input.rebake === true) {
    resolved.rebake = true;
  }
  for (const field of ['samples', 'bounces']) {
    if (!Number.isInteger(resolved[field])) {
      throw new RangeError(`Bake ${field} must be an integer.`);
    }
  }
  return resolved;
}

/**
 * The text a bake is cached by: the bake settings (not `rebake`), the lights, materials and the world matrix of every
 * part. The scene stores it when it bakes; a frame whose key differs is lit by a bake that no longer matches.
 */
export function lightBakeKey(recipe, generatedGeometryGenerators, environment, worldMatrices) {
  const { pointLights, spotLights, areaLights, keyColor, keyIntensity, lightDirection, keyAffects } = environment;
  return JSON.stringify([{ ...recipe.bake, rebake: undefined }, [...generatedGeometryGenerators], pointLights, spotLights, areaLights, keyColor, keyIntensity, lightDirection, keyAffects, recipe.materials,
    [...worldMatrices].map(([name, matrix]) => [name, Array.from(matrix)])]);
}

/** The scene_inspect diagnostics for a bake whose inputs, at the sampled pose, differ from the ones it was traced at. */
export function staleBakeProblems(state, generators, bakedKey) {
  const environment = state.movedLook ? motionEnvironment(structuredClone(state.recipe.environment), state.movedLook) : state.recipe.environment;
  const graph = state.poseGraph ?? state.graph;
  const worldMatrices = new Map(state.sourceRestParts.map(part => [part.name, graph.getNode(part.name).worldMatrix]));
  return lightBakeKey(state.recipe, generators, environment, worldMatrices) === bakedKey ? [] : [staleBakeDiagnostic()];
}

function staleBakeDiagnostic() {
  return {
    kind: 'bake-stale', severity: 'warning', target: 'bake',
    message: 'A light, the sun or a part has moved from the pose the bake was traced at, so the baked light no longer matches the frame.',
    fix: 'Bounced light does not follow motion. Bake a pose that stays put, or set bake.rebake true (scene_apply set-bake) to trace again on every build and silence this. Material animation is not checked.',
  };
}

function isPreset(settings) {
  return Object.values(BAKE_PRESETS).some(preset => Object.keys(preset).every(field => preset[field] === settings[field]));
}

// Path steps in total: texels x samples x bounces. Measured, a path costs about the same in a closed room and in an
// open one whatever the number of lights, so this tracks the time of a bake better than a count of rays does.
function pathWorkOf(plan, settings) {
  return estimateBake(plan, settings).texels * settings.samples * settings.bounces;
}

// The densest texelsPerUnit, to two decimals, that still fits the explicit limit at the given samples and bounces (0 when none does).
function largestFittingTexelsPerUnit(plan, settings) {
  let fitting = 0;
  let tooMuch = settings.texelsPerUnit;
  for (let step = 0; step < 12; step++) {
    const middle = Math.floor((fitting + tooMuch) / 2 * 100) / 100;
    if (middle <= fitting) {
      break;
    }
    if (pathWorkOf(plan, { ...settings, texelsPerUnit: middle }) <= BAKE_EXPLICIT_PATH_WORK_LIMIT) {
      fitting = middle;
    } else {
      tooMuch = middle;
    }
  }
  return fitting >= BAKE_RANGES.texelsPerUnit[0] ? fitting : 0;
}

function overLimitMessage(plan, settings, pathWork) {
  const fittingSamples = Math.floor(BAKE_EXPLICIT_PATH_WORK_LIMIT * settings.samples / pathWork);
  const fittingTexelsPerUnit = largestFittingTexelsPerUnit(plan, settings);
  const choices = [];
  if (fittingSamples >= BAKE_RANGES.samples[0]) {
    choices.push(`samples ${fittingSamples} or fewer with texelsPerUnit ${settings.texelsPerUnit}`);
  }
  if (fittingTexelsPerUnit > 0) {
    choices.push(`texelsPerUnit ${fittingTexelsPerUnit} or less with samples ${settings.samples}`);
  }
  const advice = choices.length > 0 ? `At bounces ${settings.bounces} this scene fits ${choices.join(', or ')}.` : 'Remove parts or lights, or lower bounces.';
  return `The bake would follow ${pathWork} path steps (texels x samples x bounces); the limit for explicit settings is ${BAKE_EXPLICIT_PATH_WORK_LIMIT}. ${advice}`;
}

function scalePresetDown(settings) {
  return {
    ...settings,
    samples: Math.max(PRESET_SAMPLES_FLOOR, Math.floor(settings.samples * 0.8)),
    texelsPerUnit: Math.max(BAKE_RANGES.texelsPerUnit[0], Math.round(settings.texelsPerUnit * 0.9 * 100) / 100),
  };
}

/**
 * Keeps a bake inside its work limits before any ray is traced. The estimate counts texels, samples and bounces and reads
 * no clock, so the same recipe always resolves to the same settings. Explicit samples or texelsPerUnit are never changed:
 * they fail up front only over the hard limit, and otherwise run until the real maxSeconds limit. A preset is scaled down
 * (samples by a fifth, texel density by a tenth, repeatedly) until it fits BAKE_PRESET_PATH_WORK.
 */
export function fitSettingsToBudget(plan, settings) {
  if (!isPreset(settings)) {
    const pathWork = pathWorkOf(plan, settings);
    if (pathWork > BAKE_EXPLICIT_PATH_WORK_LIMIT) {
      throw new RangeError(overLimitMessage(plan, settings, pathWork));
    }
    return { used: settings, reduced: false, reduction: null };
  }
  // Samples and texel density shrink first. When the floor of both still does not fit (a large hall), a bounce is given up and
  // the density and samples start again from the preset, so the result is the largest bake that fits and never a refusal.
  // One bounce at the floor always fits a scene the explicit limit lets through, and past that the scene is too large to bake.
  for (let bounces = settings.bounces; bounces >= BAKE_RANGES.bounces[0]; bounces--) {
    let used = { ...settings, bounces };
    while (pathWorkOf(plan, used) > BAKE_PRESET_PATH_WORK && !atPresetFloor(used)) {
      used = scalePresetDown(used);
    }
    if (pathWorkOf(plan, used) <= BAKE_PRESET_PATH_WORK) {
      const reduced = used.samples !== settings.samples || used.bounces !== settings.bounces || used.texelsPerUnit !== settings.texelsPerUnit;
      return { used, reduced, reduction: reduced ? reductionMessage(settings, used) : null };
    }
  }
  throw new RangeError(`Even ${PRESET_SAMPLES_FLOOR} samples, 1 bounce and texelsPerUnit ${BAKE_RANGES.texelsPerUnit[0]} is over the preset budget of ${BAKE_PRESET_PATH_WORK} path steps for this scene. Remove parts or lights.`);
}

function atPresetFloor(settings) {
  return settings.samples <= PRESET_SAMPLES_FLOOR && settings.texelsPerUnit <= BAKE_RANGES.texelsPerUnit[0];
}

// What the agent reads in bake.reduction: what the preset asked for, what ran, and the one thing to do for more.
function reductionMessage(asked, used) {
  return `The preset asked for samples ${asked.samples}, bounces ${asked.bounces}, texelsPerUnit ${asked.texelsPerUnit}; this scene is too large for that within the preset budget of ${BAKE_PRESET_PATH_WORK} path steps, so it baked samples ${used.samples}, bounces ${used.bounces}, texelsPerUnit ${used.texelsPerUnit} (bake.used). For a denser bake pass explicit samples, bounces and texelsPerUnit, up to ${BAKE_EXPLICIT_PATH_WORK_LIMIT} path steps and ${BAKE_MAXIMUM_SECONDS} s.`;
}

function timeLimitMessage(error, settings) {
  const lowerSamples = Math.max(BAKE_RANGES.samples[0], Math.floor(settings.samples / 2));
  return `${error.message} The scene is unchanged. Try samples ${lowerSamples}, or texelsPerUnit ${Math.max(BAKE_RANGES.texelsPerUnit[0], Math.round(settings.texelsPerUnit / 2 * 100) / 100)}.`;
}

// The baked part keeps reading every other material field from the live material, so motion tracks still drive it.
function liveBakedMaterial(liveMaterial, bakedMaterial) {
  const output = {};
  for (const field of Object.keys(bakedMaterial)) {
    const source = BAKED_MATERIAL_FIELDS.includes(field) ? bakedMaterial : liveMaterial;
    Object.defineProperty(output, field, { enumerable: true, get: () => source[field] });
  }
  return Object.freeze(output);
}

// Inside a worker the bake blocks nothing, so it may run longer; on the page's own thread it must stay short.
function runsOnWorker() {
  return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
}

/** The seconds a bake may run here: 90 on a worker, 20 on the page's own thread. */
export function bakeSecondsLimit() {
  return runsOnWorker() ? BAKE_WORKER_MAXIMUM_SECONDS : BAKE_MAXIMUM_SECONDS;
}

function traceWithAdvice(plan, used) {
  try {
    return traceLightmaps(plan, used);
  } catch (error) {
    if (/passed maxSeconds/.test(error.message)) {
      throw new Error(timeLimitMessage(error, used));
    }
    throw error;
  }
}

/**
 * The light bake as a worker kernel: unwrap, budget fit and trace all run in the same place, because unwrapping and
 * tracing are both the heavy parts. Only the parts the bake changed travel back, as [index, part] pairs, because a part
 * that was left alone is the caller's own object and has nothing to send. An explicit setting over the budget throws
 * the same RangeError here as it would inline, and the worker sends it back with its message.
 */
export function bakeChangedParts(snapshots, lighting, settings) {
  const plan = planLightmaps(snapshots, lighting, { ...settings, maxSeconds: bakeSecondsLimit() });
  const { used, reduced, reduction } = fitSettingsToBudget(plan, settings);
  const { parts, report } = traceWithAdvice(plan, used);
  return { changed: changedPartsOf(parts, snapshots), report, used, reduced, reduction };
}

/** The [index, part] pairs of the parts a bake replaced; a part left alone is the caller's own object. */
export function changedPartsOf(bakedParts, snapshots) {
  const changed = [];
  bakedParts.forEach((part, index) => {
    if (part !== snapshots[index]) {
      changed.push([index, part]);
    }
  });
  return changed;
}

/**
 * Bakes the parts at the world matrices given by name (a retained part's own matrix is only refreshed after a commit).
 * Returns the new parts, which share the originals' matrices so poses still move them, and a report: texels,
 * rayWork, seconds, skipped parts with reasons.
 */
export function bakeAgentParts(parts, worldMatrices, environment, settings, generatedGeometryGenerators = new Map()) {
  const sunScale = environment.keyIntensity ?? 1;
  const lighting = {
    pointLights: environment.pointLights,
    spotLights: environment.spotLights,
    areaLights: environment.areaLights,
    keyColor: Array.from(environment.keyColor, channel => channel * sunScale),
    skyTop: environment.skyTop,
    skyBottom: environment.skyBottom,
    lightDirection: environment.lightDirection,
  };
  if (settings.gridFog) {
    lighting.volumeFog = environment.volumeFog;
    lighting.skyMean = meanSkyRadiance(environment.map);
  }
  // A hair, particle or cloth node is drawn from geometry built every frame, which has no lightmap UVs.
  const snapshots = parts.map(part => ({
    ...part,
    matrix: worldMatrices.get(part.name),
    material: { ...part.material },
    generatesGeometry: generatedGeometryGenerators.get(part.name) ?? false,
  }));
  if (settings.irradianceGrid) {
    return bakeIrradianceGridParts(parts, snapshots, lighting, settings);
  }
  const { changed, report, used, reduced, reduction } = runKernel('lightBake', [snapshots, lighting, settings], bakeChangedParts);
  // Probes see the unbaked parts, as the bake does, and are traced as a kernel of their own so a worker can take them too.
  const probeTrace = !settings.probes ? null
    : runKernel('probeTrace', [snapshots, lighting, settings.probes, { environment: lighting, maxSeconds: bakeSecondsLimit() }], traceProbes);
  const bakedSnapshots = snapshots.slice();
  for (const [index, part] of changed) {
    bakedSnapshots[index] = part;
  }
  const bakedParts = parts.map((part, index) => {
    if (bakedSnapshots[index] === snapshots[index]) {
      return part;
    }
    const { geometry, material } = bakedSnapshots[index];
    return Object.freeze({ ...part, geometry, material: liveBakedMaterial(part.material, material) });
  });
  // Probes are placed here, on the page, because they build maps and materials; their trace ran above.
  const placed = probeTrace ? placeProbes(bakedParts, probeTrace) : null;
  return { parts: Object.freeze(placed ? placed.parts : bakedParts), report: { ...settings, ...(placed ? { probes: placed.report } : {}), used, reduced, reduction, texels: report.texels, rayWork: report.rayWork, seconds: report.seconds,
    backend: report.backend, ...(report.gpu ? { gpu: report.gpu, gpuCompileSeconds: report.gpuCompileSeconds } : {}), bakedParts: report.parts.length, skipped: report.skipped } };
}

// The grid is a few thousand nodes of six gathers each, so its samples are a quarter of the lightmap preset's: about 32 at standard.
const GRID_SAMPLES_SHARE = 4;
const GRID_MINIMUM_SAMPLES = 8;

/**
 * The irradiance grid trace as a worker kernel. The time limit is read here and not passed in, so a worker traces under its
 * own 90 s and the page's 20 s never reaches it (and never changes the kernel's cache key).
 */
export function traceGridKernel(snapshots, lighting, options) {
  return traceIrradianceGrid(snapshots, lighting, { ...options, maxSeconds: bakeSecondsLimit() });
}

// bake.irradianceGrid: no lightmaps. Every part reads one baked grid of bounced light (the sun's lit patches included), and the
// probes still run. Inside a worker session the trace runs on the worker (90 s); otherwise on the page's thread (20 s).
function bakeIrradianceGridParts(parts, snapshots, lighting, settings) {
  const gridOptions = {
    resolution: settings.irradianceGrid,
    samples: Math.max(GRID_MINIMUM_SAMPLES, Math.round(settings.samples / GRID_SAMPLES_SHARE)),
    bounces: settings.bounces,
  };
  const grid = withMeanRadiance(runKernel('gridTrace', [snapshots, lighting, gridOptions], traceGridKernel));
  const probeTrace = !settings.probes ? null
    : runKernel('probeTrace', [snapshots, lighting, settings.probes, { environment: lighting, maxSeconds: bakeSecondsLimit() }], traceProbes);
  const gridParts = placeIrradianceGrid(parts, grid);
  const placed = probeTrace ? placeProbes(gridParts, probeTrace) : null;
  const { data, ...gridReport } = grid;
  return { parts: Object.freeze(placed ? placed.parts : gridParts), report: { ...settings, ...(placed ? { probes: placed.report } : {}), used: settings, reduced: false, reduction: null, texels: 0, rayWork: 0,
    seconds: grid.seconds, bakedParts: 0, skipped: [], irradianceGrid: gridReport } };
}

import { createAnimationClip, compileAnimationSampler } from './animation.js';
import { trackEffectsDescription } from './animation-modifiers.js';
import { invalidField, withFieldPrefix } from './field-error.js';
import { createCameraPath } from './camera-path.js';
import { CAMERA_LENS_FIELDS } from './camera.js';
import { createSkeletonPose } from './skeleton-pose.js';
import { createNodeConstraintEvaluator, normalizeConstraints, normalizeDrivers } from './node-constraints.js';
import { normalizeClipLayers } from './agent-clip-layers.js';
import { normalizeKeyframeEasing } from './easing.js';
import { normalizeFootLock } from './foot-lock.js';
import { bounded, denseArray, finite, knownKeys, valueFrom } from './motion-validation.js';
import { agentSceneModule } from './agent-scene-modules.js';

const PHYSICAL_SKY_TRACK_PROPERTIES = new Set(['sunElevation', 'sunRotation', 'turbidity', 'groundAlbedo', 'aerialPerspective', 'ozone']);

const PROPERTIES = {
  // visible is 1 or 0 and defaults to STEP interpolation; a hidden node and its children draw and cast nothing.
  node: { translation: 3, rotation: 4, scale: 3, visible: 1 },
  material: { color: 3, emissiveColor: 3, emission: 1, metallic: 1, roughness: 1 },
  camera: { eye: 3, target: 3, fov: 1, roll: 1 },
  // An imported asset's morph target weight, addressed by the target's name.
  morph: { weight: 1 },
  // A light of the scene, addressed as point:N, spot:N or area:N (its index in environment.pointLights and so on). Spot and area lights also take direction.
  light: { position: 3, direction: 3, color: 3, intensity: 1 },
  // The key light of the environment: lightDirection, keyColor, keyIntensity.
  sun: { direction: 3, color: 3, intensity: 1 },
  // Sky, fog and ambient values of the environment. volumeFogDensity is environment.volumeFog.density; environmentIntensity and
  // environmentRotation (radians) dim and turn the sky map that shows when environment.world is true.
  environment: {
    skyTop: 3, skyBottom: 3, fogColor: 3, fogDensity: 1, volumeFogDensity: 1,
    ambientIntensity: 1, fillIntensity: 1, environmentIntensity: 1, environmentRotation: 1,
    sunElevation: 1, sunRotation: 1, turbidity: 1, groundAlbedo: 1, aerialPerspective: 1, ozone: 1,
  },
  // Frame effects: exposure, and the focus distance of the depth of field (needs effects.depthOfField.blur above 0).
  effects: { exposure: 1, focusDistance: 1 },
};
// Kinds with one target in the scene, so a track names no ID.
const SINGLETON_KINDS = new Set(['camera', 'sun', 'environment', 'effects']);
const LOOK_KINDS = new Set(['light', 'sun', 'environment', 'effects']);
const LIGHT_LISTS = { point: 'pointLights', spot: 'spotLights', area: 'areaLights' };
const LIGHT_DIRECTION_TYPES = new Set(['spot', 'area']);
const LOOK_RANGES = {
  light: { position: [-1e6, 1e6], direction: [-1e6, 1e6], color: [0, 1], intensity: [0, 1e5] },
  sun: { direction: [-1e6, 1e6], color: [0, 1000], intensity: [0, 100] },
  environment: {
    skyTop: [0, 1], skyBottom: [0, 1], fogColor: [0, 1], fogDensity: [0, 10], volumeFogDensity: [0, 1000],
    ambientIntensity: [0, 100], fillIntensity: [0, 100], environmentIntensity: [0, 100], environmentRotation: [-100, 100],
    sunElevation: [-90, 90], sunRotation: [-360, 360], turbidity: [1, 10], groundAlbedo: [0, 1], aerialPerspective: [0, 4], ozone: [0, 10],
  },
  effects: { exposure: [0.01, 16], focusDistance: [0.01, 100000] },
};
const INTERPOLATIONS = ['LINEAR', 'STEP', 'SMOOTH', 'CUBICSPLINE'];
const MAX_IK_SOLVERS = 16;
const IK_SWEEP_SAMPLES = 33;
const CAMERA_DEFAULTS = { eye: [4, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 1000 };

function validateValue(kind, property, value, valuePath = `${kind}.${property}`) {
  const components = typeof value === 'number' ? [value] : value;
  for (const component of components) {
    finite(component, valuePath);
  }
  if (property === 'visible' && components.some(component => component !== 0 && component !== 1)) {
    throw invalidField(valuePath, value, '1 (shown) or 0 (hidden)');
  }
  if (property === 'scale' && components.some(component => Math.fround(component) <= 0)) {
    throw invalidField(valuePath, value, 'positive numbers, such as [1, 1, 1]');
  }
  if (kind === 'material') {
    if (components.some(component => component < 0)) {
      throw invalidField(valuePath, value, `numbers of 0 or more for ${property}, such as 0.5`);
    }
    if (['color', 'metallic', 'roughness'].includes(property) && components.some(component => component > 1)) {
      throw invalidField(valuePath, value, `numbers from 0 to 1 for ${property}, such as 0.5`);
    }
  }
  if (kind === 'morph' && components.some(component => component < 0 || component > 1)) {
    throw invalidField(valuePath, value, 'a morph weight from 0 to 1, such as 0.5');
  }
  const range = LOOK_RANGES[kind]?.[property];
  if (range && components.some(component => component < range[0] || component > range[1])) {
    throw invalidField(valuePath, value, `${kind} ${property} values from ${range[0]} to ${range[1]}, such as ${Math.min(Math.max(1, range[0]), range[1])}`);
  }
  if (property === 'direction' && Math.hypot(...components) < 1e-6) {
    throw invalidField(valuePath, value, 'a direction that is not all zero, such as [0, -1, 0]; keyframes of opposite directions blend through zero');
  }
  if (kind === 'camera' && property === 'fov' && (Math.fround(value) <= 0 || Math.fround(value) >= 180)) {
    throw invalidField(valuePath, value, 'degrees above 0 and below 180, such as 50');
  }
}

function coreProperty(track) {
  if (track.property === 'rotation') {
    return 'rotation';
  }
  return PROPERTIES[track.kind][track.property] === 1 ? 'value' : 'translation';
}

function copiedKeyframe(keyframe, interpolation) {
  const result = {
    time: keyframe.time,
    value: Array.isArray(keyframe.value) ? [...keyframe.value] : keyframe.value,
  };
  if (keyframe.easing !== undefined) result.easing = keyframe.easing;
  if (interpolation === 'CUBICSPLINE') {
    result.inTangent = Array.isArray(keyframe.inTangent) ? [...keyframe.inTangent] : keyframe.inTangent;
    result.outTangent = Array.isArray(keyframe.outTangent) ? [...keyframe.outTangent] : keyframe.outTangent;
  }
  return result;
}

function normalizedKeyframe(keyframe, track, duration, interpolation) {
  knownKeys(keyframe, ['time', 'value', 'inTangent', 'outTangent', 'easing'], 'motion keyframe');
  const size = PROPERTIES[track.kind][track.property];
  const result = {
    time: bounded(keyframe.time, 0, duration, 'time'),
    value: valueFrom(keyframe.value, size, 'value'),
  };
  validateValue(track.kind, track.property, result.value, 'value');
  const easing = normalizeKeyframeEasing(keyframe);
  if (easing && interpolation !== 'LINEAR' && interpolation !== 'SMOOTH') {
    throw invalidField('easing', keyframe.easing, `a field left out unless the track interpolation is LINEAR or SMOOTH, not ${interpolation}`);
  }
  Object.assign(result, easing);
  if (interpolation === 'CUBICSPLINE') {
    result.inTangent = valueFrom(keyframe.inTangent, size, 'Incoming tangent');
    result.outTangent = valueFrom(keyframe.outTangent, size, 'Outgoing tangent');
  } else if (Object.hasOwn(keyframe, 'inTangent') || Object.hasOwn(keyframe, 'outTangent')) {
    throw invalidField(Object.hasOwn(keyframe, 'inTangent') ? 'inTangent' : 'outTangent', keyframe.inTangent ?? keyframe.outTangent, `a field left out unless the track interpolation is CUBICSPLINE, such as "interpolation": "CUBICSPLINE" (this track is ${interpolation})`, TypeError);
  }
  return result;
}

/** The light IDs a recipe's environment has, such as point:0, spot:0 and area:1. */
function lightIds(environment) {
  return Object.entries(LIGHT_LISTS).flatMap(([type, field]) => (environment[field] ?? []).map((_, index) => `${type}:${index}`));
}

/** Checks that a light, sun, environment or effects track names something the scene has. */
function checkLookTarget(track, recipe) {
  const { kind, id, property } = track;
  if (!LOOK_KINDS.has(kind)) return;
  if (!recipe.environment || !recipe.effects) {
    throw invalidField(`motion.tracks.${kind}`, kind, 'a node, material, morph or camera track, since lights, sky and effects belong to a scene recipe and an imported asset has none');
  }
  if (kind === 'light') {
    const ids = lightIds(recipe.environment);
    if (!ids.includes(id)) {
      throw invalidField('motion.tracks.id', id, `one of the lights of this scene: ${ids.join(', ') || 'none yet'}; the sun is a sun track, such as "point:0"`);
    }
    if (property === 'direction' && !LIGHT_DIRECTION_TYPES.has(id.split(':')[0])) {
      throw invalidField('motion.tracks.property', `${id}.direction`, 'a property the light has; only spot and area lights have a direction, and a point light takes position, color and intensity');
    }
  }
  if (kind === 'effects' && property === 'focusDistance' && !(recipe.effects.depthOfField?.blur > 0)) {
    throw invalidField('motion.tracks.property', 'effects.focusDistance', 'a track only when effects.depthOfField.blur is above 0, such as blur 2; a camera with an fStop focuses on its target, so move the camera target track instead');
  }
  if (kind === 'environment' && PHYSICAL_SKY_TRACK_PROPERTIES.has(property) && recipe.environment.sky?.type !== 'physical') {
    throw invalidField('motion.tracks.property', `environment.${property}`, 'a track only when environment.sky is { "type": "physical" }');
  }
}

function nodeIdFrom(value, nodes, label) {
  if (typeof value !== 'string' || !nodes.has(value)) {
    throw invalidField(label, value, 'a node ID in this recipe, such as "arm"');
  }
  return value;
}

/** Keyframed IK channels share the motion's clip clock and keyframe budget. */
function ikKeyframes(input, size, duration, label) {
  knownKeys(input, ['keyframes', 'interpolation'], label);
  const interpolation = input.interpolation ?? 'LINEAR';
  if (!['LINEAR', 'STEP', 'SMOOTH'].includes(interpolation)) {
    throw invalidField(`${label}.interpolation`, interpolation, 'LINEAR, STEP or SMOOTH');
  }
  denseArray(input.keyframes, 64, `${label}.keyframes`);
  if (!input.keyframes.length) {
    throw invalidField(`${label}.keyframes`, input.keyframes, 'at least one keyframe, such as [{ "time": 0, "value": [0, 1, 0] }]');
  }
  const keyframes = input.keyframes.map(keyframe => {
    knownKeys(keyframe, ['time', 'value'], `${label}.keyframe`);
    return { time: bounded(keyframe.time, 0, duration, 'Keyframe time'), value: valueFrom(keyframe.value, size, `${label}.value`) };
  });
  return { interpolation, keyframes };
}

function ikPoint(input, nodes, duration, label) {
  if (Array.isArray(input)) {
    return valueFrom(input, 3, label);
  }
  if (input && Object.hasOwn(input, 'node')) {
    knownKeys(input, ['node'], label);
    return { node: nodeIdFrom(input.node, nodes, `${label}.node`) };
  }
  if (input && Object.hasOwn(input, 'keyframes')) {
    return ikKeyframes(input, 3, duration, label);
  }
  throw invalidField(label, input, '[x, y, z], { "node": id } or { "keyframes": [{ "time", "value" }] }, such as [0, 1, 0]', TypeError);
}

function ikWeight(input, duration, label) {
  if (input === undefined) {
    return 1;
  }
  if (typeof input === 'number') {
    return bounded(input, 0, 1, label);
  }
  const weight = ikKeyframes(input, 1, duration, label);
  weight.keyframes.forEach(keyframe => bounded(keyframe.value, 0, 1, label));
  return weight;
}

/** { root: { x: [min, max], y, z }, middle: {...} } in degrees, the turn away from the rest rotation in the joint's own axes. */
function jointLimits(input, label, allowedJoints = null) {
  if (allowedJoints) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalidField(label, input, 'an object mapping joint node IDs to { x, y, z } degree ranges', TypeError);
    }
    for (const joint of Object.keys(input)) {
      if (!allowedJoints.has(joint)) {
        throw invalidField(`${label}.${joint}`, joint, 'a node ID in the chain');
      }
    }
  } else {
    knownKeys(input, ['root', 'middle'], label);
  }
  const limits = {};
  for (const joint of Object.keys(input)) {
    knownKeys(input[joint], ['x', 'y', 'z'], `${label}.${joint}`);
    limits[joint] = {};
    for (const axis of Object.keys(input[joint])) {
      const range = valueFrom(input[joint][axis], 2, `${label}.${joint}.${axis}`);
      if (range[0] > range[1] || range[0] < -180 || range[1] > 180) {
        throw invalidField(`${label}.${joint}.${axis}`, input[joint][axis], '[min, max] degrees within -180 and 180, min first, such as [-90, 90]');
      }
      limits[joint][axis] = range;
    }
  }
  return limits;
}

function normalizeIkChainSpec(input, nodes, label) {
  if (input.chain !== undefined && (input.root !== undefined || input.end !== undefined)) {
    throw invalidField(`${label}.chain`, input.chain, 'chain, or root and end, not both', TypeError);
  }
  if (input.chain !== undefined) {
    const names = denseArray(input.chain, 16, `${label}.chain`);
    if (names.length < 2) {
      throw invalidField(`${label}.chain`, input.chain, '2 to 16 node IDs from base to end, such as ["b0", "b1", "b2", "tip"]');
    }
    return { chain: names.map((name, slot) => nodeIdFrom(name, nodes, `${label}.chain[${slot}]`)) };
  }
  if (input.root !== undefined && input.end !== undefined) {
    return {
      root: nodeIdFrom(input.root, nodes, `${label}.root`),
      end: nodeIdFrom(input.end, nodes, `${label}.end`),
    };
  }
  throw invalidField(`${label}.chain`, input.chain, 'chain: [nodeIds], or root and end node IDs', TypeError);
}

function normalizeIkStretch(value, label) {
  if (typeof value === 'boolean') return value;
  return bounded(value, 0, 1, label);
}

function normalizeIkCurve(input, visibleNodes, label) {
  if (Array.isArray(input)) {
    denseArray(input, 64, label);
    if (input.length < 2) {
      throw invalidField(label, input, '2 to 64 [x, y, z] points');
    }
    return input.map((point, index) => valueFrom(point, 3, `${label}[${index}]`));
  }
  if (input && typeof input === 'object' && Object.hasOwn(input, 'nodes')) {
    knownKeys(input, ['nodes'], label);
    const ids = denseArray(input.nodes, 64, `${label}.nodes`);
    if (ids.length < 2) {
      throw invalidField(`${label}.nodes`, input.nodes, '2 to 64 node IDs');
    }
    return { nodes: ids.map((id, index) => nodeIdFrom(id, visibleNodes, `${label}.nodes[${index}]`)) };
  }
  throw invalidField(label, input, '2 to 64 [x, y, z] points or { "nodes": [ids] }', TypeError);
}

function normalizeIkSolver(input, position, nodes, visibleNodes, duration) {
  const label = `motion.ik[${position}]`;
  if (input?.type === 'two-bone') {
    knownKeys(input, ['type', 'root', 'middle', 'end', 'target', 'pole', 'weight', 'keepEndRotation', 'limits', 'bendToward'], label);
    const solver = {
      type: 'two-bone',
      root: nodeIdFrom(input.root, nodes, `${label}.root`),
      middle: nodeIdFrom(input.middle, nodes, `${label}.middle`),
      end: nodeIdFrom(input.end, nodes, `${label}.end`),
      target: ikPoint(input.target, visibleNodes, duration, `${label}.target`),
      weight: ikWeight(input.weight, duration, `${label}.weight`),
    };
    if (input.pole !== undefined) {
      solver.pole = ikPoint(input.pole, visibleNodes, duration, `${label}.pole`);
    }
    if (input.keepEndRotation !== undefined) {
      if (typeof input.keepEndRotation !== 'boolean') {
        throw invalidField(`${label}.keepEndRotation`, input.keepEndRotation, 'true or false', TypeError);
      }
      solver.keepEndRotation = input.keepEndRotation;
    }
    if (input.limits !== undefined) {
      solver.limits = jointLimits(input.limits, `${label}.limits`);
    }
    if (input.bendToward !== undefined) {
      solver.bendToward = valueFrom(input.bendToward, 3, `${label}.bendToward`);
    }
    return solver;
  }
  if (input?.type === 'aim') {
    knownKeys(input, ['type', 'joint', 'joints', 'forward', 'worldForward', 'target', 'maxAngle', 'weight'], label);
    if (input.forward !== undefined && input.worldForward !== undefined) {
      throw invalidField(`${label}.worldForward`, input.worldForward, 'forward or worldForward, not both; leave one out', TypeError);
    }
    if ((input.joint === undefined) === (input.joints === undefined)) {
      throw invalidField(`${label}.joint`, input.joint, 'joint, or joints listed from the base of the chain to the aiming node, such as { "joint": "head" }', TypeError);
    }
    const names = input.joints === undefined ? [input.joint] : denseArray(input.joints, 16, `${label}.joints`);
    if (!names.length) {
      throw invalidField(`${label}.joints`, input.joints, 'at least one node ID, such as ["neck", "head"]');
    }
    const solver = {
      type: 'aim',
      joints: names.map(name => nodeIdFrom(name, nodes, `${label}.joint`)),
      target: ikPoint(input.target, visibleNodes, duration, `${label}.target`),
      weight: ikWeight(input.weight, duration, `${label}.weight`),
    };
    if (input.worldForward !== undefined) {
      solver.worldForward = valueFrom(input.worldForward, 3, `${label}.worldForward`);
    } else {
      solver.forward = valueFrom(input.forward ?? [0, 0, 1], 3, `${label}.forward`);
    }
    if (input.maxAngle !== undefined) {
      solver.maxAngle = bounded(input.maxAngle, 0.001, 180, `${label}.maxAngle`);
    }
    return solver;
  }
  if (input?.type === 'chain' || input?.type === 'ik') {
    knownKeys(input, ['type', 'chain', 'root', 'end', 'target', 'pole', 'poleAngle', 'stretch', 'iterations', 'limits', 'keepEndRotation', 'weight'], label);
    const spec = normalizeIkChainSpec(input, nodes, label);
    const solver = {
      type: 'chain',
      ...spec,
      target: ikPoint(input.target, visibleNodes, duration, `${label}.target`),
      weight: ikWeight(input.weight, duration, `${label}.weight`),
    };
    if (input.pole !== undefined) {
      solver.pole = ikPoint(input.pole, visibleNodes, duration, `${label}.pole`);
    }
    if (input.poleAngle !== undefined) {
      solver.poleAngle = bounded(input.poleAngle, -180, 180, `${label}.poleAngle`);
    }
    if (input.stretch !== undefined) {
      solver.stretch = normalizeIkStretch(input.stretch, `${label}.stretch`);
    }
    if (input.iterations !== undefined) {
      if (!Number.isInteger(input.iterations)) {
        throw invalidField(`${label}.iterations`, input.iterations, 'a whole number of iterations from 1 to 64, such as 16', TypeError);
      }
      solver.iterations = bounded(input.iterations, 1, 64, `${label}.iterations`);
    }
    if (input.keepEndRotation !== undefined) {
      if (typeof input.keepEndRotation !== 'boolean') {
        throw invalidField(`${label}.keepEndRotation`, input.keepEndRotation, 'true or false', TypeError);
      }
      solver.keepEndRotation = input.keepEndRotation;
    }
    if (input.limits !== undefined) {
      const allowed = spec.chain ? new Set(spec.chain.slice(0, -1)) : nodes;
      solver.limits = jointLimits(input.limits, `${label}.limits`, allowed);
    }
    return solver;
  }
  if (input?.type === 'spline' || input?.type === 'spline_ik') {
    knownKeys(input, ['type', 'chain', 'root', 'end', 'curve', 'stretch', 'weight'], label);
    const spec = normalizeIkChainSpec(input, nodes, label);
    const solver = {
      type: 'spline',
      ...spec,
      curve: normalizeIkCurve(input.curve, visibleNodes, `${label}.curve`),
      weight: ikWeight(input.weight, duration, `${label}.weight`),
    };
    if (input.stretch !== undefined) {
      solver.stretch = normalizeIkStretch(input.stretch, `${label}.stretch`);
    }
    return solver;
  }
  throw invalidField(`${label}.type`, input?.type, 'one of two-bone, aim, chain or spline');
}

function solverNodes(solver) {
  if (solver.type === 'two-bone') return [solver.root, solver.middle, solver.end];
  if (solver.type === 'aim') return solver.joints;
  return solver.chain ?? [solver.root, solver.end];
}

function pointNodes(solver) {
  const points = [solver.target, solver.pole].filter(point => point?.node).map(point => point.node);
  return solver.curve?.nodes ? [...points, ...solver.curve.nodes] : points;
}

function ancestorsOf(id, nodesById) {
  const found = [];
  let current = nodesById.get(id)?.parent;
  while (current !== undefined && current !== null) {
    found.push(current);
    current = nodesById.get(current)?.parent;
  }
  return found;
}

// The rig math assumes uniform scale. A non-uniform parent would shear what the solver thinks is a rigid chain. A node's
// own scale only reaches its children, so the end of a chain or a lone aimed box can have any size.
function checkIkScales(ik, tracks, recipe) {
  const nodesById = new Map(ikHierarchy(recipe).map(node => [node.id, node]));
  const scaledByTrack = new Set(tracks.filter(track => track.kind === 'node' && track.property === 'scale').map(track => track.id));
  const uniformRequired = new Set();
  for (const solver of ik) {
    for (const id of [...solverNodes(solver), ...pointNodes(solver)]) {
      ancestorsOf(id, nodesById).forEach(ancestor => uniformRequired.add(ancestor));
    }
  }
  for (const id of uniformRequired) {
    if (scaledByTrack.has(id)) {
      throw invalidField('motion.tracks', `node ${id} scale`, `no scale track on node ${id}, since IK nodes sit below it; drop the track or put the size on a child node`);
    }
    const scale = nodesById.get(id).scale ?? [1, 1, 1];
    if (Math.max(...scale) - Math.min(...scale) > 1e-3 * Math.max(...scale)) {
      throw invalidField(`nodes.${id}.scale`, scale, 'a uniform scale such as [1, 1, 1], since IK nodes sit below it; put the size on a child node with the geometry');
    }
  }
}

/** Every node IK can see. An imported asset's editable nodes can sit under fixed ones, which still carry them. */
function ikHierarchy(recipe) {
  return recipe.ikHierarchy ?? recipe.nodes;
}

function normalizeIk(input, recipe, tracks, duration) {
  denseArray(input, MAX_IK_SOLVERS, 'Motion ik');
  const movableNodes = new Set(recipe.nodes.map(node => node.id));
  const visibleNodes = new Set(ikHierarchy(recipe).map(node => node.id));
  const ik = input.map((solver, position) => normalizeIkSolver(solver, position, movableNodes, visibleNodes, duration));
  checkIkScales(ik, tracks, recipe);
  return ik;
}

function ikKeyframeCount(ik) {
  let count = 0;
  for (const solver of ik) {
    for (const channel of [solver.target, solver.pole, solver.weight]) {
      count += channel?.keyframes?.length ?? 0;
    }
  }
  return count;
}

/** Normalize bounded authored data without storing bindings or sampled poses. */
/** The canonical drive entry and the drive built from it, which proves the wheels, path and speeds are usable. */
function normalizedDrive(input, recipe) {
  if (!recipe.normalizeDrive) {
    throw invalidField('motion.drive', input, 'a field left out in a scene recipe, since it moves an imported asset recipe; for an asset placed in a scene, give the placement a drive: { asset: { id, drive } }');
  }
  const canonical = recipe.normalizeDrive(input, 'motion.drive');
  return { canonical, built: recipe.buildDrive(canonical) };
}

export function normalizeAgentMotion(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, ['duration', 'loop', 'tracks', 'ik', 'constraints', 'drivers', 'layers', 'footLock', 'drive'], 'motion');
  const drive = input.drive === undefined ? null : normalizedDrive(input.drive, recipe);
  // A drive knows how long its path takes, so the motion may leave the duration out.
  const duration = bounded(input.duration === undefined && drive ? Math.ceil(drive.built.duration * 1000) / 1000 : input.duration, 0.1, 30, 'motion.duration');
  const loop = input.loop === undefined ? false : input.loop;
  if (typeof loop !== 'boolean') {
    throw invalidField('motion.loop', loop, 'true or false', TypeError);
  }
  const inputTracks = input.tracks ?? [];
  denseArray(inputTracks, 128, 'Motion tracks');
  if (!inputTracks.length && !input.layers?.length && !input.ik?.length && !input.constraints?.length && !input.drivers?.length && !drive) {
    throw invalidField('motion', input, 'at least one track, IK solver, constraint or driver, such as { "duration": 1, "tracks": [...] }; use null to clear it');
  }
  const nodes = new Set((recipe.nodes ?? []).map(node => node.id));
  const materials = new Set((recipe.materials ?? []).map(material => material.id));
  // An imported asset lists its morph targets; a recipe mesh offers the names of its shape keys.
  const morphTargets = new Set(recipe.morphTargets ?? (recipe.geometries ?? []).flatMap(geometry => (geometry.shapeKeys ?? []).map(key => key.name)));
  const identities = new Set();
  let keyframeCount = 0;
  const tracks = inputTracks.map((track, index) => {
    knownKeys(track, ['kind', 'id', 'property', 'interpolation', 'keyframes', 'extrapolation', 'modifiers'], 'motion track');
    if (!Object.hasOwn(PROPERTIES, track.kind) || !Object.hasOwn(PROPERTIES[track.kind], track.property)) {
      const known = Object.hasOwn(PROPERTIES, track.kind) ? ` ${track.kind} properties: ${Object.keys(PROPERTIES[track.kind]).join(', ')}.` : ` Kinds: ${Object.keys(PROPERTIES).join(', ')}.`;
      throw invalidField(`motion.tracks[${index}].property`, `${track.kind}.${track.property}`, `a kind and property pair.${known}`);
    }
    if (SINGLETON_KINDS.has(track.kind)) {
      if (Object.hasOwn(track, 'id')) {
        throw invalidField(`motion.tracks[${index}].id`, track.id, `a field left out, since ${track.kind} tracks have no ID, such as { "kind": "${track.kind}", "property": ..., "keyframes": [...] }`, TypeError);
      }
    } else {
      if (typeof track.id !== 'string' || !track.id.trim() || track.id.length > 128) {
        throw invalidField(`motion.tracks[${index}].id`, track.id, 'an ID of 1 to 128 characters, such as "body"', TypeError);
      }
      const references = track.kind === 'node' ? nodes : track.kind === 'morph' ? morphTargets : materials;
      if (track.kind !== 'light' && !references.has(track.id)) {
        const hint = track.kind === 'morph' ? `; morph targets of this asset: ${[...morphTargets].slice(0, 24).join(', ') || 'none'}` : '';
        throw invalidField(`motion.tracks[${index}].id`, track.id, `the ID of a ${track.kind} in this recipe, such as ${JSON.stringify([...references][0] ?? 'body')}${hint}`);
      }
    }
    checkLookTarget(track, recipe);
    const identity = JSON.stringify([track.kind, track.id ?? null, track.property]);
    if (identities.has(identity)) {
      throw invalidField(`motion.tracks[${index}].property`, `${track.kind}.${track.property}`, 'one track per target and property, but this one repeats an earlier track: merge the keyframes, or drop the duplicate');
    }
    identities.add(identity);
    const interpolation = track.interpolation ?? (track.property === 'visible' ? 'STEP' : 'LINEAR');
    if (!INTERPOLATIONS.includes(interpolation)) {
      throw invalidField(`motion.tracks[${index}].interpolation`, interpolation, `one of ${INTERPOLATIONS.join(', ')}`);
    }
    denseArray(track.keyframes, 64, 'Motion keyframes');
    keyframeCount += track.keyframes.length;
    if (keyframeCount > 2048) {
      throw invalidField(`motion.tracks[${index}].keyframes`, track.keyframes.length, `fewer keyframes, since a motion holds at most 2048 in total and this track reaches ${keyframeCount}`);
    }
    const keyframes = track.keyframes.map((keyframe, keyframeIndex) => withFieldPrefix(`motion.tracks[${index}].keyframes[${keyframeIndex}]`, () => normalizedKeyframe(keyframe, track, duration, interpolation)));
    const clip = createAnimationClip({
      duration, loop,
      tracks: [{ target: String(index), property: coreProperty(track), interpolation, keyframes, extrapolation: track.extrapolation, modifiers: track.modifiers }],
    });
    const result = {
      kind: track.kind,
      property: track.property,
      interpolation,
      keyframes: clip.tracks[0].keyframes.map(keyframe => copiedKeyframe(keyframe, interpolation)),
    };
    if (clip.tracks[0].effects) Object.assign(result, trackEffectsDescription(clip.tracks[0].effects));
    if (!SINGLETON_KINDS.has(track.kind)) {
      result.id = track.id;
    }
    return result;
  });
  const result = { duration, loop, tracks };
  if (drive) {
    result.drive = drive.canonical;
  }
  if (input.layers !== undefined) {
    result.layers = normalizeClipLayers(input.layers, recipe.clipLayerContext);
  }
  if (input.footLock !== undefined) {
    if (!result.layers?.length) throw invalidField('motion.footLock', input.footLock, 'a field left out unless motion.layers has layers, since it plants the feet of their clips, such as layers [{ "clip": 0 }]');
    result.footLock = normalizeFootLock(input.footLock);
  }
  if (input.ik !== undefined) {
    result.ik = normalizeIk(input.ik, recipe, tracks, duration);
    if (keyframeCount + ikKeyframeCount(result.ik) > 2048) {
      throw invalidField('motion.ik', input.ik, `fewer keyframes, since a motion holds at most 2048 in total and tracks plus IK reach ${keyframeCount + ikKeyframeCount(result.ik)}`);
    }
  }
  const visibleIds = new Set(ikHierarchy(recipe).map(node => node.id));
  if (input.constraints !== undefined) {
    result.constraints = normalizeConstraints(input.constraints, nodes, visibleIds);
  }
  if (input.drivers !== undefined) {
    result.drivers = normalizeDrivers(input.drivers, nodes, materials, visibleIds);
    for (const { target } of result.drivers) {
      if (identities.has(JSON.stringify([target.kind, target.id, target.property]))) {
        throw invalidField('motion.drivers', `${target.id} ${target.property}`, `a property no track animates, since a track on ${target.kind} ${target.id} already moves ${target.property}; drop the track or the driver`);
      }
    }
  }
  return result;
}

/** A rig of just the nodes IK needs: chains, the nodes their targets follow, and all their ancestors. */
function ikRig(ik, recipe) {
  const hierarchy = ikHierarchy(recipe);
  const nodesById = new Map(hierarchy.map(node => [node.id, node]));
  const needed = new Set();
  for (const solver of ik) {
    for (const id of [...solverNodes(solver), ...pointNodes(solver)]) {
      needed.add(id);
      ancestorsOf(id, nodesById).forEach(ancestor => needed.add(ancestor));
    }
  }
  const members = hierarchy.filter(node => needed.has(node.id));
  const indexById = new Map(members.map((node, index) => [node.id, index]));
  return {
    // Identifying joints by node ID alone keeps a node named like a humanoid bone from being mapped to another one.
    mapping: {},
    ...(recipe.ikRootMatrix ? { rootMatrix: recipe.ikRootMatrix } : {}),
    joints: members.map(node => ({
      name: node.id,
      parent: node.parent === undefined || node.parent === null ? -1 : indexById.get(node.parent),
      translation: node.translation ?? [0, 0, 0],
      rotation: node.rotation ?? [0, 0, 0, 1],
      scale: node.scale ?? [1, 1, 1],
    })),
  };
}

function ikChannelClip(ik, duration, loop) {
  const tracks = [];
  ik.forEach((solver, position) => {
    if (solver.target?.keyframes) tracks.push({ target: `target ${position}`, property: 'translation', interpolation: solver.target.interpolation, keyframes: solver.target.keyframes });
    if (solver.pole?.keyframes) tracks.push({ target: `pole ${position}`, property: 'translation', interpolation: solver.pole.interpolation, keyframes: solver.pole.keyframes });
    if (solver.weight.keyframes) tracks.push({ target: `weight ${position}`, property: 'value', interpolation: solver.weight.interpolation, keyframes: solver.weight.keyframes });
  });
  return tracks.length ? createAnimationClip({ duration, loop, tracks }) : null;
}

/** Solve a motion's IK on top of its sampled node tracks. Returns staged rotations per node ID. */
function createIkEvaluator(motion, recipe, stagedNodeTracks) {
  const rig = ikRig(motion.ik, recipe);
  const clip = ikChannelClip(motion.ik, motion.duration, motion.loop);
  const channelSampler = clip ? compileAnimationSampler(clip) : null;
  const channelOutput = name => channelSampler.tracks.find(track => track.target === name).output;
  let pose = null;
  const pointReader = (point, name) => {
    if (Array.isArray(point)) return () => point;
    if (point.node) return () => pose.jointWorld(point.node).position;
    const output = channelOutput(name);
    return () => output;
  };
  const definitions = motion.ik.map((solver, position) => {
    const weightOutput = solver.weight.keyframes ? channelOutput(`weight ${position}`) : null;
    const weight = weightOutput ? () => Math.min(1, Math.max(0, weightOutput[0])) : solver.weight;
    if (solver.type === 'spline') {
      const curve = Array.isArray(solver.curve)
        ? solver.curve
        : () => solver.curve.nodes.map(nodeId => pose.jointWorld(nodeId).position);
      return {
        type: 'spline',
        ...(solver.chain ? { chain: solver.chain } : { root: solver.root, end: solver.end }),
        curve, stretch: solver.stretch, weight,
      };
    }
    const common = { target: pointReader(solver.target, `target ${position}`), weight };
    if (solver.type === 'aim') {
      return { ...common, type: 'aim', joints: solver.joints, forward: solver.forward, worldForward: solver.worldForward, maxAngle: solver.maxAngle };
    }
    if (solver.type === 'chain') {
      return {
        ...common, type: 'chain',
        ...(solver.chain ? { chain: solver.chain } : { root: solver.root, end: solver.end }),
        ...(solver.pole ? { pole: pointReader(solver.pole, `pole ${position}`) } : {}),
        poleAngle: solver.poleAngle, stretch: solver.stretch, iterations: solver.iterations,
        limits: solver.limits, keepEndRotation: solver.keepEndRotation,
      };
    }
    return {
      ...common, type: 'two-bone', root: solver.root, middle: solver.middle, end: solver.end,
      ...(solver.pole ? { pole: pointReader(solver.pole, `pole ${position}`) } : {}),
      keepEndRotation: solver.keepEndRotation, limits: solver.limits, bendToward: solver.bendToward,
    };
  });
  pose = createSkeletonPose({ rig, ik: definitions });
  const indexById = new Map(rig.joints.map((joint, index) => [joint.name, index]));
  const baseBindings = rig.joints.map((joint, index) => ({ index, tracks: stagedNodeTracks.get(joint.name) }));
  const skippedEnds = new Set(
    motion.ik
      .filter(solver => (solver.type === 'two-bone' || solver.type === 'chain') && solver.keepEndRotation === false)
      .map(solver => solver.end ?? solver.chain[solver.chain.length - 1])
  );
  const solvedIds = new Set(pose.solvedJointNames.filter(id => !skippedEnds.has(id)));
  const staged = new Map([...solvedIds].map(id => [id, new Float64Array(4)]));
  const translatedIds = pose.writtenJoints.filter(entry => entry.translation).map(entry => rig.joints[entry.index].name);
  const stagedTranslations = new Map(translatedIds.map(id => [id, new Float64Array(3)]));
  function setBaseFromTracks(localRotations, localTranslations) {
    for (const { index, tracks } of baseBindings) {
      if (tracks?.rotation) localRotations[index].set(tracks.rotation);
      if (tracks?.translation) localTranslations[index].set(tracks.translation);
    }
  }
  return {
    staged,
    stagedTranslations,
    /** Solve for a time. `nodePoses` is a staged { id, translation, rotation } list; without it the base is the tracks. */
    solve(time, nodePoses) {
      channelSampler?.sample(time);
      if (nodePoses) {
        const poseById = new Map(nodePoses.map(nodePose => [nodePose.id, nodePose]));
        pose.apply(time, (localRotations, localTranslations) => {
          rig.joints.forEach((joint, index) => {
            const nodePose = poseById.get(joint.name);
            localRotations[index].set(nodePose.rotation);
            localTranslations[index].set(nodePose.translation);
          });
        });
      } else {
        pose.apply(time, setBaseFromTracks);
      }
      for (const [id, rotation] of staged) {
        rotation.set(pose.localRotation(indexById.get(id)));
        if (!rotation.every(Number.isFinite)) throw new RangeError(`Motion ik produced an invalid rotation for node ${id}.`);
      }
      for (const [id, translation] of stagedTranslations) {
        translation.set(pose.localTranslation(indexById.get(id)));
      }
      return pose.ikResults;
    },
  };
}

function validateRadiance(material, materialId) {
  const emission = material.emission ?? 0;
  const color = material.emissiveColor ?? material.color ?? [0.5, 0.5, 0.5];
  for (const component of color) {
    const radiance = Math.fround(component) * Math.fround(emission);
    if (!Number.isFinite(Math.fround(radiance))) {
      throw invalidField(`materials.${materialId}.emission`, emission, 'a value that keeps emissiveColor times emission inside Float32 range, such as 5');
    }
    if (material.tag === 'unlit' && radiance > 65500) {
      throw invalidField(`materials.${materialId}.emission`, emission, 'a value that keeps an unlit emissiveColor times emission at or below 65500, such as 5');
    }
  }
}

/** IDs of the nodes a driver or constraint writes. */
function constrainedNodeIds(motion) {
  const driven = (motion.drivers ?? []).filter(driver => driver.target.kind === 'node').map(driver => driver.target.id);
  return new Set([...driven, ...(motion.constraints ?? []).map(constraint => constraint.node)]);
}

/** An environment (a clone the caller may change) with the light, sun and sky values a sampled motion sets. */
export function motionEnvironment(environment, sampled) {
  for (const [id, patch] of sampled.lights) {
    const [type, index] = id.split(':');
    Object.assign(environment[LIGHT_LISTS[type]][Number(index)], copiedPatch(patch));
  }
  if (sampled.sun) {
    const { direction, color, intensity } = copiedPatch(sampled.sun);
    if (direction) environment.lightDirection = direction;
    if (color) environment.keyColor = color;
    if (intensity !== undefined) environment.keyIntensity = intensity;
  }
  if (sampled.environment) {
    const { volumeFogDensity, ...fields } = copiedPatch(sampled.environment);
    const skyPatch = {};
    for (const property of PHYSICAL_SKY_TRACK_PROPERTIES) {
      if (fields[property] !== undefined) {
        skyPatch[property] = fields[property];
        delete fields[property];
      }
    }
    if (environment.sky && Object.keys(skyPatch).length > 0) {
      agentSceneModule('physicalSky').applyPhysicalSky({ ...environment.sky, ...skyPatch }, environment, invalidField);
    }
    Object.assign(environment, fields);
    if (volumeFogDensity !== undefined) environment.volumeFog.density = volumeFogDensity;
  }
  return environment;
}

/** Effects (a clone the caller may change) with the exposure and focus distance a sampled motion sets. */
export function motionEffects(effects, sampled) {
  const { exposure, focusDistance } = sampled.effects;
  if (exposure !== undefined) effects.exposure = exposure;
  if (focusDistance !== undefined) effects.depthOfField.focusDistance = focusDistance;
  return effects;
}

/** True when a sample moves a light, the sky or the effects, which the scene then reads through the two functions above. */
export function motionMovesLook(sampled) {
  return Boolean(sampled && (sampled.lights.size || sampled.sun || sampled.environment || sampled.effects));
}

function copiedPatch(patch) {
  return Object.fromEntries(Object.entries(patch).map(([property, value]) => [property, typeof value === 'number' ? value : Array.from(value)]));
}

/** Retains published maps and vectors. A failed sample leaves them unchanged. */
export function compileAgentMotion(input, recipe) {
  const motion = normalizeAgentMotion(input, recipe);
  if (motion === null) {
    return null;
  }
  const ordinaryTracks = motion.tracks.filter(track => track.kind !== 'camera');
  // Light, sun, environment and effects patches are allocated once here; the scene reads them through lookAt functions below.
  const clip = createAnimationClip({
    duration: motion.duration,
    loop: motion.loop,
    tracks: ordinaryTracks.map((track, index) => ({
      target: String(index),
      property: coreProperty(track),
      interpolation: track.interpolation,
      keyframes: track.keyframes,
      extrapolation: track.extrapolation,
      modifiers: track.modifiers,
    })),
  });
  const sampler = compileAnimationSampler(clip);
  const output = { nodes: new Map(), materials: new Map(), morphs: new Map(), lights: new Map(), sun: null, environment: null, effects: null, camera: null };
  const patchesByKind = { node: output.nodes, material: output.materials, morph: output.morphs, light: output.lights };
  const bindings = ordinaryTracks.map((track, index) => {
    let patch;
    if (LOOK_KINDS.has(track.kind) && track.kind !== 'light') {
      output[track.kind] ??= {};
      patch = output[track.kind];
    } else {
      const patches = patchesByKind[track.kind];
      if (!patches.has(track.id)) {
        patches.set(track.id, {});
      }
      patch = patches.get(track.id);
    }
    const size = PROPERTIES[track.kind][track.property];
    patch[track.property] = size === 1 ? 0 : new Float64Array(size);
    return { track, patch, staged: sampler.tracks[index].output };
  });
  const stagedNodeTracks = new Map();
  for (const { track, staged } of bindings) {
    if (track.kind !== 'node') continue;
    if (!stagedNodeTracks.has(track.id)) stagedNodeTracks.set(track.id, {});
    stagedNodeTracks.get(track.id)[track.property] = staged;
  }
  const ikEvaluator = motion.ik?.length ? createIkEvaluator(motion, recipe, stagedNodeTracks) : null;
  const constraintEvaluator = createNodeConstraintEvaluator({
    hierarchy: ikHierarchy(recipe), rootMatrix: recipe.ikRootMatrix,
    constraints: motion.constraints, drivers: motion.drivers, materials: recipe.materials ?? [],
  });
  // An imported asset's base pose comes from its decoder, so it asks for IK and constraints itself with solveStagedPose.
  const ikUsesStagedPose = Boolean((ikEvaluator || constraintEvaluator) && recipe.ikHierarchy);
  if (ikEvaluator && !ikUsesStagedPose) {
    for (const id of ikEvaluator.staged.keys()) {
      if (!output.nodes.has(id)) output.nodes.set(id, {});
      const nodePatch = output.nodes.get(id);
      if (!nodePatch.rotation) nodePatch.rotation = new Float64Array(4);
    }
    for (const id of ikEvaluator.stagedTranslations.keys()) {
      if (!output.nodes.has(id)) output.nodes.set(id, {});
      const nodePatch = output.nodes.get(id);
      if (!nodePatch.translation) nodePatch.translation = new Float64Array(3);
    }
  }
  if (constraintEvaluator && !ikUsesStagedPose) {
    for (const id of constrainedNodeIds(motion)) {
      if (!output.nodes.has(id)) output.nodes.set(id, {});
      const nodePatch = output.nodes.get(id);
      nodePatch.translation ??= new Float64Array(3);
      nodePatch.rotation ??= new Float64Array(4);
      nodePatch.scale ??= new Float64Array(3);
    }
  }
  const drivenMaterials = (motion.drivers ?? []).filter(driver => driver.target.kind === 'material');
  for (const { target } of drivenMaterials) {
    if (!output.materials.has(target.id)) output.materials.set(target.id, {});
    output.materials.get(target.id)[target.property] = target.component === undefined ? 0 : new Float64Array(3);
  }
  const driveSampler = motion.drive ? recipe.buildDrive(motion.drive) : null;
  if (driveSampler) {
    // The drive touches the same nodes and tail-light materials at every time, so its patches are allocated once.
    for (const { id } of driveSampler.sample(0).nodeOverrides) {
      output.nodes.set(id, { translation: new Float64Array(3), rotation: new Float64Array(4), scale: new Float64Array(3) });
    }
    for (const { material } of motion.drive.lights?.tailLights ?? []) output.materials.set(material, { emission: 0 });
  }
  const baselines = new Map((recipe.materials ?? []).map(material => [material.id, structuredClone(material)]));
  const cameraTracks = motion.tracks.filter(track => track.kind === 'camera');
  const cameraInput = {
    ...structuredClone(CAMERA_DEFAULTS),
    ...structuredClone(recipe.camera ?? {}),
    duration: motion.duration,
    loop: motion.loop,
  };
  for (const track of cameraTracks) {
    cameraInput[track.property] = { interpolation: track.interpolation, keyframes: track.keyframes, extrapolation: track.extrapolation, modifiers: track.modifiers };
  }
  const cameraPath = cameraTracks.length ? createCameraPath(cameraInput) : null;
  const stagedCamera = cameraPath ? { eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3) } : null;
  if (cameraPath) {
    if (cameraInput.focalLength !== undefined && cameraTracks.some(track => track.property === 'fov')) {
      throw invalidField('motion.tracks.property', 'camera.fov', 'a camera track other than fov, since the camera has a focalLength; give the camera a fov instead, or leave fov out of the motion');
    }
    output.camera = {
      eye: new Float32Array(3), target: new Float32Array(3), up: new Float32Array(3),
      fov: 45, near: cameraInput.near, far: cameraInput.far,
      // The lens the recipe camera sets (projection, focal length, shift, f-stop) stays while the tracks move the camera.
      ...Object.fromEntries(CAMERA_LENS_FIELDS.filter(field => cameraInput[field] !== undefined).map(field => [field, cameraInput[field]])),
    };
  }
  const materialSamples = new Map([...output.materials.keys()].map(id => [id, { ...baselines.get(id) }]));
  /** Node values straight from the tracks. A node without a track keeps its rest value. */
  const trackBases = () => new Map([...stagedNodeTracks].map(([id, tracks]) => [id, { ...tracks }]));
  /** The tracks with IK's rotations on top: the pose drivers and constraints start from. */
  function poseBases() {
    const bases = trackBases();
    for (const [id, rotation] of ikEvaluator?.staged ?? []) bases.set(id, { ...bases.get(id), rotation });
    for (const [id, translation] of ikEvaluator?.stagedTranslations ?? []) bases.set(id, { ...bases.get(id), translation });
    return bases;
  }
  return Object.freeze({
    ikUsesStagedPose,
    driveSampler,
    /**
     * Solve IK, then drivers and constraints, over a pose an asset staged for this time ({ id, translation, rotation,
     * scale } per node). Returns the node overrides to add: rotations for IK nodes, whole transforms for constrained ones.
     */
    solveStagedPose(time, nodePoses) {
      const overrides = new Map();
      const bases = new Map(nodePoses.map(({ id, translation, rotation, scale }) => [id, { translation, rotation, scale }]));
      if (ikEvaluator) {
        ikEvaluator.solve(time, nodePoses);
        for (const [id, rotation] of ikEvaluator.staged) {
          overrides.set(id, { rotation: Array.from(rotation) });
          bases.set(id, { ...bases.get(id), rotation });
        }
        for (const [id, translation] of ikEvaluator.stagedTranslations) {
          overrides.set(id, { ...overrides.get(id), translation: Array.from(translation) });
          bases.set(id, { ...bases.get(id), translation });
        }
      }
      if (constraintEvaluator) {
        for (const [id, frame] of constraintEvaluator.evaluate(time, bases).nodes) {
          overrides.set(id, { translation: Array.from(frame.translation), rotation: Array.from(frame.rotation), scale: Array.from(frame.scale) });
        }
      }
      return [...overrides].map(([id, fields]) => ({ id, ...fields }));
    },
    /**
     * How IK fares across the whole clip: one { type, reached, worstError, atTime } per solver. Moves the sampler.
     * `stagedPoseAt(time)` supplies the base pose when the asset owns it.
     */
    sweepIk(stagedPoseAt) {
      if (!ikEvaluator) return [];
      const worst = motion.ik.map(solver => ({ type: solver.type, reached: true, worstError: 0, atTime: 0, warnings: [], limited: [] }));
      for (let sample = 0; sample < IK_SWEEP_SAMPLES; sample++) {
        const time = motion.duration * sample / (IK_SWEEP_SAMPLES - 1);
        sampler.sample(time);
        ikEvaluator.solve(time, stagedPoseAt?.(time)).forEach((result, position) => {
          const record = worst[position];
          const atTime = Number(time.toFixed(3));
          record.reached = record.reached && result.reached;
          if (result.error > record.worstError) {
            record.worstError = Number(result.error.toFixed(6));
            record.atTime = atTime;
          }
          // Each distinct warning and each limited axis is reported once, at the first time it shows.
          for (const warning of result.warnings ?? []) {
            if (!record.warnings.some(known => known.code === warning.code)) record.warnings.push({ ...warning, atTime });
          }
          for (const change of result.limited ?? []) {
            if (!record.limited.some(known => known.joint === change.joint && known.axis === change.axis)) record.limited.push({ ...change, atTime });
          }
        });
      }
      return worst;
    },
    sample(time) {
      bounded(time, 0, 3600, 'Motion sample time');
      sampler.sample(time);
      for (const { track, staged } of bindings) {
        const value = staged.length === 1 ? staged[0] : staged;
        validateValue(track.kind, track.property, value);
        if (track.kind === 'material') {
          materialSamples.get(track.id)[track.property] = value;
        }
      }
      const driven = driveSampler?.sample(time);
      if (!ikUsesStagedPose) ikEvaluator?.solve(time);
      const evaluated = constraintEvaluator?.evaluate(time, ikUsesStagedPose ? trackBases() : poseBases());
      const drivenValues = [];
      for (const { target } of drivenMaterials) {
        const value = evaluated.materials.get(target.id)[target.property];
        validateValue('material', target.property, value);
        materialSamples.get(target.id)[target.property] = value;
        drivenValues.push({ target, value });
      }
      for (const [materialId, material] of materialSamples) {
        validateRadiance(material, materialId);
      }
      if (cameraPath) {
        cameraPath.sample(time, stagedCamera);
        for (const field of ['fov', 'near', 'far']) {
          finite(stagedCamera[field], `Camera ${field}`);
        }
        if (Math.fround(stagedCamera.fov) <= 0 || Math.fround(stagedCamera.fov) >= 180 ||
            Math.fround(stagedCamera.near) <= 0 || Math.fround(stagedCamera.far) <= Math.fround(stagedCamera.near)) {
          throw invalidField('motion.tracks.camera', { fov: stagedCamera.fov, near: stagedCamera.near, far: stagedCamera.far }, 'a lens with fov above 0 and below 180, near above 0 and far above near, such as fov 50, near 0.1, far 100; check the fov, near and far tracks');
        }
      }
      // Publish only after every track, material product, camera pose, IK solve and constraint passes.
      for (const { track, patch, staged } of bindings) {
        if (staged.length === 1) {
          patch[track.property] = staged[0];
        } else {
          patch[track.property].set(staged);
        }
      }
      if (ikEvaluator && !ikUsesStagedPose) {
        for (const [id, rotation] of ikEvaluator.staged) output.nodes.get(id).rotation.set(rotation);
        for (const [id, translation] of ikEvaluator.stagedTranslations) output.nodes.get(id).translation.set(translation);
      }
      if (evaluated && !ikUsesStagedPose) {
        for (const [id, frame] of evaluated.nodes) {
          const nodePatch = output.nodes.get(id);
          nodePatch.translation.set(frame.translation);
          nodePatch.rotation.set(frame.rotation);
          nodePatch.scale.set(frame.scale);
        }
      }
      for (const override of driven?.nodeOverrides ?? []) {
        const nodePatch = output.nodes.get(override.id);
        nodePatch.translation.set(override.translation);
        nodePatch.rotation.set(override.rotation);
        nodePatch.scale.set(override.scale);
      }
      for (const { material, emission } of driven?.emissions ?? []) output.materials.get(material).emission = emission;
      for (const { target, value } of drivenValues) {
        const materialPatch = output.materials.get(target.id);
        if (typeof value === 'number') materialPatch[target.property] = value;
        else materialPatch[target.property].set(value);
      }
      if (cameraPath) {
        for (const field of ['eye', 'target', 'up']) {
          output.camera[field].set(stagedCamera[field]);
        }
        for (const field of ['fov', 'near', 'far']) {
          output.camera[field] = stagedCamera[field];
        }
      }
      return output;
    },
  });
}

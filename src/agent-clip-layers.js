import { bounded, denseArray, knownKeys } from './motion-validation.js';
import { retargetReport } from './agent-retarget.js';
import { invalidField } from './field-error.js';
import { STRIP_BLENDS, STRIP_EXTENDS } from './clip-strip.js';

// Clip layers for an imported asset's motion: play clips the file ships, blend them over each other, and limit each to
// some bones. Agent input is untrusted plain data, so everything here is named, bounded and checked against the asset.

export const MAX_CLIP_LAYERS = 8;
const MAX_MASK_JOINTS = 32;
const MAX_BONE_MAP_ENTRIES = 64;
const MAX_NAME_LENGTH = 128;
const MAX_LAYER_SPEED = 8;
const MAX_LAYER_OFFSET = 30;
const MAX_STRIP_TIME = 600;
const MIN_STRIP_SCALE = 0.05;
const MAX_STRIP_SCALE = 20;
const MIN_STRIP_REPEAT = 0.05;
const MAX_STRIP_REPEAT = 100;

/**
 * What the layers are checked against: `clips` (`{ duration, targets }` per clip, the node names its tracks move) and
 * `nodes` (`{ id, name }` per node). Built by the asset from its decoded file.
 */
export function clipLayerContextFromAsset(animations, nodes) {
  return {
    clips: animations.map(animation => ({
      duration: animation.duration,
      targets: new Set(animation.tracks.map(track => track.name.slice(0, track.name.lastIndexOf('.')))),
    })),
    nodes: nodes.map(({ id, name }) => ({ id, name })),
    hierarchy: nodes,
    external: new Map(),
  };
}

/** What a layer needs of another catalog asset: its clips' durations, its clips and its nodes. Add it to `context.external` by asset ID. */
export function retargetSourceFromAsset(decoded) {
  return {
    clips: decoded.animations.map(animation => ({ duration: animation.duration })),
    animations: decoded.animations,
    nodes: decoded.nodes.map(node => structuredClone(node)),
  };
}

function nodeNameResolver(context) {
  const nameById = new Map(context.nodes.map(node => [node.id, node.name]));
  const names = new Set(context.nodes.map(node => node.name));
  return function resolveNode(value, path) {
    if (typeof value !== 'string' || !value || value.length > MAX_NAME_LENGTH) {
      throw invalidField(path, value, `a node ID or name of 1 to ${MAX_NAME_LENGTH} characters, such as "Hips"`, TypeError);
    }
    if (nameById.has(value)) return nameById.get(value);
    if (names.has(value)) return value;
    throw invalidField(path, value, 'a node ID or name of this asset, such as "Hips"; find them with scene_inspect kind hierarchy');
  };
}

function normalizedMask(input, resolveNode, position) {
  const label = `Motion layer ${position} mask`;
  const path = `motion.layers[${position}].mask`;
  knownKeys(input, ['joints', 'descendants', 'exclude'], label);
  denseArray(input.joints, MAX_MASK_JOINTS, `${label} joints`);
  if (!input.joints.length) throw invalidField(`${path}.joints`, input.joints, 'at least one node, such as ["Spine"]');
  const mask = { joints: input.joints.map(joint => resolveNode(joint, `${path}.joints`)) };
  if (input.descendants !== undefined) {
    if (typeof input.descendants !== 'boolean') throw invalidField(`${path}.descendants`, input.descendants, 'true or false', TypeError);
    mask.descendants = input.descendants;
  }
  if (input.exclude !== undefined) {
    denseArray(input.exclude, MAX_MASK_JOINTS, `${label} exclude`);
    mask.exclude = input.exclude.map(joint => resolveNode(joint, `${path}.exclude`));
  }
  return mask;
}

/** Retargeting by name: the clip's track target (a node name in the clip) mapped to the node of this asset it should move. */
function normalizedBoneMap(input, clip, resolveNode, position) {
  const path = `motion.layers[${position}].bones`;
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw invalidField(path, input, 'an object from clip node names to asset node names, such as { "Hips": "mixamorig:Hips" }', TypeError);
  const entries = Object.entries(input);
  if (!entries.length || entries.length > MAX_BONE_MAP_ENTRIES) throw invalidField(path, input, `1 to ${MAX_BONE_MAP_ENTRIES} entries, such as { "Hips": "mixamorig:Hips" }`);
  const resolved = entries.map(([from, to]) => {
    if (!clip.targets.has(from)) throw invalidField(`${path}.${from.slice(0, 64)}`, from, `a node the clip moves: one of ${[...clip.targets].slice(0, 8).join(', ')}`);
    return [from, resolveNode(to, `${path}.${from.slice(0, 64)}`)];
  });
  const destinations = resolved.map(([, destination]) => destination);
  if (new Set(destinations).size !== destinations.length) throw invalidField(path, input, 'each asset node used once, so no two clip nodes map to the same node');
  return Object.fromEntries(resolved);
}

/** `from`: a clip of another catalog asset. It must be loaded for this session, and both skeletons must map to the humanoid bones. */
function normalizedSource(input, context, label, path) {
  knownKeys(input, ['asset', 'clip'], `${label} from`);
  const source = typeof input.asset === 'string' ? context.external.get(input.asset.toLowerCase()) : undefined;
  if (!source) throw invalidField(`${path}.from.asset`, input.asset, 'the ID of a catalog asset loaded for this session other than this scene\'s own, such as one from scene_asset_catalog');
  const clip = source.clips[input.clip];
  if (!Number.isInteger(input.clip) || !clip) throw invalidField(`${path}.from.clip`, input.clip, `the index of a clip in that asset, from 0 to ${source.clips.length - 1}`);
  retargetReport(source.nodes, context.hierarchy, label);
  return { from: { asset: input.asset.toLowerCase(), clip: input.clip }, clip };
}

function oneOf(value, allowed, path) {
  if (!allowed.includes(value)) throw invalidField(path, value, `one of ${allowed.join(', ')}`);
  return value;
}

/**
 * A strip places the layer's clip on the motion timeline. `end` and `repeat` both say how long it plays, so one at
 * most; `end` becomes a (maybe fractional) repeat count of the stretched clip.
 */
function normalizedStrip(input, layer, clip, position) {
  const label = `Motion layer ${position} strip`;
  const path = `motion.layers[${position}].strip`;
  knownKeys(input, ['start', 'end', 'scale', 'repeat', 'blendIn', 'blendOut', 'extend', 'blend'], label);
  for (const field of ['speed', 'offset', 'loop']) {
    if (layer[field] !== undefined) throw invalidField(`motion.layers[${position}].${field}`, layer[field], 'a field left out, since a strip times the clip with its own start, scale and repeat');
  }
  if (!(clip.duration > 0)) throw invalidField(`${path}`, input, 'a field left out, since this clip has no length to place');
  if (input.end !== undefined && input.repeat !== undefined) throw invalidField(`${path}.end`, input.end, 'end or repeat, not both: end stops the strip at a time, repeat counts its cycles');
  const strip = {
    start: bounded(input.start ?? 0, -MAX_STRIP_TIME, MAX_STRIP_TIME, `${label} start`),
    scale: bounded(input.scale ?? 1, MIN_STRIP_SCALE, MAX_STRIP_SCALE, `${label} scale`),
  };
  if (input.end !== undefined) {
    const end = bounded(input.end, -MAX_STRIP_TIME, MAX_STRIP_TIME, `${label} end`);
    if (end <= strip.start) throw invalidField(`${path}.end`, end, `a time after start ${strip.start}`);
    strip.repeat = (end - strip.start) / (clip.duration * strip.scale);
  } else {
    strip.repeat = input.repeat ?? 1;
  }
  bounded(strip.repeat, MIN_STRIP_REPEAT, MAX_STRIP_REPEAT, input.end !== undefined ? `${label} end (as ${strip.repeat} repeats of the clip)` : `${label} repeat`);
  const length = clip.duration * strip.scale * strip.repeat;
  strip.blendIn = bounded(input.blendIn ?? 0, 0, length, `${label} blendIn`);
  strip.blendOut = bounded(input.blendOut ?? 0, 0, length, `${label} blendOut`);
  if (strip.blendIn + strip.blendOut > length) {
    throw invalidField(`${path}.blendOut`, strip.blendOut, `at most ${length - strip.blendIn} seconds, since blendIn ${strip.blendIn} and blendOut share the strip's ${length} seconds`);
  }
  strip.extend = oneOf(input.extend ?? 'nothing', STRIP_EXTENDS, `${path}.extend`);
  strip.blend = oneOf(input.blend ?? 'replace', STRIP_BLENDS, `${path}.blend`);
  if (strip.blend === 'add' && layer.additive === false) throw invalidField(`motion.layers[${position}].additive`, false, 'a field left out, since strip blend "add" makes the layer additive');
  return strip;
}

function normalizedLayer(input, position, context, resolveNode) {
  const label = `Motion layer ${position}`;
  const path = `motion.layers[${position}]`;
  knownKeys(input, ['clip', 'from', 'scale', 'rootMotion', 'loop', 'weight', 'speed', 'offset', 'additive', 'reference', 'mask', 'bones', 'morph', 'strip'], label);
  const layer = {};
  let clip;
  if (input.from !== undefined) {
    if (input.clip !== undefined || input.bones !== undefined || input.morph !== undefined) throw invalidField(`${path}.from`, input.from, 'from or clip, not both, such as { "clip": 0 } alone; a layer with from has no bones or morph', TypeError);
    const sourced = normalizedSource(input.from, context, label, path);
    clip = sourced.clip;
    layer.from = sourced.from;
    if (input.scale !== undefined) layer.scale = bounded(input.scale, 0.1, 10, `${label} scale`);
    if (input.rootMotion !== undefined) {
      if (typeof input.rootMotion !== 'boolean') throw invalidField(`${path}.rootMotion`, input.rootMotion, 'true or false', TypeError);
      layer.rootMotion = input.rootMotion;
    }
  } else {
    clip = context.clips[input.clip];
    if (!Number.isInteger(input.clip) || !clip) throw invalidField(`${path}.clip`, input.clip, `the index of a clip in the asset, from 0 to ${context.clips.length - 1}`);
    layer.clip = input.clip;
    if (input.scale !== undefined || input.rootMotion !== undefined) throw invalidField(`${path}.${input.scale !== undefined ? 'scale' : 'rootMotion'}`, input.scale ?? input.rootMotion, 'a field left out, since scale and rootMotion only apply to a layer with from', TypeError);
  }
  for (const flag of ['loop', 'additive', 'morph']) {
    if (input[flag] === undefined) continue;
    if (typeof input[flag] !== 'boolean') throw invalidField(`${path}.${flag}`, input[flag], 'true or false', TypeError);
    layer[flag] = input[flag];
  }
  if (input.weight !== undefined) layer.weight = bounded(input.weight, 0, 1, `${label} weight`);
  if (input.speed !== undefined) layer.speed = bounded(input.speed, 0.05, MAX_LAYER_SPEED, `${label} speed`);
  if (input.offset !== undefined) layer.offset = bounded(input.offset, -MAX_LAYER_OFFSET, MAX_LAYER_OFFSET, `${label} offset`);
  if (input.reference !== undefined) layer.reference = bounded(input.reference, 0, clip.duration, `${label} reference`);
  if (input.strip !== undefined) {
    layer.strip = normalizedStrip(input.strip, layer, clip, position);
    if (layer.strip.blend === 'add') layer.additive = true;
  }
  if (input.mask !== undefined) layer.mask = normalizedMask(input.mask, resolveNode, position);
  if (input.bones !== undefined) layer.bones = normalizedBoneMap(input.bones, clip, resolveNode, position);
  return layer;
}

/** Validate `motion.layers` against the asset. Returns plain data the asset turns into layer definitions. */
export function normalizeClipLayers(input, context) {
  if (!context) throw invalidField('motion.layers', input, 'a field left out, since layers play clips of an imported asset and this is a scene recipe; use an asset recipe');
  denseArray(input, MAX_CLIP_LAYERS, 'Motion layers');
  if (!input.length) throw invalidField('motion.layers', input, 'at least one layer, such as [{ "clip": 0 }]; leave layers out to play none');
  const resolveNode = nodeNameResolver(context);
  return input.map((layer, position) => normalizedLayer(layer, position, context, resolveNode));
}

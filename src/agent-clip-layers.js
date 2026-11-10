import { bounded, denseArray, knownKeys } from './motion-validation.js';
import { retargetReport } from './agent-retarget.js';
import { invalidField } from './field-error.js';

// Clip layers for an imported asset's motion: play clips the file ships, blend them over each other, and limit each to
// some bones. Agent input is untrusted plain data, so everything here is named, bounded and checked against the asset.

export const MAX_CLIP_LAYERS = 8;
const MAX_MASK_JOINTS = 32;
const MAX_BONE_MAP_ENTRIES = 64;
const MAX_NAME_LENGTH = 128;
const MAX_LAYER_SPEED = 8;
const MAX_LAYER_OFFSET = 30;

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

function normalizedLayer(input, position, context, resolveNode) {
  const label = `Motion layer ${position}`;
  const path = `motion.layers[${position}]`;
  knownKeys(input, ['clip', 'from', 'scale', 'rootMotion', 'loop', 'weight', 'speed', 'offset', 'additive', 'reference', 'mask', 'bones', 'morph'], label);
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

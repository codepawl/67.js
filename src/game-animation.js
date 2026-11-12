import { createAnimationClip } from './animation.js';
import { createAnimationGraph } from './animation-graph.js';
import { assetCopyKey } from './agent-scene-assets.js';
import { retargetAssetClip } from './agent-retarget.js';
import { clipFromGltfAnimation, createAssetLayerEvaluator, createSkeletonPose } from './skeleton-pose.js';

// The `animation` section of a game character in a scene recipe: clips keyed on the character's child nodes, an animation
// graph (states, 1D and 2D blend spaces, layers with masks) and how the game drives it. It is plain data. The same section
// serves the player (`game.player.animation`) and each path-following NPC (`game.npcs[].animation`). See docs/game.md.

export const GAME_ANIMATION_LIMITS = Object.freeze({
  maxClips: 16,
  maxTracksPerClip: 64,
  maxKeyframesPerTrack: 256,
  maxClipSeconds: 300,
  maxCharacterNodes: 256,
});

export const GAME_ANIMATION_DRIVES = Object.freeze(['speed', 'intentSpeed', 'airborne']);
const ANIMATION_FIELDS = ['clips', 'parameters', 'boneGroups', 'layers', 'rootMotion', 'drive'];
const CLIP_FIELDS = ['duration', 'loop', 'tracks'];
const TRACK_PROPERTIES = ['translation', 'rotation'];
// A character that is a placed catalog asset takes its clips from asset files instead of keyed tracks.
const ASSET_CLIP_FIELDS = ['from', 'loop', 'scale'];
const ASSET_ID = /^[a-f0-9]{64}$/;

function fail(path, problem) {
  throw new RangeError(`Game setup ${path} ${problem}`);
}

function requireRecord(value, path, example) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, `must be an object, such as ${example}.`);
}

function rejectUnknownFields(record, allowed, path) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, `is not a field. Use one of: ${allowed.join(', ')}.`);
  }
}

/** The ids of the nodes below `characterId`, parents before children. */
export function characterDescendants(nodes, characterId) {
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (node.parent === undefined) continue;
    if (!childrenByParent.has(node.parent)) childrenByParent.set(node.parent, []);
    childrenByParent.get(node.parent).push(node);
  }
  const found = [];
  const queue = [characterId];
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child.id);
    }
  }
  return found;
}

function checkClips(clips, descendantIds, path) {
  requireRecord(clips, `${path}.clips`, '{ "idle": { "duration": 1, "tracks": [...] } }');
  const names = Object.keys(clips);
  if (names.length === 0 || names.length > GAME_ANIMATION_LIMITS.maxClips) fail(`${path}.clips`, `needs 1 to ${GAME_ANIMATION_LIMITS.maxClips} clips, got ${names.length}.`);
  const normalized = {};
  for (const name of names) {
    const clipPath = `${path}.clips.${name}`;
    const clip = clips[name];
    requireRecord(clip, clipPath, '{ "duration": 1, "loop": true, "tracks": [{ "target": "arm", "property": "rotation", "keyframes": [{ "time": 0, "value": [0, 0, 0, 1] }] }] }');
    rejectUnknownFields(clip, CLIP_FIELDS, clipPath);
    if (typeof clip.duration !== 'number' || !(clip.duration > 0) || clip.duration > GAME_ANIMATION_LIMITS.maxClipSeconds) {
      fail(`${clipPath}.duration`, `must be a number of seconds above 0 and up to ${GAME_ANIMATION_LIMITS.maxClipSeconds}, got ${JSON.stringify(clip.duration)}.`);
    }
    if (clip.loop !== undefined && typeof clip.loop !== 'boolean') fail(`${clipPath}.loop`, `must be true or false, got ${JSON.stringify(clip.loop)}.`);
    if (!Array.isArray(clip.tracks) || clip.tracks.length === 0 || clip.tracks.length > GAME_ANIMATION_LIMITS.maxTracksPerClip) {
      fail(`${clipPath}.tracks`, `needs 1 to ${GAME_ANIMATION_LIMITS.maxTracksPerClip} tracks, each { target, property, keyframes }.`);
    }
    clip.tracks.forEach((track, index) => {
      const trackPath = `${clipPath}.tracks[${index}]`;
      requireRecord(track, trackPath, '{ "target": "arm", "property": "rotation", "keyframes": [...] }');
      if (!descendantIds.has(track.target)) {
        const known = [...descendantIds].slice(0, 12).join(', ') || 'none; give the character child nodes';
        fail(`${trackPath}.target`, `names ${JSON.stringify(track.target)}, which is not a child node of the character. Use one of: ${known}.`);
      }
      if (!TRACK_PROPERTIES.includes(track.property)) fail(`${trackPath}.property`, `is ${JSON.stringify(track.property)}. Use one of: ${TRACK_PROPERTIES.join(', ')}.`);
      if (!Array.isArray(track.keyframes) || track.keyframes.length === 0 || track.keyframes.length > GAME_ANIMATION_LIMITS.maxKeyframesPerTrack) {
        fail(`${trackPath}.keyframes`, `needs 1 to ${GAME_ANIMATION_LIMITS.maxKeyframesPerTrack} keyframes, each { time, value }.`);
      }
    });
    try {
      createAnimationClip({ duration: clip.duration, loop: clip.loop ?? true, tracks: clip.tracks });
    } catch (error) {
      fail(clipPath, `is not a valid clip: ${error.message}`);
    }
    normalized[name] = { duration: clip.duration, loop: clip.loop ?? true, tracks: structuredClone(clip.tracks) };
  }
  return normalized;
}

function checkAssetClips(clips, path) {
  requireRecord(clips, `${path}.clips`, '{ "walk": { "from": { "asset": "<64 hex catalog asset id>", "clip": 0 } } }');
  const names = Object.keys(clips);
  if (names.length === 0 || names.length > GAME_ANIMATION_LIMITS.maxClips) fail(`${path}.clips`, `needs 1 to ${GAME_ANIMATION_LIMITS.maxClips} clips, got ${names.length}.`);
  const normalized = {};
  for (const name of names) {
    const clipPath = `${path}.clips.${name}`;
    const clip = clips[name];
    requireRecord(clip, clipPath, '{ "from": { "asset": "<64 hex catalog asset id>", "clip": 0 }, "loop": true }');
    rejectUnknownFields(clip, ASSET_CLIP_FIELDS, clipPath);
    requireRecord(clip.from, `${clipPath}.from`, '{ "clip": 0 } for a clip of the character\'s own asset, or { "asset": "<64 hex catalog asset id>", "clip": 0 } for another humanoid');
    rejectUnknownFields(clip.from, ['asset', 'clip'], `${clipPath}.from`);
    if (clip.from.asset !== undefined && !(typeof clip.from.asset === 'string' && ASSET_ID.test(clip.from.asset.toLowerCase()))) {
      fail(`${clipPath}.from.asset`, `is ${JSON.stringify(clip.from.asset)}. Pass a catalog asset id of 64 hexadecimal characters, or leave it out for the character's own asset.`);
    }
    if (!Number.isInteger(clip.from.clip) || clip.from.clip < 0) fail(`${clipPath}.from.clip`, `must be the index of a clip in that asset, a whole number of 0 or more, got ${JSON.stringify(clip.from.clip)}.`);
    if (clip.loop !== undefined && typeof clip.loop !== 'boolean') fail(`${clipPath}.loop`, `must be true or false, got ${JSON.stringify(clip.loop)}.`);
    if (clip.scale !== undefined && !(Number.isFinite(clip.scale) && clip.scale > 0 && clip.scale <= 100)) fail(`${clipPath}.scale`, `must be a number above 0 and at most 100 (the hips travel ratio between the two rigs), got ${JSON.stringify(clip.scale)}.`);
    normalized[name] = {
      from: { ...(clip.from.asset ? { asset: clip.from.asset.toLowerCase() } : {}), clip: clip.from.clip },
      loop: clip.loop ?? true,
      ...(clip.scale === undefined ? {} : { scale: clip.scale }),
    };
  }
  return normalized;
}

function decodedAsset(assets, assetId, label) {
  const asset = assets?.get(assetCopyKey(assetId, 0));
  if (!asset) {
    throw new RangeError(`${label} needs catalog asset ${assetId.slice(0, 12)}, which the host did not load. Pass it in the assets option of startGame, keyed by assetCopyKey(id, 0).`);
  }
  return asset;
}

// The clips of an asset character, moved onto its own skeleton: a clip of another asset is retargeted by the humanoid bone map.
function assetCharacterClips(animation, ownId, assets, path) {
  const own = decodedAsset(assets, ownId, `${path}.clips`);
  const clips = {};
  for (const [name, definition] of Object.entries(animation.clips)) {
    const sourceId = definition.from.asset ?? ownId;
    const source = decodedAsset(assets, sourceId, `${path}.clips.${name}.from.asset`);
    const gltfAnimation = source.animations[definition.from.clip];
    if (!gltfAnimation) {
      fail(`${path}.clips.${name}.from.clip`, `is ${definition.from.clip}, but asset ${sourceId.slice(0, 12)} has ${source.animations.length} clips. Use an index from 0 to ${source.animations.length - 1}.`);
    }
    if (sourceId === ownId) {
      clips[name] = clipFromGltfAnimation(gltfAnimation, { loop: definition.loop });
      continue;
    }
    // Retargeted from a clip that does not wrap: a looping source would sample its last frame as its first and lose the travel of the cycle.
    const retargeted = retargetAssetClip(source.nodes, own.nodes, clipFromGltfAnimation(gltfAnimation, { loop: false }), { scale: definition.scale });
    clips[name] = createAnimationClip({ duration: retargeted.duration, loop: definition.loop, tracks: retargeted.tracks });
  }
  return { own, clips };
}

function createAssetCharacterAnimation(animation, characterNode, assets) {
  const { clips: _clips, drive: _drive, ...graphDefinition } = animation;
  const { own, clips } = assetCharacterClips(animation, characterNode.asset.id, assets, `animation of ${characterNode.id}`);
  const graph = createAnimationGraph({ ...graphDefinition, clips });
  const evaluator = createAssetLayerEvaluator(own, graph.poseLayers());
  return {
    graph,
    drive: animation.drive,
    hasRootMotion: Boolean(animation.rootMotion),
    assetNode: characterNode.id,
    operations: () => [],
    /** The pose of the asset at the graph's time, for `scene.setAssetPose`. */
    assetPose: () => evaluator.evaluate(graph.time),
  };
}

function jointsOf(descendants, characterId) {
  const index = new Map(descendants.map((node, position) => [node.id, position]));
  return descendants.map(node => ({
    name: node.id,
    parent: index.get(node.parent) ?? -1,
    translation: node.translation ?? [0, 0, 0],
    rotation: node.rotation ?? [0, 0, 0, 1],
    scale: node.scale ?? [1, 1, 1],
  }));
}

/**
 * Build the graph and the pose of one character from a `normalizeGameAnimation` result. `nodes` are the recipe nodes and
 * `characterId` the node the controller or follower moves. `graph` is a normal animation graph; `operations()` poses the nodes
 * below the character at the graph's time and returns the `set-node` operations that write them.
 */
export function createGameAnimation(animation, nodes, characterId, { assets } = {}) {
  const characterNode = nodes.find(node => node.id === characterId);
  if (characterNode?.asset) return createAssetCharacterAnimation(animation, characterNode, assets);
  const descendants = characterDescendants(nodes, characterId);
  const clips = Object.fromEntries(Object.entries(animation.clips).map(([name, clip]) => [name, createAnimationClip(clip)]));
  const { clips: _clips, drive: _drive, ...graphDefinition } = animation;
  const graph = createAnimationGraph({ ...graphDefinition, clips });
  const pose = createSkeletonPose({ rig: { joints: jointsOf(descendants, characterId) }, layers: graph.poseLayers() });
  const written = pose.writtenJoints.map(({ index, translation }) => ({ id: descendants[index].id, index, translation }));
  return {
    graph,
    drive: animation.drive,
    hasRootMotion: Boolean(animation.rootMotion),
    assetNode: null,
    assetPose: () => null,
    operations() {
      pose.apply(graph.time);
      return written.map(({ id, index, translation }) => ({
        type: 'set-node',
        id,
        rotation: Array.from(pose.localRotation(index)),
        ...(translation ? { translation: Array.from(pose.localTranslation(index)) } : {}),
      }));
    },
  };
}

function defaultDrive(animation) {
  const speed = animation.parameters?.speed;
  if (!speed || speed.type !== 'number') return {};
  return { speed: animation.rootMotion ? 'intentSpeed' : 'speed' };
}

function checkDrive(drive, animation, path) {
  if (drive === undefined) return defaultDrive(animation);
  requireRecord(drive, `${path}.drive`, '{ "speed": "intentSpeed" }');
  const parameters = animation.parameters ?? {};
  for (const [parameter, source] of Object.entries(drive)) {
    if (!GAME_ANIMATION_DRIVES.includes(source)) fail(`${path}.drive.${parameter}`, `is ${JSON.stringify(source)}. Use one of: ${GAME_ANIMATION_DRIVES.join(', ')}.`);
    const type = parameters[parameter]?.type;
    const expected = source === 'airborne' ? 'boolean' : 'number';
    if (type !== expected) fail(`${path}.drive.${parameter}`, `needs a ${expected} parameter of that name in parameters, because ${source} is a ${expected}. Declare "${parameter}": { "type": "${expected}" }.`);
  }
  return structuredClone(drive);
}

/**
 * Check a character's `animation` section against the recipe nodes and return a normalised copy. `characterId` must be a
 * node of `nodes`; clips target its child nodes, never the node itself, because the controller or follower owns that one.
 * Options: `path` for messages and `driven` (false for an NPC, whose follower sets the `speed` parameter).
 */
export function normalizeGameAnimation(animation, nodes, characterId, { path = 'animation', driven = true } = {}) {
  requireRecord(animation, path, '{ "clips": {...}, "layers": [...] }');
  rejectUnknownFields(animation, ANIMATION_FIELDS, path);
  if (nodes.find(node => node.id === characterId)?.asset) return normalizeAssetCharacterAnimation(animation, path, driven);
  const descendants = characterDescendants(nodes, characterId);
  if (descendants.length === 0) fail(path, `has nothing to move: "${characterId}" has no child nodes. Give the character child nodes (a body, limbs) and point clip tracks at them.`);
  if (descendants.length > GAME_ANIMATION_LIMITS.maxCharacterNodes) fail(path, `would pose ${descendants.length} nodes; the limit is ${GAME_ANIMATION_LIMITS.maxCharacterNodes}.`);
  if (!Array.isArray(animation.layers)) fail(`${path}.layers`, 'must be a list of animation graph layers, such as [{ "name": "base", "states": [{ "name": "idle", "clip": "idle" }] }].');
  const normalized = { ...structuredClone(animation), clips: checkClips(animation.clips, new Set(descendants.map(node => node.id)), path) };
  if (driven) normalized.drive = checkDrive(animation.drive, normalized, path);
  else if (animation.drive !== undefined) fail(`${path}.drive`, 'is not allowed on an NPC: its path follower sets the "speed" parameter. Remove drive.');
  try {
    const built = createGameAnimation(normalized, nodes, characterId);
    built.operations();
  } catch (error) {
    throw new RangeError(`Game setup ${path}: ${error.message}`);
  }
  return normalized;
}

// An asset character cannot be built here: its clips and skeleton live in files the host loads when the game starts. The
// shape is checked now; clip indexes, bone names and the graph itself are checked by createGameAnimation with the files.
function normalizeAssetCharacterAnimation(animation, path, driven) {
  if (!Array.isArray(animation.layers)) fail(`${path}.layers`, 'must be a list of animation graph layers, such as [{ "name": "base", "states": [{ "name": "idle", "clip": "idle" }] }].');
  const normalized = { ...structuredClone(animation), clips: checkAssetClips(animation.clips, path) };
  if (driven) normalized.drive = checkDrive(animation.drive, normalized, path);
  else if (animation.drive !== undefined) fail(`${path}.drive`, 'is not allowed on an NPC: its path follower sets the "speed" parameter. Remove drive.');
  return normalized;
}

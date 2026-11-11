import { createAnimationClip } from './animation.js';
import { createAnimationGraph } from './animation-graph.js';
import { createSkeletonPose } from './skeleton-pose.js';

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
export function createGameAnimation(animation, nodes, characterId) {
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

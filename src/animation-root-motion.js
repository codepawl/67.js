// Root motion: the horizontal travel baked into a clip's root bone, taken out of the clip so the player controller can
// apply it to the body instead of the feet sliding. `extractRootMotion` returns an in-place copy of the clip (the root
// bone keeps its height but stays at its first-frame x and z) and a `displacement` function that says how far the root
// had travelled after a number of cycles. Results use the player's convention: x to the right, negative z forward.
import { sampleAnimationClip } from './animation.js';

export const ROOT_MOTION_LIMITS = Object.freeze({ minimumScale: 1e-6, maximumScale: 1e6 });
export const ROOT_MOTION_FACINGS = Object.freeze(['+z', '-z']);

const NO_DISPLACEMENT = Object.freeze([0, 0]);

/**
 * Validate and normalize a rootMotion option: { bone, layer, facing, scale }. `facing` is the way the rig faces at rest
 * ('+z' for glTF, '-z' for the player's own convention) and `scale` converts the clip's units to metres.
 */
export function normalizeRootMotionSettings(definition, label) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError(`${label} must be an object like { bone: "Root" }, got ${definition === null ? 'null' : typeof definition}.`);
  }
  if (typeof definition.bone !== 'string' || !definition.bone.trim()) {
    throw new TypeError(`${label}.bone must be the name of the root bone whose translation track carries the motion, such as "Root".`);
  }
  const facing = definition.facing ?? '+z';
  if (!ROOT_MOTION_FACINGS.includes(facing)) {
    throw new RangeError(`${label}.facing must be "+z" or "-z" (the way the rig faces at rest; glTF rigs face "+z"), got ${JSON.stringify(facing)}.`);
  }
  const scale = definition.scale ?? 1;
  const { minimumScale, maximumScale } = ROOT_MOTION_LIMITS;
  if (!Number.isFinite(scale) || scale < minimumScale || scale > maximumScale) {
    throw new RangeError(`${label}.scale must be a number from ${minimumScale} to ${maximumScale} (clip units to metres, 0.01 for a rig in centimetres), got ${String(scale)}.`);
  }
  return { bone: definition.bone, layer: definition.layer, facing, scale };
}

function withFlatKeyframes(track) {
  const restX = track.keyframes[0].value[0];
  const restZ = track.keyframes[0].value[2];
  const keyframes = track.keyframes.map(keyframe => {
    const flat = { ...keyframe, value: [restX, keyframe.value[1], restZ] };
    if (keyframe.inTangent) flat.inTangent = [0, keyframe.inTangent[1], 0];
    if (keyframe.outTangent) flat.outTangent = [0, keyframe.outTangent[1], 0];
    return Object.freeze(flat);
  });
  return Object.freeze({ ...track, keyframes: Object.freeze(keyframes) });
}

/**
 * Split a clip into an in-place clip and the root bone's horizontal travel. A clip without a translation track on `bone`
 * comes back unchanged with `hasMotion: false`. `displacement(cycles, loops)` is the travel since the first frame after
 * `cycles` plays of the clip, as [x, z] in metres; with `loops` false it stops at the last frame. The returned array is
 * reused by the next call.
 */
export function extractRootMotion(clip, settings) {
  const { bone, facing, scale } = settings;
  const track = clip.tracks.find(candidate => candidate.target === bone && candidate.property === 'translation');
  if (!track) return { clip, hasMotion: false, displacement: () => NO_DISPLACEMENT };
  // Looping is handled by displacement itself, so the end of the clip is sampled as its last frame and not wrapped to the first.
  const sampler = Object.freeze({ duration: clip.duration, loop: false, tracks: Object.freeze([track]) });
  const first = track.keyframes[0].value;
  const last = track.keyframes[track.keyframes.length - 1].value;
  const flip = facing === '+z' ? -1 : 1;
  const output = [0, 0];

  function displacement(cycles, loops = clip.loop) {
    const wholeCycles = loops ? Math.floor(cycles) : 0;
    const fraction = loops ? cycles - wholeCycles : Math.min(Math.max(cycles, 0), 1);
    const sampled = sampleAnimationClip(sampler, fraction * clip.duration)[0].value;
    output[0] = flip * scale * (wholeCycles * (last[0] - first[0]) + sampled[0] - first[0]);
    output[1] = flip * scale * (wholeCycles * (last[2] - first[2]) + sampled[2] - first[2]);
    return output;
  }

  const inPlace = Object.freeze({ ...clip, tracks: Object.freeze(clip.tracks.map(candidate => (candidate === track ? withFlatKeyframes(track) : candidate))) });
  return { clip: inPlace, hasMotion: true, displacement };
}

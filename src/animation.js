import { mat4, quat } from 'gl-matrix';
import { easedProgress, normalizeKeyframeEasing } from './easing.js';

const PROPERTY_SIZES = { translation: 3, rotation: 4, scale: 3, value: 1, emission: 1, metallic: 1, roughness: 1 };
const INTERPOLATIONS = new Set(['LINEAR', 'STEP', 'SMOOTH', 'CUBICSPLINE']);
const MATERIAL_PROPERTIES = new Set(['emission', 'metallic', 'roughness']);
const MINIMUM_POSITIVE_VALUE = 1e-8;
const isolatedMaterials = new WeakMap();

/** Share one isolated target material across source-internal animation bindings. */
export function retainAnimationMaterial(part, candidate = { ...part.material }) {
  const retained = isolatedMaterials.get(part);
  const material = retained && retained === part.material ? retained : candidate;
  part.material = material;
  isolatedMaterials.set(part, material);
  return material;
}

function normalizedTangent(property, tangent) {
  const size = PROPERTY_SIZES[property];
  if (size === 1) {
    if (!Number.isFinite(tangent)) throw new TypeError('Spline tangents must be finite numbers.');
    return tangent;
  }
  if ((!Array.isArray(tangent) && !ArrayBuffer.isView(tangent)) || tangent.length !== size || !Array.from(tangent).every(Number.isFinite)) {
    throw new TypeError(`${property} tangents need ${size} finite values.`);
  }
  return Object.freeze(Array.from(tangent));
}

function normalizedValue(property, value) {
  const size = PROPERTY_SIZES[property];
  if (size === 1) {
    if (!Number.isFinite(value)) throw new TypeError('Numeric keyframes must be finite.');
    if (property === 'emission' && value < 0) throw new RangeError('Emission keyframes cannot be negative.');
    if (['metallic', 'roughness'].includes(property) && (value > 1 || value < 0 || property === 'roughness' && value === 0)) {
      throw new RangeError(`${property} keyframes must stay within their material range.`);
    }
    return value;
  }
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== size || !Array.from(value).every(Number.isFinite)) {
    throw new TypeError(`${property} keyframes need ${size} finite values.`);
  }
  const result = Array.from(value);
  if (property === 'rotation') {
    const length = Math.hypot(...result);
    if (!Number.isFinite(length) || length < 1e-8) throw new RangeError('Rotation keyframes need a finite nonzero quaternion length.');
    return Object.freeze(result.map(component => component / length));
  }
  if (property === 'scale' && result.some(component => component < 0)) throw new RangeError('Scale keyframes cannot be negative. Zero is allowed and hides the node.');
  return Object.freeze(result);
}

/** Keyframes are absolute local transforms. Input order does not affect sampling. */
export function createAnimationClip({ duration, loop = false, tracks = [] } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('Clip duration must be positive and finite.');
  if (typeof loop !== 'boolean' || !Array.isArray(tracks)) throw new TypeError('Clip loop must be boolean and tracks must be an array.');
  const properties = new Set();
  const compiled = tracks.map(track => {
    if (!track || typeof track.target !== 'string' || !track.target.trim()) throw new TypeError('Every track needs a target name.');
    if (!Object.hasOwn(PROPERTY_SIZES, track.property)) throw new RangeError(`Unknown animation property: ${track.property}`);
    const identity = `${track.target}\u0000${track.property}`;
    if (properties.has(identity)) throw new RangeError('Each target property can have only one track.');
    properties.add(identity);
    const interpolation = track.interpolation ?? 'LINEAR';
    if (!INTERPOLATIONS.has(interpolation)) throw new RangeError(`Unknown interpolation: ${interpolation}`);
    if (!Array.isArray(track.keyframes) || !track.keyframes.length) throw new RangeError('Tracks need at least one keyframe.');
    if (interpolation === 'CUBICSPLINE' && track.keyframes.length < 2) throw new RangeError('Spline tracks need at least two keyframes.');
    const keyframes = track.keyframes.map(keyframe => {
      if (!keyframe || !Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > duration) {
        throw new RangeError('Keyframe times must be within the clip duration.');
      }
      const compiledKeyframe = { time: keyframe.time, value: normalizedValue(track.property, keyframe.value) };
      const easing = normalizeKeyframeEasing(keyframe);
      if (easing && interpolation !== 'LINEAR' && interpolation !== 'SMOOTH') {
        throw new RangeError(`Keyframe easing needs LINEAR or SMOOTH interpolation, not ${interpolation}.`);
      }
      Object.assign(compiledKeyframe, easing);
      if (interpolation === 'CUBICSPLINE') {
        compiledKeyframe.inTangent = normalizedTangent(track.property, keyframe.inTangent);
        compiledKeyframe.outTangent = normalizedTangent(track.property, keyframe.outTangent);
      }
      return Object.freeze(compiledKeyframe);
    }).sort((first, second) => first.time - second.time);
    for (let index = 1; index < keyframes.length; index++) {
      if (keyframes[index].time === keyframes[index - 1].time) throw new RangeError('Keyframe times must be distinct.');
    }
    return Object.freeze({ target: track.target, property: track.property, interpolation, keyframes: Object.freeze(keyframes) });
  });
  return Object.freeze({ duration, loop, tracks: Object.freeze(compiled) });
}

function constrainSample(property, value) {
  if (!Number.isFinite(value)) throw new RangeError('Animation output must be finite. Reduce the values or tangents.');
  if (property === 'scale') return Math.max(MINIMUM_POSITIVE_VALUE, value);
  if (property === 'emission') return Math.max(0, value);
  if (property === 'metallic') return Math.max(0, Math.min(1, value));
  if (property === 'roughness') return Math.max(MINIMUM_POSITIVE_VALUE, Math.min(1, value));
  return value;
}

function copySample(output, value) {
  if (typeof value === 'number') output[0] = value;
  else output.set(value);
  return output;
}

function sampleTrackInto(track, time, output) {
  const keyframes = track.keyframes;
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (time <= first.time) return copySample(output, first.value);
  if (time >= last.time) return copySample(output, last.value);
  let lower = 0;
  let upper = keyframes.length - 1;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (keyframes[middle].time <= time) lower = middle;
    else upper = middle;
  }
  const start = keyframes[lower];
  const end = keyframes[upper];
  if (time === start.time || track.interpolation === 'STEP') return copySample(output, start.value);
  const interval = end.time - start.time;
  let progress = (time - start.time) / interval;
  if (track.interpolation === 'CUBICSPLINE') {
    const squared = progress * progress;
    const cubed = squared * progress;
    const startWeight = 2 * cubed - 3 * squared + 1;
    const endWeight = -2 * cubed + 3 * squared;
    const outgoingWeight = (cubed - 2 * squared + progress) * interval;
    const incomingWeight = (cubed - squared) * interval;
    for (let axis = 0; axis < output.length; axis++) {
      const scalar = output.length === 1;
      const startValue = scalar ? start.value : start.value[axis];
      const endValue = scalar ? end.value : end.value[axis];
      const outgoing = scalar ? start.outTangent : start.outTangent[axis];
      const incoming = scalar ? end.inTangent : end.inTangent[axis];
      output[axis] = constrainSample(track.property,
        startWeight * startValue + outgoingWeight * outgoing + endWeight * endValue + incomingWeight * incoming);
    }
    if (track.property === 'rotation') {
      const length = Math.hypot(output[0], output[1], output[2], output[3]);
      if (!Number.isFinite(length) || length === 0) throw new RangeError('Spline produced an invalid quaternion. Adjust the rotation tangents.');
      for (let axis = 0; axis < 4; axis++) output[axis] /= length;
    }
    return output;
  }
  if (start.easing !== undefined) progress = easedProgress(start, progress);
  else if (track.interpolation === 'SMOOTH') progress = progress * progress * (3 - 2 * progress);
  if (track.property === 'rotation') return quat.slerp(output, start.value, end.value, progress);
  for (let axis = 0; axis < output.length; axis++) {
    const startValue = output.length === 1 ? start.value : start.value[axis];
    const endValue = output.length === 1 ? end.value : end.value[axis];
    output[axis] = startValue + (endValue - startValue) * progress;
  }
  return output;
}

/**
 * Linear keyframes that trace a track with eased segments, for formats with no easing (glTF). Each segment gets
 * `stepsPerSegment` linear pieces; a track without easing comes back unchanged.
 */
export function bakeEasedKeyframes(track, stepsPerSegment) {
  if (!track.keyframes.some(keyframe => keyframe.easing !== undefined)) return track.keyframes;
  const size = PROPERTY_SIZES[track.property];
  const baked = [];
  for (let index = 0; index < track.keyframes.length; index++) {
    const start = track.keyframes[index];
    baked.push({ time: start.time, value: start.value });
    const end = track.keyframes[index + 1];
    if (!end) break;
    for (let step = 1; step < stepsPerSegment; step++) {
      const time = start.time + (end.time - start.time) * step / stepsPerSegment;
      const output = sampleTrackInto(track, time, new Float64Array(size));
      baked.push({ time, value: size === 1 ? output[0] : Array.from(output) });
    }
  }
  return baked;
}

function normalizedTime(clip, time) {
  if (!Number.isFinite(time)) throw new TypeError('Animation time must be finite.');
  if (!clip.loop) return Math.max(0, Math.min(clip.duration, time));
  const remainder = time % clip.duration;
  return remainder < 0 ? remainder + clip.duration : remainder;
}

export function sampleAnimationClip(clip, time) {
  const clipTime = normalizedTime(clip, time);
  return clip.tracks.map(track => {
    const output = sampleTrackInto(track, clipTime, new Float64Array(PROPERTY_SIZES[track.property]));
    const value = output.length === 1 ? output[0] : Array.from(output);
    return { target: track.target, property: track.property, value };
  });
}

/** Internal compiled sampler for retained mixer buffers; not a package entry point. */
export function compileAnimationSampler(clip) {
  const tracks = clip.tracks.map(track => ({
    target: track.target,
    property: track.property,
    output: new Float64Array(PROPERTY_SIZES[track.property]),
  }));
  return {
    tracks,
    sample(time) {
      const clipTime = normalizedTime(clip, time);
      for (let index = 0; index < tracks.length; index++) {
        sampleTrackInto(clip.tracks[index], clipTime, tracks[index].output);
      }
      return tracks;
    },
  };
}

/** Bind once before playback. Matrix identities and untracked initial components stay stable. */
export function createAnimationPlayer(clip, parts) {
  const namedParts = new Map();
  for (const part of parts) {
    if (namedParts.has(part.name)) throw new RangeError(`Duplicate animated part name: ${part.name}`);
    namedParts.set(part.name, part);
  }
  const bindings = new Map();
  const compiledTracks = [];
  for (const track of clip.tracks) {
    const part = namedParts.get(track.target);
    if (!part) throw new RangeError(`Animation target was not found: ${track.target}`);
    if (track.property === 'value') throw new RangeError('Value tracks are sampled directly, rather than bound to parts.');
    if (!bindings.has(track.target)) {
      if (!(part.matrix instanceof Float32Array) || part.matrix.length !== 16 || !Array.from(part.matrix).every(Number.isFinite)) {
        throw new TypeError('Animated parts need a finite Float32Array matrix.');
      }
      const translation = mat4.getTranslation(new Float64Array(3), part.matrix);
      const scale = mat4.getScaling(new Float64Array(3), part.matrix);
      if (Array.from(scale).some(value => value < Math.fround(MINIMUM_POSITIVE_VALUE))) throw new RangeError('Animated matrices must have nonzero scale.');
      const rotationMatrix = mat4.clone(part.matrix);
      for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) rotationMatrix[column * 4 + row] /= scale[column];
      }
      if (mat4.determinant(rotationMatrix) < 0.9999) throw new RangeError('Animated matrices must use rotation and positive scale without shear.');
      const rotation = quat.normalize(new Float64Array(4), mat4.getRotation(new Float64Array(4), rotationMatrix));
      bindings.set(track.target, { part, translation, scale, rotation, matrix: mat4.create(), hasTransform: false, material: null });
    }
    const binding = bindings.get(track.target);
    const materialTrack = MATERIAL_PROPERTIES.has(track.property);
    if (materialTrack && !binding.material) {
      const retained = isolatedMaterials.get(part);
      binding.material = retained && retained === part.material ? retained : { ...part.material };
    }
    if (!materialTrack) binding.hasTransform = true;
    const output = materialTrack ? new Float64Array(1) : binding[track.property];
    compiledTracks.push({ track, binding, output, materialTrack });
  }
  const compiledBindings = Array.from(bindings.values());
  for (const binding of compiledBindings) {
    if (binding.material) {
      binding.material = retainAnimationMaterial(binding.part, binding.material);
    }
  }
  return {
    clip,
    apply(time) {
      const clipTime = normalizedTime(clip, time);
      for (const compiled of compiledTracks) {
        sampleTrackInto(compiled.track, clipTime, compiled.output);
      }
      for (const binding of compiledBindings) {
        if (binding.hasTransform) {
          mat4.fromRotationTranslationScale(binding.matrix, binding.rotation, binding.translation, binding.scale);
          for (let index = 0; index < 16; index++) {
            if (!Number.isFinite(binding.matrix[index])) throw new RangeError('Animated matrix exceeds the finite float range. Reduce the transform values.');
          }
        }
      }
      // Commit only after every sample and composed matrix is valid.
      for (const compiled of compiledTracks) {
        if (compiled.materialTrack) compiled.binding.material[compiled.track.property] = compiled.output[0];
      }
      for (const binding of compiledBindings) {
        if (binding.hasTransform) binding.part.matrix.set(binding.matrix);
      }
      return parts;
    },
  };
}

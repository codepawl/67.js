import { attributeFloats } from './gltf-accessors.js';

export const INTERPOLATE_DISCRETE = 2300;
export const INTERPOLATE_LINEAR = 2301;
export const INTERPOLATE_SMOOTH = 2302;

const INTERPOLATION_BY_NAME = { STEP: INTERPOLATE_DISCRETE, LINEAR: INTERPOLATE_LINEAR, CUBICSPLINE: INTERPOLATE_SMOOTH };
const PROPERTY_BY_PATH = { translation: 'position', rotation: 'quaternion', scale: 'scale', weights: 'morphTargetInfluences' };

/** The decoded node a track writes to. Kept outside the track so the public track stays plain data. */
const targetByTrack = new WeakMap();

function lastIndexBelow(times, time) {
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle;
    else high = middle;
  }
  return low;
}

function slerpInto(result, values, offset0, offset1, weight) {
  let [x0, y0, z0, w0] = [values[offset0], values[offset0 + 1], values[offset0 + 2], values[offset0 + 3]];
  const [x1, y1, z1, w1] = [values[offset1], values[offset1 + 1], values[offset1 + 2], values[offset1 + 3]];
  let from = 1 - weight;
  let to = weight;
  const cosine = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
  const direction = cosine >= 0 ? 1 : -1;
  const squaredSine = 1 - cosine * cosine;
  if (squaredSine > Number.EPSILON) {
    const sine = Math.sqrt(squaredSine);
    const angle = Math.atan2(sine, cosine * direction);
    from = Math.sin(from * angle) / sine;
    to = Math.sin(to * angle) / sine;
  }
  const signedTo = to * direction;
  x0 = x0 * from + x1 * signedTo;
  y0 = y0 * from + y1 * signedTo;
  z0 = z0 * from + z1 * signedTo;
  w0 = w0 * from + w1 * signedTo;
  if (from === 1 - weight) {
    const scale = 1 / Math.hypot(x0, y0, z0, w0);
    x0 *= scale;
    y0 *= scale;
    z0 *= scale;
    w0 *= scale;
  }
  result[0] = x0;
  result[1] = y0;
  result[2] = z0;
  result[3] = w0;
}

function sampleStep(track, interval, result, size) {
  for (let component = 0; component < size; component++) result[component] = track.values[interval * size + component];
}

function sampleLinear(track, interval, time, result, size, isRotation) {
  const t0 = track.times[interval];
  const t1 = track.times[interval + 1];
  const weight = (time - t0) / (t1 - t0);
  if (isRotation) {
    slerpInto(result, track.values, interval * 4, (interval + 1) * 4, weight);
    return;
  }
  for (let component = 0; component < size; component++) {
    const from = track.values[interval * size + component];
    const to = track.values[(interval + 1) * size + component];
    result[component] = from * (1 - weight) + to * weight;
  }
}

function sampleCubic(track, interval, time, result, size, isRotation) {
  const t0 = track.times[interval];
  const delta = track.times[interval + 1] - t0;
  const p = (time - t0) / delta;
  const pp = p * p;
  const ppp = pp * p;
  const blendEnd = -2 * ppp + 3 * pp;
  const blendEndTangent = ppp - pp;
  const blendStart = 1 - blendEnd;
  const blendStartTangent = blendEndTangent - pp + p;
  const stride = size * 3;
  const first = interval * stride;
  const second = (interval + 1) * stride;
  for (let component = 0; component < size; component++) {
    const startPoint = track.values[first + size + component];
    const startTangent = track.values[first + 2 * size + component] * delta;
    const endPoint = track.values[second + size + component];
    const endTangent = track.values[second + component] * delta;
    result[component] = blendStart * startPoint + blendStartTangent * startTangent + blendEnd * endPoint + blendEndTangent * endTangent;
  }
  if (isRotation) {
    const scale = 1 / Math.hypot(result[0], result[1], result[2], result[3]);
    for (let component = 0; component < 4; component++) result[component] *= scale;
  }
}

/** Value of a track at a time. Times outside the keys clamp to the first or last key. */
function sampleTrack(track, time, result) {
  const cubic = track.interpolation === INTERPOLATE_SMOOTH;
  const size = track.values.length / track.times.length / (cubic ? 3 : 1);
  const last = track.times.length - 1;
  const clamped = time <= track.times[0] ? 0 : time >= track.times[last] ? last : -1;
  if (clamped >= 0) {
    const offset = (cubic ? clamped * 3 + 1 : clamped) * size;
    for (let component = 0; component < size; component++) result[component] = track.values[offset + component];
    return result;
  }
  const interval = lastIndexBelow(track.times, time);
  const isRotation = track.name.endsWith('.quaternion');
  if (track.interpolation === INTERPOLATE_DISCRETE) sampleStep(track, interval, result, size);
  else if (cubic) sampleCubic(track, interval, time, result, size, isRotation);
  else sampleLinear(track, interval, time, result, size, isRotation);
  return result;
}

function createTrack(name, times, values, interpolation) {
  const track = {
    name,
    times,
    values,
    interpolation,
    getInterpolation() {
      return interpolation;
    },
    getValueSize() {
      return values.length / times.length;
    },
    createInterpolant(result) {
      const size = track.getValueSize() / (interpolation === INTERPOLATE_SMOOTH ? 3 : 1);
      return { evaluate: time => sampleTrack(track, time, result.subarray(0, size)) };
    },
  };
  return track;
}

function validateTimes(times) {
  for (let index = 0; index < times.length; index++) {
    if (times[index] < 0 || index && times[index] <= times[index - 1]) throw new Error('Animation times must be nonnegative and strictly increasing.');
  }
}

function validateRotations(values, interpolation) {
  const cubic = interpolation === INTERPOLATE_SMOOTH;
  for (let offset = cubic ? 4 : 0; offset < values.length; offset += cubic ? 12 : 4) {
    const length = Math.hypot(values[offset], values[offset + 1], values[offset + 2], values[offset + 3]);
    if (Math.abs(length - 1) > 0.01) throw new Error('Animation rotation values require unit quaternions.');
  }
}

/** Unnamed nodes are addressed by their source id ("node-4"), the same id the asset's node metadata falls back to. */
function nodeTrackName(node) {
  if (node.name) return node.name;
  return node.association?.nodes === undefined ? node.uuid : `node-${node.association.nodes}`;
}

function tracksForChannel(channel, sampler, node, readAccessor) {
  const interpolation = INTERPOLATION_BY_NAME[sampler.interpolation ?? 'LINEAR'];
  const times = attributeFloats(readAccessor(sampler.input));
  validateTimes(times);
  const values = attributeFloats(readAccessor(sampler.output));
  if (!times.every(Number.isFinite) || !values.every(Number.isFinite)) throw new Error('Animation times and values must be finite.');
  const path = channel.target.path;
  if (path === 'rotation') validateRotations(values, interpolation);
  const property = PROPERTY_BY_PATH[path];
  if (path !== 'weights') {
    const track = createTrack(`${nodeTrackName(node)}.${property}`, times, values, interpolation);
    targetByTrack.set(track, node);
    return [track];
  }
  const meshes = [node, ...node.children].filter(candidate => candidate.morphTargetInfluences);
  return meshes.map(mesh => {
    const track = createTrack(`${nodeTrackName(mesh)}.${property}`, times, values, interpolation);
    targetByTrack.set(track, mesh);
    return track;
  });
}

/** Build one clip per glTF animation. `nodeAt(index)` returns the decoded node for a glTF node index. */
export function createClips(document, nodeAt, readAccessor) {
  return (document.animations ?? []).map((definition, animationIndex) => {
    const tracks = [];
    for (const channel of definition.channels ?? []) {
      if (channel.target.node === undefined) continue;
      const sampler = definition.samplers[channel.sampler];
      tracks.push(...tracksForChannel(channel, sampler, nodeAt(channel.target.node), readAccessor));
    }
    const duration = Math.max(0, ...tracks.map(track => track.times[track.times.length - 1]));
    return { name: definition.name ? definition.name : `animation_${animationIndex}`, duration, tracks };
  });
}

/** Write the clip's value at `time` into the decoded nodes. Properties without a track keep their current value. */
export function applyClip(clip, time) {
  const clamped = Math.max(0, Math.min(time, clip.duration));
  for (const track of clip.tracks) {
    const target = targetByTrack.get(track);
    const result = new Float64Array(track.getValueSize() / (track.interpolation === INTERPOLATE_SMOOTH ? 3 : 1));
    const value = sampleTrack(track, clamped, result);
    const property = track.name.slice(track.name.lastIndexOf('.') + 1);
    if (property === 'morphTargetInfluences') {
      for (let index = 0; index < value.length; index++) target.morphTargetInfluences[index] = value[index];
    } else {
      target[property].fromArray(value);
    }
  }
}

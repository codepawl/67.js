/**
 * Track modifiers and extrapolation, after Blender's F-curve modifiers (fmodifier.cc) and extrapolation (fcurve.cc).
 *
 * A track samples in three steps. Time modifiers (`cycles`, `stepped`) run in listed order and remap the time. The keyframes
 * are sampled at the remapped time, extended past the first and last keyframe by the track `extrapolation`. Value modifiers
 * (`noise`, `generator`, `limits`, `envelope`) then run in listed order on the sampled value. Every step is a pure function of
 * the track and the time, so seeking backwards and rendering give the same bytes.
 */

import { registerTrackEffects } from './animation.js';

const CYCLE_MODES = ['none', 'repeat', 'offset', 'mirror'];
const TIME_TYPES = new Set(['cycles', 'stepped']);
const MAXIMUM_MODIFIERS = 8;
const MAXIMUM_POLYNOMIAL_TERMS = 8;
const MAXIMUM_ENVELOPE_POINTS = 16;

function finiteNumber(value, field, fallback) {
  const result = value ?? fallback;
  if (!Number.isFinite(result)) throw new RangeError(`Modifier ${field} must be a finite number, for example ${fallback}.`);
  return result;
}

function checkKeys(modifier, allowed) {
  for (const key of Object.keys(modifier)) {
    if (key !== 'type' && !allowed.includes(key)) throw new RangeError(`Modifier ${modifier.type} has no field ${key}. Fields: ${allowed.join(', ')}.`);
  }
}

function cycleCount(value, field) {
  const count = value ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw new RangeError(`Modifier ${field} must be an integer from 0 (forever) to 1000.`);
  return count;
}

function normalizeCycles(modifier, property) {
  checkKeys(modifier, ['before', 'after', 'beforeCount', 'afterCount']);
  const before = modifier.before ?? 'repeat';
  const after = modifier.after ?? 'repeat';
  for (const [field, mode] of [['before', before], ['after', after]]) {
    if (!CYCLE_MODES.includes(mode)) throw new RangeError(`Modifier cycles ${field} must be one of ${CYCLE_MODES.join(', ')}, not ${mode}.`);
    if (mode === 'offset' && property === 'rotation') throw new RangeError('Modifier cycles offset does not apply to rotation. Use repeat or mirror.');
  }
  return { type: 'cycles', before, after, beforeCount: cycleCount(modifier.beforeCount, 'cycles beforeCount'), afterCount: cycleCount(modifier.afterCount, 'cycles afterCount') };
}

function normalizeStepped(modifier) {
  checkKeys(modifier, ['step', 'offset']);
  const step = finiteNumber(modifier.step, 'stepped step', 0.1);
  if (step <= 0) throw new RangeError('Modifier stepped step must be above 0 seconds, for example 0.1.');
  return { type: 'stepped', step, offset: finiteNumber(modifier.offset, 'stepped offset', 0) };
}

function normalizeNoise(modifier) {
  checkKeys(modifier, ['scale', 'strength', 'phase', 'seed']);
  const scale = finiteNumber(modifier.scale, 'noise scale', 1);
  if (scale <= 0) throw new RangeError('Modifier noise scale is seconds per wobble and must be above 0, for example 0.25.');
  const seed = modifier.seed ?? 0;
  if (!Number.isInteger(seed) || Math.abs(seed) > 2 ** 31) throw new RangeError('Modifier noise seed must be an integer, for example 7.');
  return { type: 'noise', scale, strength: finiteNumber(modifier.strength, 'noise strength', 1), phase: finiteNumber(modifier.phase, 'noise phase', 0), seed };
}

function normalizeGenerator(modifier) {
  checkKeys(modifier, ['coefficients', 'additive']);
  const coefficients = modifier.coefficients ?? [0, 1];
  if (!Array.isArray(coefficients) || !coefficients.length || coefficients.length > MAXIMUM_POLYNOMIAL_TERMS || !coefficients.every(Number.isFinite)) {
    throw new RangeError(`Modifier generator coefficients are 1 to ${MAXIMUM_POLYNOMIAL_TERMS} finite numbers, lowest power first, for example [0, 1].`);
  }
  if (modifier.additive !== undefined && typeof modifier.additive !== 'boolean') throw new RangeError('Modifier generator additive must be true or false.');
  return { type: 'generator', coefficients: [...coefficients], additive: modifier.additive ?? false };
}

function normalizeLimits(modifier) {
  checkKeys(modifier, ['min', 'max']);
  if (modifier.min === undefined && modifier.max === undefined) throw new RangeError('Modifier limits needs min, max or both, for example {min:0,max:1}.');
  const result = { type: 'limits' };
  if (modifier.min !== undefined) result.min = finiteNumber(modifier.min, 'limits min', 0);
  if (modifier.max !== undefined) result.max = finiteNumber(modifier.max, 'limits max', 1);
  if (result.min !== undefined && result.max !== undefined && result.min > result.max) throw new RangeError('Modifier limits min must not exceed max.');
  return result;
}

function normalizeEnvelope(modifier) {
  checkKeys(modifier, ['points', 'referenceMin', 'referenceMax']);
  const points = modifier.points;
  if (!Array.isArray(points) || !points.length || points.length > MAXIMUM_ENVELOPE_POINTS) {
    throw new RangeError(`Modifier envelope points are 1 to ${MAXIMUM_ENVELOPE_POINTS} of {time,min,max}, for example [{time:0,min:-1,max:1}].`);
  }
  const normalized = points.map(point => ({
    time: finiteNumber(point?.time, 'envelope point time', 0),
    min: finiteNumber(point?.min, 'envelope point min', -1),
    max: finiteNumber(point?.max, 'envelope point max', 1),
  })).sort((first, second) => first.time - second.time);
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index].time === normalized[index - 1].time) throw new RangeError('Modifier envelope point times must be distinct.');
  }
  const referenceMin = finiteNumber(modifier.referenceMin, 'envelope referenceMin', -1);
  const referenceMax = finiteNumber(modifier.referenceMax, 'envelope referenceMax', 1);
  if (referenceMax <= referenceMin) throw new RangeError('Modifier envelope referenceMax must be above referenceMin.');
  return { type: 'envelope', points: normalized, referenceMin, referenceMax };
}

const NORMALIZERS = {
  cycles: normalizeCycles,
  stepped: normalizeStepped,
  noise: normalizeNoise,
  generator: normalizeGenerator,
  limits: normalizeLimits,
  envelope: normalizeEnvelope,
};

/** Returns `{ extrapolation, timeModifiers, valueModifiers }` frozen, or null when the track has neither. */
export function normalizeTrackEffects(track) {
  const extrapolation = track.extrapolation ?? 'constant';
  if (extrapolation !== 'constant' && extrapolation !== 'linear') throw new RangeError(`Track extrapolation must be constant or linear, not ${extrapolation}.`);
  if (extrapolation === 'linear' && track.property === 'rotation') throw new RangeError('Rotation tracks cannot extrapolate linearly. Use constant, or a cycles modifier.');
  const modifiers = track.modifiers ?? [];
  if (!Array.isArray(modifiers) || modifiers.length > MAXIMUM_MODIFIERS) throw new RangeError(`Track modifiers is a list of at most ${MAXIMUM_MODIFIERS} objects like {type:'noise'}.`);
  if (extrapolation === 'constant' && !modifiers.length) return null;
  const timeModifiers = [];
  const valueModifiers = [];
  for (const modifier of modifiers) {
    const normalizer = NORMALIZERS[modifier?.type];
    if (!normalizer) throw new RangeError(`Unknown modifier type ${modifier?.type}. Types: ${Object.keys(NORMALIZERS).join(', ')}.`);
    if (!TIME_TYPES.has(modifier.type) && track.property === 'rotation') throw new RangeError(`Rotation tracks accept only cycles and stepped modifiers, not ${modifier.type}.`);
    (TIME_TYPES.has(modifier.type) ? timeModifiers : valueModifiers).push(Object.freeze(normalizer(modifier, track.property)));
  }
  return Object.freeze({ extrapolation, timeModifiers: Object.freeze(timeModifiers), valueModifiers: Object.freeze(valueModifiers) });
}

/** The modifiers back in authored form, for recipes: time modifiers first, as they run. */
export function trackEffectsDescription(effects) {
  const description = {};
  if (effects.extrapolation !== 'constant') description.extrapolation = effects.extrapolation;
  const modifiers = [...effects.timeModifiers, ...effects.valueModifiers];
  if (modifiers.length) description.modifiers = modifiers.map(modifier => structuredClone(modifier));
  return description;
}

/** Remaps time through `cycles` and `stepped`. Returns the time and adds the per-cycle value offset multiples to `offsets`. */
export function remapTime(effects, keyframes, time, offsets) {
  const firstTime = keyframes[0].time;
  const length = keyframes[keyframes.length - 1].time - firstTime;
  let remapped = time;
  for (const modifier of effects.timeModifiers) {
    if (modifier.type === 'stepped') {
      remapped = Math.floor((remapped - modifier.offset) / modifier.step + 1e-9) * modifier.step + modifier.offset;
      continue;
    }
    if (length <= 0 || remapped >= firstTime && remapped <= firstTime + length) continue;
    const isBefore = remapped < firstTime;
    const mode = isBefore ? modifier.before : modifier.after;
    if (mode === 'none') continue;
    const limit = isBefore ? modifier.beforeCount : modifier.afterCount;
    let cycle = Math.floor((remapped - firstTime) / length);
    let local = remapped - firstTime - cycle * length;
    const passed = isBefore ? -cycle : cycle;
    if (limit > 0 && passed > limit) {
      cycle = isBefore ? -limit : limit;
      local = isBefore ? 0 : length;
    }
    if (mode === 'mirror' && Math.abs(cycle) % 2 === 1) local = length - local;
    if (mode === 'offset') offsets.push(cycle);
    remapped = firstTime + local;
  }
  return remapped;
}

function hashUnit(index, seed) {
  let state = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
  state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d);
  state = Math.imul(state ^ (state >>> 12), 0x297a2d39);
  state ^= state >>> 15;
  return (state >>> 0) / 2147483648 - 1;
}

/** Smooth value noise in [-1, 1]; the same input always gives the same output. */
export function valueNoise(position, seed) {
  const cell = Math.floor(position);
  const fraction = position - cell;
  const blend = fraction * fraction * (3 - 2 * fraction);
  const start = hashUnit(cell, seed);
  return start + (hashUnit(cell + 1, seed) - start) * blend;
}

function envelopeBounds(points, time) {
  const last = points[points.length - 1];
  if (time <= points[0].time) return [points[0].min, points[0].max];
  if (time >= last.time) return [last.min, last.max];
  let upper = 1;
  while (points[upper].time < time) upper++;
  const start = points[upper - 1];
  const end = points[upper];
  const progress = (time - start.time) / (end.time - start.time);
  return [start.min + (end.min - start.min) * progress, start.max + (end.max - start.max) * progress];
}

/** Runs the value modifiers over `output` in place. `time` is the original, unremapped time. */
export function applyValueModifiers(effects, time, output) {
  for (const modifier of effects.valueModifiers) {
    for (let axis = 0; axis < output.length; axis++) {
      const value = output[axis];
      if (modifier.type === 'noise') {
        output[axis] = value + valueNoise((time + modifier.phase) / modifier.scale, modifier.seed + axis * 7919) * modifier.strength;
      } else if (modifier.type === 'generator') {
        let polynomial = 0;
        for (let term = modifier.coefficients.length - 1; term >= 0; term--) polynomial = polynomial * time + modifier.coefficients[term];
        output[axis] = modifier.additive ? value + polynomial : polynomial;
      } else if (modifier.type === 'limits') {
        output[axis] = Math.min(modifier.max ?? Infinity, Math.max(modifier.min ?? -Infinity, value));
      } else {
        const [minimum, maximum] = envelopeBounds(modifier.points, time);
        const progress = (value - modifier.referenceMin) / (modifier.referenceMax - modifier.referenceMin);
        output[axis] = minimum + (maximum - minimum) * progress;
      }
    }
  }
}

function componentOf(value, axis) {
  return typeof value === 'number' ? value : value[axis];
}

/** Secant slope per second between two keyframes on one axis. */
function secantSlope(from, to, axis) {
  return (componentOf(to.value, axis) - componentOf(from.value, axis)) / (to.time - from.time);
}

function sampleTrackWithEffects(track, time, output, sampleKeyframes, constrainSample) {
  const { effects, keyframes } = track;
  const offsets = [];
  const remapped = remapTime(effects, keyframes, time, offsets);
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  sampleKeyframes(track, remapped, output);
  if (effects.extrapolation === 'linear' && keyframes.length > 1) {
    const slopeFrom = remapped < first.time ? first : keyframes[keyframes.length - 2];
    const slopeTo = remapped < first.time ? keyframes[1] : last;
    const distance = remapped < first.time ? remapped - first.time : remapped > last.time ? remapped - last.time : 0;
    for (let axis = 0; axis < output.length; axis++) output[axis] += secantSlope(slopeFrom, slopeTo, axis) * distance;
  }
  for (const cycle of offsets) {
    for (let axis = 0; axis < output.length; axis++) output[axis] += cycle * (componentOf(last.value, axis) - componentOf(first.value, axis));
  }
  applyValueModifiers(effects, time, output);
  for (let axis = 0; axis < output.length; axis++) output[axis] = constrainSample(track.property, output[axis]);
  return output;
}

registerTrackEffects({ normalize: normalizeTrackEffects, sample: sampleTrackWithEffects });

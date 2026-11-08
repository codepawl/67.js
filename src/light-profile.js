// The IES profile math, apart from the shader code so the path tracer can read it alone.

// An IES profile is the candela of a lamp against the angle from its axis, in degrees. It is stored as 16 relative
// values at equal steps of angle from 0 (the axis) to 90 degrees (the plane of the lamp), divided by the value on the
// axis, so `intensity` stays the candela head on. The raster shader and the path tracer read the same 16 values.
// A spot light multiplies its cone by the profile; an area light multiplies its Lambert emission by it.

export const PROFILE_SAMPLE_COUNT = 16;
const PROFILE_MAXIMUM_POINTS = 32;

// Bundled profiles, made for 67js as cosine powers (CC0): the exponent sets how tight the beam is.
// 'batwing' peaks at 45 degrees off the axis, as a wall washer does.
const BUNDLED_EXPONENTS = { 'wide-flood': 1.5, downlight: 6, 'narrow-spot': 30 };
export const IES_PROFILE_NAMES = Object.freeze([...Object.keys(BUNDLED_EXPONENTS), 'batwing']);

function bundledCandela(name, angleDegrees) {
  const radians = (angleDegrees * Math.PI) / 180;
  if (name === 'batwing') return 0.35 + 0.65 * Math.sin(2 * radians) ** 2;
  return Math.cos(radians) ** BUNDLED_EXPONENTS[name];
}

function bundledProfile(name) {
  const angles = [];
  for (let step = 0; step <= 9; step++) angles.push(step * 10);
  return { angles, candela: angles.map(angle => bundledCandela(name, angle)) };
}

/** Checks a recipe's `ies` value (a bundled name or { angles, candela }) and returns it in one canonical shape. */
export function resolveIesProfile(value, label = 'ies') {
  if (typeof value === 'string') {
    if (!IES_PROFILE_NAMES.includes(value)) throw new RangeError(`${label} must be one of ${IES_PROFILE_NAMES.join(', ')} or { angles, candela }.`);
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a profile name or { angles, candela }.`);
  const { angles, candela } = value;
  if (!Array.isArray(angles) || !Array.isArray(candela) || angles.length !== candela.length || angles.length < 2 || angles.length > PROFILE_MAXIMUM_POINTS) {
    throw new RangeError(`${label} angles and candela must be arrays of the same length, from 2 to ${PROFILE_MAXIMUM_POINTS}.`);
  }
  angles.forEach((angle, index) => {
    if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < 0 || angle > 180 || (index > 0 && angle <= angles[index - 1])) {
      throw new RangeError(`${label} angles must be degrees from 0 to 180, strictly rising.`);
    }
  });
  candela.forEach(entry => {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 1e7) throw new RangeError(`${label} candela must be numbers from 0 to 10000000.`);
  });
  if (!candela.some(entry => entry > 0)) throw new RangeError(`${label} candela needs a value above zero.`);
  return { angles: [...angles], candela: [...candela] };
}

function candelaAt(profile, angleDegrees) {
  const { angles, candela } = profile;
  if (angleDegrees <= angles[0]) return candela[0];
  for (let index = 1; index < angles.length; index++) {
    if (angleDegrees <= angles[index]) {
      const fraction = (angleDegrees - angles[index - 1]) / (angles[index] - angles[index - 1]);
      return candela[index - 1] + (candela[index] - candela[index - 1]) * fraction;
    }
  }
  return 0;
}

const profileCache = new Map();

/** The 16 relative values of a profile, 1 on the axis. The array is shared: do not change it. */
export function profileSamples(value) {
  const key = typeof value === 'string' ? value : JSON.stringify(value);
  const cached = profileCache.get(key);
  if (cached) return cached;
  const profile = typeof value === 'string' ? bundledProfile(value) : value;
  const onAxis = candelaAt(profile, 0) > 0 ? candelaAt(profile, 0) : Math.max(...profile.candela);
  const samples = new Float32Array(PROFILE_SAMPLE_COUNT);
  for (let index = 0; index < PROFILE_SAMPLE_COUNT; index++) {
    samples[index] = candelaAt(profile, (index / (PROFILE_SAMPLE_COUNT - 1)) * 90) / onAxis;
  }
  if (profileCache.size > 64) profileCache.clear();
  profileCache.set(key, samples);
  return samples;
}

/** The gain of a profile at the cosine of the angle from the lamp's axis; 0 at or past 90 degrees. */
export function profileGain(samples, cosine) {
  if (cosine <= 0) return 0;
  const position = (Math.acos(Math.min(cosine, 1)) / (Math.PI / 2)) * (PROFILE_SAMPLE_COUNT - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, PROFILE_SAMPLE_COUNT - 1);
  return samples[lower] + (samples[upper] - samples[lower]) * (position - lower);
}


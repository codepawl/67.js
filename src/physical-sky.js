import { createEnvironmentMap } from './environment.js';

// environment.sky { type: 'physical' }: a clear-sky model driven by the sun alone. It is an analytic single-scattering
// approximation (Rayleigh and Henyey-Greenstein aerosol, Kasten-Young air mass), not the Nishita integration Blender uses.
// The normalized recipe stores the resolved sun, so the key light, the sky map, the background gradient and the
// aerial perspective of distant geometry always agree.

export const PHYSICAL_SKY_FIELDS = Object.freeze(['type', 'sunElevation', 'sunRotation', 'turbidity', 'groundAlbedo', 'aerialPerspective', 'ozone', 'sunDisc']);

// Named looks an agent can ask for with environment.sky { preset }: they set the sun and nothing else, so the sky, the key colour and
// the haze all come from the same atmosphere. Fields named beside a preset win over it.
export const PHYSICAL_SKY_PRESETS = Object.freeze({
  'golden-hour': Object.freeze({ sunElevation: 4, sunRotation: 250 }),
  sunset: Object.freeze({ sunElevation: 1, sunRotation: 250 }),
  'blue-hour': Object.freeze({ sunElevation: -4, sunRotation: 250 }),
});
export const PHYSICAL_SKY_PRESET_NAMES = Object.freeze(Object.keys(PHYSICAL_SKY_PRESETS));

const DEFAULTS = Object.freeze({ sunElevation: 45, sunRotation: 0, turbidity: 3, groundAlbedo: 0.3, aerialPerspective: 1, ozone: 1, sunDisc: true });
const LIMITS = Object.freeze({
  sunElevation: [-90, 90, 'degrees above the horizon, such as 15'],
  sunRotation: [-360, 360, 'degrees clockwise from -Z seen from above, such as 120'],
  turbidity: [1, 10, 'haze from 1 (very clear) to 10 (thick haze), such as 3'],
  groundAlbedo: [0, 1, 'a reflectance from 0 to 1, such as 0.3'],
  aerialPerspective: [0, 4, 'a scale from 0 (none) to 4, such as 1'],
  ozone: [0, 10, 'ozone absorption from 0 (none) to 10, such as 1'],
});

const MAP_WIDTH = 1024;
const MAP_HEIGHT = 512;
// Per-channel (red, green, blue) optical depth of the air at the zenith, the aerosol depth per unit turbidity, and the
// Chappuis-band ozone absorption depth per unit ozone (strong in orange-green, weak in blue).
const RAYLEIGH_DEPTH = [0.04, 0.1, 0.24];
const AEROSOL_DEPTH_PER_TURBIDITY = [0.0125, 0.015, 0.0175];
const OZONE_DEPTH = [0.02, 0.014, 0.0005];
const SUN_STRENGTH = 3.4;
const SKY_STRENGTH = 2.2;
const SUN_DISC_STRENGTH = 18;
const SUN_DISC_COSINE = 0.9994;
const MAXIMUM_AIR_MASS = 20;
const AEROSOL_ANISOTROPY = 0.76;
const SHARED_SUN_MASS = 4;
const LOW_SUN_FADE_END = 14;
const LOW_SUN_HORIZON_BOOST = [2.4, 0.1, -0.4];
const HORIZON_BAND_SINE = 0.15;
const LOW_SUN_ZENITH_DIMMING = 0.4;
const LOW_SUN_KEY_BOOST = 1.2;

/** Checks and fills the sky fields; `fail` builds the error for a field, a value and what is accepted. */
export function resolvePhysicalSky(input, fail) {
  const unknown = Object.keys(input).filter(key => key !== 'preset' && !PHYSICAL_SKY_FIELDS.includes(key));
  if (unknown.length > 0 || input.type !== 'physical') {
    throw fail('environment.sky', input.type !== 'physical' ? input.type : unknown[0], `type 'physical' with fields ${[...PHYSICAL_SKY_FIELDS.slice(1), 'preset'].join(', ')}`);
  }
  if (input.preset !== undefined && !Object.hasOwn(PHYSICAL_SKY_PRESETS, input.preset)) {
    throw fail('environment.sky.preset', input.preset, `one of ${PHYSICAL_SKY_PRESET_NAMES.join(', ')}`);
  }
  const preset = PHYSICAL_SKY_PRESETS[input.preset] ?? {};
  const resolved = { type: 'physical' };
  for (const [field, [minimum, maximum, example]] of Object.entries(LIMITS)) {
    const value = input[field] ?? preset[field] ?? DEFAULTS[field];
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw fail(`environment.sky.${field}`, value, `a number from ${minimum} to ${maximum}, ${example}`);
    }
    resolved[field] = value;
  }
  const sunDisc = input.sunDisc ?? DEFAULTS.sunDisc;
  if (typeof sunDisc !== 'boolean') {
    throw fail('environment.sky.sunDisc', sunDisc, 'true or false');
  }
  resolved.sunDisc = sunDisc;
  return resolved;
}

function airMass(elevationRadians) {
  const degrees = Math.max(elevationRadians, 0) * 180 / Math.PI;
  return Math.min(MAXIMUM_AIR_MASS, 1 / (Math.sin(Math.max(elevationRadians, 0)) + 0.15 * Math.pow(degrees + 3.885, -1.253)));
}

function opticalDepth(turbidity, ozone = 1) {
  return RAYLEIGH_DEPTH.map((rayleigh, channel) => rayleigh + AEROSOL_DEPTH_PER_TURBIDITY[channel] * turbidity + OZONE_DEPTH[channel] * ozone);
}

/** The unit direction toward the sun; azimuth turns clockwise seen from above, from -Z. */
export function physicalSunDirection(sky) {
  const elevation = sky.sunElevation * Math.PI / 180;
  const rotation = sky.sunRotation * Math.PI / 180;
  return [Math.cos(elevation) * Math.sin(rotation), Math.sin(elevation), -Math.cos(elevation) * Math.cos(rotation)];
}

/** 1 for a sun at 2 degrees or lower, falling to 0 at 14 degrees, where the sky is exactly what it was before the low-sun fit. */
function lowSunShare(sky) {
  return Math.min(1, Math.max(0, (LOW_SUN_FADE_END - sky.sunElevation) / (LOW_SUN_FADE_END - 2)));
}

function sunColor(sky) {
  const elevation = sky.sunElevation * Math.PI / 180;
  const mass = airMass(elevation);
  const depth = opticalDepth(sky.turbidity, sky.ozone ?? 1);
  // The disc sinks under the horizon over about three degrees.
  const setting = Math.min(1, Math.max(0, (sky.sunElevation + 1) / 3));
  // The same fitted low-sun fade as the sky: Blender's low sun lights a plane more than sin(elevation) of the noon sun does.
  const strength =SUN_STRENGTH * (1 + LOW_SUN_KEY_BOOST * lowSunShare(sky));
  return depth.map(channelDepth => strength * Math.exp(-channelDepth * mass) * setting);
}

function skyRadiance(sky, direction, sun) {
  const ozone = sky.ozone ?? 1;
  const depth = opticalDepth(sky.turbidity, ozone);
  const fullSunMass = airMass(Math.asin(Math.max(-1, Math.min(1, sun[1]))));
  const sunCosine = direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2];
  const rayleighPhase = 0.75 * (1 + sunCosine * sunCosine);
  const anisotropy = AEROSOL_ANISOTROPY;
  const uncappedAerosolPhase = (1 - anisotropy * anisotropy) / Math.pow(1 + anisotropy * anisotropy - 2 * anisotropy * sunCosine, 1.5) / (4 * Math.PI) * 4;
  const aerosolPhase = Math.min(uncappedAerosolPhase, 2.5);
  const viewMass = airMass(Math.asin(Math.max(0, direction[1])) + 0.02);
  const setting = Math.min(1, Math.max(0, (sky.sunElevation + 6) / 8));
  // Light scattered high above a view direction crossed less air toward the sun than light scattered low over the horizon.
  // Up to a sun air mass of 4 the whole sky shares one path, so a sun above about 14 degrees looks as it always did; below
  // that the horizon keeps the full path (orange) while the zenith stays near the shared one (blue).
  const lowShare = (1 - Math.sqrt(Math.max(0, direction[1]))) ** 2;
  const sunMassCap = SHARED_SUN_MASS + (MAXIMUM_AIR_MASS - SHARED_SUN_MASS) * lowShare;
  // Fitted to Blender's sky at 2 to 15 degrees: a low sun lifts the red of the horizon band (multiple scattering the single
  // scattering sum above lacks) and dims the zenith, fading to nothing at a sun 14 degrees up.
  const lowSun = lowSunShare(sky);
  const horizonBand = Math.max(0, 1 - direction[1] / HORIZON_BAND_SINE) ** 2;
  return depth.map((channelDepth, channel) => {
    const rayleigh = RAYLEIGH_DEPTH[channel];
    const aerosol = AEROSOL_DEPTH_PER_TURBIDITY[channel] * sky.turbidity;
    const scattered = (rayleigh * rayleighPhase + aerosol * aerosolPhase * 1.5) / (rayleigh + aerosol);
    const inScatter = 1 - Math.exp(-(rayleigh + aerosol) * viewMass);
    // Light scattered near the sun and low in the sky crossed the whole air mass toward the sun; the rest of the sky saw a short path.
    const nearSun = Math.max(0, sunCosine) ** 2 * (1 - Math.max(0, direction[1]));
    const sunMass = Math.min(sunMassCap, fullSunMass) * (1 - nearSun) + fullSunMass * nearSun;
    const lightReaching = Math.exp(-channelDepth * sunMass * 0.45 - OZONE_DEPTH[channel] * ozone * viewMass * 0.35);
    const lowSunTint = 1 + lowSun * (horizonBand * LOW_SUN_HORIZON_BOOST[channel] - (1 - lowShare) * LOW_SUN_ZENITH_DIMMING);
    return SKY_STRENGTH * scattered * inScatter * lightReaching * setting * lowSunTint;
  });
}

function groundRadiance(sky, sunColorValue, zenith, sun) {
  const sunlight = Math.max(sun[1], 0);
  return sunColorValue.map((component, channel) => sky.groundAlbedo * (component * sunlight * 0.3 + zenith[channel] * 0.55));
}

function colorAtZenithAndHorizon(sky) {
  const sun = physicalSunDirection(sky);
  const color = sunColor(sky);
  const sideHorizon = [-sun[2], 0.04, sun[0]];
  const zenith = skyRadiance(sky, [0, 1, 0], sun);
  const toward = skyRadiance(sky, [sun[0], Math.max(0.04, sun[1] * 0.2), sun[2]], sun);
  const across = skyRadiance(sky, sideHorizon, sun);
  const horizon = toward.map((component, channel) => component * 0.7 + across[channel] * 0.3);
  return { sun, color, zenith, horizon };
}

/**
 * The recipe fields the sun and haze imply: key direction and colour, the background gradient and the fog that
 * gives distant geometry its aerial perspective. All stay inside the ranges the environment checks accept.
 */
export function physicalSkyFields(sky) {
  const { sun, color, zenith, horizon } = colorAtZenithAndHorizon(sky);
  // A colour above 1 keeps its hue and scales down to the brightest channel being 1.
  const clamped = vector => vector.map(component => Math.max(0, component / Math.max(1, ...vector)));
  const fields = {
    lightDirection: sun,
    keyColor: color.map(component => Math.round(component * 1000) / 1000),
    skyTop: clamped(zenith),
    skyBottom: clamped(horizon),
    fogColor: clamped(horizon),
    aerialDensity: 0.0025 * sky.turbidity * sky.aerialPerspective,
  };
  return fields;
}

/** A physical sky owns the sun and the haze: its key light, background gradient and aerial perspective replace those fields. */
export function applyPhysicalSky(input, environment, fail) {
  const sky = resolvePhysicalSky(input, fail);
  const { aerialDensity, ...fields } = physicalSkyFields(sky);
  Object.assign(environment, fields, { sky, fogDensity: aerialDensity });
}

const mapsByKey = new Map();
const MAXIMUM_CACHED_MAPS = 8;

/**
 * A round disc with a flat bright top and a soft rim, by the angle from the sun's centre. A squared falloff over a map of a few
 * degrees per texel drew the sun as the texel grid (a rounded rectangle); the finer map and this profile keep it a circle.
 */
function sunDiscWeight(sunCosine) {
  const rim = (sunCosine - SUN_DISC_COSINE) / (1 - SUN_DISC_COSINE);
  const edge = Math.min(Math.max(rim / 0.64, 0), 1);
  return edge * edge * (3 - 2 * edge) * SUN_DISC_STRENGTH;
}

// Haze fills the first degrees under the horizon, so a finite sea or plane whose far edge ends short of the true horizon meets
// haze the colour of the sky, not a flat band of ground colour with a hard step at the horizon line.
const HORIZON_HAZE_SINE = 0.12;

function belowHorizonRadiance(sky, color, zenith, sun, direction) {
  const horizonSky = skyRadiance(sky, [direction[0], 0, direction[2]], sun);
  const ground = groundRadiance(sky, color, zenith, sun).map((component, channel) => component + horizonSky[channel] * 0.35 * (1 - sky.groundAlbedo));
  const depth = Math.min(-direction[1] / HORIZON_HAZE_SINE, 1);
  const groundShare = depth * depth * (3 - 2 * depth);
  return ground.map((component, channel) => horizonSky[channel] + (component - horizonSky[channel]) * groundShare);
}

function buildMapData(sky) {
  const { sun, color, zenith } = colorAtZenithAndHorizon(sky);
  const drawDisc = sky.sunDisc !== false && sky.sunElevation > -1.5;
  const data = new Float32Array(MAP_WIDTH * MAP_HEIGHT * 3);
  for (let row = 0; row < MAP_HEIGHT; row++) {
    const polar = ((row + 0.5) / MAP_HEIGHT) * Math.PI;
    for (let column = 0; column < MAP_WIDTH; column++) {
      const azimuth = ((column + 0.5) / MAP_WIDTH - 0.5) * 2 * Math.PI;
      const direction = [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth)];
      const sunCosine = direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2];
      const discWeight = drawDisc && direction[1] > 0 && sunCosine > SUN_DISC_COSINE
        ? sunDiscWeight(sunCosine)
        : 0;
      const radiance = direction[1] >= 0
        ? skyRadiance(sky, direction, sun).map((component, channel) => component + color[channel] * discWeight)
        : belowHorizonRadiance(sky, color, zenith, sun, direction);
      data.set(radiance, (row * MAP_WIDTH + column) * 3);
    }
  }
  return data;
}

/** The environment map of a physical sky; the same object returns while sky, strength, rotation and background hold. */
export function createPhysicalSkyMap({ sky, environmentIntensity: intensity, environmentRotation: rotation, world: showBackground }) {
  const key = [...PHYSICAL_SKY_FIELDS.slice(1).map(field => sky[field]), intensity, rotation, showBackground].join('|');
  if (!mapsByKey.has(key)) {
    if (mapsByKey.size >= MAXIMUM_CACHED_MAPS) {
      mapsByKey.clear();
    }
    mapsByKey.set(key, createEnvironmentMap({ width: MAP_WIDTH, height: MAP_HEIGHT, data: buildMapData(sky), intensity, rotation, showBackground }));
  }
  return mapsByKey.get(key);
}

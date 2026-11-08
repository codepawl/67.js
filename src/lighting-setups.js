import { createEnvironmentMap } from './environment.js';
import { LIGHTING_SETUP_NAMES } from './agent-scene-capabilities.js';
import { catalogEnvironmentSource, environmentRegistrationCount } from './look-catalog.js';

const MAP_WIDTH = 128;
const MAP_HEIGHT = 64;

// Radiance values are linear. A panel is a soft disc of light: direction, angular radius in radians, color.
const SETUPS = Object.freeze({
  daylight: Object.freeze({
    sky: { zenith: [0.28, 0.46, 0.95], horizon: [0.95, 1.0, 1.05], ground: [0.32, 0.29, 0.25] },
    panels: [],
    fields: { lightDirection: [-3, 6, 4], keyColor: [3, 2.8, 2.5], keyIntensity: 1, fillIntensity: 0, ambientIntensity: 1, skyTop: [0.2, 0.38, 0.52], skyBottom: [0.62, 0.7, 0.67] },
  }),
  overcast: Object.freeze({
    sky: { zenith: [0.85, 0.88, 0.92], horizon: [0.6, 0.62, 0.65], ground: [0.28, 0.28, 0.28] },
    panels: [],
    fields: { lightDirection: [-1, 6, 2], keyColor: [0.9, 0.9, 0.92], keyIntensity: 1, fillIntensity: 0, ambientIntensity: 1, skyTop: [0.6, 0.62, 0.66], skyBottom: [0.55, 0.57, 0.6] },
  }),
  sunset: Object.freeze({
    sky: { zenith: [0.12, 0.18, 0.42], horizon: [1.7, 0.75, 0.32], ground: [0.22, 0.13, 0.1] },
    panels: [{ direction: [-6, 1.5, 3], radius: 0.35, color: [6, 2.6, 0.9] }],
    fields: { lightDirection: [-6, 1.5, 3], keyColor: [3.4, 1.8, 0.85], keyIntensity: 1, fillIntensity: 0, ambientIntensity: 1, skyTop: [0.1, 0.16, 0.38], skyBottom: [0.9, 0.45, 0.25] },
  }),
  studio: Object.freeze({
    sky: { zenith: [0.5, 0.5, 0.5], horizon: [0.3, 0.3, 0.31], ground: [0.22, 0.22, 0.22] },
    panels: [
      { direction: [-3, 6, 4], radius: 0.7, color: [5, 4.9, 4.7] },
      { direction: [0, 1, 0], radius: 0.8, color: [3, 3, 3.1] },
      { direction: [4, 1.5, -3], radius: 0.5, color: [1.8, 2, 2.4] },
    ],
    fields: { lightDirection: [-3, 6, 4], keyColor: [2.4, 2.3, 2.2], keyIntensity: 1, fillIntensity: 0, ambientIntensity: 1, skyTop: [0.45, 0.45, 0.46], skyBottom: [0.3, 0.3, 0.32] },
  }),
});

const mapDataByName = new Map();
const mapsByKey = new Map();
const MAXIMUM_CACHED_MAPS = 16;

function requireSetup(name) {
  if (!LIGHTING_SETUP_NAMES.includes(name)) {
    throw new RangeError(`Unknown lighting setup: ${String(name)}. Use ${LIGHTING_SETUP_NAMES.join(', ')}.`);
  }
  return SETUPS[name];
}

/** The environment fields a setup supplies, as fresh arrays. */
export function lightingSetupFields(name) {
  return structuredClone(requireSetup(name).fields);
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  return vector.map(component => component / length);
}

function mixColors(from, to, amount) {
  return from.map((component, index) => component + (to[index] - component) * amount);
}

function skyRadiance(sky, upward) {
  if (upward >= 0) {
    return mixColors(sky.horizon, sky.zenith, Math.sqrt(upward));
  }
  return mixColors(sky.horizon, sky.ground, Math.min(1, Math.pow(-upward, 0.4) * 1.4));
}

function panelContribution(panel, direction) {
  const axis = normalized(panel.direction);
  const alignment = axis[0] * direction[0] + axis[1] * direction[1] + axis[2] * direction[2];
  const inner = Math.cos(panel.radius);
  const outer = Math.cos(panel.radius * 1.6);
  const amount = Math.min(1, Math.max(0, (alignment - outer) / (inner - outer)));
  return amount * amount * (3 - 2 * amount);
}

function buildMapData(setup) {
  const data = new Float32Array(MAP_WIDTH * MAP_HEIGHT * 3);
  for (let row = 0; row < MAP_HEIGHT; row++) {
    const polar = ((row + 0.5) / MAP_HEIGHT) * Math.PI;
    for (let column = 0; column < MAP_WIDTH; column++) {
      const azimuth = ((column + 0.5) / MAP_WIDTH - 0.5) * 2 * Math.PI;
      const direction = [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth)];
      const radiance = skyRadiance(setup.sky, direction[1]);
      for (const panel of setup.panels) {
        const weight = panelContribution(panel, direction);
        for (let channel = 0; channel < 3; channel++) {
          radiance[channel] += panel.color[channel] * weight;
        }
      }
      data.set(radiance, (row * MAP_WIDTH + column) * 3);
    }
  }
  return data;
}

/**
 * The procedural environment map of a setup. Pixel data is built once per setup, so the renderer
 * keeps its prefiltered textures while only intensity, rotation or background change.
 */
export function createLightingSetupMap(name, { intensity = 1, rotation = 0, showBackground = false } = {}) {
  const setup = requireSetup(name);
  const key = [name, intensity, rotation, showBackground].join('|');
  if (mapsByKey.has(key)) {
    return mapsByKey.get(key);
  }
  if (!mapDataByName.has(name)) {
    mapDataByName.set(name, buildMapData(setup));
  }
  if (mapsByKey.size >= MAXIMUM_CACHED_MAPS) {
    mapsByKey.clear();
  }
  const map = createEnvironmentMap({ width: MAP_WIDTH, height: MAP_HEIGHT, data: mapDataByName.get(name), intensity, rotation, showBackground });
  mapsByKey.set(key, map);
  return map;
}

/** The environment map of a registered catalog HDRI; the same object returns while name, strength, rotation, background and registered data hold. */
export function createCatalogEnvironmentMap(reference, { intensity = 1, rotation = 0, showBackground = false } = {}) {
  const key = ['catalog', reference, environmentRegistrationCount(), intensity, rotation, showBackground].join('|');
  if (!mapsByKey.has(key)) {
    if (mapsByKey.size >= MAXIMUM_CACHED_MAPS) {
      mapsByKey.clear();
    }
    mapsByKey.set(key, createEnvironmentMap({ ...catalogEnvironmentSource(reference), intensity, rotation, showBackground }));
  }
  return mapsByKey.get(key);
}

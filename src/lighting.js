import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';

export { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS };
export const DEFAULT_SPECULAR_ANTI_ALIASING = 1;
export const MAXIMUM_SPECULAR_ANTI_ALIASING = 4;

// One 2048 x 3072 depth atlas holds 24 tiles of 512 x 512 (24 MiB). A shadowed spot light uses one tile and a shadowed point
// light uses six, one for each cube face.
export const SHADOW_ATLAS_TILES = 24;
export const POINT_SHADOW_TILES = 6;
export const NO_SHADOW_TILE = -1;
export const SPOT_FACE = -1;
const SPOT_MAXIMUM_ANGLE = Math.PI / 2 - 0.01;
const SPOT_COSINE_GAP = 1e-4;

function numberInRange(value, minimum, maximum, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function vectorInRange(value, minimum, maximum, name) {
  if (value?.length !== 3) throw new TypeError(`${name} must have three components`);
  for (let axis = 0; axis < 3; axis++) numberInRange(value[axis], minimum, maximum, name);
  return value;
}

function lightList(environment, field, maximum) {
  const lights = environment[field] ?? [];
  if (!Array.isArray(lights) || lights.length > maximum) {
    throw new RangeError(`${field} must be an array of at most ${maximum} lights`);
  }
  return lights;
}

function lightObject(light, name) {
  if (!light || typeof light !== 'object' || Array.isArray(light)) throw new TypeError(`${name} must be an object`);
  return light;
}

function validateRange(light, name) {
  const range = light.range ?? 0;
  numberInRange(range, 0, 1e6, `${name} range`);
  if (range !== 0 && range < 0.001) throw new RangeError(`${name} range must be zero or at least 0.001`);
}

function validateCastShadow(light, name) {
  if (light.castShadow !== undefined && typeof light.castShadow !== 'boolean') throw new TypeError(`${name} castShadow must be true or false`);
}

function normalizedDirection(direction, name) {
  vectorInRange(direction, -1e6, 1e6, name);
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length < 1e-6) throw new RangeError(`${name} must not be zero length`);
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function validatePointLight(light) {
  lightObject(light, 'Point light');
  vectorInRange(light.position, -1e6, 1e6, 'Point light position');
  vectorInRange(light.color ?? [1, 1, 1], 0, 1, 'Point light color');
  numberInRange(light.intensity ?? 1, 0, 1e5, 'Point light intensity');
  numberInRange(light.radius ?? 0.05, 0.001, 1e6, 'Point light radius');
  validateRange(light, 'Point light');
  validateCastShadow(light, 'Point light');
}

function validateSpotLight(light) {
  lightObject(light, 'Spot light');
  vectorInRange(light.position, -1e6, 1e6, 'Spot light position');
  normalizedDirection(light.direction, 'Spot light direction');
  vectorInRange(light.color ?? [1, 1, 1], 0, 1, 'Spot light color');
  numberInRange(light.intensity ?? 1, 0, 1e5, 'Spot light intensity');
  numberInRange(light.radius ?? 0.05, 0.001, 1e6, 'Spot light radius');
  numberInRange(light.angle ?? Math.PI / 4, 0.01, SPOT_MAXIMUM_ANGLE, 'Spot light angle');
  numberInRange(light.penumbra ?? 0.15, 0, 1, 'Spot light penumbra');
  validateRange(light, 'Spot light');
  validateCastShadow(light, 'Spot light');
}

function validateAreaLight(light) {
  lightObject(light, 'Area light');
  vectorInRange(light.position, -1e6, 1e6, 'Area light position');
  const direction = normalizedDirection(light.direction, 'Area light direction');
  const up = normalizedDirection(light.up ?? [0, 1, 0], 'Area light up');
  const alignment = Math.abs(direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2]);
  if (alignment > 0.999 && light.up !== undefined) throw new RangeError('Area light up must not be parallel to its direction');
  vectorInRange(light.color ?? [1, 1, 1], 0, 1, 'Area light color');
  numberInRange(light.intensity ?? 1, 0, 1e5, 'Area light intensity');
  numberInRange(light.width, 0.001, 1e4, 'Area light width');
  numberInRange(light.height, 0.001, 1e4, 'Area light height');
}

// Shadow tiles are handed out in order, point lights first. A request beyond the atlas is an error, not a silent drop.
function countShadowTiles(pointLights, spotLights) {
  let tiles = 0;
  for (const light of pointLights) if (light.castShadow) tiles += POINT_SHADOW_TILES;
  for (const light of spotLights) if (light.castShadow) tiles += 1;
  if (tiles > SHADOW_ATLAS_TILES) {
    throw new RangeError(`Shadow casting lights need ${tiles} atlas tiles, and the atlas holds ${SHADOW_ATLAS_TILES} (a point light uses ${POINT_SHADOW_TILES}, a spot light one)`);
  }
  return tiles;
}

export function createLightingState() {
  return {
    positions: new Float32Array(MAX_POINT_LIGHTS * 4),
    colors: new Float32Array(MAX_POINT_LIGHTS * 4),
    radii: new Float32Array(MAX_POINT_LIGHTS),
    pointShadows: new Float32Array(MAX_POINT_LIGHTS),
    spotPositions: new Float32Array(MAX_SPOT_LIGHTS * 4),
    spotColors: new Float32Array(MAX_SPOT_LIGHTS * 4),
    spotDirections: new Float32Array(MAX_SPOT_LIGHTS * 4),
    spotParameters: new Float32Array(MAX_SPOT_LIGHTS * 4),
    areaPositions: new Float32Array(MAX_AREA_LIGHTS * 4),
    areaColors: new Float32Array(MAX_AREA_LIGHTS * 4),
    areaNormals: new Float32Array(MAX_AREA_LIGHTS * 4),
    areaTangents: new Float32Array(MAX_AREA_LIGHTS * 4),
    // The lights that own atlas tiles, so the renderer can build each tile's view.
    shadowCasters: [],
    keyColor: new Float32Array(3),
    pointCount: 0,
    spotCount: 0,
    areaCount: 0,
    fillIntensity: 1,
    ambientIntensity: 1,
    specularAntiAliasing: DEFAULT_SPECULAR_ANTI_ALIASING,
  };
}

function writePointLights(state, pointLights) {
  state.positions.fill(0);
  state.colors.fill(0);
  state.radii.fill(0);
  state.pointShadows.fill(NO_SHADOW_TILE);
  for (let index = 0; index < pointLights.length; index++) {
    const light = pointLights[index];
    state.positions.set(light.position, index * 4);
    state.positions[index * 4 + 3] = light.range ?? 0;
    state.colors.set(light.color ?? [1, 1, 1], index * 4);
    state.colors[index * 4 + 3] = light.intensity ?? 1;
    state.radii[index] = light.radius ?? 0.05;
    if (!light.castShadow) continue;
    state.pointShadows[index] = state.shadowCasters.length;
    for (let face = 0; face < POINT_SHADOW_TILES; face++) state.shadowCasters.push({ light, face });
  }
}

function writeSpotLights(state, spotLights) {
  state.spotPositions.fill(0);
  state.spotColors.fill(0);
  state.spotDirections.fill(0);
  state.spotParameters.fill(0);
  for (let index = 0; index < spotLights.length; index++) {
    const light = spotLights[index];
    const angle = light.angle ?? Math.PI / 4;
    const cosineOuter = Math.cos(angle);
    const cosineInner = cosineOuter + Math.max((1 - cosineOuter) * (light.penumbra ?? 0.15), SPOT_COSINE_GAP);
    state.spotPositions.set(light.position, index * 4);
    state.spotPositions[index * 4 + 3] = light.range ?? 0;
    state.spotColors.set(light.color ?? [1, 1, 1], index * 4);
    state.spotColors[index * 4 + 3] = light.intensity ?? 1;
    state.spotDirections.set(normalizedDirection(light.direction, 'Spot light direction'), index * 4);
    state.spotDirections[index * 4 + 3] = cosineOuter;
    state.spotParameters[index * 4] = light.radius ?? 0.05;
    state.spotParameters[index * 4 + 1] = cosineInner;
    state.spotParameters[index * 4 + 2] = NO_SHADOW_TILE;
    if (!light.castShadow) continue;
    state.spotParameters[index * 4 + 2] = state.shadowCasters.length;
    state.shadowCasters.push({ light, face: SPOT_FACE });
  }
}

function writeAreaLights(state, areaLights) {
  state.areaPositions.fill(0);
  state.areaColors.fill(0);
  state.areaNormals.fill(0);
  state.areaTangents.fill(0);
  for (let index = 0; index < areaLights.length; index++) {
    const light = areaLights[index];
    const normal = normalizedDirection(light.direction, 'Area light direction');
    const up = normalizedDirection(light.up ?? [0, 1, 0], 'Area light up');
    // The rectangle's width axis is up x normal, which keeps width horizontal for an upright light.
    let tangent = [up[1] * normal[2] - up[2] * normal[1], up[2] * normal[0] - up[0] * normal[2], up[0] * normal[1] - up[1] * normal[0]];
    let tangentLength = Math.hypot(...tangent);
    if (tangentLength < 1e-3) {
      tangent = [1, 0, 0];
      tangentLength = 1;
    }
    state.areaPositions.set(light.position, index * 4);
    state.areaColors.set(light.color ?? [1, 1, 1], index * 4);
    state.areaColors[index * 4 + 3] = light.intensity ?? 1;
    state.areaNormals.set(normal, index * 4);
    state.areaNormals[index * 4 + 3] = light.width;
    state.areaTangents.set(tangent.map(component => component / tangentLength), index * 4);
    state.areaTangents[index * 4 + 3] = light.height;
  }
}

// Preflight before publishing so malformed later lights cannot corrupt retained uniforms.
export function updateLightingState(state, environment, { world = false } = {}) {
  const pointLights = lightList(environment, 'pointLights', MAX_POINT_LIGHTS);
  const spotLights = lightList(environment, 'spotLights', MAX_SPOT_LIGHTS);
  const areaLights = lightList(environment, 'areaLights', MAX_AREA_LIGHTS);
  const keyIntensity = numberInRange(environment.keyIntensity ?? 1, 0, 100, 'Key intensity');
  const fillIntensity = numberInRange(environment.fillIntensity ?? 1, 0, 100, 'Fill intensity');
  const ambientIntensity = numberInRange(environment.ambientIntensity ?? 1, 0, 100, 'Ambient intensity');
  const daylight = numberInRange(environment.daylight ?? 1, 0, 100, 'Daylight');
  const specularAntiAliasing = numberInRange(environment.specularAntiAliasing ?? DEFAULT_SPECULAR_ANTI_ALIASING, 0, MAXIMUM_SPECULAR_ANTI_ALIASING, 'Specular anti-aliasing');
  const keyColor = environment.keyColor ?? (world ? [3.7 * daylight, 3.4 * daylight, 2.9 * daylight] : [5.2, 4.7, 4.1]);
  vectorInRange(keyColor, 0, 1000, 'Key color');
  pointLights.forEach(validatePointLight);
  spotLights.forEach(validateSpotLight);
  areaLights.forEach(validateAreaLight);
  countShadowTiles(pointLights, spotLights);
  state.shadowCasters = [];
  writePointLights(state, pointLights);
  writeSpotLights(state, spotLights);
  writeAreaLights(state, areaLights);
  for (let axis = 0; axis < 3; axis++) state.keyColor[axis] = keyColor[axis] * keyIntensity;
  state.pointCount = pointLights.length;
  state.spotCount = spotLights.length;
  state.areaCount = areaLights.length;
  state.fillIntensity = fillIntensity;
  state.ambientIntensity = ambientIntensity;
  state.specularAntiAliasing = specularAntiAliasing;
  return state;
}

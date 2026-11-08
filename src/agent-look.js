import { mat4 } from 'gl-matrix';
import { createLightingState, updateLightingState, MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './lighting.js';
import { resolveEffects } from './effects.js';
import { resolveVolumeFog } from './volumetric.js';
import { LIQUID_OPTICS, resolveLiquidOptics } from './liquid-optics.js';
import { createLightingSetupMap, lightingSetupFields } from './lighting-setups.js';
import { agentSceneModule } from './agent-scene-modules.js';
import { VIEW_TRANSFORM_NAMES, LOOK_NAMES } from './view-transform-names.js';
import { DEFAULT_LIGHTING_SETUP, LIGHTING_SETUP_NAMES, DEFAULT_AMBIENT_OCCLUSION } from './agent-scene-capabilities.js';

// The longest list in a look is the longest light list.
const MAX_LOOK_ARRAY_ENTRIES = Math.max(MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS);

const ENVIRONMENT_FIELDS = [
  'world', 'ground', 'setup', 'environmentIntensity', 'environmentRotation', 'lightDirection', 'keyColor', 'keyIntensity', 'fillIntensity', 'ambientIntensity',
  'daylight', 'pointLights', 'spotLights', 'areaLights', 'skyTop', 'skyBottom', 'fogColor', 'fogDensity', 'volumeFog', 'liquid', 'shadowCascades', 'keyAffects', 'objectReflections', 'floorSkyTrace', 'sunBounce', 'lines', 'resolveCoplanar', 'viewTransform', 'look', 'wind',
];
const EFFECT_FIELDS = ['exposure', 'saturation', 'contrast', 'temperature', 'vignette', 'grain', 'ambientOcclusion', 'ambientOcclusionRadius', 'bloom', 'depthOfField', 'motionBlur'];
const SHADOW_FIELDS = ['target', 'extent', 'distance', 'near', 'far'];
const POINT_LIGHT_FIELDS = ['position', 'color', 'intensity', 'radius', 'range', 'castShadow', 'affects'];
const SPOT_LIGHT_FIELDS = ['position', 'direction', 'angle', 'penumbra', 'color', 'intensity', 'radius', 'range', 'castShadow', 'affects'];
const AREA_LIGHT_FIELDS = ['position', 'direction', 'up', 'width', 'height', 'color', 'intensity', 'affects'];
const VOLUME_VECTOR_FIELDS = ['minimum', 'maximum', 'color', 'ambient', 'drift'];
const VOLUME_NUMBER_FIELDS = ['density', 'steps', 'anisotropy', 'noiseAmount', 'noiseScale', 'maxDistance', 'shadowAmbient', 'heightFalloff', 'detailOctaves', 'detailAmount', 'warp', 'contrast', 'profileSoftness', 'keyScattering'];
const BLOOM_FIELDS = ['strength', 'threshold', 'radius'];
const DEPTH_OF_FIELD_FIELDS = ['blur', 'focusDistance'];
const MOTION_BLUR_FIELDS = ['shutter'];
const MAXIMUM_SHADOW_CASCADES = 4;
const MAXIMUM_AFFECTED_NODES = 1024;

// Only a light that is linked carries the field, so recipes without links keep their exported shape.
function affectsFrom(light, label) {
  if (light.affects === undefined) {
    return {};
  }
  const names = light.affects;
  if (!Array.isArray(names) || names.length > MAXIMUM_AFFECTED_NODES || names.some(name => typeof name !== 'string' || name.length < 1 || name.length > 128)) {
    throw new TypeError(`${label} affects must be a list of at most ${MAXIMUM_AFFECTED_NODES} node IDs.`);
  }
  return { affects: [...names] };
}

function shadowCascadesFrom(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAXIMUM_SHADOW_CASCADES) {
    throw new RangeError(`environment.shadowCascades must be an integer from 1 to ${MAXIMUM_SHADOW_CASCADES}, or 0 for the single shadow map.`);
  }
  return value;
}

/** Whether any light of the environment is limited to a list of nodes. */
export function environmentLinksLights(environment) {
  const lights = [...(environment.pointLights ?? []), ...(environment.spotLights ?? []), ...(environment.areaLights ?? [])];
  return environment.keyAffects !== undefined || lights.some(light => light.affects !== undefined);
}


function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain JSON object.`);
  }
}

function knownKeys(value, fields, label) {
  plainObject(value, label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) {
      throw new TypeError(`Unknown ${label} field: ${String(key)}.`);
    }
  }
}

// Domain resolvers accept ordinary values. Copy descriptors first so accessors never execute.
function copiedJson(input, depth = 0, ancestors = new Set()) {
  if (depth > 32) {
    throw new RangeError('Look JSON nesting exceeds 32 levels.');
  }
  if (input === null || typeof input === 'boolean' || typeof input === 'string') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isFinite(Math.fround(input))) {
      throw new TypeError('Look JSON numbers must be finite Float32 values.');
    }
    return input;
  }
  if (!input || typeof input !== 'object' || ancestors.has(input)) {
    throw new TypeError('Look must contain acyclic plain JSON data.');
  }
  const array = Array.isArray(input);
  if (array && (Object.getPrototypeOf(input) !== Array.prototype || input.length > MAX_LOOK_ARRAY_ENTRIES)) {
    throw new TypeError(`Look JSON arrays must be ordinary arrays with at most ${MAX_LOOK_ARRAY_ENTRIES} entries.`);
  }
  if (!array) {
    plainObject(input, 'Look');
  }
  ancestors.add(input);
  const result = array ? [] : {};
  for (const key of Reflect.ownKeys(input)) {
    if (array && key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || key === '__proto__') {
      throw new TypeError('Look JSON keys must be ordinary strings.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Look JSON accessors and hidden fields are unsupported.');
    }
    if (array && key !== String(result.length)) {
      throw new TypeError('Look JSON arrays must be dense without extra fields.');
    }
    result[key] = copiedJson(descriptor.value, depth + 1, ancestors);
  }
  if (array && result.length !== input.length) {
    throw new TypeError('Look JSON arrays cannot contain trailing holes.');
  }
  ancestors.delete(input);
  return result;
}

function numberInRange(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) ||
      value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a finite Float32 number within ${minimum} and ${maximum}.`);
  }
  return value;
}

function vectorInRange(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${label} needs three JSON numbers.`);
  }
  return value.map(component => numberInRange(component, minimum, maximum, label));
}

function fallback(value, defaultValue) {
  return value === undefined ? defaultValue : value;
}

function directionFrom(value, label = 'lightDirection') {
  const direction = vectorInRange(value, -1e6, 1e6, label);
  const length = Math.hypot(...direction);
  if (length < 1e-6) {
    throw new RangeError(`${label} length must be at least 0.000001.`);
  }
  return { direction, unitDirection: direction.map(component => component / length) };
}

function lightListFrom(value, maximum, name) {
  const lights = fallback(value, []);
  if (!Array.isArray(lights) || lights.length > maximum) {
    throw new RangeError(`${name} must contain at most ${maximum} lights.`);
  }
  return lights;
}

function rangeFrom(light, label) {
  const range = numberInRange(fallback(light.range, 0), 0, 1e6, `${label} range`);
  if (range !== 0 && range < 0.001) {
    throw new RangeError(`${label} range must be zero or at least 0.001.`);
  }
  return range;
}

// Only a light that casts shadows carries the field, so recipes without shadows keep their exported shape.
function shadowFieldFrom(light, label) {
  const castShadow = fallback(light.castShadow, false);
  if (typeof castShadow !== 'boolean') {
    throw new TypeError(`${label} castShadow must be boolean.`);
  }
  return castShadow ? { castShadow } : {};
}

function pointLightFrom(light) {
  knownKeys(light, POINT_LIGHT_FIELDS, 'point light');
  return {
    position: vectorInRange(light.position, -1e6, 1e6, 'point light position'),
    color: vectorInRange(fallback(light.color, [1, 1, 1]), 0, 1, 'point light color'),
    intensity: numberInRange(fallback(light.intensity, 1), 0, 1e5, 'point light intensity'),
    radius: numberInRange(fallback(light.radius, 0.05), 0.001, 1e6, 'point light radius'),
    range: rangeFrom(light, 'point light'),
    ...shadowFieldFrom(light, 'point light'),
    ...affectsFrom(light, 'point light'),
  };
}

function spotLightFrom(light) {
  knownKeys(light, SPOT_LIGHT_FIELDS, 'spot light');
  return {
    position: vectorInRange(light.position, -1e6, 1e6, 'spot light position'),
    direction: directionFrom(light.direction, 'spot light direction').direction,
    angle: numberInRange(fallback(light.angle, Math.PI / 4), 0.01, Math.PI / 2 - 0.01, 'spot light angle'),
    penumbra: numberInRange(fallback(light.penumbra, 0.15), 0, 1, 'spot light penumbra'),
    color: vectorInRange(fallback(light.color, [1, 1, 1]), 0, 1, 'spot light color'),
    intensity: numberInRange(fallback(light.intensity, 1), 0, 1e5, 'spot light intensity'),
    radius: numberInRange(fallback(light.radius, 0.05), 0.001, 1e6, 'spot light radius'),
    range: rangeFrom(light, 'spot light'),
    ...shadowFieldFrom(light, 'spot light'),
    ...affectsFrom(light, 'spot light'),
  };
}

function areaLightFrom(light) {
  knownKeys(light, AREA_LIGHT_FIELDS, 'area light');
  const resolved = {
    position: vectorInRange(light.position, -1e6, 1e6, 'area light position'),
    direction: directionFrom(light.direction, 'area light direction').direction,
    width: numberInRange(light.width, 0.001, 1e4, 'area light width'),
    height: numberInRange(light.height, 0.001, 1e4, 'area light height'),
    color: vectorInRange(fallback(light.color, [1, 1, 1]), 0, 1, 'area light color'),
    intensity: numberInRange(fallback(light.intensity, 1), 0, 1e5, 'area light intensity'),
  };
  if (light.up !== undefined) resolved.up = directionFrom(light.up, 'area light up').direction;
  return { ...resolved, ...affectsFrom(light, 'area light') };
}

function volumeFogFrom(input = {}) {
  knownKeys(input, [...VOLUME_VECTOR_FIELDS, ...VOLUME_NUMBER_FIELDS], 'volumeFog');
  for (const field of VOLUME_VECTOR_FIELDS) {
    if (Object.hasOwn(input, field)) {
      vectorInRange(input[field], -1e5, 1e5, `volumeFog.${field}`);
    }
  }
  for (const field of VOLUME_NUMBER_FIELDS) {
    if (Object.hasOwn(input, field)) {
      numberInRange(input[field], -Number.MAX_VALUE, Number.MAX_VALUE, `volumeFog.${field}`);
    }
  }
  return copiedJson(resolveVolumeFog(input));
}

function environmentFrom(input = {}) {
  knownKeys(input, ENVIRONMENT_FIELDS, 'environment');
  const world = fallback(input.world, false);
  if (typeof world !== 'boolean') {
    throw new TypeError('environment.world must be boolean.');
  }
  const setup = fallback(input.setup, DEFAULT_LIGHTING_SETUP);
  if (!LIGHTING_SETUP_NAMES.includes(setup)) {
    throw new RangeError(`environment.setup must be one of ${LIGHTING_SETUP_NAMES.join(', ')}.`);
  }
  const defaults = lightingSetupFields(setup);
  const environment = {
    world,
    setup,
    environmentIntensity: numberInRange(fallback(input.environmentIntensity, 1), 0, 100, 'environmentIntensity'),
    environmentRotation: numberInRange(fallback(input.environmentRotation, 0), -100, 100, 'environmentRotation'),
    lightDirection: directionFrom(fallback(input.lightDirection, defaults.lightDirection)).direction,
    keyColor: vectorInRange(fallback(input.keyColor, defaults.keyColor), 0, 1000, 'keyColor'),
    keyIntensity: numberInRange(fallback(input.keyIntensity, defaults.keyIntensity), 0, 100, 'keyIntensity'),
    fillIntensity: numberInRange(fallback(input.fillIntensity, defaults.fillIntensity), 0, 100, 'fillIntensity'),
    ambientIntensity: numberInRange(fallback(input.ambientIntensity, defaults.ambientIntensity), 0, 100, 'ambientIntensity'),
    daylight: numberInRange(fallback(input.daylight, 1), 0, 100, 'daylight'),
    pointLights: lightListFrom(input.pointLights, MAX_POINT_LIGHTS, 'pointLights').map(pointLightFrom),
    skyTop: vectorInRange(fallback(input.skyTop, defaults.skyTop), 0, 1, 'skyTop'),
    skyBottom: vectorInRange(fallback(input.skyBottom, defaults.skyBottom), 0, 1, 'skyBottom'),
    fogColor: vectorInRange(fallback(input.fogColor, [0.35, 0.43, 0.43]), 0, 1, 'fogColor'),
    fogDensity: input.fogDensity === undefined || input.fogDensity === null ? null : numberInRange(input.fogDensity, 0, 10, 'fogDensity'),
    volumeFog: volumeFogFrom(input.volumeFog),
  };
  // Optional so recipes without these fields keep their exported shape.
  if (input.ground !== undefined) {
    if (typeof input.ground !== 'boolean') {
      throw new TypeError('environment.ground must be a boolean.');
    }
    environment.ground = input.ground;
  }
  if (input.objectReflections !== undefined) {
    if (typeof input.objectReflections !== 'boolean') {
      throw new TypeError('environment.objectReflections must be a boolean.');
    }
    environment.objectReflections = input.objectReflections;
  }
  // `false` opts out of the floor sky trace that src/floor-sky-visibility.js gives sun-lit closed rooms.
  if (input.floorSkyTrace !== undefined) {
    if (typeof input.floorSkyTrace !== 'boolean') {
      throw new TypeError('environment.floorSkyTrace must be a boolean.');
    }
    environment.floorSkyTrace = input.floorSkyTrace;
  }
  // Scales the light the sunlit patches of a sun-lit closed room bounce on (src/sun-bounce.js); 0 turns it off.
  if (input.sunBounce !== undefined) {
    if (!Number.isFinite(input.sunBounce) || input.sunBounce < 0) {
      throw new TypeError('environment.sunBounce must be a number of 0 or more.');
    }
    environment.sunBounce = input.sunBounce;
  }
  // Outlines and line geometry; null clears them. The module checks the fields and loads on demand.
  if (input.lines !== undefined && input.lines !== null) {
    environment.lines = copiedJson(agentSceneModule('lineArt').resolveLineArt(input.lines));
  }
  if (input.resolveCoplanar !== undefined) {
    if (input.resolveCoplanar !== 'offset' && input.resolveCoplanar !== false) {
      throw new TypeError("environment.resolveCoplanar must be 'offset' or false.");
    }
    environment.resolveCoplanar = input.resolveCoplanar;
  }
  if (input.spotLights !== undefined) {
    environment.spotLights = lightListFrom(input.spotLights, MAX_SPOT_LIGHTS, 'spotLights').map(spotLightFrom);
  }
  if (input.areaLights !== undefined) {
    environment.areaLights = lightListFrom(input.areaLights, MAX_AREA_LIGHTS, 'areaLights').map(areaLightFrom);
  }
  if (input.shadowCascades !== undefined) {
    environment.shadowCascades = shadowCascadesFrom(input.shadowCascades);
  }
  if (input.wind !== undefined && input.wind !== null) environment.wind = agentSceneModule('vegetation').normalizeWind(input.wind);
  if (input.viewTransform !== undefined) {
    if (!VIEW_TRANSFORM_NAMES.includes(input.viewTransform)) {
      throw new RangeError(`environment.viewTransform must be one of ${VIEW_TRANSFORM_NAMES.join(', ')}.`);
    }
    environment.viewTransform = input.viewTransform;
  }
  if (input.look !== undefined && input.look !== null) {
    if (!LOOK_NAMES.includes(input.look)) {
      throw new RangeError(`environment.look must be one of ${LOOK_NAMES.join(', ')}.`);
    }
    environment.look = input.look;
  }
  if (input.keyAffects !== undefined) {
    environment.keyAffects = affectsFrom({ affects: input.keyAffects }, 'environment keyAffects').affects;
  }
  if (input.liquid !== undefined) {
    knownKeys(input.liquid, Object.keys(LIQUID_OPTICS), 'liquid');
    environment.liquid = copiedJson(resolveLiquidOptics(copiedJson(input.liquid)));
  }
  updateLightingState(createLightingState(), environment, { world });
  return environment;
}

/**
 * Setup-derived fields come with the setup name, so switching setups never keeps the old key light.
 * Fields in the patch itself still win.
 */
export function environmentPatchWithSetup(patch) {
  if (patch.setup === undefined) {
    return patch;
  }
  return { ...lightingSetupFields(patch.setup), ...patch };
}

/** The procedural environment map that lights a normalized environment; the same object returns while inputs hold. */
export function agentEnvironmentMap(environment) {
  return createLightingSetupMap(environment.setup, {
    intensity: environment.environmentIntensity,
    rotation: environment.environmentRotation,
    showBackground: environment.world,
  });
}

function effectsFrom(input = {}) {
  knownKeys(input, EFFECT_FIELDS, 'effects');
  const groupFields = { bloom: BLOOM_FIELDS, depthOfField: DEPTH_OF_FIELD_FIELDS, motionBlur: MOTION_BLUR_FIELDS };
  for (const field of EFFECT_FIELDS) {
    if (!(field in groupFields) && Object.hasOwn(input, field)) {
      numberInRange(input[field], -Number.MAX_VALUE, Number.MAX_VALUE, `effects.${field}`);
    }
  }
  const groups = {};
  for (const [group, fields] of Object.entries(groupFields)) {
    groups[group] = fallback(input[group], {});
    knownKeys(groups[group], fields, group);
    for (const field of fields) {
      if (Object.hasOwn(groups[group], field)) {
        numberInRange(groups[group][field], -Number.MAX_VALUE, Number.MAX_VALUE, `${group}.${field}`);
      }
    }
  }
  const ambientOcclusion = fallback(input.ambientOcclusion, DEFAULT_AMBIENT_OCCLUSION);
  const resolved = resolveEffects({ ...input, ambientOcclusion, ...groups, bloom: { strength: 0.12, threshold: 1, radius: 1, ...groups.bloom } });
  return { ...resolved, exposure: numberInRange(fallback(input.exposure, 1), 0.01, 16, 'exposure') };
}

function shadowFrom(input = {}) {
  knownKeys(input, SHADOW_FIELDS, 'shadow');
  const shadow = {
    target: vectorInRange(fallback(input.target, [0, 1, 0]), -1e6, 1e6, 'shadow target'),
    extent: numberInRange(fallback(input.extent, 3.5), 0.01, 1e5, 'shadow extent'),
    distance: numberInRange(fallback(input.distance, 8), 0.01, 1e6, 'shadow distance'),
    near: numberInRange(fallback(input.near, 0.1), 0.001, 1e6, 'shadow near'),
    far: numberInRange(fallback(input.far, 15), 0.001, 1e6, 'shadow far'),
  };
  if (Math.fround(shadow.near) >= Math.fround(shadow.far)) {
    throw new RangeError('Shadow needs near < far at Float32 precision.');
  }
  return shadow;
}

function shadowBoundsFrom(shadow, direction) {
  const { unitDirection } = directionFrom(direction);
  const eye = shadow.target.map((component, axis) => component + unitDirection[axis] * shadow.distance);
  if (!eye.every(component => Number.isFinite(Math.fround(component))) ||
      eye.every((component, axis) => Math.fround(component) === Math.fround(shadow.target[axis]))) {
    throw new RangeError('Shadow eye and target must remain finite and distinguishable at Float32 precision.');
  }
  const up = Math.abs(unitDirection[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const view = mat4.lookAt(mat4.create(), eye, shadow.target, up);
  const projection = mat4.ortho(mat4.create(), -shadow.extent, shadow.extent, -shadow.extent, shadow.extent, shadow.near, shadow.far);
  const combined = mat4.multiply(mat4.create(), projection, view);
  for (const matrix of [view, projection, combined]) {
    const determinant = mat4.determinant(matrix);
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0) {
      throw new RangeError('Shadow view, projection, and combined matrices must remain finite and nonsingular at Float32 precision.');
    }
  }
  return { eye, target: [...shadow.target], up, extent: shadow.extent, near: shadow.near, far: shadow.far };
}

/** Derive a detached directional shadow projector from validated ordinary JSON. */
export function resolveAgentShadow(inputShadow = {}, inputDirection = [-3, 6, 4]) {
  const shadow = shadowFrom(copiedJson(inputShadow));
  const direction = copiedJson(inputDirection);
  return shadowBoundsFrom(shadow, direction);
}

/** Normalize the complete look without mutating caller input or sharing default arrays. */
export function normalizeAgentLook(input = {}) {
  knownKeys(input, ['environment', 'effects', 'shadow'], 'look');
  const copied = copiedJson(input);
  const environment = environmentFrom(copied.environment);
  const effects = effectsFrom(copied.effects);
  const shadow = shadowFrom(copied.shadow);
  shadowBoundsFrom(shadow, environment.lightDirection);
  return { environment, effects, shadow };
}

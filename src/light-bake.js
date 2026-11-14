import { invalidField } from './field-error.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';
import { buildTriangleBvh } from './triangle-bvh.js';
import { readTriangle } from './triangle-math.js';
import { createTracer, pointLightFalloff } from './ray-query.js';
import { extractRender } from './mesh-render.js';
import { meshFromGeometry } from './mesh-convert.js';
import { unwrapUv } from './mesh-uv.js';
import { createImage, linearToSrgbByte } from './material-texture-kit.js';

// Light bake: the light that bounces between surfaces, written into one lightmap texture per part. A part draws it
// through its emissive map, so the renderer, its shaders and every scene without a bake stay exactly as they were.
// The bake gathers light that reaches each texel after reflecting off other surfaces (point lights and the sun, shadowed
// by ray tracing). Direct light stays live, so shadows and moving lights keep working. Same input, same bytes.

export const BAKE_LIMITS = Object.freeze({
  maxResolution: { minimum: 4, maximum: 256, fallback: 128 },
  texelsPerUnit: { minimum: 0.5, maximum: 64, fallback: 6 },
  samples: { minimum: 1, maximum: 512, fallback: 128 },
  bounces: { minimum: 1, maximum: 8, fallback: 3 },
  maxSeconds: { minimum: 1, maximum: 600, fallback: 60 },
});
// Total ray work (texels x samples x bounces x rays per hit) a bake may ask for, checked before any ray is traced.
export const MAX_BAKE_RAY_WORK = 400_000_000;
export const MAX_BAKE_TEXELS = 1_000_000;
export const MAX_BAKE_TRIANGLES = 200_000;
export const MAX_BAKE_PARTS = 256;
// The GPU tracer takes as many parts as the path tracer does (MAX_TRACE_PARTS); the CPU bake keeps 256.
export const MAX_GPU_BAKE_PARTS = 1024;
const BAKE_BACKENDS = ['cpu', 'gpu', 'webgpu', 'native'];
export const MAX_BAKE_POINT_LIGHTS = MAX_POINT_LIGHTS;
export const MAX_BAKE_SPOT_LIGHTS = MAX_SPOT_LIGHTS;
export const MAX_BAKE_AREA_LIGHTS = MAX_AREA_LIGHTS;
// A part that sees at least this share of the sky keeps its live sky light as it is.
const SKY_VISIBLE_ENOUGH = 0.98;
// The renderer's own soft edge for a spot light that gives none.
const DEFAULT_SPOT_PENUMBRA = 0.15;

const MAP_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const SURFACE_UTILIZATION_FLOOR = 0.05;
const MINIMUM_AXIS_SCALE = 1e-6;
// Smoothing of the gathered light over texels of one surface: two passes of a gaussian of sigma 1.5 texels over a 7 x 7 window.
const SMOOTH_PASSES = 2;
const SMOOTH_RADIUS_TEXELS = 3;
const SMOOTH_SIGMA_TEXELS = 1.5;
const SMOOTH_MINIMUM_FACING = 0.9;
const SMOOTH_PLANE_TEXELS = 1;
const DILATION_PASSES = 2;
// How far outside a chart (in texels, centre to edge) a texel still takes the chart's own surface instead of a neighbour's light.
const GUTTER_TEXELS = 0.75;
const AVERAGE_GRID = 16;
const LIGHT_MAP_CLAMP_TO_EDGE = 33071;
const LIGHT_MAP_LINEAR = 9729;

function boundedNumber(options, name) {
  const limit = BAKE_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (!Number.isFinite(value) || value < limit.minimum || value > limit.maximum) {
    throw invalidField(`bake.${name}`, value, `a number from ${limit.minimum} to ${limit.maximum}, such as ${limit.fallback}`);
  }
  return name === 'samples' || name === 'bounces' || name === 'maxResolution' ? Math.floor(value) : value;
}

/** Validates the bake options and fills in defaults. Throws a RangeError that names the field and its bounds. */
export function normalizeBakeOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Light bake options must be an object.');
  const normalized = {};
  for (const name of Object.keys(BAKE_LIMITS)) normalized[name] = boundedNumber(options, name);
  normalized.backend = options.backend ?? 'cpu';
  if (!BAKE_BACKENDS.includes(normalized.backend)) throw invalidField('bake.backend', normalized.backend, 'one of "cpu", "gpu", "webgpu" or "native"', TypeError);
  return normalized;
}

function finiteVector(value, length) {
  return (Array.isArray(value) || ArrayBuffer.isView(value)) && value.length === length && Array.from(value).every(Number.isFinite);
}

function normalizedDirection(direction, label) {
  if (!finiteVector(direction, 3) || Math.hypot(...direction) === 0) throw new RangeError(`${label} needs a finite, nonzero direction.`);
  const length = Math.hypot(...direction);
  return Array.from(direction, component => component / length);
}

function checkedLightList(lights, maximum, name) {
  if (!Array.isArray(lights) || lights.length > maximum) throw new RangeError(`Light bake takes at most ${maximum} ${name}.`);
}

function checkedLightBasics(light, label) {
  if (!finiteVector(light.position, 3) || !finiteVector(light.color ?? [1, 1, 1], 3) || !Number.isFinite(light.intensity) || light.intensity < 0) {
    throw new RangeError(`${label} needs a position, a color and a nonnegative intensity.`);
  }
}

/** Spot lights in the form the path tracer uses: a unit axis, the cosine of the outer half angle and the soft edge width. */
function normalizeSpotLights(spotLights) {
  checkedLightList(spotLights, MAX_BAKE_SPOT_LIGHTS, 'spot lights');
  return spotLights.map((light, index) => {
    const label = `Light bake spot light ${index}`;
    checkedLightBasics(light, label);
    const angle = light.angle ?? Math.PI / 4;
    const penumbra = light.penumbra ?? DEFAULT_SPOT_PENUMBRA;
    const range = light.range ?? 0;
    const radius = light.radius ?? 0.05;
    if (![angle, penumbra, range, radius].every(Number.isFinite) || angle <= 0 || angle >= Math.PI || penumbra < 0 || range < 0 || radius < 0) {
      throw new RangeError(`${label} has an invalid angle, penumbra, range or radius.`);
    }
    const cosineHalfAngle = Math.cos(angle);
    return {
      position: Array.from(light.position), color: Array.from(light.color ?? [1, 1, 1]), intensity: light.intensity, range, radius,
      direction: normalizedDirection(light.direction, label), cosineHalfAngle, blend: (1 - cosineHalfAngle) * penumbra,
    };
  });
}

/** Rectangular area lights: a unit normal and the two unit axes that span the rectangle (width along `across`). */
function normalizeAreaLights(areaLights) {
  checkedLightList(areaLights, MAX_BAKE_AREA_LIGHTS, 'area lights');
  return areaLights.map((light, index) => {
    const label = `Light bake area light ${index}`;
    checkedLightBasics(light, label);
    if (!(light.width >= 0) || !(light.height >= 0) || !Number.isFinite(light.width) || !Number.isFinite(light.height)) {
      throw new RangeError(`${label} needs a finite width and height.`);
    }
    const normal = normalizedDirection(light.direction, label);
    const guide = normalizedDirection(light.up ?? [0, 1, 0], label);
    let across = [guide[1] * normal[2] - guide[2] * normal[1], guide[2] * normal[0] - guide[0] * normal[2], guide[0] * normal[1] - guide[1] * normal[0]];
    const acrossLength = Math.hypot(...across);
    across = acrossLength < 1e-3 ? [1, 0, 0] : across.map(component => component / acrossLength);
    const along = [normal[1] * across[2] - normal[2] * across[1], normal[2] * across[0] - normal[0] * across[2], normal[0] * across[1] - normal[1] * across[0]];
    return { position: Array.from(light.position), color: Array.from(light.color ?? [1, 1, 1]), intensity: light.intensity, width: light.width, height: light.height, normal, across, along };
  });
}

function withAffects(normalizedLights, sourceLights) {
  return normalizedLights.map((light, index) => ({ ...light, affects: sourceLights[index].affects ?? null }));
}

/**
 * Each light gets `reach`, one byte per part: 1 when the light lights that part, or null when it lights every part.
 * A light limited by `affects` adds nothing at a surface of a part it skips, as in the renderer, so a part that a
 * light does not reach is not lit by it even as the bounce of another part.
 */
export function withReach(lights, parts) {
  const reachOf = (light) => {
    if (light.affects === null) return null;
    const names = new Set(light.affects);
    return Uint8Array.from(parts, part => (names.has(part.name) ? 1 : 0));
  };
  const linked = light => ({ ...light, reach: reachOf(light) });
  return { pointLights: lights.pointLights.map(linked), spotLights: lights.spotLights.map(linked), areaLights: lights.areaLights.map(linked), sun: lights.sun && linked(lights.sun) };
}

function lightReaches(light, owner) {
  return light.reach === null || light.reach[owner] === 1;
}

export function normalizeLights(lighting) {
  if (lighting === null || typeof lighting !== 'object') throw new TypeError('Light bake needs a lighting object.');
  const pointLights = lighting.pointLights ?? [];
  if (!Array.isArray(pointLights) || pointLights.length > MAX_BAKE_POINT_LIGHTS) throw new RangeError(`Light bake takes at most ${MAX_BAKE_POINT_LIGHTS} point lights.`);
  const normalizedPoints = pointLights.map((light, index) => {
    const range = light.range ?? 0;
    const radius = light.radius ?? 0.05;
    if (!finiteVector(light.position, 3) || !finiteVector(light.color ?? [1, 1, 1], 3) || !Number.isFinite(light.intensity) || light.intensity < 0) {
      throw new RangeError(`Light bake point light ${index} needs a position, a color and a nonnegative intensity.`);
    }
    if (!Number.isFinite(range) || range < 0 || !Number.isFinite(radius) || radius < 0) throw new RangeError(`Light bake point light ${index} has an invalid range or radius.`);
    return { position: Array.from(light.position), color: Array.from(light.color ?? [1, 1, 1]), intensity: light.intensity, range, radius };
  });
  const spotSources = lighting.spotLights ?? [];
  const areaSources = lighting.areaLights ?? [];
  const spotLights = withAffects(normalizeSpotLights(spotSources), spotSources);
  const areaLights = withAffects(normalizeAreaLights(areaSources), areaSources);
  const keyColor = lighting.keyColor ?? [0, 0, 0];
  const lightDirection = lighting.lightDirection ?? [0, 1, 0];
  if (!finiteVector(keyColor, 3) || keyColor.some(channel => channel < 0) || !finiteVector(lightDirection, 3)) throw new RangeError('Light bake keyColor and lightDirection must be finite vectors.');
  const directionLength = Math.hypot(...lightDirection);
  const hasSun = keyColor.some(channel => channel > 0) && directionLength > 0;
  const sunDirection = hasSun ? lightDirection.map(component => component / directionLength) : [0, 1, 0];
  return { pointLights: withAffects(normalizedPoints, pointLights), spotLights, areaLights, sun: hasSun ? { color: Array.from(keyColor), direction: sunDirection, affects: lighting.keyAffects ?? null } : null };
}

export function validatePart(part, index) {
  const { geometry, matrix } = part ?? {};
  const label = `Light bake part ${index}`;
  if (!geometry || !(geometry.positions instanceof Float32Array) || geometry.positions.length === 0 || geometry.positions.length % 3 !== 0) throw new TypeError(`${label} needs Float32 positions.`);
  if (!(geometry.indices instanceof Uint32Array) || geometry.indices.length === 0 || geometry.indices.length % 3 !== 0) throw new TypeError(`${label} needs Uint32 triangle indices.`);
  if (!finiteVector(matrix, 16)) throw new RangeError(`${label} needs a finite 4x4 matrix.`);
  const vertexCount = geometry.positions.length / 3;
  for (let position = 0; position < geometry.positions.length; position++) {
    if (!Number.isFinite(geometry.positions[position])) throw new RangeError(`${label} has a non-finite position.`);
  }
  for (let slot = 0; slot < geometry.indices.length; slot++) {
    if (geometry.indices[slot] >= vertexCount) throw new RangeError(`${label} has an index past its last vertex.`);
  }
  const color = part.material?.color;
  if (!finiteVector(color, 3)) throw new RangeError(`${label} needs a material color.`);
}

function skipReason(part) {
  const material = part.material;
  if (part.generatesGeometry) {
    const generator = typeof part.generatesGeometry === 'string' ? part.generatesGeometry : 'a hair or particle system';
    return `${generator} rebuilds its geometry every frame, so it has no fixed surface to bake`;
  }
  if (part.skin || part.morph || part.geometry.skinIndices || part.geometry.morphTargets) return 'skinned or morphing parts move, so a fixed lightmap would not follow';
  if ((material.tag ?? 'surface') !== 'surface') return `the ${material.tag} material draws its own look`;
  if (material.opacity !== undefined && material.opacity < 1 || material.alphaMode && material.alphaMode !== 'opaque') return 'it is transparent';
  const layerMapsOnSecondSet = Object.entries(material.layerMaps ?? {}).filter(([, map]) => map?.uvChannel === 1).map(([field]) => field);
  const mapsOnSecondSet = [...MAP_FIELDS.filter(field => material[field]?.uvChannel === 1), ...layerMapsOnSecondSet];
  if (mapsOnSecondSet.length) {
    return `material ${material.name ?? 'without a name'} reads ${mapsOnSecondSet.join(', ')} from the second UV set (TEXCOORD_1), which the bake would replace with the lightmap atlas`;
  }
  return null;
}

/**
 * A plain part shows the light through its emissive map on UV channel 0. A part with texture maps, a pattern, layers or
 * its own emission keeps channel 0 and its look, and receives the light through the lightMap slot on a second UV set.
 */
function usesLightMapSlot(material) {
  return MAP_FIELDS.some(field => material[field]) || Boolean(material.pattern || material.layers) || (material.emission ?? 0) > 0;
}

function srgbToLinear(byte) {
  const unit = byte / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** Mean linear colour of a base color map on a fixed grid of samples, or white when the image bytes are not readable. */
export function averageMapColor(map) {
  const image = map?.image;
  if (!image?.data || !(image.width > 0) || !(image.height > 0)) return [1, 1, 1];
  const sum = [0, 0, 0];
  for (let row = 0; row < AVERAGE_GRID; row++) {
    for (let column = 0; column < AVERAGE_GRID; column++) {
      const x = Math.floor((column + 0.5) / AVERAGE_GRID * image.width);
      const y = Math.floor((row + 0.5) / AVERAGE_GRID * image.height);
      for (let channel = 0; channel < 3; channel++) sum[channel] += srgbToLinear(image.data[(y * image.width + x) * 4 + channel]);
    }
  }
  return sum.map(total => total / (AVERAGE_GRID * AVERAGE_GRID));
}

export function diffuseAlbedo(material) {
  const keep = 1 - (material.metallic ?? 0);
  const mapAverage = averageMapColor(material.map);
  return material.color.map((channel, index) => Math.max(channel, 0) * keep * mapAverage[index]);
}

export function emittedRadiance(material) {
  const strength = material.emission ?? 0;
  if (strength <= 0) return [0, 0, 0];
  return (material.emissiveColor ?? material.color).map(channel => channel * strength);
}

/** All parts in world space as one triangle soup: positions, indices, and the part each triangle belongs to. */
export function buildWorld(parts) {
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const part of parts) {
    vertexTotal += part.geometry.positions.length / 3;
    indexTotal += part.geometry.indices.length;
  }
  if (indexTotal / 3 > MAX_BAKE_TRIANGLES) throw new RangeError(`Light bake takes at most ${MAX_BAKE_TRIANGLES} triangles in total.`);
  const positions = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const triangleOwner = new Uint32Array(indexTotal / 3);
  let vertexOffset = 0;
  let triangleOffset = 0;
  parts.forEach((part, partIndex) => {
    const { matrix } = part;
    const source = part.geometry.positions;
    for (let vertex = 0; vertex < source.length / 3; vertex++) {
      const x = source[vertex * 3];
      const y = source[vertex * 3 + 1];
      const z = source[vertex * 3 + 2];
      const target = (vertexOffset + vertex) * 3;
      positions[target] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      positions[target + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      positions[target + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    for (let slot = 0; slot < part.geometry.indices.length; slot++) indices[triangleOffset * 3 + slot] = part.geometry.indices[slot] + vertexOffset;
    triangleOwner.fill(partIndex, triangleOffset, triangleOffset + part.geometry.indices.length / 3);
    vertexOffset += source.length / 3;
    triangleOffset += part.geometry.indices.length / 3;
  });
  return { positions, indices, triangleOwner, bvh: buildTriangleBvh(positions, indices) };
}

export function sceneScale(positions) {
  let largest = 0;
  for (let index = 0; index < positions.length; index++) largest = Math.max(largest, Math.abs(positions[index]));
  return Math.max(largest, 1e-3);
}

/** Integer hash to [0, 1): the only source of randomness, so a bake repeats exactly. */
export function hashUnit(first, second, third) {
  let value = Math.imul(first ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(second + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(third + 0x165667b1, 0x27d4eb2f);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39);
  value ^= value >>> 15;
  return (value >>> 0) / 4294967296;
}

export function radicalInverse(index) {
  let bits = index;
  let result = 0;
  let scale = 0.5;
  while (bits > 0) {
    if (bits & 1) result += scale;
    bits >>>= 1;
    scale *= 0.5;
  }
  return result;
}

/** A cosine-weighted direction about `normal`, written into `out`. */
export function cosineDirection(normal, firstUnit, secondUnit, out) {
  const radius = Math.sqrt(firstUnit);
  const angle = 2 * Math.PI * secondUnit;
  const localX = radius * Math.cos(angle);
  const localY = radius * Math.sin(angle);
  const localZ = Math.sqrt(Math.max(0, 1 - firstUnit));
  const helper = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let tangentX = normal[1] * helper[2] - normal[2] * helper[1];
  let tangentY = normal[2] * helper[0] - normal[0] * helper[2];
  let tangentZ = normal[0] * helper[1] - normal[1] * helper[0];
  const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
  tangentX /= tangentLength;
  tangentY /= tangentLength;
  tangentZ /= tangentLength;
  const bitangentX = normal[1] * tangentZ - normal[2] * tangentY;
  const bitangentY = normal[2] * tangentX - normal[0] * tangentZ;
  const bitangentZ = normal[0] * tangentY - normal[1] * tangentX;
  out[0] = tangentX * localX + bitangentX * localY + normal[0] * localZ;
  out[1] = tangentY * localX + bitangentY * localY + normal[1] * localZ;
  out[2] = tangentZ * localX + bitangentZ * localY + normal[2] * localZ;
}

/**
 * Builds the function that returns the irradiance (light power per area, before the albedo and 1/pi of a diffuse
 * surface) of the direct lights at a point, with shadow rays against the world.
 */
export function createDirectIrradiance(tracer, lights, offset, scale, sunReaching = null) {
  const result = [0, 0, 0];
  const shadowReach = scale * 1e6;
  function addLight(point, normal, toLight, distance, power) {
    const cosine = normal[0] * toLight[0] + normal[1] * toLight[1] + normal[2] * toLight[2];
    if (cosine <= 0) return;
    const blocked = tracer.trace(
      point[0] + normal[0] * offset, point[1] + normal[1] * offset, point[2] + normal[2] * offset,
      toLight[0], toLight[1], toLight[2], distance, true,
    ).nearestTriangle >= 0;
    if (blocked) return;
    for (let channel = 0; channel < 3; channel++) result[channel] += power[channel] * cosine;
  }
  const toLight = [0, 0, 0];
  const power = [0, 0, 0];
  const sunPower = [0, 0, 0];
  // Aims `toLight` at a light's position and returns the distance, or 0 when the point sits on the light.
  function aimAtPosition(point, lightX, lightY, lightZ) {
    const deltaX = lightX - point[0];
    const deltaY = lightY - point[1];
    const deltaZ = lightZ - point[2];
    const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    if (distanceSquared < 1e-12) return { distance: 0, distanceSquared };
    const distance = Math.sqrt(distanceSquared);
    toLight[0] = deltaX / distance;
    toLight[1] = deltaY / distance;
    toLight[2] = deltaZ / distance;
    return { distance, distanceSquared };
  }
  function addSpotLight(point, normal, light) {
    const { distance, distanceSquared } = aimAtPosition(point, light.position[0], light.position[1], light.position[2]);
    if (distance === 0) return;
    const axisCosine = -(light.direction[0] * toLight[0] + light.direction[1] * toLight[1] + light.direction[2] * toLight[2]);
    const inside = axisCosine - light.cosineHalfAngle;
    if (inside <= 0) return;
    const edge = light.blend > 0 && inside < light.blend ? inside / light.blend : 1;
    const mask = edge * edge * (3 - 2 * edge);
    const strength = light.intensity * pointLightFalloff(distanceSquared, light) * mask;
    for (let channel = 0; channel < 3; channel++) power[channel] = light.color[channel] * strength;
    addLight(point, normal, toLight, distance - offset, power);
  }
  // One shadow ray to a point of the rectangle that changes with every call. The sequence depends only on the order of
  // the calls, so a bake repeats exactly and the many paths of a texel average the soft shadow.
  let areaSampleCount = 0;
  function addAreaLight(point, normal, light, lightIndex) {
    areaSampleCount++;
    const across = (hashUnit(areaSampleCount, 17, lightIndex) - 0.5) * light.width;
    const along = (hashUnit(areaSampleCount, 19, lightIndex) - 0.5) * light.height;
    const { distance, distanceSquared } = aimAtPosition(
      point,
      light.position[0] + light.across[0] * across + light.along[0] * along,
      light.position[1] + light.across[1] * across + light.along[1] * along,
      light.position[2] + light.across[2] * across + light.along[2] * along,
    );
    if (distance === 0) return;
    const emitCosine = -(light.normal[0] * toLight[0] + light.normal[1] * toLight[1] + light.normal[2] * toLight[2]);
    if (emitCosine <= 0) return;
    const strength = light.intensity * emitCosine / distanceSquared;
    for (let channel = 0; channel < 3; channel++) power[channel] = light.color[channel] * strength;
    addLight(point, normal, toLight, distance - offset, power);
  }
  return function directIrradiance(point, normal, owner) {
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    for (const light of lights.pointLights) {
      if (!lightReaches(light, owner)) continue;
      const deltaX = light.position[0] - point[0];
      const deltaY = light.position[1] - point[1];
      const deltaZ = light.position[2] - point[2];
      const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
      if (distanceSquared < 1e-12) continue;
      const distance = Math.sqrt(distanceSquared);
      toLight[0] = deltaX / distance;
      toLight[1] = deltaY / distance;
      toLight[2] = deltaZ / distance;
      const strength = light.intensity * pointLightFalloff(distanceSquared, light);
      for (let channel = 0; channel < 3; channel++) power[channel] = light.color[channel] * strength;
      addLight(point, normal, toLight, distance - offset, power);
    }
    for (const light of lights.spotLights) {
      if (lightReaches(light, owner)) addSpotLight(point, normal, light);
    }
    for (let index = 0; index < lights.areaLights.length; index++) {
      if (lightReaches(lights.areaLights[index], owner)) addAreaLight(point, normal, lights.areaLights[index], index);
    }
    if (lights.sun && lightReaches(lights.sun, owner)) {
      if (!sunReaching) {
        addLight(point, normal, lights.sun.direction, shadowReach, lights.sun.color);
      } else {
        // The fog dims the sun on its way to the surface.
        const reaching = sunReaching(point);
        for (let channel = 0; channel < 3; channel++) sunPower[channel] = lights.sun.color[channel] * reaching;
        addLight(point, normal, lights.sun.direction, shadowReach, sunPower);
      }
    }
    return result;
  };
}

export function hitNormal(world, triangleId, direction, out) {
  readTriangle(world.positions, world.indices, triangleId, SCRATCH_TRIANGLE);
  const firstX = SCRATCH_TRIANGLE[3] - SCRATCH_TRIANGLE[0];
  const firstY = SCRATCH_TRIANGLE[4] - SCRATCH_TRIANGLE[1];
  const firstZ = SCRATCH_TRIANGLE[5] - SCRATCH_TRIANGLE[2];
  const secondX = SCRATCH_TRIANGLE[6] - SCRATCH_TRIANGLE[0];
  const secondY = SCRATCH_TRIANGLE[7] - SCRATCH_TRIANGLE[1];
  const secondZ = SCRATCH_TRIANGLE[8] - SCRATCH_TRIANGLE[2];
  let normalX = firstY * secondZ - firstZ * secondY;
  let normalY = firstZ * secondX - firstX * secondZ;
  let normalZ = firstX * secondY - firstY * secondX;
  const length = Math.hypot(normalX, normalY, normalZ) || 1;
  normalX /= length;
  normalY /= length;
  normalZ /= length;
  const facing = normalX * direction[0] + normalY * direction[1] + normalZ * direction[2] > 0 ? -1 : 1;
  out[0] = normalX * facing;
  out[1] = normalY * facing;
  out[2] = normalZ * facing;
}
const SCRATCH_TRIANGLE = new Float64Array(9);

/**
 * The mean radiance arriving at one texel from other surfaces: cosine-weighted paths of up to `bounces` reflections,
 * each hit adding its own emission and its direct light. The caller multiplies by the texel's albedo.
 */
export function createGatherer({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance, offset, samples, bounces, medium = null, fogScatterLimit = 8 }) {
  const scatterSum = [0, 0, 0];
  const singleScatterSum = [0, 0, 0];
  const direction = [0, 0, 0];
  const origin = [0, 0, 0];
  const normal = [0, 0, 0];
  const hitPoint = [0, 0, 0];
  const throughput = [1, 1, 1];
  return function gather(point, surfaceNormal, texelIndex, sum, fogLight = null) {
    sum[0] = 0;
    sum[1] = 0;
    sum[2] = 0;
    scatterSum.fill(0);
    singleScatterSum.fill(0);
    const rotation = hashUnit(texelIndex, 1, 7);
    // Rays that leave the scene on their first leg see the sky, so the share of them is how much sky this point sees.
    let escaped = 0;
    for (let sample = 0; sample < samples; sample++) {
      const firstUnit = (sample + 0.5) / samples;
      const secondUnit = (radicalInverse(sample) + rotation) % 1;
      cosineDirection(surfaceNormal, firstUnit, secondUnit, direction);
      origin[0] = point[0] + surfaceNormal[0] * offset;
      origin[1] = point[1] + surfaceNormal[1] * offset;
      origin[2] = point[2] + surfaceNormal[2] * offset;
      throughput[0] = 1;
      throughput[1] = 1;
      throughput[2] = 1;
      let bounce = 0;
      let leg = 0;
      let fogScatters = 0;
      while (bounce < bounces) {
        const hit = tracer.trace(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], Infinity, false);
        // The tracer reuses its hit record, and the fog traces rays of its own, so the hit is read first.
        const hitTriangle = hit.nearestTriangle;
        const hitDistance = hit.nearestDistance;
        // The fog may scatter the path inside this leg: the path then goes on from the scattering point.
        if (medium && medium(origin, direction, hitTriangle < 0 ? Infinity : hitDistance, throughput, scatterSum, texelIndex, sample, leg++, singleScatterSum)) {
          if (++fogScatters >= fogScatterLimit) break;
          continue;
        }
        if (hitTriangle < 0) {
          if (bounce === 0) escaped++;
          // A path the fog scattered brings the sky's light with it: the sky lights the fog through the openings.
          if (fogScatters > 0) medium.addSky(throughput, scatterSum);
          break;
        }
        for (let axis = 0; axis < 3; axis++) hitPoint[axis] = origin[axis] + direction[axis] * hitDistance;
        hitNormal(world, hitTriangle, direction, normal);
        const owner = world.triangleOwner[hitTriangle];
        const albedo = albedoOfPart[owner];
        const emission = emissionOfPart[owner];
        const irradiance = directIrradiance(hitPoint, normal, owner);
        for (let channel = 0; channel < 3; channel++) {
          sum[channel] += throughput[channel] * (emission[channel] + albedo[channel] * irradiance[channel] / Math.PI);
          throughput[channel] *= albedo[channel];
        }
        if (throughput[0] + throughput[1] + throughput[2] < 1e-4) break;
        origin[0] = hitPoint[0] + normal[0] * offset;
        origin[1] = hitPoint[1] + normal[1] * offset;
        origin[2] = hitPoint[2] + normal[2] * offset;
        cosineDirection(normal, hashUnit(texelIndex, sample, bounce * 2 + 11), hashUnit(texelIndex, sample, bounce * 2 + 12), direction);
        bounce++;
      }
    }
    // `sum` holds the fog's light too; `fogLight`, when given, gets the single scattered sun alone, the part the fog on screen adds itself.
    for (let channel = 0; channel < 3; channel++) {
      scatterSum[channel] /= samples;
      sum[channel] = sum[channel] / samples + scatterSum[channel];
      if (fogLight) fogLight[channel] = singleScatterSum[channel] / samples;
    }
    return escaped / samples;
  };
}

function worldTriangleArea(part) {
  const { positions, indices } = part.geometry;
  const { matrix } = part;
  const world = new Float64Array(9);
  let area = 0;
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const source = indices[triangle * 3 + corner] * 3;
      const x = positions[source];
      const y = positions[source + 1];
      const z = positions[source + 2];
      world[corner * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      world[corner * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      world[corner * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    const firstX = world[3] - world[0];
    const firstY = world[4] - world[1];
    const firstZ = world[5] - world[2];
    const secondX = world[6] - world[0];
    const secondY = world[7] - world[1];
    const secondZ = world[8] - world[2];
    area += Math.hypot(firstY * secondZ - firstZ * secondY, firstZ * secondX - firstX * secondZ, firstX * secondY - firstY * secondX) / 2;
  }
  return area;
}

/** The length of each matrix column: how far the part stretches a unit step along its own x, y and z. */
export function partAxisScale(matrix) {
  const lengths = [0, 1, 2].map(column => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]));
  return lengths.map(length => Math.max(length, MINIMUM_AXIS_SCALE));
}

function scaleKey(scale) {
  return scale.map(length => length.toPrecision(6)).join(',');
}

/**
 * The geometry as it is sized in the world, so the unwrap gives every metre the same share of the lightmap. A shared unit
 * box scaled to 2 x 32 x 180 m would otherwise get one square per face and texels 90 times longer than wide, which draws
 * as streaks along the long axis. Normals follow the inverse transpose of the scale.
 */
function scaledForUnwrap(geometry, scale) {
  const positions = Float32Array.from(geometry.positions, (value, index) => value * scale[index % 3]);
  const normals = Float32Array.from(geometry.normals, (value, index) => value / scale[index % 3]);
  return { ...geometry, positions, normals };
}

/** Returns an unwrapped geometry to the part's own units: positions divided, normals multiplied by the scale and made unit length. */
function unscaledAfterUnwrap(extracted, scale) {
  const positions = Float32Array.from(extracted.positions, (value, index) => value / scale[index % 3]);
  const normals = Float32Array.from(extracted.normals, (value, index) => value * scale[index % 3]);
  for (let vertex = 0; vertex < normals.length / 3; vertex++) {
    const length = Math.hypot(normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[vertex * 3 + axis] /= length;
  }
  return { ...extracted, positions, normals };
}

/** Gives a geometry its lightmap UVs in channel 0, from the unwrap that `uv_unwrap` uses. */
function unwrapForLightmap(geometry, scale) {
  const { positions, normals, indices } = scaledForUnwrap(geometry, scale);
  const mesh = meshFromGeometry({ positions, normals, indices }, { quads: false, tags: 'none' });
  const unwrapped = unwrapUv(mesh);
  const { geometry: unwrappedGeometry } = extractRender(unwrapped.mesh);
  return { geometry: unscaledAfterUnwrap(unwrappedGeometry, scale), utilization: Math.max(unwrapped.utilization, SURFACE_UTILIZATION_FLOOR) };
}

/**
 * Gives a geometry lightmap UVs in `lightUvs` and keeps its own `uvs` and `colors`. The unwrap splits vertices along its
 * seams, so each source vertex index rides through it as a corner colour and the attributes are gathered back from it.
 */
function unwrapIntoSecondUvSet(geometry, scale) {
  const { positions, normals, indices } = scaledForUnwrap(geometry, scale);
  const vertexCount = positions.length / 3;
  const sourceIndices = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) sourceIndices[vertex * 3] = vertex;
  const mesh = meshFromGeometry({ positions, normals, indices, colors: sourceIndices }, { quads: false, tags: 'none' });
  const unwrapped = unwrapUv(mesh);
  const extracted = unscaledAfterUnwrap(extractRender(unwrapped.mesh).geometry, scale);
  const newCount = extracted.positions.length / 3;
  const result = { positions: extracted.positions, normals: extracted.normals, indices: extracted.indices, lightUvs: extracted.uvs };
  const uvs = geometry.uvs ? new Float32Array(newCount * 2) : null;
  const colors = geometry.colors ? new Float32Array(newCount * 3) : null;
  const skyVisibility = geometry.skyVisibility ? new Float32Array(newCount) : null;
  const surfaceMasks = geometry.surfaceMasks ? new Float32Array(newCount) : null;
  for (let vertex = 0; vertex < newCount; vertex++) {
    const source = Math.round(extracted.colors[vertex * 3]);
    if (uvs) {
      uvs[vertex * 2] = geometry.uvs[source * 2];
      uvs[vertex * 2 + 1] = geometry.uvs[source * 2 + 1];
    }
    if (skyVisibility) skyVisibility[vertex] = geometry.skyVisibility[source];
    if (surfaceMasks) surfaceMasks[vertex] = geometry.surfaceMasks[source];
    if (colors) {
      for (let channel = 0; channel < 3; channel++) colors[vertex * 3 + channel] = geometry.colors[source * 3 + channel];
    }
  }
  if (uvs) result.uvs = uvs;
  if (colors) result.colors = colors;
  if (skyVisibility) result.skyVisibility = skyVisibility;
  if (surfaceMasks) result.surfaceMasks = surfaceMasks;
  return { geometry: result, utilization: Math.max(unwrapped.utilization, SURFACE_UTILIZATION_FLOOR) };
}

function lightmapResolution(area, utilization, options) {
  const wanted = Math.sqrt(area / utilization) * options.texelsPerUnit;
  const rounded = Math.ceil(wanted / 4) * 4;
  return Math.min(Math.max(rounded, BAKE_LIMITS.maxResolution.minimum), options.maxResolution);
}

/** The world position and facing of every texel a triangle of the geometry covers, or null where nothing covers it. */
function rasterizeTexels(geometry, matrix, resolution) {
  const texelCount = resolution * resolution;
  const positions = new Float64Array(texelCount * 3);
  const normals = new Float64Array(texelCount * 3);
  const covered = new Uint8Array(texelCount);
  const nearestDistance = new Float64Array(texelCount).fill(Infinity);
  const { positions: vertexPositions, normals: vertexNormals, indices } = geometry;
  const uvs = geometry.lightUvs ?? geometry.uvs;
  const worldCorner = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const corners = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
    for (let corner = 0; corner < 3; corner++) {
      const x = vertexPositions[corners[corner] * 3];
      const y = vertexPositions[corners[corner] * 3 + 1];
      const z = vertexPositions[corners[corner] * 3 + 2];
      worldCorner[corner * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      worldCorner[corner * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      worldCorner[corner * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    const faceNormal = worldFaceNormal(worldCorner, vertexNormals, corners[0], matrix);
    const texels = corners.map(corner => [uvs[corner * 2] * resolution, uvs[corner * 2 + 1] * resolution]);
    const [firstTexel, secondTexel, thirdTexel] = texels;
    const determinant = (secondTexel[1] - thirdTexel[1]) * (firstTexel[0] - thirdTexel[0]) + (thirdTexel[0] - secondTexel[0]) * (firstTexel[1] - thirdTexel[1]);
    if (Math.abs(determinant) < 1e-12) continue;
    const minimumColumn = Math.max(Math.floor(Math.min(firstTexel[0], secondTexel[0], thirdTexel[0])) - 1, 0);
    const maximumColumn = Math.min(Math.ceil(Math.max(firstTexel[0], secondTexel[0], thirdTexel[0])) + 1, resolution - 1);
    const minimumRow = Math.max(Math.floor(Math.min(firstTexel[1], secondTexel[1], thirdTexel[1])) - 1, 0);
    const maximumRow = Math.min(Math.ceil(Math.max(firstTexel[1], secondTexel[1], thirdTexel[1])) + 1, resolution - 1);
    for (let row = minimumRow; row <= maximumRow; row++) {
      for (let column = minimumColumn; column <= maximumColumn; column++) {
        const index = row * resolution + column;
        const centerX = column + 0.5;
        const centerY = row + 0.5;
        const { weights, distance } = nearestTriangleWeights(centerX, centerY, texels, determinant);
        // A texel whose centre is inside a triangle is covered by it. A texel just outside belongs to the nearest triangle, at
        // the nearest point on its edge, so a chart edge is sampled at its own surface and never at its neighbour's.
        if (distance > GUTTER_TEXELS || distance >= nearestDistance[index]) continue;
        nearestDistance[index] = distance;
        for (let axis = 0; axis < 3; axis++) {
          positions[index * 3 + axis] = weights[0] * worldCorner[axis] + weights[1] * worldCorner[3 + axis] + weights[2] * worldCorner[6 + axis];
          normals[index * 3 + axis] = faceNormal[axis];
        }
        covered[index] = 1;
      }
    }
  }
  return { positions, normals, covered, nearestDistance };
}

/** The barycentric weights of the point of a triangle (in texel space) nearest a texel centre, and how far that point is, in texels. */
function nearestTriangleWeights(centerX, centerY, texels, determinant) {
  const [first, second, third] = texels;
  const firstWeight = ((second[1] - third[1]) * (centerX - third[0]) + (third[0] - second[0]) * (centerY - third[1])) / determinant;
  const secondWeight = ((third[1] - first[1]) * (centerX - third[0]) + (first[0] - third[0]) * (centerY - third[1])) / determinant;
  const thirdWeight = 1 - firstWeight - secondWeight;
  if (firstWeight >= -1e-9 && secondWeight >= -1e-9 && thirdWeight >= -1e-9) return { weights: [firstWeight, secondWeight, thirdWeight], distance: 0 };
  let nearest = { weights: [1, 0, 0], distance: Infinity };
  for (let edge = 0; edge < 3; edge++) {
    const start = texels[edge];
    const end = texels[(edge + 1) % 3];
    const edgeX = end[0] - start[0];
    const edgeY = end[1] - start[1];
    const along = Math.min(Math.max(((centerX - start[0]) * edgeX + (centerY - start[1]) * edgeY) / (edgeX * edgeX + edgeY * edgeY || 1), 0), 1);
    const distance = Math.hypot(centerX - start[0] - along * edgeX, centerY - start[1] - along * edgeY);
    if (distance < nearest.distance) {
      const weights = [0, 0, 0];
      weights[edge] = 1 - along;
      weights[(edge + 1) % 3] = along;
      nearest = { weights, distance };
    }
  }
  return nearest;
}

function worldFaceNormal(worldCorner, vertexNormals, firstVertex, matrix) {
  const firstX = worldCorner[3] - worldCorner[0];
  const firstY = worldCorner[4] - worldCorner[1];
  const firstZ = worldCorner[5] - worldCorner[2];
  const secondX = worldCorner[6] - worldCorner[0];
  const secondY = worldCorner[7] - worldCorner[1];
  const secondZ = worldCorner[8] - worldCorner[2];
  const crossX = firstY * secondZ - firstZ * secondY;
  const crossY = firstZ * secondX - firstX * secondZ;
  const crossZ = firstX * secondY - firstY * secondX;
  const length = Math.hypot(crossX, crossY, crossZ) || 1;
  const authored = [vertexNormals[firstVertex * 3], vertexNormals[firstVertex * 3 + 1], vertexNormals[firstVertex * 3 + 2]];
  const transformedX = matrix[0] * authored[0] + matrix[4] * authored[1] + matrix[8] * authored[2];
  const transformedY = matrix[1] * authored[0] + matrix[5] * authored[1] + matrix[9] * authored[2];
  const transformedZ = matrix[2] * authored[0] + matrix[6] * authored[1] + matrix[10] * authored[2];
  const facing = crossX * transformedX + crossY * transformedY + crossZ * transformedZ < 0 ? -1 : 1;
  return [crossX / length * facing, crossY / length * facing, crossZ / length * facing];
}

/** Fills texels outside every chart from covered neighbours, so bilinear sampling at a chart edge reads real light. */
function dilate(radiance, covered, resolution) {
  for (let pass = 0; pass < DILATION_PASSES; pass++) {
    const additions = [];
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        if (covered[row * resolution + column]) continue;
        const sum = [0, 0, 0];
        let neighbours = 0;
        for (let rowShift = -1; rowShift <= 1; rowShift++) {
          for (let columnShift = -1; columnShift <= 1; columnShift++) {
            const neighbourRow = row + rowShift;
            const neighbourColumn = column + columnShift;
            if (neighbourRow < 0 || neighbourColumn < 0 || neighbourRow >= resolution || neighbourColumn >= resolution) continue;
            const neighbour = neighbourRow * resolution + neighbourColumn;
            if (!covered[neighbour]) continue;
            for (let channel = 0; channel < 3; channel++) sum[channel] += radiance[neighbour * 3 + channel];
            neighbours++;
          }
        }
        if (neighbours > 0) additions.push([row * resolution + column, sum.map(value => value / neighbours)]);
      }
    }
    for (const [index, value] of additions) {
      radiance.set(value, index * 3);
      covered[index] = 1;
    }
  }
}

/**
 * Smooths the gathered values (each an array of three floats per texel) over neighbouring texels of the same surface.
 * A texel has only `samples` rays, so its value is noisy, and the noise reads as grain on every wall. A neighbour counts only
 * when it lies on the same plane (its normal agrees and its position is within a texel of this texel's plane), so a corner,
 * a seam between charts and the gap between two parts never leak light into each other. Same input, same bytes.
 */
export function smoothTexels(arrays, covered, positions, normals, resolution, spacing) {
  const radius = SMOOTH_RADIUS_TEXELS;
  const sigmaSquared = SMOOTH_SIGMA_TEXELS * SMOOTH_SIGMA_TEXELS;
  const planeTolerance = spacing * SMOOTH_PLANE_TEXELS;
  let sources = arrays;
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const results = sources.map(source => new Float32Array(source.length));
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        const center = row * resolution + column;
        if (!covered[center]) continue;
        const totals = sources.map(() => [0, 0, 0]);
        let weightSum = 0;
        for (let rowShift = -radius; rowShift <= radius; rowShift++) {
          const neighbourRow = row + rowShift;
          if (neighbourRow < 0 || neighbourRow >= resolution) continue;
          for (let columnShift = -radius; columnShift <= radius; columnShift++) {
            const neighbourColumn = column + columnShift;
            if (neighbourColumn < 0 || neighbourColumn >= resolution) continue;
            const neighbour = neighbourRow * resolution + neighbourColumn;
            if (!covered[neighbour]) continue;
            const facing = normals[center * 3] * normals[neighbour * 3] + normals[center * 3 + 1] * normals[neighbour * 3 + 1] + normals[center * 3 + 2] * normals[neighbour * 3 + 2];
            if (facing < SMOOTH_MINIMUM_FACING) continue;
            const offset = (positions[neighbour * 3] - positions[center * 3]) * normals[center * 3] + (positions[neighbour * 3 + 1] - positions[center * 3 + 1]) * normals[center * 3 + 1] + (positions[neighbour * 3 + 2] - positions[center * 3 + 2]) * normals[center * 3 + 2];
            if (Math.abs(offset) > planeTolerance) continue;
            const weight = Math.exp(-(rowShift * rowShift + columnShift * columnShift) / (2 * sigmaSquared));
            weightSum += weight;
            sources.forEach((source, which) => {
              for (let channel = 0; channel < 3; channel++) totals[which][channel] += weight * source[neighbour * 3 + channel];
            });
          }
        }
        results.forEach((result, which) => {
          for (let channel = 0; channel < 3; channel++) result[center * 3 + channel] = totals[which][channel] / weightSum;
        });
      }
    }
    sources = results;
  }
  return sources;
}

function lightmapDescriptor(bytes, resolution, colorSpace) {
  return { image: createImage(bytes, resolution, resolution), colorSpace, wrapS: LIGHT_MAP_CLAMP_TO_EDGE, wrapT: LIGHT_MAP_CLAMP_TO_EDGE, minFilter: LIGHT_MAP_LINEAR, magFilter: LIGHT_MAP_LINEAR };
}

// Sky visibility is a plain fraction, so it is stored linear and read back through the part's occlusion map.
function skyVisibilityTexture(visibility, resolution) {
  const bytes = new Uint8ClampedArray(resolution * resolution * 4).fill(255);
  for (let texel = 0; texel < resolution * resolution; texel++) {
    bytes.fill(Math.round(visibility[texel * 3] * 255), texel * 4, texel * 4 + 3);
  }
  return lightmapDescriptor(bytes, resolution, 'linear');
}

function lightmapTexture(radiance, resolution, peak) {
  const bytes = new Uint8ClampedArray(resolution * resolution * 4);
  for (let texel = 0; texel < resolution * resolution; texel++) {
    for (let channel = 0; channel < 3; channel++) bytes[texel * 4 + channel] = linearToSrgbByte(radiance[texel * 3 + channel] / peak);
    bytes[texel * 4 + 3] = 255;
  }
  return lightmapDescriptor(bytes, resolution, 'srgb');
}

function bakedPart(part, geometry, texture, peak) {
  return { ...part, geometry, material: { ...part.material, emission: peak, emissiveColor: [1, 1, 1], emissiveMap: texture } };
}

function lightMappedPart(part, geometry, texture, peak) {
  return { ...part, geometry, material: { ...part.material, lightMap: texture, lightMapScale: peak } };
}

// The sky and world light reach a surface only through what it can see of them, so a part that sees little of the sky
// (a room with a small opening) takes its sky light and reflections through this map. The renderer already multiplies
// them by an occlusion map, so a bake adds no shader work for a part that sees the whole sky.
function skyVisibilityPart(part, geometry, texture, slot) {
  return { ...part, geometry, material: { ...part.material, occlusionMap: slot ? { ...texture, uvChannel: 1 } : texture, occlusionStrength: 1 } };
}

/**
 * Bakes bounced light into the parts and returns new parts (the input is not changed) plus a report.
 * lighting: { pointLights: [{ position, color, intensity, radius, range }], keyColor, lightDirection }, the same shapes
 * the renderer takes, plus optional spotLights and areaLights in their renderer shapes.
 * options: maxResolution, texelsPerUnit, samples, bounces, maxSeconds (see BAKE_LIMITS). The time limit throws and
 * never truncates, so a bake that finishes always has the same bytes.
 */
export function bakeLightmaps(parts, lighting, options = {}) {
  const plan = planLightmaps(parts, lighting, options);
  return traceLightmaps(plan, { ...plan.settings, skyOnly: options.skyOnly === true });
}

/**
 * Sky visibility alone, with no light written: the parts that see little of the sky get the occlusion map the full bake
 * would give them, and every other part is returned as it was. One ray per sample and no light leaves it much cheaper
 * than a bake, so it can run at a low density on a scene that never asked for one.
 */
export function bakeSkyVisibility(parts, lighting, options = {}) {
  return bakeLightmaps(parts, lighting, { ...options, skyOnly: true });
}

// The gatherer of a sky-only bake: the same first-leg cosine rays, and nothing is shaded when one hits a part.
function createSkyVisibilityGatherer({ tracer, offset, samples }) {
  const direction = [0, 0, 0];
  return function gatherSkyVisibility(point, surfaceNormal, texelIndex, sum) {
    sum[0] = 0;
    sum[1] = 0;
    sum[2] = 0;
    const rotation = hashUnit(texelIndex, 1, 7);
    let escaped = 0;
    for (let sample = 0; sample < samples; sample++) {
      cosineDirection(surfaceNormal, (sample + 0.5) / samples, (radicalInverse(sample) + rotation) % 1, direction);
      const hit = tracer.trace(
        point[0] + surfaceNormal[0] * offset, point[1] + surfaceNormal[1] * offset, point[2] + surfaceNormal[2] * offset,
        direction[0], direction[1], direction[2], Infinity, false,
      );
      if (hit.nearestTriangle < 0) escaped++;
    }
    return escaped / samples;
  };
}

/**
 * Everything a bake decides before the first ray: validated options and lights, the unwrap of each bakeable part and the
 * parts that are skipped. It reads no clock to decide anything, so `estimateBake` of one plan is the same on every
 * machine. Pass the plan and the final settings to `traceLightmaps`.
 */
export function planLightmaps(parts, lighting, options = {}) {
  const settings = normalizeBakeOptions(options);
  const lights = normalizeLights(lighting);
  const maximumParts = settings.backend !== 'cpu' ? MAX_GPU_BAKE_PARTS : MAX_BAKE_PARTS;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > maximumParts) throw new RangeError(`Light bake takes from 1 to ${maximumParts} parts.`);
  parts.forEach(validatePart);
  const triangleTotal = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  if (triangleTotal > MAX_BAKE_TRIANGLES) throw new RangeError(`Light bake takes at most ${MAX_BAKE_TRIANGLES} triangles in total.`);
  const started = performance.now();
  const unwrapCache = new Map();
  const secondSetCache = new Map();
  const entries = [];
  const skipped = [];
  parts.forEach((part, index) => {
    const reason = skipReason(part);
    if (reason) {
      skipped.push({ name: part.name, reason });
      return;
    }
    const slot = usesLightMapSlot(part.material);
    const scale = partAxisScale(part.matrix);
    const cache = slot ? secondSetCache : unwrapCache;
    if (!cache.has(part.geometry)) cache.set(part.geometry, new Map());
    const unwraps = cache.get(part.geometry);
    const key = scaleKey(scale);
    if (!unwraps.has(key)) unwraps.set(key, slot ? unwrapIntoSecondUvSet(part.geometry, scale) : unwrapForLightmap(part.geometry, scale));
    entries.push({ part, index, unwrapped: unwraps.get(key), area: worldTriangleArea(part), slot });
  });
  return { parts, lights, settings, started, entries, skipped };
}

/** Texels and ray work of a planned bake at the given settings, with no tracing. Ray work counts one bounce ray plus one shadow ray per light. */
export function estimateBake(plan, { samples, bounces, texelsPerUnit }) {
  const resolutionSettings = { texelsPerUnit, maxResolution: plan.settings.maxResolution };
  const texels = plan.entries.reduce((total, { area, unwrapped }) => {
    const resolution = lightmapResolution(area, unwrapped.utilization, resolutionSettings);
    return total + resolution * resolution;
  }, 0);
  const { lights } = plan;
  const raysPerHit = 1 + lights.pointLights.length + lights.spotLights.length + lights.areaLights.length + (lights.sun ? 1 : 0);
  return { texels, rayWork: texels * samples * bounces * raysPerHit };
}

export function checkedBakeSize(plan, settings) {
  const { texels, rayWork } = estimateBake(plan, settings);
  if (texels > MAX_BAKE_TEXELS) throw new RangeError(`Light bake would use ${texels} texels; the limit is ${MAX_BAKE_TEXELS}. Lower maxResolution or texelsPerUnit.`);
  if (rayWork > MAX_BAKE_RAY_WORK) throw new RangeError(`Light bake would trace about ${rayWork} rays; the limit is ${MAX_BAKE_RAY_WORK}. Lower samples, bounces or texelsPerUnit.`);
  return { texels, rayWork };
}

export function checkBudget(plan, settings) {
  if (performance.now() - plan.started > settings.maxSeconds * 1000) throw new Error(`Light bake passed maxSeconds (${settings.maxSeconds}).`);
}

/** Where every texel of every bakeable part sits in the world: the same input to the CPU and the GPU tracer. */
export function rasterizeEntries(plan, settings) {
  return plan.entries.map((entry) => {
    const resolution = lightmapResolution(entry.area, entry.unwrapped.utilization, settings);
    return { entry, resolution, ...rasterizeTexels(entry.unwrapped.geometry, entry.part.matrix, resolution) };
  });
}

/**
 * The CPU tracer's turn: for each rasterized part, `light` (the mean radiance that arrives at each texel, three floats)
 * and `escaped` (the share of first rays that left the scene).
 */
function gatherOnCpu(plan, settings, rasterized) {
  const { parts, lights } = plan;
  const world = buildWorld(parts);
  const scale = sceneScale(world.positions);
  const offset = scale * 1e-4;
  const tracer = createTracer(world);
  const directIrradiance = createDirectIrradiance(tracer, withReach(lights, parts), offset, scale);
  const albedoOfPart = parts.map(part => diffuseAlbedo(part.material));
  const emissionOfPart = parts.map(part => emittedRadiance(part.material));
  const gather = settings.skyOnly
    ? createSkyVisibilityGatherer({ tracer, offset, samples: settings.samples })
    : createGatherer({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance, offset, samples: settings.samples, bounces: settings.bounces });
  const sum = [0, 0, 0];
  const point = [0, 0, 0];
  const normal = [0, 0, 0];
  return rasterized.map(({ entry, resolution, positions, normals, covered }) => {
    const light = new Float32Array(resolution * resolution * 3);
    const escaped = new Float32Array(resolution * resolution);
    for (let texel = 0; texel < resolution * resolution; texel++) {
      if (!covered[texel]) continue;
      checkBudget(plan, settings);
      for (let axis = 0; axis < 3; axis++) {
        point[axis] = positions[texel * 3 + axis];
        normal[axis] = normals[texel * 3 + axis];
      }
      escaped[texel] = gather(point, normal, entry.index * 1_000_003 + texel, sum);
      light.set(sum, texel * 3);
    }
    return { light, escaped };
  });
}

/** Lightmaps and parts from the gathered light: albedo, smoothing, dilation, sky visibility and the baked copies of the parts. */
export function finishLightmaps(plan, settings, rasterized, gathered, sizes) {
  const baked = plan.parts.slice();
  const partReports = [];
  rasterized.forEach(({ entry, resolution, positions, normals, covered, nearestDistance }, entryNumber) => {
    const { part, index, unwrapped, area, slot } = entry;
    const { light, escaped } = gathered[entryNumber];
    const albedo = diffuseAlbedo(part.material);
    const radiance = new Float32Array(resolution * resolution * 3);
    const skyVisibility = new Float32Array(resolution * resolution * 3);
    let skySum = 0;
    let skyTexels = 0;
    let peak = 0;
    for (let texel = 0; texel < resolution * resolution; texel++) {
      if (!covered[texel]) continue;
      skyVisibility.fill(escaped[texel], texel * 3, texel * 3 + 3);
      // Only texels inside a chart count toward the mean, so the gutter around a chart does not change what the part sees on average.
      if (nearestDistance[texel] === 0) {
        skySum += escaped[texel];
        skyTexels++;
      }
      for (let channel = 0; channel < 3; channel++) {
        // The lightMap slot stores the light that arrives; the shader multiplies it by the live surface colour.
        radiance[texel * 3 + channel] = slot ? light[texel * 3 + channel] : light[texel * 3 + channel] * albedo[channel];
        peak = Math.max(peak, radiance[texel * 3 + channel]);
      }
    }
    const meanSkyVisibility = skyTexels > 0 ? skySum / skyTexels : 1;
    partReports.push({ name: part.name, resolution, peak, skyVisibility: meanSkyVisibility });
    const sealed = meanSkyVisibility < SKY_VISIBLE_ENOUGH && !part.material.occlusionMap;
    if (peak <= 0 && !sealed) return;
    let bakedResult = part;
    const spacing = Math.sqrt(area / Math.max(skyTexels, 1));
    const [smoothRadiance, smoothSkyVisibility] = smoothTexels([radiance, skyVisibility], covered, positions, normals, resolution, spacing);
    if (sealed) dilate(smoothSkyVisibility, covered.slice(), resolution);
    dilate(smoothRadiance, covered, resolution);
    const smoothPeak = smoothRadiance.reduce((largest, value) => Math.max(largest, value), 0);
    if (smoothPeak > 0) bakedResult = (slot ? lightMappedPart : bakedPart)(part, unwrapped.geometry, lightmapTexture(smoothRadiance, resolution, smoothPeak), smoothPeak);
    if (sealed) bakedResult = skyVisibilityPart(bakedResult, unwrapped.geometry, skyVisibilityTexture(smoothSkyVisibility, resolution), slot);
    baked[index] = bakedResult;
  });
  const report = { parts: partReports, skipped: plan.skipped, texels: sizes.texels, rayWork: sizes.rayWork, backend: settings.backend, seconds: (performance.now() - plan.started) / 1000 };
  return { parts: baked, report };
}

/** Traces a plan with the given settings (samples, bounces, texelsPerUnit, maxSeconds) and returns the baked parts and the report. */
export function traceLightmaps(plan, tracedSettings) {
  const settings = { ...plan.settings, ...tracedSettings };
  if (settings.backend !== 'cpu') throw new TypeError(`Light bake backend "${settings.backend}" is asynchronous: use bakeLightmapsAsync from light-bake-gpu.js.`);
  const sizes = checkedBakeSize(plan, settings);
  const rasterized = rasterizeEntries(plan, settings);
  return finishLightmaps(plan, settings, rasterized, gatherOnCpu(plan, settings, rasterized), sizes);
}

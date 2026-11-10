import { computeIrradianceCoefficients, evaluateIrradiance } from './environment.js';
import { createTracer } from './ray-query.js';
import {
  MAX_BAKE_PARTS, averageMapColor, buildWorld, createDirectIrradiance, createGatherer, emittedRadiance, hitNormal, normalizeLights, sceneScale, validatePart, withReach,
} from './light-bake.js';

// The half of reflection probes that needs no GPU and no renderer: validating a probe list, placing the automatic probe
// and tracing the maps. It is pure data in and out, so a bake worker can run it. reflection-probes.js turns the traces
// into maps and gives parts their probe.

export const MAXIMUM_PROBES = 4;
export const PROBE_MAP_WIDTH = 64;
// An automatic probe is only worth placing in a room: below this share of rays hitting a part the scene is open air.
export const ENCLOSED_HIT_FRACTION = 0.9;
const PROBE_SAMPLES = 32;
const PROBE_BOUNCES = 2;

const MAX_PROBE_PIXELS = 65536;
const LEVEL_FLOOR_NORMAL = 0.99;

// Object probes: a sharp mirror needs a finer map than a room probe, and one bounce is enough for what a reflection shows.
export const MAXIMUM_OBJECT_PROBES = 8;
const OBJECT_PROBE_WIDTH = 128;
const OBJECT_PROBE_SAMPLES = 16;
const OBJECT_PROBE_BOUNCES = 1;
const OBJECT_PROBE_MINIMUM_METALLIC = 0.5;
const OBJECT_PROBE_MAXIMUM_ROUGHNESS = 0.6;

// A metal part has no diffuse albedo, but a probe that showed it black would hide the one thing a reflection is for.
export function probeAlbedo(material) {
  const metallic = material.metallic ?? 0;
  const keep = 1 - metallic * 0.5;
  const mapAverage = averageMapColor(material.map);
  return material.color.map((channel, index) => Math.max(channel, 0) * keep * mapAverage[index]);
}

/**
 * The radiance seen from each probe position, as one equirectangular map per probe (rows from straight up, the centre
 * looking toward -Z, the layout of `createEnvironmentMap`). A ray that hits a part returns its emission plus the direct
 * light and the bounced light it receives, shaded as the bake shades a texel; a ray that leaves the scene returns
 * `missRadiance(direction, out)`. `rotation` stores the map the way an environment of that rotation expects it, so a
 * lookup that applies the rotation finds the true direction. Returns `{ data, width, height, hitFraction }` for each
 * probe; the same input gives the same bytes.
 */
export function traceProbeMaps(parts, lighting, positions, { width = 64, samples = 32, bounces = 2, rotation = 0, missRadiance = null, skyIrradiance = null, maxSeconds = 60 } = {}) {
  const height = width / 2;
  if (!Number.isInteger(width) || width < 8 || width * height > MAX_PROBE_PIXELS) throw new RangeError(`Probe width must be an even integer from 8 whose map has at most ${MAX_PROBE_PIXELS} pixels.`);
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_BAKE_PARTS) throw new RangeError(`Probes take from 1 to ${MAX_BAKE_PARTS} parts.`);
  parts.forEach(validatePart);
  const lights = normalizeLights(lighting);
  const world = buildWorld(parts);
  const scale = sceneScale(world.positions);
  const offset = scale * 1e-4;
  const tracer = createTracer(world);
  const directIrradiance = createDirectIrradiance(tracer, withReach(lights, parts), offset, scale);
  const albedoOfPart = parts.map(part => probeAlbedo(part.material));
  const emissionOfPart = parts.map(part => emittedRadiance(part.material));
  const gather = createGatherer({ world, tracer, albedoOfPart, emissionOfPart, directIrradiance, offset, samples, bounces });
  const skyReflection = skyIrradiance ? createSkyReflection({ tracer, offset, skyIrradiance, parts }) : null;
  const started = performance.now();
  const rotationCosine = Math.cos(rotation);
  const rotationSine = Math.sin(rotation);
  const direction = [0, 0, 0];
  const point = [0, 0, 0];
  const normal = [0, 0, 0];
  const direct = [0, 0, 0];
  const bounced = [0, 0, 0];
  const missed = [0, 0, 0];
  return positions.map((position, probeIndex) => {
    const data = new Float32Array(width * height * 3);
    let hits = 0;
    for (let row = 0; row < height; row++) {
      const polar = (row + 0.5) / height * Math.PI;
      for (let column = 0; column < width; column++) {
        if (performance.now() - started > maxSeconds * 1000) throw new Error(`Probe trace passed maxSeconds (${maxSeconds}).`);
        const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
        const mappedX = Math.sin(polar) * Math.sin(azimuth);
        const mappedZ = -Math.sin(polar) * Math.cos(azimuth);
        direction[0] = rotationCosine * mappedX + rotationSine * mappedZ;
        direction[1] = Math.cos(polar);
        direction[2] = -rotationSine * mappedX + rotationCosine * mappedZ;
        const target = (row * width + column) * 3;
        const hit = tracer.trace(position[0], position[1], position[2], direction[0], direction[1], direction[2], Infinity, false);
        if (hit.nearestTriangle < 0) {
          if (missRadiance) {
            missRadiance(direction, missed);
            data.set(missed, target);
          }
          continue;
        }
        hits++;
        for (let axis = 0; axis < 3; axis++) point[axis] = position[axis] + direction[axis] * hit.nearestDistance;
        hitNormal(world, hit.nearestTriangle, direction, normal);
        const owner = world.triangleOwner[hit.nearestTriangle];
        // The direct light function reuses one result array, and the gatherer calls it again for every neighbour it hits.
        const shared = directIrradiance(point, normal, owner);
        direct[0] = shared[0];
        direct[1] = shared[1];
        direct[2] = shared[2];
        gather(point, normal, (probeIndex + 7777) * 1_000_003 + row * width + column, bounced);
        // An open scene's surfaces are lit by the sky too, and the room trace leaves that to the environment map.
        const sky = skyIrradiance ? skyIrradiance(normal) : null;
        const reflected = skyReflection ? skyReflection(point, normal, direction, owner) : null;
        for (let channel = 0; channel < 3; channel++) {
          const skyLight = sky ? sky[channel] : 0;
          const reflectedLight = reflected ? reflected[channel] : 0;
          data[target + channel] = emissionOfPart[owner][channel] + albedoOfPart[owner][channel] * (direct[channel] / Math.PI + bounced[channel] + skyLight) + reflectedLight;
        }
      }
    }
    return { data, width, height, hitFraction: hits / (width * height), floorHeight: floorBelow(world, tracer, position) };
  });
}

// The sky a dielectric surface mirrors toward the probe: Fresnel (Schlick, F0 0.04, capped by gloss) times the sky light of
// the mirror direction, blurred to a cosine lobe, and only where that direction leaves the scene.
function createSkyReflection({ tracer, offset, skyIrradiance, parts }) {
  const result = [0, 0, 0];
  const mirror = [0, 0, 0];
  return function skyReflection(point, normal, incoming, owner) {
    const material = parts[owner].material;
    const dielectric = 1 - (material.metallic ?? 0);
    const cosine = -(incoming[0] * normal[0] + incoming[1] * normal[1] + incoming[2] * normal[2]);
    result[0] = 0;
    result[1] = 0;
    result[2] = 0;
    if (dielectric <= 0 || cosine <= 0) return result;
    for (let axis = 0; axis < 3; axis++) mirror[axis] = incoming[axis] + 2 * cosine * normal[axis];
    const escapes = tracer.trace(point[0] + normal[0] * offset, point[1] + normal[1] * offset, point[2] + normal[2] * offset, mirror[0], mirror[1], mirror[2], Infinity, true).nearestTriangle < 0;
    if (!escapes) return result;
    const gloss = 1 - (material.roughness ?? 0.5);
    const fresnel = Math.min(0.04 + 0.96 * (1 - cosine) ** 5, Math.max(gloss, 0.04)) * dielectric;
    const light = skyIrradiance(mirror);
    for (let channel = 0; channel < 3; channel++) result[channel] = fresnel * light[channel] / Math.PI;
    return result;
  };
}

// The height of the horizontal surface straight under a probe, or null when the ground there is not level. A reflected ray
// that heads down meets this plane, which is how the lookup is corrected for the probe sitting away from the shaded point.
function floorBelow(world, tracer, position) {
  const hit = tracer.trace(position[0], position[1], position[2], 0, -1, 0, Infinity, false);
  if (hit.nearestTriangle < 0) return null;
  const normal = [0, 0, 0];
  hitNormal(world, hit.nearestTriangle, [0, -1, 0], normal);
  return normal[1] > LEVEL_FLOOR_NORMAL ? position[1] - hit.nearestDistance : null;
}

/** Validates the probe list of a recipe: up to MAXIMUM_PROBES of `{ position, radius? }`. */
export function normalizeProbeList(list) {
  if (!Array.isArray(list) || list.length > MAXIMUM_PROBES) {
    throw new RangeError(`bake.probes must be false or a list of at most ${MAXIMUM_PROBES} probes.`);
  }
  return list.map((probe, index) => {
    const label = `bake.probes[${index}]`;
    const validPosition = Array.isArray(probe?.position) && probe.position.length === 3 && probe.position.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6);
    if (!validPosition) {
      throw new TypeError(`${label} needs position [x, y, z].`);
    }
    for (const key of Object.keys(probe)) {
      if (key !== 'position' && key !== 'radius') {
        throw new TypeError(`${label} has an unknown field ${key}; use position and radius.`);
      }
    }
    if (probe.radius !== undefined && !(Number.isFinite(probe.radius) && probe.radius > 0 && probe.radius <= 1e6)) {
      throw new RangeError(`${label}.radius must be a number above 0.`);
    }
    return { position: [...probe.position], ...(probe.radius === undefined ? {} : { radius: probe.radius }) };
  });
}

export function worldBounds(part) {
  const { positions } = part.geometry;
  const { matrix } = part;
  const [xx, xy, xz, , yx, yy, yz, , zx, zy, zz, , tx, ty, tz] = matrix;
  let minimumX = Infinity;
  let minimumY = Infinity;
  let minimumZ = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  let maximumZ = -Infinity;
  // Scalars, not arrays indexed by axis: this runs over every vertex of every part, millions of them in a terrain scene.
  for (let vertex = 0; vertex < positions.length; vertex += 3) {
    const x = positions[vertex];
    const y = positions[vertex + 1];
    const z = positions[vertex + 2];
    const worldX = xx * x + yx * y + zx * z + tx;
    const worldY = xy * x + yy * y + zy * z + ty;
    const worldZ = xz * x + yz * y + zz * z + tz;
    minimumX = Math.min(minimumX, worldX);
    minimumY = Math.min(minimumY, worldY);
    minimumZ = Math.min(minimumZ, worldZ);
    maximumX = Math.max(maximumX, worldX);
    maximumY = Math.max(maximumY, worldY);
    maximumZ = Math.max(maximumZ, worldZ);
  }
  return { minimum: [minimumX, minimumY, minimumZ], maximum: [maximumX, maximumY, maximumZ] };
}

export function boundsCentre({ minimum, maximum }) {
  return minimum.map((value, axis) => (value + maximum[axis]) / 2);
}

/** The probe a room gets by default: the middle of the parts' bounds, reaching every corner of it. */
export function roomCentreProbe(parts) {
  const total = { minimum: [Infinity, Infinity, Infinity], maximum: [-Infinity, -Infinity, -Infinity] };
  for (const part of parts) {
    const bounds = worldBounds(part);
    for (let axis = 0; axis < 3; axis++) {
      total.minimum[axis] = Math.min(total.minimum[axis], bounds.minimum[axis]);
      total.maximum[axis] = Math.max(total.maximum[axis], bounds.maximum[axis]);
    }
  }
  const diagonal = Math.hypot(...total.maximum.map((value, axis) => value - total.minimum[axis]));
  return { position: boundsCentre(total), radius: diagonal / 2 };
}

// A ray that leaves the scene reads the environment map the scene is lit by, turned the way the renderer turns it.
function environmentMissRadiance(map) {
  const cosine = Math.cos(map.rotation);
  const sine = Math.sin(map.rotation);
  return (direction, out) => {
    const mappedX = cosine * direction[0] - sine * direction[2];
    const mappedZ = sine * direction[0] + cosine * direction[2];
    const column = Math.min(map.width - 1, Math.floor((Math.atan2(mappedX, -mappedZ) / (2 * Math.PI) + 0.5) * map.width));
    const row = Math.min(map.height - 1, Math.floor(Math.acos(Math.min(Math.max(direction[1], -1), 1)) / Math.PI * map.height));
    const offset = (row * map.width + column) * map.channels;
    for (let channel = 0; channel < 3; channel++) {
      out[channel] = map.data[offset + channel] * map.intensity;
    }
  };
}

// The diffuse light the environment map gives a surface with this normal, turned the way the renderer turns the map.
function environmentSkyIrradiance(map) {
  const coefficients = computeIrradianceCoefficients(map);
  const cosine = Math.cos(map.rotation);
  const sine = Math.sin(map.rotation);
  const mapped = [0, 0, 0];
  return normal => {
    mapped[0] = cosine * normal[0] - sine * normal[2];
    mapped[1] = normal[1];
    mapped[2] = sine * normal[0] + cosine * normal[2];
    return evaluateIrradiance(coefficients, mapped).map(value => value * map.intensity);
  };
}

function skyMissRadiance(environment) {
  const bottom = environment.skyBottom ?? [0.62, 0.70, 0.67];
  const top = environment.skyTop ?? [0.20, 0.38, 0.52];
  return (direction, out) => {
    const blend = Math.min(Math.max((direction[1] + 0.15) / 0.85, 0), 1);
    const smooth = blend * blend * (3 - 2 * blend);
    for (let channel = 0; channel < 3; channel++) {
      out[channel] = bottom[channel] + (top[channel] - bottom[channel]) * smooth;
    }
  };
}

/** A part that shows its surroundings: metal with a smooth enough surface for a reflection to read as a picture. */
export function isReflectivePart(material) {
  return (material.metallic ?? 0) >= OBJECT_PROBE_MINIMUM_METALLIC && (material.roughness ?? 1) <= OBJECT_PROBE_MAXIMUM_ROUGHNESS;
}

/**
 * One probe for each reflective part, at the middle of its bounds, traced without that part so it shows the others and
 * the floor and never itself. Each traced entry names its `part` (the index in `parts`). A scene with no reflective part,
 * or only one part, traces nothing.
 */
export function traceObjectProbes(parts, lighting, options = {}) {
  const { environment = {}, environmentMap = null, rotation = 0, samples = OBJECT_PROBE_SAMPLES, bounces = OBJECT_PROBE_BOUNCES, width = OBJECT_PROBE_WIDTH, maxSeconds = 60 } = options;
  const reflective = [];
  parts.forEach((part, index) => {
    if (isReflectivePart(part.material)) reflective.push(index);
  });
  // Many small metal parts (lamp posts, spires) read as shapes and not as mirrors, and each probe costs a trace and a draw batch.
  const tooManyOthers = parts.length - 1 > MAX_BAKE_PARTS;
  const wanted = reflective.length > MAXIMUM_OBJECT_PROBES || tooManyOthers ? [] : reflective;
  const skipped = wanted.length > 0 ? null : reflective.length > MAXIMUM_OBJECT_PROBES ? `more than ${MAXIMUM_OBJECT_PROBES} reflective parts` : tooManyOthers ? `more than ${MAX_BAKE_PARTS} other parts` : 'no reflective part';
  if (wanted.length === 0 || parts.length < 2) {
    return { traced: [], automatic: true, requested: reflective.length, skipped, seconds: 0 };
  }
  const started = performance.now();
  const missRadiance = environmentMap ? environmentMissRadiance(environmentMap) : skyMissRadiance(environment);
  const skyIrradiance = environmentMap ? environmentSkyIrradiance(environmentMap) : null;
  const traced = wanted.map(index => {
    const others = parts.filter((part, other) => other !== index);
    const position = boundsCentre(worldBounds(parts[index]));
    const [map] = traceProbeMaps(others, lighting, [position], { width, samples, bounces, rotation, missRadiance, skyIrradiance, maxSeconds });
    return { position, radius: null, part: index, ...map };
  });
  return { traced, automatic: true, requested: reflective.length, skipped: null, seconds: (performance.now() - started) / 1000 };
}

/**
 * Traces the probes of `specs`: a list of `{ position, radius? }` (a missing radius reaches the whole scene), or
 * `'room'` for one probe in the middle of the parts, kept only when the scene is enclosed. `parts` need world `matrix`
 * values. Returns `{ traced, automatic, requested, skipped, seconds }`, where each traced probe holds its position,
 * radius, equirectangular `data` and the share of rays that hit a part. The same input gives the same bytes.
 */
export function traceProbes(parts, lighting, specs, options = {}) {
  const { environment = {}, environmentMap = null, rotation = 0, samples = PROBE_SAMPLES, bounces = PROBE_BOUNCES, maxSeconds = 60 } = options;
  const automatic = specs === 'room';
  const requested = automatic ? [roomCentreProbe(parts)] : normalizeProbeList(specs);
  const sceneRadius = roomCentreProbe(parts).radius * 2;
  const started = performance.now();
  const positions = requested.map(probe => probe.position);
  const maps = requested.length === 0 ? [] : traceProbeMaps(parts, lighting, positions, { width: PROBE_MAP_WIDTH, samples, bounces, rotation, missRadiance: environmentMap ? environmentMissRadiance(environmentMap) : skyMissRadiance(environment), maxSeconds });
  const traced = [];
  requested.forEach((spec, index) => {
    if (automatic && maps[index].hitFraction < ENCLOSED_HIT_FRACTION) {
      return;
    }
    traced.push({ position: spec.position, radius: spec.radius ?? sceneRadius, ...maps[index] });
  });
  return {
    traced,
    automatic,
    requested: requested.length,
    skipped: automatic && traced.length === 0 ? 'open scene: under 90 percent of rays from the room centre hit a part' : null,
    seconds: (performance.now() - started) / 1000,
  };
}

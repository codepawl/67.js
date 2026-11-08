import { buildWorld, cosineDirection, hashUnit, radicalInverse, sceneScale } from './light-bake.js';
import { createTracer } from './ray-query.js';
import { CLOSED_ROOM_SHARE } from './closed-room.js';
import { fittedClosedRoomShare } from './fitted-closed-room.js';
import { partDiffuseAlbedo } from './ground-bounce.js';
import { MAX_POINT_LIGHTS } from './light-limits.js';

// Light a sunlit patch sends on to the rest of a closed room. The patches are found once, when the scene is prepared: surfaces
// of the room are sampled, the samples the sun reaches (a shadow ray) and that sit inside the room (most of a short cosine ray
// fan hits something) are grouped into a few patches by position and facing, and each patch becomes a point light just above
// it. Its flux is the sun's irradiance times the lit area times the surface's albedo, per colour channel, spread over the
// half space the patch looks into. A wall near a patch then gets more of it than a wall across the room, and a red carpet
// bounces red. It adds no shader code and nothing to the core entry; the cost is one trace when the parts are prepared, and
// one more point light for each patch in every frame.

export const SUN_BOUNCE_PATCH_LIGHTS = 6;
export const SUN_BOUNCE_SAMPLES = 20_000;
// The first pass only finds which triangles an enclosed, lit sample lands on.
const COARSE_SAMPLES = 5000;
const ROOM_RAYS = 16;
// Share of the room rays that must hit something for a lit sample to count as inside the room (a roof's outer side hits nothing).
const ENCLOSED_SHARE = 0.75;
const CLUSTER_PASSES = 6;
// The light stands this many patch radii above its patch: close enough to light the patch's own surroundings, high enough not to
// brighten the patch itself much.
const LIFT_IN_RADII = 1;
// Fitted against Cycles on the reference halls (docs/lighting.md); environment.sunBounce multiplies it.
export const SUN_BOUNCE_GAIN = 0.3;
// The strength a scene gets when it sets no `environment.sunBounce`.
export const DEFAULT_SUN_BOUNCE = 1;
// A light closer than this share of the scene to a surface blows up as 1/d^2 into a hard speck, so a patch with less free space in front is left out.
const MINIMUM_LIFT_SHARE = 0.03;
const KEY_THRESHOLD = 1e-3;
const EXCLUDED_TAGS = new Set(['liquid', 'foam', 'unlit', 'fire', 'smoke']);

function isBounceSurface(part) {
  return !['blend', 'add'].includes(part.material?.alphaMode) && !((part.material?.emission ?? 0) > 0) && !EXCLUDED_TAGS.has(part.material?.tag);
}

function sunOf(environment) {
  const keyColor = environment.keyColor ?? [1, 1, 1];
  const keyIntensity = environment.keyIntensity ?? 1;
  const length = Math.hypot(...environment.lightDirection);
  return { irradiance: keyColor.map(channel => channel * keyIntensity), direction: environment.lightDirection.map(component => component / length) };
}

function hasSun(environment) {
  const keyColor = environment.keyColor ?? [1, 1, 1];
  return Boolean(environment.lightDirection) && (environment.keyIntensity ?? 1) * (keyColor[0] + keyColor[1] + keyColor[2]) > KEY_THRESHOLD;
}

// Lit, enclosed samples of the room's surfaces (position, outward normal and the flux the sample reflects, per channel) and the
// tracer that found them. A coarse pass first finds the triangles an enclosed, lit sample lands on; the fine pass then spends
// its samples there, so a lawn outside a window does not take nearly all of them.
function sampleLitSurfaces(parts, sun) {
  const world = buildWorld(parts);
  const tracer = createTracer(world);
  const offset = sceneScale(world.positions) * 1e-4;
  const { positions, indices, triangleOwner } = world;
  const albedoOfPart = parts.map(part => partDiffuseAlbedo(part.material ?? {}));
  const triangleCount = indices.length / 3;
  const corner = (triangle, slot, axis) => positions[indices[triangle * 3 + slot] * 3 + axis];
  const normals = new Float32Array(triangleCount * 3);
  const areas = new Float32Array(triangleCount);
  const facesSun = new Uint8Array(triangleCount);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const edgeOne = [0, 1, 2].map(axis => corner(triangle, 1, axis) - corner(triangle, 0, axis));
    const edgeTwo = [0, 1, 2].map(axis => corner(triangle, 2, axis) - corner(triangle, 0, axis));
    const cross = [edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1], edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2], edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0]];
    const length = Math.hypot(...cross);
    if (length < 1e-12) continue;
    areas[triangle] = length / 2;
    for (let axis = 0; axis < 3; axis++) normals[triangle * 3 + axis] = cross[axis] / length;
    const cosine = normals[triangle * 3] * sun.direction[0] + normals[triangle * 3 + 1] * sun.direction[1] + normals[triangle * 3 + 2] * sun.direction[2];
    if (cosine > 0 && isBounceSurface(parts[triangleOwner[triangle]])) facesSun[triangle] = 1;
  }
  const fan = [0, 0, 0];

  // About `count` samples over the triangles of `domain`, by area; only the lit ones inside the room are kept.
  function drawSamples(domain, count) {
    let domainArea = 0;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      if (domain[triangle]) domainArea += areas[triangle];
    }
    const samples = [];
    if (domainArea === 0) return samples;
    const sampleArea = domainArea / count;
    let carried = 0;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      if (!domain[triangle]) continue;
      const normal = [normals[triangle * 3], normals[triangle * 3 + 1], normals[triangle * 3 + 2]];
      const cosine = normal[0] * sun.direction[0] + normal[1] * sun.direction[1] + normal[2] * sun.direction[2];
      carried += areas[triangle] / sampleArea;
      for (let slot = 0; carried >= 1; slot++, carried -= 1) {
        let firstWeight = hashUnit(triangle, slot, 1);
        let secondWeight = hashUnit(triangle, slot, 2);
        if (firstWeight + secondWeight > 1) {
          firstWeight = 1 - firstWeight;
          secondWeight = 1 - secondWeight;
        }
        const point = [0, 1, 2].map(axis => corner(triangle, 0, axis) + firstWeight * (corner(triangle, 1, axis) - corner(triangle, 0, axis)) + secondWeight * (corner(triangle, 2, axis) - corner(triangle, 0, axis)));
        const origin = point.map((value, axis) => value + normal[axis] * offset);
        if (tracer.trace(origin[0], origin[1], origin[2], sun.direction[0], sun.direction[1], sun.direction[2], Infinity, true).nearestTriangle >= 0) continue;
        let blocked = 0;
        for (let ray = 0; ray < ROOM_RAYS; ray++) {
          cosineDirection(normal, (ray + 0.5) / ROOM_RAYS, radicalInverse(ray + 1), fan);
          if (tracer.trace(origin[0], origin[1], origin[2], fan[0], fan[1], fan[2], Infinity, true).nearestTriangle >= 0) blocked++;
        }
        if (blocked / ROOM_RAYS < ENCLOSED_SHARE) continue;
        const albedo = albedoOfPart[triangleOwner[triangle]];
        samples.push({ triangle, point, normal, flux: sun.irradiance.map((channel, index) => channel * cosine * sampleArea * albedo[index]) });
      }
    }
    return samples;
  }

  const roomTriangles = new Uint8Array(triangleCount);
  for (const sample of drawSamples(facesSun, COARSE_SAMPLES)) roomTriangles[sample.triangle] = 1;
  return { samples: drawSamples(roomTriangles, SUN_BOUNCE_SAMPLES), tracer };
}

function luminanceOf(flux) {
  return flux[0] + flux[1] + flux[2];
}

// Groups samples into `count` patches by position and facing (weighted by flux), starting from the farthest-apart heavy samples.
function clusterSamples(samples, count, scale) {
  const features = samples.map(sample => [...sample.point, ...sample.normal.map(component => component * scale)]);
  const distance = (first, second) => first.reduce((total, value, index) => total + (value - second[index]) ** 2, 0);
  const centres = [features[samples.reduce((best, sample, index) => (luminanceOf(sample.flux) > luminanceOf(samples[best].flux) ? index : best), 0)]];
  const nearest = features.map(feature => distance(feature, centres[0]));
  while (centres.length < count) {
    let best = 0;
    for (let index = 1; index < samples.length; index++) {
      if (nearest[index] * luminanceOf(samples[index].flux) > nearest[best] * luminanceOf(samples[best].flux)) best = index;
    }
    if (nearest[best] === 0) break;
    centres.push(features[best]);
    features.forEach((feature, index) => { nearest[index] = Math.min(nearest[index], distance(feature, features[best])); });
  }
  const assignment = new Int32Array(samples.length);
  for (let pass = 0; pass < CLUSTER_PASSES; pass++) {
    const sums = centres.map(() => ({ weight: 0, total: new Array(6).fill(0) }));
    features.forEach((feature, index) => {
      let closest = 0;
      for (let centre = 1; centre < centres.length; centre++) {
        if (distance(feature, centres[centre]) < distance(feature, centres[closest])) closest = centre;
      }
      assignment[index] = closest;
      const weight = luminanceOf(samples[index].flux);
      sums[closest].weight += weight;
      feature.forEach((value, axis) => { sums[closest].total[axis] += value * weight; });
    });
    sums.forEach((sum, centre) => {
      if (sum.weight > 0) centres[centre] = sum.total.map(value => value / sum.weight);
    });
  }
  return centres.map((centre, index) => samples.filter((sample, sampleIndex) => assignment[sampleIndex] === index)).filter(group => group.length > 0);
}

function lightOfPatch(group, strength, tracer, probeOffset, sceneSize) {
  const flux = [0, 0, 0];
  const centre = [0, 0, 0];
  const facing = [0, 0, 0];
  let weight = 0;
  for (const sample of group) {
    const sampleWeight = luminanceOf(sample.flux);
    weight += sampleWeight;
    for (let axis = 0; axis < 3; axis++) {
      flux[axis] += sample.flux[axis];
      centre[axis] += sample.point[axis] * sampleWeight;
      facing[axis] += sample.normal[axis] * sampleWeight;
    }
  }
  const facingLength = Math.hypot(...facing) || 1;
  const normal = facing.map(component => component / facingLength);
  const middle = centre.map(component => component / weight);
  const radius = Math.sqrt(group.reduce((total, sample) => total + luminanceOf(sample.flux) * sample.point.reduce((sum, value, axis) => sum + (value - middle[axis]) ** 2, 0), 0) / weight);
  const freeDistance = probeOffset + tracer.trace(middle[0] + normal[0] * probeOffset, middle[1] + normal[1] * probeOffset, middle[2] + normal[2] * probeOffset, normal[0], normal[1], normal[2], Infinity, false).nearestDistance;
  const minimumLift = sceneSize * MINIMUM_LIFT_SHARE;
  if (freeDistance / 2 < minimumLift) return null;
  const lift = Math.max(Math.min(radius * LIFT_IN_RADII, freeDistance / 2), minimumLift);
  // Spread over the half space in front of the patch: intensity = flux / (2 pi).
  const intensity = flux.map(channel => (strength * SUN_BOUNCE_GAIN * channel) / (2 * Math.PI));
  const peak = Math.max(...intensity, 1e-9);
  return { position: middle.map((value, axis) => value + normal[axis] * lift), color: intensity.map(channel => Math.min(channel / peak, 1)), intensity: Math.min(peak, 1e5), radius: lift };
}

/**
 * The point lights that stand for the sunlit patches of a closed room: `[]` when the scene has no sun, is not a closed room,
 * is drawn with a bake or has no lit, enclosed surface. `strength` multiplies every light (`environment.sunBounce`).
 * `maximumLights` caps how many patches there are.
 */
export function findSunBounceLights(parts, environment, { strength = 1, maximumLights = SUN_BOUNCE_PATCH_LIGHTS } = {}) {
  if (strength <= 0 || maximumLights <= 0 || !hasSun(environment) || parts.some(part => part.material?.lightMap || part.material?.irradianceGrid)) return [];
  const share = fittedClosedRoomShare(parts, new Map(parts.map(part => [part.name, part.matrix])));
  if (share === null || share < CLOSED_ROOM_SHARE) return [];
  const surfaces = parts.filter(isBounceSurface);
  const sun = sunOf(environment);
  let sampled;
  try {
    sampled = sampleLitSurfaces(surfaces, sun);
  } catch {
    return [];
  }
  const { samples, tracer } = sampled;
  if (samples.length === 0) return [];
  const sceneSize = Math.max(...[0, 1, 2].map(axis => Math.max(...samples.map(sample => sample.point[axis])) - Math.min(...samples.map(sample => sample.point[axis]))), 1e-3);
  return clusterSamples(samples, maximumLights, sceneSize).map(group => lightOfPatch(group, strength, tracer, sceneSize * 1e-3, sceneSize)).filter(Boolean);
}

const lightsOfParts = new WeakMap();

/**
 * The environment with the sunlit patches' lights added to its point lights. `environment.sunBounce` (default 1) scales
 * them; 0 returns the environment itself. The patches are found once for these parts and this sun and kept.
 */
export function withSunBounce(parts, environment) {
  const strength = environment.sunBounce ?? DEFAULT_SUN_BOUNCE;
  if (strength <= 0 || !hasSun(environment)) return environment;
  const existing = environment.pointLights ?? [];
  const room = Math.min(SUN_BOUNCE_PATCH_LIGHTS, MAX_POINT_LIGHTS - existing.length);
  const key = JSON.stringify([parts.length, environment.keyColor, environment.keyIntensity, environment.lightDirection, room]);
  let remembered = lightsOfParts.get(parts);
  if (remembered?.key !== key) {
    remembered = { key, lights: findSunBounceLights(parts, environment, { strength: 1, maximumLights: room }), scaled: new Map() };
    lightsOfParts.set(parts, remembered);
  }
  if (remembered.lights.length === 0) return environment;
  if (!remembered.scaled.has(strength)) {
    remembered.scaled.set(strength, remembered.lights.map(light => scaledLight(light, strength)));
  }
  return { ...environment, pointLights: [...existing, ...remembered.scaled.get(strength)] };
}

function scaledLight(light, strength) {
  const peak = light.intensity * strength;
  return { ...light, intensity: Math.min(peak, 1e5) };
}

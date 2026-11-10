import { fibonacciDirection } from './closed-room.js';
import { buildWorld, createDirectIrradiance, emittedRadiance, hitNormal, normalizeLights, sceneScale, validatePart, withReach } from './light-bake.js';
import { probeAlbedo } from './probe-trace.js';
import { createTracer } from './ray-query.js';

export const FOG_BOUNCE_RAYS = 64;
// A part with an emissive map is skipped as a source: a baked part (light-bake.js) carries its lightmap there, and that holds
// the sun's bounce too, which the fog's ambient already stands in for.
const NO_EMISSION = [0, 0, 0];
const GOLDEN_ANGLE =Math.PI * (3 - Math.sqrt(5));

/**
 * The light that surfaces give the fog around them, at the centres of the same cells as `skyVisibilityGrid`: red, green and
 * blue radiance per cell as floats, x fastest then y then z. From each cell centre a fixed spiral of rays finds the nearest
 * surface, and that surface sends back what it emits plus the light `lighting` gives it times its albedo over pi, so a glowing
 * window or a surface under a lamp brightens the fog near it. The renderer passes point lights and no sun, because the
 * ambient of a lit room already stands in for the sun's bounce. The mean over all rays is what isotropic scattering at the
 * cell sends toward the eye; rays that leave the scene add nothing, because the sky grid carries the sky. One bounce, built
 * once per scene and fog box. Null when the scene has a part the light bake cannot read, which leaves the fog without it.
 * `lighting` holds `pointLights`, `keyColor` and `lightDirection`, as the light bake takes them.
 */
export function fogBounceGrid(parts, size, minimum, maximum, lighting) {
  const surfaces = parts.filter(part => !['blend', 'add'].includes(part.material?.alphaMode));
  let world;
  let lights;
  try {
    surfaces.forEach(validatePart);
    world = buildWorld(surfaces);
    lights = normalizeLights(lighting);
  } catch {
    return null;
  }
  const scale = sceneScale(world.positions);
  const offset = scale * 1e-4;
  const tracer = createTracer(world);
  const directIrradiance = createDirectIrradiance(tracer, withReach(lights, surfaces), offset, scale);
  const albedoOfPart = surfaces.map(part => probeAlbedo(part.material));
  const emissionOfPart = surfaces.map(part => (part.material.emissiveMap ? NO_EMISSION : emittedRadiance(part.material)));
  const directions = Array.from({ length: FOG_BOUNCE_RAYS }, (unused, ray) => fibonacciDirection(ray, FOG_BOUNCE_RAYS, [0, 0, 0]));
  const data = new Float32Array(size[0] * size[1] * size[2] * 3);
  const point = [0, 0, 0];
  const direction = [0, 0, 0];
  const normal = [0, 0, 0];
  let cellIndex = 0;
  for (let z = 0; z < size[2]; z++) {
    for (let y = 0; y < size[1]; y++) {
      for (let x = 0; x < size[0]; x++) {
        const cell = [x, y, z];
        const origin = cell.map((index, axis) => minimum[axis] + (index + 0.5) / size[axis] * (maximum[axis] - minimum[axis]));
        // Turning the spiral about the vertical axis from cell to cell keeps its pattern from lining up across neighbours.
        const turn = cellIndex * GOLDEN_ANGLE;
        const turnCosine = Math.cos(turn);
        const turnSine = Math.sin(turn);
        for (const spiral of directions) {
          direction[0] = turnCosine * spiral[0] + turnSine * spiral[2];
          direction[1] = spiral[1];
          direction[2] = -turnSine * spiral[0] + turnCosine * spiral[2];
          const hit = tracer.trace(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], Infinity, false);
          if (hit.nearestTriangle < 0) {
            continue;
          }
          for (let axis = 0; axis < 3; axis++) {
            point[axis] = origin[axis] + direction[axis] * hit.nearestDistance;
          }
          hitNormal(world, hit.nearestTriangle, direction, normal);
          const owner = world.triangleOwner[hit.nearestTriangle];
          const direct = directIrradiance(point, normal, owner);
          for (let channel = 0; channel < 3; channel++) {
            data[cellIndex * 3 + channel] += (emissionOfPart[owner][channel] + albedoOfPart[owner][channel] * direct[channel] / Math.PI) / FOG_BOUNCE_RAYS;
          }
        }
        cellIndex++;
      }
    }
  }
  return data;
}

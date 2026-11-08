import { hashUnit } from './light-bake.js';
import { henyeyGreensteinPhase, resolveTraceVolume, sampleHenyeyGreensteinCosine, volumeInterval } from './path-tracer-volume.js';

// The fog a path of the irradiance grid crosses. It is optional and lives here, so a trace of a scene without fog runs the plain gatherer.

/** Scattering events one path may have, as many orders as Cycles keeps for the fog of the reference scenes. */
export const MAXIMUM_FOG_SCATTERS = 8;

/**
 * The fog along one leg of a grid path, from the same box, density, colour and Henyey-Greenstein anisotropy the renderer's
 * `environment.volumeFog` uses. It returns null when the lighting has no fog. Otherwise it returns
 * `medium(origin, direction, distance, throughput, sum, texelIndex, sample, leg)`, which treats the leg as a volumetric path:
 * the path scatters inside the fog with the probability that a photon would, and otherwise reaches the surface beyond with
 * its throughput intact. A scattering adds the sun the point sees (one shadow ray, phase weighted) to `sum`, multiplies
 * `throughput` by the fog colour, moves `origin` to the point, turns `direction` by a Henyey-Greenstein draw, and returns
 * true: the path goes on from there, so light that the fog scatters again and again stays in the fog instead of being lost.
 */
export function createGridMedium({ lighting, sun, tracer, scale }) {
  const volume = resolveTraceVolume(lighting.volumeFog);
  if (!volume) return null;
  const interval = [0, 0];
  const shadowReach = scale * 1e6;
  return function medium(origin, direction, distance, throughput, sum, texelIndex, sample, leg) {
    if (!volumeInterval(volume, origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], distance, interval)) return false;
    const scatteredShare = 1 - Math.exp(-volume.density * (interval[1] - interval[0]));
    const seed = leg * 4;
    if (hashUnit(texelIndex, sample, seed + 200) >= scatteredShare) return false;
    const along = interval[0] - Math.log(1 - hashUnit(texelIndex, sample, seed + 201) * scatteredShare) / volume.density;
    for (let axis = 0; axis < 3; axis++) origin[axis] += direction[axis] * along;
    if (sun) {
      const sunBlocked = tracer.trace(origin[0], origin[1], origin[2], sun.direction[0], sun.direction[1], sun.direction[2], shadowReach, true).nearestTriangle >= 0;
      if (!sunBlocked) {
        const phase = henyeyGreensteinPhase(volume.anisotropy, direction[0] * sun.direction[0] + direction[1] * sun.direction[1] + direction[2] * sun.direction[2]);
        for (let channel = 0; channel < 3; channel++) sum[channel] += throughput[channel] * volume.albedo[channel] * sun.color[channel] * phase;
      }
    }
    for (let channel = 0; channel < 3; channel++) throughput[channel] *= volume.albedo[channel];
    turnDirection(direction, sampleHenyeyGreensteinCosine(volume.anisotropy, hashUnit(texelIndex, sample, seed + 202)), 2 * Math.PI * hashUnit(texelIndex, sample, seed + 203));
    return true;
  };
}

/** Turns `direction` (a unit vector) in place by the polar angle whose cosine is given, around it by `azimuth`. */
function turnDirection(direction, cosine, azimuth) {
  const [x, y, z] = direction;
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  const helperIsX = Math.abs(x) < 0.9;
  // tangent = normalize(helper x direction), bitangent = direction x tangent
  const tangentX = helperIsX ? 0 : -z;
  const tangentY = helperIsX ? z : 0;
  const tangentZ = helperIsX ? -y : x;
  const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
  const firstX = tangentX / tangentLength;
  const firstY = tangentY / tangentLength;
  const firstZ = tangentZ / tangentLength;
  const secondX = y * firstZ - z * firstY;
  const secondY = z * firstX - x * firstZ;
  const secondZ = x * firstY - y * firstX;
  const cosineAzimuth = Math.cos(azimuth) * sine;
  const sineAzimuth = Math.sin(azimuth) * sine;
  direction[0] = x * cosine + firstX * cosineAzimuth + secondX * sineAzimuth;
  direction[1] = y * cosine + firstY * cosineAzimuth + secondY * sineAzimuth;
  direction[2] = z * cosine + firstZ * cosineAzimuth + secondZ * sineAzimuth;
}

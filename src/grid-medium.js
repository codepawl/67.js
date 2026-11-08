import { hashUnit } from './light-bake.js';
import { henyeyGreensteinPhase, resolveTraceVolume, volumeInterval } from './path-tracer-volume.js';

// The fog a path of the irradiance grid crosses. It is optional and lives here, so a trace of a scene without fog runs the plain gatherer.

const FOUR_PI = 4 * Math.PI;

/**
 * The fog along one leg of a grid path, from the same box, density, colour and Henyey-Greenstein anisotropy the renderer's
 * `environment.volumeFog` uses. It returns null when the lighting has no fog. Otherwise it returns
 * `medium(origin, direction, distance, throughput, sum, texelIndex, sample, bounce)`: one scattering point drawn from the leg's
 * free-flight distribution, the light it scatters toward the path added to `sum`, and `throughput` dimmed by the leg's
 * transmittance, which the surface beyond the leg inherits. The scattered light is the sun (one shadow ray) and, when
 * `surfaceRadiance(point, direction, out)` is given, the light the nearest surface in one random direction sends back
 * (the fog's second scattering, which a bounce off the lit walls feeds). Neither is dimmed by the fog on its way.
 */
export function createGridMedium({ lighting, sun, tracer, scale, surfaceRadiance = null }) {
  const volume = resolveTraceVolume(lighting.volumeFog);
  if (!volume) return null;
  const interval = [0, 0];
  const point = [0, 0, 0];
  const sampleDirection = [0, 0, 0];
  const surfaceColor = [0, 0, 0];
  const scattered = [0, 0, 0];
  const shadowReach = scale * 1e6;
  return function medium(origin, direction, distance, throughput, sum, texelIndex, sample, bounce) {
    if (!volumeInterval(volume, origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], distance, interval)) return;
    const transmittance = Math.exp(-volume.density * (interval[1] - interval[0]));
    const scatteredShare = 1 - transmittance;
    const seed = bounce * 4;
    const along = interval[0] - Math.log(1 - hashUnit(texelIndex, sample, seed + 201) * scatteredShare) / volume.density;
    for (let axis = 0; axis < 3; axis++) point[axis] = origin[axis] + direction[axis] * along;
    scattered[0] = 0;
    scattered[1] = 0;
    scattered[2] = 0;
    if (sun) {
      const sunBlocked = tracer.trace(point[0], point[1], point[2], sun.direction[0], sun.direction[1], sun.direction[2], shadowReach, true).nearestTriangle >= 0;
      if (!sunBlocked) {
        const phase = henyeyGreensteinPhase(volume.anisotropy, direction[0] * sun.direction[0] + direction[1] * sun.direction[1] + direction[2] * sun.direction[2]);
        for (let channel = 0; channel < 3; channel++) scattered[channel] += sun.color[channel] * phase;
      }
    }
    if (surfaceRadiance) {
      const height = 1 - 2 * hashUnit(texelIndex, sample, seed + 202);
      const ring = Math.sqrt(Math.max(0, 1 - height * height));
      const angle = 2 * Math.PI * hashUnit(texelIndex, sample, seed + 203);
      sampleDirection[0] = ring * Math.cos(angle);
      sampleDirection[1] = height;
      sampleDirection[2] = ring * Math.sin(angle);
      surfaceRadiance(point, sampleDirection, surfaceColor);
      const cosine = direction[0] * sampleDirection[0] + direction[1] * sampleDirection[1] + direction[2] * sampleDirection[2];
      // Uniform directions have the density 1 / (4 pi), so the estimate is the radiance times the phase times 4 pi.
      const weight = henyeyGreensteinPhase(volume.anisotropy, cosine) * FOUR_PI;
      for (let channel = 0; channel < 3; channel++) scattered[channel] += surfaceColor[channel] * weight;
    }
    for (let channel = 0; channel < 3; channel++) {
      sum[channel] += throughput[channel] * scatteredShare * volume.albedo[channel] * scattered[channel];
      throughput[channel] *= transmittance;
    }
  };
}

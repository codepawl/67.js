import { resolveVolumeFog } from './volumetric.js';
import { localVolumeInterval, localVolumeProfile } from './local-volumes.js';
import { buildTriangleBvh } from './triangle-bvh.js';
import { createTracer } from './ray-query.js';

// Homogeneous fog for the path tracer: a box of uniform scattering medium with the colour, density and anisotropy of the
// rasterizer's `environment.volumeFog`. Distances to the next scattering event are drawn from the exact free-flight
// distribution, so the cost is one random number per ray segment and there is no step count to trade against quality.
// The rasterizer's noise, drift and ambient term are not traced: the medium is uniform and lit only by the scene's lights.

/** The medium the tracer reads, or null when the environment has no fog. Throws what the rasterizer throws for bad input. */
export function resolveTraceVolume(volumeFog) {
  if (!volumeFog) return null;
  const resolved = resolveVolumeFog(volumeFog);
  if (!(resolved.density > 0)) return null;
  return {
    density: resolved.density,
    minimum: resolved.minimum,
    maximum: resolved.maximum,
    albedo: resolved.color,
    anisotropy: resolved.anisotropy,
    maxDistance: resolved.maxDistance,
  };
}

/**
 * Where the ray is inside the box, as distances along it: writes `[entry, exit]` into `out`
 * clipped to `[0, limit]` and returns true, or returns false when the ray misses the box in that range.
 */
export function volumeInterval(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  let entry = 0;
  let exit = Math.min(limit, volume.maxDistance);
  for (let axis = 0; axis < 3; axis++) {
    const origin = axis === 0 ? originX : axis === 1 ? originY : originZ;
    const direction = axis === 0 ? directionX : axis === 1 ? directionY : directionZ;
    if (direction === 0) {
      if (origin < volume.minimum[axis] || origin > volume.maximum[axis]) return false;
      continue;
    }
    const first = (volume.minimum[axis] - origin) / direction;
    const second = (volume.maximum[axis] - origin) / direction;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
  }
  if (!(entry < exit)) return false;
  out[0] = entry;
  out[1] = exit;
  return true;
}

/** Henyey-Greenstein value per steradian; `cosine` is between the path direction and the direction toward the light. */
export function henyeyGreensteinPhase(anisotropy, cosine) {
  const squared = anisotropy * anisotropy;
  return (1 - squared) / (4 * Math.PI * (1 + squared - 2 * anisotropy * cosine) ** 1.5);
}

/**
 * Draws the cosine of the scattering angle from Henyey-Greenstein. The probability density of the drawn direction is
 * `henyeyGreensteinPhase(anisotropy, cosine)`, so a scatter keeps its throughput times the albedo.
 */
export function sampleHenyeyGreensteinCosine(anisotropy, unit) {
  if (Math.abs(anisotropy) < 1e-3) return 1 - 2 * unit;
  const squared = anisotropy * anisotropy;
  const ratio = (1 - squared) / (1 - anisotropy + 2 * anisotropy * unit);
  return Math.max(-1, Math.min(1, (1 + squared - ratio * ratio) / (2 * anisotropy)));
}

const MAXIMUM_MESH_CROSSINGS = 64;
const MAXIMUM_MESH_SEGMENTS = MAXIMUM_MESH_CROSSINGS / 2;
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function weldedVertexIds(positions, tolerance) {
  const ids = new Map();
  const welded = new Uint32Array(positions.length / 3);
  for (let vertex = 0; vertex < welded.length; vertex++) {
    const key = `${Math.round(positions[vertex * 3] / tolerance)},${Math.round(positions[vertex * 3 + 1] / tolerance)},${Math.round(positions[vertex * 3 + 2] / tolerance)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    welded[vertex] = ids.get(key);
  }
  return welded;
}

/** The number of edges that do not join exactly two triangles, with vertices at the same place counted as one. 0 for a closed mesh. */
export function countOpenEdges(positions, indices, tolerance) {
  const welded = weldedVertexIds(positions, tolerance);
  const uses = new Map();
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const from = welded[indices[corner + edge]];
      const to = welded[indices[corner + (edge + 1) % 3]];
      if (from === to) continue;
      const key = from < to ? `${from}-${to}` : `${to}-${from}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of uses.values()) {
    if (count !== 2) open++;
  }
  return open;
}

/**
 * Gives a mesh volume (shape "mesh", bound to its part by bindLocalVolumeParts) what the tracer needs: the part's triangles in
 * world space with their own BVH. A mesh that is not closed has no inside, so it throws with the number of open edges.
 */
export function prepareMeshVolume(volume, label) {
  const { geometry, matrix = IDENTITY_MATRIX } = volume.part;
  const source = geometry.positions;
  const positions = new Float32Array(source.length);
  for (let vertex = 0; vertex < source.length; vertex += 3) {
    const x = source[vertex];
    const y = source[vertex + 1];
    const z = source[vertex + 2];
    positions[vertex] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    positions[vertex + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    positions[vertex + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  const diagonal = Math.hypot(...volume.size);
  const openEdges = countOpenEdges(positions, geometry.indices, diagonal * 1e-6);
  if (openEdges > 0) throw new RangeError(`${label}.part "${volume.part.name}" is not a closed mesh (${openEdges} open edges), so it has no inside; close it or use fit "bounds"`);
  const bvh = buildTriangleBvh(positions, geometry.indices);
  return { ...volume, mesh: { tracer: createTracer({ positions, indices: geometry.indices, bvh }), stepOffset: diagonal * 1e-6 } };
}

/**
 * Where a ray is inside a closed mesh volume: writes `[entry, exit]` pairs into `out`, clipped to `[0, limit]`, and returns how
 * many. The ray is walked from crossing to crossing, so an L-shaped room gives two segments where a ray leaves and comes back.
 * Whether the origin is inside follows from the parity of the crossings ahead of it.
 */
export function meshVolumeSegments(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  const { tracer, stepOffset } = volume.mesh;
  const crossings = [];
  let cursor = 0;
  while (crossings.length < MAXIMUM_MESH_CROSSINGS) {
    const found = tracer.trace(originX + directionX * cursor, originY + directionY * cursor, originZ + directionZ * cursor, directionX, directionY, directionZ, Infinity, false);
    if (found.nearestTriangle < 0) break;
    cursor += found.nearestDistance;
    crossings.push(cursor);
    cursor += stepOffset;
  }
  let inside = crossings.length % 2 === 1;
  let start = 0;
  let count = 0;
  for (const crossing of crossings) {
    if (inside) {
      const end = Math.min(crossing, limit);
      if (end > start && count < MAXIMUM_MESH_SEGMENTS) {
        out[count * 2] = start;
        out[count * 2 + 1] = end;
        count++;
      }
    } else {
      start = crossing;
    }
    inside = !inside;
  }
  return count;
}

/** Marches the inside segments of a mesh volume; `volume.steps` are shared between them in proportion to their length. */
function marchMeshVolume(volume, spans, originX, originY, originZ, directionX, directionY, directionZ, jitter, throughput, emitted) {
  let total = 0;
  for (let slot = 0; slot < spans.length; slot += 2) total += spans[slot + 1] - spans[slot];
  for (let slot = 0; slot < spans.length; slot += 2) {
    const entry = spans[slot];
    const segmentLength = spans[slot + 1] - entry;
    const steps = Math.max(1, Math.round(volume.steps * segmentLength / total));
    const stepLength = segmentLength / steps;
    for (let step = 0; step < steps; step++) {
      const distance = entry + (step + jitter) * stepLength;
      const width = localVolumeProfile(volume, originX + directionX * distance, originY + directionY * distance, originZ + directionZ * distance) * stepLength;
      for (let channel = 0; channel < 3; channel++) {
        emitted[channel] += throughput[channel] * volume.emission[channel] * volume.emissionStrength * width;
        throughput[channel] *= Math.exp(-volume.absorption[channel] * volume.density * width);
      }
    }
  }
}

/**
 * Builds the function that carries a ray through the scene's local volumes (environment.localVolumes). Each volume is marched with
 * its own step count between its entry and exit, nearest entry first: the emitted light is added in proportion to the throughput
 * so far, then the throughput is dimmed by exp(-absorption * profile * step). Emission and absorption do not scatter, so no light
 * sample is taken. The rasterizer's noise is not traced. `jitter` (0 to 1) offsets the samples within a step.
 * The returned function writes the emitted light into `emitted` and scales `throughput` in place.
 */
export function createLocalVolumeCrossing(volumes) {
  const entries = new Float64Array(volumes.length);
  const exits = new Float64Array(volumes.length);
  const order = new Int32Array(volumes.length);
  const span = new Float64Array(2);
  const meshScratch = new Float64Array(MAXIMUM_MESH_SEGMENTS * 2);
  const meshSpans = new Array(volumes.length);
  return function crossLocalVolumes(originX, originY, originZ, directionX, directionY, directionZ, length, jitter, throughput, emitted) {
    emitted[0] = 0;
    emitted[1] = 0;
    emitted[2] = 0;
    let count = 0;
    for (let index = 0; index < volumes.length; index++) {
      if (volumes[index].mesh) {
        const segmentCount = meshVolumeSegments(volumes[index], originX, originY, originZ, directionX, directionY, directionZ, length, meshScratch);
        if (segmentCount === 0) continue;
        meshSpans[index] = meshScratch.slice(0, segmentCount * 2);
        span[0] = meshScratch[0];
        span[1] = meshScratch[segmentCount * 2 - 1];
      } else if (!localVolumeInterval(volumes[index], originX, originY, originZ, directionX, directionY, directionZ, length, span)) continue;
      entries[index] = span[0];
      exits[index] = span[1];
      let slot = count++;
      while (slot > 0 && entries[order[slot - 1]] > span[0]) {
        order[slot] = order[slot - 1];
        slot--;
      }
      order[slot] = index;
    }
    for (let rank = 0; rank < count; rank++) {
      const volume = volumes[order[rank]];
      if (volume.mesh) {
        marchMeshVolume(volume, meshSpans[order[rank]], originX, originY, originZ, directionX, directionY, directionZ, jitter, throughput, emitted);
        continue;
      }
      const entry = entries[order[rank]];
      const stepLength = (exits[order[rank]] - entry) / volume.steps;
      for (let step = 0; step < volume.steps; step++) {
        const distance = entry + (step + jitter) * stepLength;
        const profile = localVolumeProfile(volume, originX + directionX * distance, originY + directionY * distance, originZ + directionZ * distance);
        if (profile <= 0) continue;
        const width = profile * stepLength;
        for (let channel = 0; channel < 3; channel++) {
          emitted[channel] += throughput[channel] * volume.emission[channel] * volume.emissionStrength * width;
          throughput[channel] *= Math.exp(-volume.absorption[channel] * volume.density * width);
        }
      }
    }
  };
}

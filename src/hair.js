// Hair and fur: strands grown from seeded points on a surface, bent by a droop and swayed by a sine of time.
// A strand is a function of its seed and the time only, so a seek repeats exactly.

import { createGenerator, cross, normalized } from './particles.js';
import { addFieldAcceleration } from './force-fields.js';

export const HAIR_LIMITS = Object.freeze({ maxSegments: 8, ringSides: 3, taperAtTip: 0.15 });

// Triangles of a world-space surface with their areas, for area-weighted root sampling.
function surfaceTriangles(positions, normals, indices) {
  const triangles = [];
  let totalArea = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const vertices = [indices[corner], indices[corner + 1], indices[corner + 2]];
    const points = vertices.map(vertex => [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]]);
    const edgeOne = points[1].map((value, axis) => value - points[0][axis]);
    const edgeTwo = points[2].map((value, axis) => value - points[0][axis]);
    const area = Math.hypot(...cross(edgeOne, edgeTwo)) / 2;
    if (area > 0) {
      totalArea += area;
      triangles.push({ vertices, points, area, cumulativeArea: totalArea });
    }
  }
  return { triangles, totalArea, normals };
}

function pickTriangle(surface, fraction) {
  const target = fraction * surface.totalArea;
  let low = 0;
  let high = surface.triangles.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (surface.triangles[middle].cumulativeArea >= target) high = middle;
    else low = middle + 1;
  }
  return surface.triangles[low];
}

/**
 * Root point, root direction and phase of every strand on a surface already moved to world space. Strands draw from
 * their own generators in a fixed order, so changing `count` keeps the earlier strands.
 */
export function createStrandRoots(settings, positions, normals, indices) {
  const surface = surfaceTriangles(positions, normals, indices);
  if (!surface.triangles.length) {
    throw new RangeError('Hair surface has no triangle with area.');
  }
  const roots = new Float64Array(settings.count * 3);
  const directions = new Float64Array(settings.count * 3);
  const lengths = new Float64Array(settings.count);
  const phases = new Float64Array(settings.count);
  for (let index = 0; index < settings.count; index++) {
    const random = createGenerator(settings.seed, index);
    random();
    const triangle = pickTriangle(surface, random());
    let first = random();
    let second = random();
    if (first + second > 1) {
      first = 1 - first;
      second = 1 - second;
    }
    const weights = [1 - first - second, first, second];
    const direction = [0, 0, 0];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = triangle.vertices[corner];
      for (let axis = 0; axis < 3; axis++) {
        roots[index * 3 + axis] += triangle.points[corner][axis] * weights[corner];
        direction[axis] += normals[vertex * 3 + axis] * weights[corner];
      }
    }
    const lean = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1].map(value => value * settings.spread);
    const rooted = normalized(normalized(direction).map((value, axis) => value + lean[axis]));
    directions.set(rooted, index * 3);
    lengths[index] = settings.length[0] + (settings.length[1] - settings.length[0]) * random();
    phases[index] = random() * Math.PI * 2;
  }
  return { count: settings.count, roots, directions, lengths, phases };
}

// Metres of tip displacement for each m/s2 of force field acceleration at a strand's root: a strand is a light, stiff
// cantilever, so a field leans it instead of flying it.
const FIELD_COMPLIANCE = 0.02;
const NO_VELOCITY = Object.freeze([0, 0, 0]);

// Where the fields push the tip of a strand, clamped to its length so a strong field bends it but never stretches it.
function fieldOffset(strands, index, fields, time) {
  const acceleration = [0, 0, 0];
  const root = [strands.roots[index * 3], strands.roots[index * 3 + 1], strands.roots[index * 3 + 2]];
  for (const field of fields) addFieldAcceleration(field, root, NO_VELOCITY, time, acceleration);
  const strength = Math.hypot(...acceleration);
  const scale = strength > 0 ? Math.min(FIELD_COMPLIANCE, strands.lengths[index] / strength) : 0;
  return acceleration.map(component => component * scale);
}

// Ring centres of one strand: the direction bends toward gravity at every segment, and the tip sways sideways.
function strandPoints(strands, index, settings, time) {
  const points = [];
  const segmentLength = strands.lengths[index] / settings.segments;
  let direction = [strands.directions[index * 3], strands.directions[index * 3 + 1], strands.directions[index * 3 + 2]];
  let point = [strands.roots[index * 3], strands.roots[index * 3 + 1], strands.roots[index * 3 + 2]];
  const swing = settings.sway ? settings.sway.amplitude * Math.sin(Math.PI * 2 * settings.sway.rate * time + strands.phases[index]) : 0;
  const pushed = settings.fields?.length ? fieldOffset(strands, index, settings.fields, time) : NO_VELOCITY;
  for (let ring = 0; ring <= settings.segments; ring++) {
    const along = ring / settings.segments;
    const swayDirection = settings.sway?.direction ?? [0, 0, 0];
    points.push({ center: point.map((value, axis) => value + (swayDirection[axis] * swing + pushed[axis]) * along * along), direction });
    direction = normalized([direction[0], direction[1] - settings.droop / settings.segments, direction[2]]);
    point = point.map((value, axis) => value + direction[axis] * segmentLength);
  }
  return points;
}

/** The mesh of every strand: a tapering triangular tube of `segments` sections, in world space. */
export function buildHairMesh(strands, settings, time) {
  const rings = settings.segments + 1;
  const sides = HAIR_LIMITS.ringSides;
  const verticesPerStrand = rings * sides;
  const positions = new Float32Array(strands.count * verticesPerStrand * 3);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array(strands.count * settings.segments * sides * 6);
  let indexOffset = 0;
  for (let strand = 0; strand < strands.count; strand++) {
    const points = strandPoints(strands, strand, settings, time);
    points.forEach(({ center, direction }, ring) => {
      const helper = Math.abs(direction[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
      const side = normalized(cross(direction, helper));
      const up = cross(direction, side);
      const radius = settings.width / 2 * (1 - (1 - HAIR_LIMITS.taperAtTip) * ring / settings.segments);
      for (let corner = 0; corner < sides; corner++) {
        const angle = corner / sides * Math.PI * 2;
        const vertex = (strand * verticesPerStrand + ring * sides + corner) * 3;
        for (let axis = 0; axis < 3; axis++) {
          const outward = side[axis] * Math.cos(angle) + up[axis] * Math.sin(angle);
          positions[vertex + axis] = center[axis] + outward * radius;
          normals[vertex + axis] = outward;
        }
      }
    });
    for (let ring = 0; ring < settings.segments; ring++) {
      for (let corner = 0; corner < sides; corner++) {
        const next = (corner + 1) % sides;
        const base = strand * verticesPerStrand + ring * sides;
        const lower = [base + corner, base + next, base + sides + corner, base + sides + next];
        indices.set([lower[0], lower[1], lower[2], lower[1], lower[3], lower[2]], indexOffset);
        indexOffset += 6;
      }
    }
  }
  return { positions, normals, indices };
}

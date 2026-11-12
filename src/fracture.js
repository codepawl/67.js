// Voronoi fracture of a closed convex mesh into fragments, and the glue that holds neighbouring fragments together.
// Pure float64 math from a seed, so the same input gives the same fragments byte for byte.

export const MIN_FRACTURE_CELLS = 2;
export const MAX_FRACTURE_CELLS = 64;
export const MAX_FRACTURE_TRIANGLES = 2048;
export const OUTSIDE_SLOT = 0;
export const INSIDE_SLOT = 1;

const SITE_ATTEMPTS_PER_CELL = 400;
const IMPACT_SHARE = 0.5;
const DEFAULT_IMPACT_RADIUS_SHARE = 0.3;
const MIN_SITE_SPACING_SHARE = 0.02;
const EPSILON_SHARE = 1e-7;
const MIN_CAP_AREA_SHARE = 1e-6;
const CONVEX_TOLERANCE_SHARE = 1e-3;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalized(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length === 0 ? [0, 0, 0] : [vector[0] / length, vector[1] / length, vector[2] / length];
}

function failure(field, received, expected) {
  return new RangeError(`${field} is ${received}; use ${expected}`);
}

function validateOptions(options) {
  const { seed = 1, cells, impact, impactRadius } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw failure('fracture seed', seed, 'an integer from 0 to 4294967295, such as 1');
  }
  if (!Number.isInteger(cells) || cells < MIN_FRACTURE_CELLS || cells > MAX_FRACTURE_CELLS) {
    throw failure('fracture cells', cells, `an integer from ${MIN_FRACTURE_CELLS} to ${MAX_FRACTURE_CELLS}, such as 12`);
  }
  if (impact !== undefined && (!Array.isArray(impact) || impact.length !== 3 || !impact.every(Number.isFinite))) {
    throw failure('fracture impact', JSON.stringify(impact), 'a point [x, y, z] in the part local space, such as [0, 1, 0]');
  }
  if (impactRadius !== undefined && !(Number.isFinite(impactRadius) && impactRadius > 0)) {
    throw failure('fracture impactRadius', impactRadius, 'a distance above 0 in the part local space, such as 0.5');
  }
  return { seed, cells, impact, impactRadius };
}

/** The source triangles as convex polygons with a vertex normal each, after checking it is a closed, outward, convex solid. */
function sourcePolygons(geometry) {
  const { positions, indices } = geometry;
  const normals = geometry.normals;
  const triangleCount = indices.length / 3;
  if (!Number.isInteger(triangleCount) || triangleCount < 4) {
    throw failure('fracture geometry', `${triangleCount} triangles`, 'a closed mesh with at least 4 triangles, such as a box');
  }
  if (triangleCount > MAX_FRACTURE_TRIANGLES) {
    throw failure('fracture geometry', `${triangleCount} triangles`, `at most ${MAX_FRACTURE_TRIANGLES} triangles; use fewer segments or subdivisions`);
  }
  const polygons = [];
  const planes = [];
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const vertices = [0, 1, 2].map(corner => {
      const vertex = indices[triangle * 3 + corner];
      const point = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
      const normal = normals ? [normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]] : [0, 0, 0];
      return { point, normal };
    });
    const faceNormal = normalized(cross(subtract(vertices[1].point, vertices[0].point), subtract(vertices[2].point, vertices[0].point)));
    if (faceNormal[0] === 0 && faceNormal[1] === 0 && faceNormal[2] === 0) continue;
    if (!normals) vertices.forEach(vertex => { vertex.normal = faceNormal; });
    polygons.push({ vertices, slot: OUTSIDE_SLOT });
    planes.push({ normal: faceNormal, offset: dot(faceNormal, vertices[0].point) });
  }
  return { polygons, planes };
}

function boundsOf(polygons) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) {
    for (const { point } of polygon.vertices) {
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
  }
  return { minimum, maximum, diagonal: Math.hypot(...subtract(maximum, minimum)) };
}

function polygonsVolume(polygons) {
  let volume = 0;
  for (const polygon of polygons) {
    const first = polygon.vertices[0].point;
    for (let corner = 1; corner < polygon.vertices.length - 1; corner++) {
      volume += dot(first, cross(polygon.vertices[corner].point, polygon.vertices[corner + 1].point)) / 6;
    }
  }
  return volume;
}

function checkConvexSolid(polygons, planes, diagonal) {
  if (polygonsVolume(polygons) <= 0) {
    throw failure('fracture geometry', 'inside out or flat', 'a closed mesh whose triangles wind counter-clockwise seen from outside');
  }
  for (const plane of planes) {
    for (const polygon of polygons) {
      for (const { point } of polygon.vertices) {
        if (dot(plane.normal, point) > plane.offset + diagonal * CONVEX_TOLERANCE_SHARE) {
          throw failure('fracture geometry', 'not convex', 'a convex closed part, such as a box, cylinder or sphere; split a concave part into convex parts first');
        }
      }
    }
  }
}

function mixVertex(from, to, fraction) {
  return {
    point: from.point.map((value, axis) => value + (to.point[axis] - value) * fraction),
    normal: normalized(from.normal.map((value, axis) => value + (to.normal[axis] - value) * fraction)),
  };
}

/** Keep the part of a convex polygon where normal . point <= offset. Returns null when less than a triangle is left. */
function clipPolygon(polygon, normal, offset, epsilon) {
  const kept = [];
  const { vertices } = polygon;
  for (let index = 0; index < vertices.length; index++) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const currentDistance = dot(normal, current.point) - offset;
    const nextDistance = dot(normal, next.point) - offset;
    if (currentDistance <= epsilon) kept.push(current);
    const crosses = (currentDistance < -epsilon && nextDistance > epsilon) || (currentDistance > epsilon && nextDistance < -epsilon);
    if (crosses) kept.push(mixVertex(current, next, currentDistance / (currentDistance - nextDistance)));
  }
  return kept.length < 3 ? null : { ...polygon, vertices: kept };
}

function distinctPoints(points, epsilon) {
  const distinct = [];
  for (const point of points) {
    if (!distinct.some(existing => Math.hypot(...subtract(existing, point)) <= epsilon * 10)) distinct.push(point);
  }
  return distinct;
}

/** The cut face on a plane: its points ordered counter-clockwise seen from along the outward normal. */
function capPolygon(points, normal, neighbor) {
  const center = points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0]).map(value => value / points.length);
  const helper = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const axisU = normalized(cross(helper, normal));
  const axisV = cross(normal, axisU);
  const ordered = points
    .map(point => ({ point, angle: Math.atan2(dot(subtract(point, center), axisV), dot(subtract(point, center), axisU)) }))
    .sort((first, second) => first.angle - second.angle);
  return { vertices: ordered.map(({ point }) => ({ point, normal })), slot: INSIDE_SLOT, neighbor };
}

function polygonArea(polygon) {
  const first = polygon.vertices[0].point;
  let doubled = [0, 0, 0];
  for (let corner = 1; corner < polygon.vertices.length - 1; corner++) {
    const piece = cross(subtract(polygon.vertices[corner].point, first), subtract(polygon.vertices[corner + 1].point, first));
    doubled = [doubled[0] + piece[0], doubled[1] + piece[1], doubled[2] + piece[2]];
  }
  return Math.hypot(...doubled) / 2;
}

function polygonCenter(polygon) {
  const sum = polygon.vertices.reduce((total, { point }) => [total[0] + point[0], total[1] + point[1], total[2] + point[2]], [0, 0, 0]);
  return sum.map(value => value / polygon.vertices.length);
}

function insideSolid(point, planes, margin) {
  return planes.every(plane => dot(plane.normal, point) <= plane.offset - margin);
}

function chooseSites(options, bounds, planes) {
  const random = seededRandom(options.seed);
  const margin = bounds.diagonal * MIN_SITE_SPACING_SHARE;
  const impactRadius = options.impactRadius ?? bounds.diagonal * DEFAULT_IMPACT_RADIUS_SHARE;
  const impactSites = options.impact ? Math.floor(options.cells * IMPACT_SHARE) : 0;
  const sites = [];
  let attempts = 0;
  while (sites.length < options.cells) {
    if (attempts++ > options.cells * SITE_ATTEMPTS_PER_CELL) {
      throw failure('fracture cells', options.cells, 'fewer cells for this part, or a larger impactRadius; the part is too thin or small to hold them apart');
    }
    const nearImpact = sites.length < impactSites;
    const candidate = [0, 1, 2].map(axis => {
      const unit = random();
      if (nearImpact) return options.impact[axis] + (unit * 2 - 1) * impactRadius;
      return bounds.minimum[axis] + unit * (bounds.maximum[axis] - bounds.minimum[axis]);
    });
    if (!insideSolid(candidate, planes, margin)) continue;
    if (sites.some(site => Math.hypot(...subtract(site, candidate)) < margin)) continue;
    sites.push(candidate);
  }
  return sites;
}

function buildCell(siteIndex, sites, polygons, epsilon) {
  let cell = polygons;
  for (let other = 0; other < sites.length; other++) {
    if (other === siteIndex) continue;
    const normal = subtract(sites[other], sites[siteIndex]);
    const midpoint = sites[siteIndex].map((value, axis) => (value + sites[other][axis]) / 2);
    const offset = dot(normal, midpoint);
    const unitNormal = normalized(normal);
    const unitOffset = offset / Math.hypot(...normal);
    const clipped = [];
    const planePoints = [];
    for (const polygon of cell) {
      const result = clipPolygon(polygon, unitNormal, unitOffset, epsilon);
      if (!result) continue;
      clipped.push(result);
      for (const { point } of result.vertices) {
        if (Math.abs(dot(unitNormal, point) - unitOffset) <= epsilon) planePoints.push(point);
      }
    }
    const rim = distinctPoints(planePoints, epsilon);
    if (rim.length >= 3) clipped.push(capPolygon(rim, unitNormal, other));
    cell = clipped;
  }
  return cell;
}

function meshOfCell(cell) {
  const ordered = [...cell].sort((first, second) => first.slot - second.slot);
  const positions = [];
  const normals = [];
  const indices = [];
  const groups = [];
  for (const slot of [OUTSIDE_SLOT, INSIDE_SLOT]) {
    const start = indices.length;
    for (const polygon of ordered.filter(candidate => candidate.slot === slot)) {
      const base = positions.length / 3;
      for (const { point, normal } of polygon.vertices) {
        positions.push(...point);
        normals.push(...normal);
      }
      for (let corner = 1; corner < polygon.vertices.length - 1; corner++) indices.push(base, base + corner, base + corner + 1);
    }
    if (indices.length > start) groups.push({ slot, start, count: indices.length - start });
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    groups,
  };
}

/**
 * Split a closed convex mesh into Voronoi fragments.
 * options: { seed (0), cells (2-64), impact [x, y, z] (packs half the cells near it), impactRadius }.
 * Returns { fragments, glue, volume }. Each fragment has positions, normals, indices, groups (material slot 0 outside,
 * slot 1 inside faces), volume and center. glue lists the neighbouring fragment pairs with the middle of the face they share.
 */
export function fractureMesh(geometry, rawOptions) {
  const options = validateOptions(rawOptions ?? {});
  const { polygons, planes } = sourcePolygons(geometry);
  const bounds = boundsOf(polygons);
  const epsilon = Math.max(bounds.diagonal * EPSILON_SHARE, Number.MIN_VALUE);
  checkConvexSolid(polygons, planes, bounds.diagonal);
  const sites = chooseSites(options, bounds, planes);
  const minimumArea = bounds.diagonal ** 2 * MIN_CAP_AREA_SHARE;
  const cells = sites.map((_, siteIndex) => buildCell(siteIndex, sites, polygons, epsilon));
  const fragments = cells.map((cell, siteIndex) => ({ ...meshOfCell(cell), volume: polygonsVolume(cell), center: sites[siteIndex] }));
  const glue = [];
  cells.forEach((cell, first) => {
    for (const polygon of cell) {
      if (polygon.slot !== INSIDE_SLOT || polygon.neighbor < first || polygonArea(polygon) < minimumArea) continue;
      glue.push({ a: first, b: polygon.neighbor, anchor: polygonCenter(polygon), area: polygonArea(polygon) });
    }
  });
  return { fragments, glue, volume: polygonsVolume(polygons) };
}

function distinctHullPoints(positions) {
  const distinct = new Map();
  for (let index = 0; index < positions.length; index += 3) {
    const key = `${positions[index]},${positions[index + 1]},${positions[index + 2]}`;
    if (!distinct.has(key)) distinct.set(key, [positions[index], positions[index + 1], positions[index + 2]]);
  }
  return [...distinct.values()].flat();
}

/**
 * Physics definition parts for fragments held together by breakable fixed joints.
 * `bodyName(index)` names each fragment body; the bodies sit at `translation` with the part's own rotation.
 * strength is the single-step contact impulse in N s that breaks a joint (see breakImpulse in docs/physics.md).
 */
export function fragmentPhysics(fracture, { translation = [0, 0, 0], rotation = [0, 0, 0, 1], strength, density = 1, bodyName = index => `fragment-${index}`, friction } = {}) {
  if (!(Number.isFinite(strength) && strength > 0)) {
    throw failure('glue strength', strength, 'an impulse above 0 in N s, such as 5');
  }
  const bodies = [];
  const colliders = [];
  fracture.fragments.forEach((fragment, index) => {
    bodies.push({ name: bodyName(index), translation, rotation });
    colliders.push({
      name: bodyName(index), body: bodyName(index), shape: 'convexHull', points: distinctHullPoints(fragment.positions), density,
      ...(friction === undefined ? {} : { friction }),
    });
  });
  const joints = fracture.glue.map(({ a, b, anchor }) => ({
    name: `glue-${a}-${b}`, type: 'fixed', bodyA: bodyName(a), bodyB: bodyName(b), anchorA: anchor, anchorB: anchor, breakImpulse: strength,
  }));
  return { bodies, colliders, joints };
}

const FULL_TURN = Math.PI * 2;
const MAX_PRIMITIVE_VERTICES = 1_000_000;

function integer(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function finiteFloat(value, name) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw new TypeError(`${name} must be a finite Float32 value.`);
  }
}

function primitiveBudget(vertices) {
  if (vertices > MAX_PRIMITIVE_VERTICES) {
    throw new RangeError('Primitive exceeds one million vertices. Reduce segments or subdivisions.');
  }
}

function periodicAngle(fraction) {
  return fraction === 1 ? 0 : fraction * FULL_TURN;
}

function geometry(positions, normals, indices) {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

// The sampled surfaces share one winding convention; zero-area pole triangles are omitted.
function surface(columns, rows, sample) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const vertex = sample(column / columns, row / rows);
      positions.push(...vertex.position);
      normals.push(...vertex.normal);
    }
  }
  function triangle(first, second, third) {
    const edgeA = positions.slice(second * 3, second * 3 + 3).map((value, axis) => value - positions[first * 3 + axis]);
    const edgeB = positions.slice(third * 3, third * 3 + 3).map((value, axis) => value - positions[first * 3 + axis]);
    const cross = [edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1], edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2], edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0]];
    if (Math.hypot(...cross) < 1e-10) return;
    const direction = cross.reduce((sum, value, axis) => sum + value * (normals[first * 3 + axis] + normals[second * 3 + axis] + normals[third * 3 + axis]), 0);
    indices.push(first, direction > 0 ? second : third, direction > 0 ? third : second);
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const first = row * (columns + 1) + column;
      const below = first + columns + 1;
      triangle(first, first + 1, below);
      triangle(first + 1, below + 1, below);
    }
  }
  const result = geometry(positions, normals, indices);
  result.uvs = new Float32Array((columns + 1) * (rows + 1) * 2);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const offset = (row * (columns + 1) + column) * 2;
      result.uvs[offset] = column / columns;
      result.uvs[offset + 1] = row / rows;
    }
  }
  return result;
}

export function sphere(segments = 64, rings = 40) {
  integer(segments, 3, 2048, 'segments');
  integer(rings, 2, 2048, 'rings');
  primitiveBudget((segments + 1) * (rings + 1));
  const result = surface(segments, rings, (longitude, latitude) => {
    const angle = periodicAngle(longitude);
    const elevation = latitude * Math.PI;
    const radial = latitude === 0 || latitude === 1 ? 0 : Math.sin(elevation);
    const position = [radial * Math.cos(angle), Math.cos(elevation), radial * Math.sin(angle)];
    return { position, normal: position };
  });
  return result;
}

// A flat unit sheet in XY facing +Z with a regular grid of vertices: the rest shape for cloth and for flat banners.
export function grid(segments = 16) {
  integer(segments, 1, 64, 'segments');
  return surface(segments, segments, (across, down) => ({ position: [across - 0.5, 0.5 - down, 0], normal: [0, 0, 1] }));
}

// A cone or frustum along Y, height 1 and centred like the cylinder. radiusTop 0 gives a point.
export function cone(radiusTop = 0, radiusBottom = 1, segments = 64) {
  finiteFloat(radiusTop, 'radiusTop');
  finiteFloat(radiusBottom, 'radiusBottom');
  if (radiusTop < 0 || radiusBottom < 0 || Math.fround(radiusTop) + Math.fround(radiusBottom) <= 0) {
    throw new RangeError('radiusTop and radiusBottom must not be negative, and at least one must be above zero.');
  }
  integer(segments, 3, 2048, 'segments');
  primitiveBudget((segments + 1) * 2 + 2 * (segments + 2));
  const slope = radiusBottom - radiusTop;
  const slopeLength = Math.hypot(1, slope);
  const wall = surface(segments, 1, (along, height) => {
    const angle = periodicAngle(along);
    const radius = height === 0 ? radiusTop : radiusBottom;
    return {
      position: [radius * Math.cos(angle), 0.5 - height, radius * Math.sin(angle)],
      normal: [Math.cos(angle) / slopeLength, slope / slopeLength, Math.sin(angle) / slopeLength],
    };
  });
  const positions = [...wall.positions];
  const normals = [...wall.normals];
  const indices = [...wall.indices];
  const caps = [{ sign: 1, radius: radiusTop }, { sign: -1, radius: radiusBottom }];
  for (const { sign, radius } of caps) {
    if (radius === 0) continue;
    const center = positions.length / 3;
    positions.push(0, sign * 0.5, 0);
    normals.push(0, sign, 0);
    for (let index = 0; index <= segments; index++) {
      const angle = periodicAngle(index / segments);
      positions.push(radius * Math.cos(angle), sign * 0.5, radius * Math.sin(angle));
      normals.push(0, sign, 0);
    }
    for (let index = 0; index < segments; index++) {
      const first = center + index + 1;
      indices.push(center, sign > 0 ? first + 1 : first, sign > 0 ? first : first + 1);
    }
  }
  return geometry(positions, normals, indices);
}

// A unit-radius sphere from a subdivided icosahedron: shared vertices and near-equal triangles, with no poles.
export function icoSphere(subdivisions = 2) {
  integer(subdivisions, 0, 7, 'subdivisions');
  primitiveBudget(10 * 4 ** subdivisions + 2);
  const golden = (1 + Math.sqrt(5)) / 2;
  const positions = [];
  const corners = [[-1, golden, 0], [1, golden, 0], [-1, -golden, 0], [1, -golden, 0], [0, -1, golden], [0, 1, golden],
    [0, -1, -golden], [0, 1, -golden], [golden, 0, -1], [golden, 0, 1], [-golden, 0, -1], [-golden, 0, 1]];
  for (const corner of corners) {
    const length = Math.hypot(...corner);
    positions.push(...corner.map(value => value / length));
  }
  let triangles = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let level = 0; level < subdivisions; level++) {
    const midpoints = new Map();
    const midpoint = (first, second) => {
      const key = first < second ? `${first}:${second}` : `${second}:${first}`;
      if (midpoints.has(key)) return midpoints.get(key);
      const middle = [0, 1, 2].map(axis => positions[first * 3 + axis] + positions[second * 3 + axis]);
      const length = Math.hypot(...middle);
      const index = positions.length / 3;
      positions.push(...middle.map(value => value / length));
      midpoints.set(key, index);
      return index;
    };
    const next = [];
    for (const [first, second, third] of triangles) {
      const ab = midpoint(first, second);
      const bc = midpoint(second, third);
      const ca = midpoint(third, first);
      next.push([first, ab, ca], [second, bc, ab], [third, ca, bc], [ab, bc, ca]);
    }
    triangles = next;
  }
  return geometry(positions, positions, triangles.flat());
}

// A flat disc in XY facing +Z with unit radius. innerRadius above zero makes a ring instead of a filled disc.
export function circle(segments = 64, innerRadius = 0) {
  integer(segments, 3, 2048, 'segments');
  finiteFloat(innerRadius, 'innerRadius');
  if (innerRadius < 0 || innerRadius >= 1) {
    throw new RangeError('innerRadius must be from 0 up to but not including 1.');
  }
  const radiusOf = row => row === 0 ? innerRadius : 1;
  if (innerRadius > 0) {
    primitiveBudget((segments + 1) * 2);
    const ring = surface(segments, 1, (along, row) => {
      const angle = periodicAngle(along);
      return { position: [radiusOf(row) * Math.cos(angle), radiusOf(row) * Math.sin(angle), 0], normal: [0, 0, 1] };
    });
    const uvs = [];
    for (let row = 0; row <= 1; row++) {
      for (let column = 0; column <= segments; column++) {
        const angle = periodicAngle(column / segments);
        uvs.push(0.5 + 0.5 * radiusOf(row) * Math.cos(angle), 0.5 + 0.5 * radiusOf(row) * Math.sin(angle));
      }
    }
    ring.uvs = new Float32Array(uvs);
    return ring;
  }
  primitiveBudget(segments + 2);
  const positions = [0, 0, 0];
  const normals = [0, 0, 1];
  const uvs = [0.5, 0.5];
  const indices = [];
  for (let index = 0; index <= segments; index++) {
    const angle = periodicAngle(index / segments);
    positions.push(Math.cos(angle), Math.sin(angle), 0);
    normals.push(0, 0, 1);
    uvs.push(0.5 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle));
  }
  for (let index = 0; index < segments; index++) {
    indices.push(0, index + 1, index + 2);
  }
  return { ...geometry(positions, normals, indices), uvs: new Float32Array(uvs) };
}

// The torus lies in XY, facing +Z. Partial arcs are useful for interrupted armor rings.
export function torus(tubeRadius = 0.08, segments = 96, sides = 24, arc = FULL_TURN, start = 0) {
  finiteFloat(tubeRadius, 'tubeRadius');
  finiteFloat(arc, 'arc');
  finiteFloat(start, 'start');
  if (Math.fround(tubeRadius) <= 0 || Math.fround(arc) <= 0 || arc > FULL_TURN) {
    throw new RangeError('tubeRadius must remain positive at Float32 precision and arc must be within (0, 2PI].');
  }
  integer(segments, 3, 2048, 'segments');
  integer(sides, 3, 128, 'sides');
  primitiveBudget((segments + 1) * (sides + 1) + (arc === FULL_TURN ? 0 : 2 * (sides + 2)));
  start %= FULL_TURN;
  const body = surface(segments, sides, (along, around) => {
    const angle = start + (arc === FULL_TURN && along === 1 ? 0 : along * arc);
    const tubeAngle = periodicAngle(around);
    const radial = 1 + tubeRadius * Math.cos(tubeAngle);
    return {
      position: [radial * Math.cos(angle), radial * Math.sin(angle), tubeRadius * Math.sin(tubeAngle)],
      normal: [Math.cos(angle) * Math.cos(tubeAngle), Math.sin(angle) * Math.cos(tubeAngle), Math.sin(tubeAngle)],
    };
  });
  if (arc === FULL_TURN) return body;
  const positions = [...body.positions];
  const normals = [...body.normals];
  const indices = [...body.indices];
  const uvs = [...body.uvs];
  for (const end of [0, 1]) {
    const angle = start + arc * end;
    const direction = end === 0 ? -1 : 1;
    const normal = [-Math.sin(angle) * direction, Math.cos(angle) * direction, 0];
    const center = positions.length / 3;
    positions.push(Math.cos(angle), Math.sin(angle), 0);
    normals.push(...normal);
    uvs.push(0.5, 0.5);
    for (let index = 0; index <= sides; index++) {
      const tubeAngle = periodicAngle(index / sides);
      const radial = 1 + tubeRadius * Math.cos(tubeAngle);
      positions.push(radial * Math.cos(angle), radial * Math.sin(angle), tubeRadius * Math.sin(tubeAngle));
      normals.push(...normal);
      uvs.push(0.5 + Math.cos(tubeAngle) * 0.5, 0.5 + Math.sin(tubeAngle) * 0.5);
    }
    for (let index = 0; index < sides; index++) {
      const first = center + index + 1;
      indices.push(center, end === 0 ? first : first + 1, end === 0 ? first + 1 : first);
    }
  }
  return { ...geometry(positions, normals, indices), uvs: new Float32Array(uvs) };
}

export function cylinder(segments = 80, bevel = 0.025, bevelSegments = 6) {
  integer(segments, 3, 2048, 'segments');
  integer(bevelSegments, 1, 128, 'bevelSegments');
  finiteFloat(bevel, 'bevel');
  if (bevel < 0 || bevel > 0.5 || bevel > 0 && Math.fround(bevel) === 0) {
    throw new RangeError('Cylinder bevel must be within zero and 0.5 without Float32 underflow.');
  }
  primitiveBudget((segments + 1) * 2 * (bevelSegments + 1) + 2 * (segments + 2));
  const profile = [];
  for (let index = 0; index <= bevelSegments; index++) {
    const angle = -Math.PI / 2 + index / bevelSegments * Math.PI / 2;
    profile.push({ radius: 1 - bevel + bevel * Math.cos(angle), height: -0.5 + bevel + bevel * Math.sin(angle), radialNormal: Math.cos(angle), verticalNormal: Math.sin(angle) });
  }
  for (let index = 0; index <= bevelSegments; index++) {
    const angle = index / bevelSegments * Math.PI / 2;
    profile.push({ radius: 1 - bevel + bevel * Math.cos(angle), height: 0.5 - bevel + bevel * Math.sin(angle), radialNormal: Math.cos(angle), verticalNormal: Math.sin(angle) });
  }
  const wall = surface(segments, profile.length - 1, (along, height) => {
    const angle = periodicAngle(along);
    const ring = profile[Math.round(height * (profile.length - 1))];
    return {
      position: [ring.radius * Math.cos(angle), ring.height, ring.radius * Math.sin(angle)],
      normal: [ring.radialNormal * Math.cos(angle), ring.verticalNormal, ring.radialNormal * Math.sin(angle)],
    };
  });
  const positions = [...wall.positions];
  const normals = [...wall.normals];
  const indices = [...wall.indices];
  for (const sign of [-1, 1]) {
    const center = positions.length / 3;
    positions.push(0, sign * 0.5, 0);
    normals.push(0, sign, 0);
    for (let index = 0; index <= segments; index++) {
      const angle = periodicAngle(index / segments);
      positions.push((1 - bevel) * Math.cos(angle), sign * 0.5, (1 - bevel) * Math.sin(angle));
      normals.push(0, sign, 0);
    }
    for (let index = 0; index < segments; index++) {
      const first = center + index + 1;
      indices.push(center, sign > 0 ? first + 1 : first, sign > 0 ? first : first + 1);
    }
  }
  return geometry(positions, normals, indices);
}

export function box(bevel = 0.08, subdivisions = 6) {
  finiteFloat(bevel, 'bevel');
  if (bevel < 0 || bevel > 0.5 || bevel > 0 && Math.fround(bevel) === 0) {
    throw new RangeError('Box bevel must be within zero and 0.5 without Float32 underflow.');
  }
  integer(subdivisions, 1, 128, 'subdivisions');
  primitiveBudget(bevel === 0 ? 24 : 6 * (2 * subdivisions + 2) ** 2);
  const positions = [];
  const normals = [];
  const indices = [];
  const coreExtent = 0.5 - bevel;
  const coordinates = [];
  if (bevel === 0) {
    coordinates.push(-0.5, 0.5);
  } else {
    // Sample the curved border in angular steps, leaving the planar center as one span.
    // Uniform grids miss narrow fillets and interpolate across the whole face instead.
    for (let index = 0; index <= subdivisions; index++) {
      const angle = (1 - index / subdivisions) * Math.PI / 4;
      coordinates.push(-coreExtent - bevel * Math.tan(angle));
    }
    coordinates.push(coreExtent);
    for (let index = 1; index <= subdivisions; index++) {
      const angle = index / subdivisions * Math.PI / 4;
      coordinates.push(coreExtent + bevel * Math.tan(angle));
    }
  }
  const gridSegments = coordinates.length - 1;
  for (let face = 0; face < 6; face++) {
    const axis = Math.floor(face / 2);
    const sign = face % 2 === 0 ? -1 : 1;
    const mesh = surface(gridSegments, gridSegments, (horizontal, vertical) => {
      const point = [0, 0, 0];
      point[axis] = sign * 0.5;
      point[(axis + 1) % 3] = coordinates[Math.round(horizontal * gridSegments)];
      point[(axis + 2) % 3] = coordinates[Math.round(vertical * gridSegments)];
      if (bevel === 0) {
        const normal = [0, 0, 0];
        normal[axis] = sign;
        return { position: point, normal };
      }
      const core = point.map(value => Math.max(-0.5 + bevel, Math.min(0.5 - bevel, value)));
      const offset = point.map((value, coordinate) => value - core[coordinate]);
      const length = Math.hypot(...offset);
      const normal = offset.map(value => value / length);
      return { position: core.map((value, coordinate) => value + normal[coordinate] * bevel), normal };
    });
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    normals.push(...mesh.normals);
    indices.push(...Array.from(mesh.indices, index => index + base));
  }
  return geometry(positions, normals, indices);
}

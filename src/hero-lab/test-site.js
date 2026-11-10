// A night desert test site: flat alluvial plain, ring of mountains, a steel tower with a suspended vessel and amber signal lamps.
// The geometry follows the film's desert set, rebuilt here so the hero does not pull the whole film module (rig, recordings, characters) into its bundle.
import { mat4, quat, vec3 } from 'gl-matrix';
import { cylinder, sphere, torus } from '../geometry.js';

const FULL_TURN = Math.PI * 2;
const HALF_PI = Math.PI / 2;

const MATERIALS = {
  terrain: { tag: 'terrain', color: [0.38, 0.255, 0.12], metallic: 0, roughness: 0.94, emission: 0 },
  rock: { tag: 'terrain', color: [0.24, 0.19, 0.14], metallic: 0, roughness: 0.95, emission: 0 },
  mountain: { tag: 'terrain', color: [0.18, 0.2, 0.19], metallic: 0, roughness: 0.95, emission: 0 },
  sage: { tag: 'terrain', color: [0.115, 0.125, 0.068], metallic: 0, roughness: 1, emission: 0 },
  steel: { tag: 'steel', color: [0.35, 0.39, 0.42], metallic: 0.94, roughness: 0.25, emission: 0 },
  graphite: { tag: 'graphite', color: [0.035, 0.043, 0.05], metallic: 0.7, roughness: 0.34, emission: 0 },
  amber: { tag: 'indicator', color: [1, 0.34, 0.035], metallic: 0.1, roughness: 0.3, emission: 4 },
  lamp: { tag: 'window', color: [0.51, 0.57, 0.51], metallic: 0, roughness: 0.8, emission: 1.8 },
};

function sampledSurface(columns, rows, sample) {
  const positions = [];
  const normals = [];
  const indices = [];
  const epsilon = 0.0001;
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const horizontal = column / columns;
      const vertical = row / rows;
      const tangent = vec3.subtract(vec3.create(), sample(horizontal + epsilon, vertical), sample(horizontal - epsilon, vertical));
      const bitangent = vec3.subtract(vec3.create(), sample(horizontal, vertical + epsilon), sample(horizontal, vertical - epsilon));
      positions.push(...sample(horizontal, vertical));
      normals.push(...vec3.normalize(vec3.create(), vec3.cross(vec3.create(), tangent, bitangent)));
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const first = row * (columns + 1) + column;
      const below = first + columns + 1;
      indices.push(first, first + 1, below, first + 1, below + 1, below);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

function desertHeight(horizontal, depth) {
  const flats = Math.min(1, Math.hypot(horizontal, depth) / 24);
  return -0.12 + flats * (Math.sin(horizontal * 0.071 + depth * 0.041) * 0.35 + Math.sin(depth * 0.17 - horizontal * 0.11) * 0.12 + Math.sin(horizontal * 0.91) * Math.cos(depth * 0.83) * 0.035);
}

function ridgeHeightAt(angle, vertical) {
  const peaks = 7 + 8 * Math.abs(Math.sin(angle * 3.1 + 0.4)) + 4 * Math.abs(Math.sin(angle * 11.5)) + 1.7 * Math.sin(angle * 47) + 0.8 * Math.cos(angle * 83);
  return -1 + Math.max(0, 1 - Math.abs(vertical * 2 - 1)) ** 0.63 * peaks + Math.sin(vertical * 33 + angle * 51) * Math.sin(vertical * Math.PI) * 0.8;
}

export function createTestSiteParts() {
  const meshes = {
    landscape: sampledSurface(140, 140, (horizontal, vertical) => {
      const x = (horizontal - 0.5) * 400;
      const z = (0.5 - vertical) * 400;
      return [x, desertHeight(x, z), z];
    }),
    ridge: sampledSurface(180, 20, (horizontal, vertical) => {
      const angle = horizontal * FULL_TURN;
      const radius = 145 + vertical * 72;
      return [Math.cos(angle) * radius, ridgeHeightAt(angle, vertical), Math.sin(angle) * radius];
    }),
    cylinder: cylinder(16, 0.02, 2),
    sphere: sphere(32, 20),
    rock: sphere(12, 8),
    ring: torus(0.055, 64, 8),
  };
  const parts = [];

  function add(name, mesh, position, scale, material, rotation = [0, 0, 0]) {
    const orientation = quat.fromEuler(quat.create(), ...rotation.map(angle => angle * 180 / Math.PI));
    parts.push({ name, geometry: meshes[mesh], matrix: mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale), material });
  }

  function beam(name, start, end, radius, material = MATERIALS.steel) {
    const difference = vec3.subtract(vec3.create(), end, start);
    const length = vec3.length(difference);
    const orientation = quat.rotationTo(quat.create(), [0, 1, 0], vec3.scale(vec3.create(), difference, 1 / length));
    const center = start.map((value, axis) => (value + end[axis]) / 2);
    parts.push({ name, geometry: meshes.cylinder, matrix: mat4.fromRotationTranslationScale(mat4.create(), orientation, center, [radius, length, radius]), material });
  }

  add('Alluvial plain', 'landscape', [0, 0, 0], [1, 1, 1], MATERIALS.terrain);
  add('Mountain ring', 'ridge', [0, 0, 0], [0.85, 2.4, 0.85], MATERIALS.rock);
  add('Distant mountain ring', 'ridge', [0, 1, 0], [1.15, 2.1, 1.15], MATERIALS.mountain, [0, 0.12, 0]);
  for (let index = 0; index < 180; index++) {
    const angle = index * 2.399963;
    const radius = 3 + (index / 180) ** 0.7 * 93;
    const horizontal = Math.cos(angle) * radius;
    const depth = Math.sin(angle) * radius;
    const ground = desertHeight(horizontal, depth);
    const size = 0.12 + index % 7 * 0.07;
    add('Weathered shale', 'rock', [horizontal, ground, depth], [size * 2, size * 0.4, size], MATERIALS.rock, [0.2, angle, 0.1]);
    for (let stem = 0; stem < 3; stem++) {
      const lean = angle + stem * 2.1;
      beam('Sagebrush stem', [horizontal + 0.8, ground, depth], [horizontal + 0.8 + Math.cos(lean) * size, ground + size * (0.5 + stem * 0.15), depth + Math.sin(lean) * size], 0.0045, MATERIALS.sage);
    }
  }
  for (const horizontal of [-1.3, 1.3]) {
    for (const depth of [-1.3, 1.3]) {
      beam('Tower leg', [horizontal * 1.5, 0, depth * 1.5], [horizontal, 10, depth], 0.065);
      for (let level = 0; level < 5; level++) {
        beam('Tower diagonal brace', [horizontal, level * 2, depth], [-horizontal, level * 2 + 2, depth], 0.035);
        beam('Tower transverse brace', [horizontal, level * 2, depth], [horizontal, level * 2 + 2, -depth], 0.035);
      }
    }
  }
  add('Tower platform', 'cylinder', [0, 10, 0], [2.3, 0.09, 2.3], MATERIALS.steel);
  add('Suspended vessel', 'sphere', [0, 11, 0], [0.85, 0.95, 0.85], MATERIALS.graphite);
  add('Vessel seam', 'ring', [0, 11, 0], [0.87, 0.87, 0.87], MATERIALS.steel, [HALF_PI, 0, 0]);
  for (let index = 0; index < 10; index++) add('Ladder rung', 'cylinder', [1.5, 0.5 + index, 1.4], [0.027, 0.7, 0.027], MATERIALS.steel, [0, 0, HALF_PI]);
  for (let index = 0; index < 19; index++) add('Signal lamp', 'sphere', [1.8, 0.07, 3 + index * 3.4], [0.055, 0.035, 0.055], MATERIALS.amber);
  for (const side of [-1, 1]) {
    add('Tower work lamp', 'sphere', [side * 1.15, 10.25, 0.95], [0.055, 0.08, 0.055], MATERIALS.lamp);
    beam('Hoist upright', [side * 1.3, 10, -0.5], [side * 1.3, 14.6, -0.5], 0.045);
    beam('Guy wire', [side * 1.3, 9.6, 0], [side * 17, 0, 9], 0.012, MATERIALS.graphite);
  }
  beam('Hoist lintel', [-1.3, 14.6, -0.5], [1.3, 14.6, -0.5], 0.045);
  return parts;
}

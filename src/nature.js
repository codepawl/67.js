import { mat4, quat } from 'gl-matrix';
import { box, cylinder, grid, sphere } from './geometry.js';
import './world-material-shader.js';

const FULL_TURN = Math.PI * 2;
const DETAIL_PRESETS = {
  low: { terrain: 48, ridge: 32, segments: 12, rings: 8, trees: 135, grass: 320, flowers: 60, rocks: 65 },
  balanced: { terrain: 80, ridge: 48, segments: 16, rings: 10, trees: 215, grass: 720, flowers: 120, rocks: 105 },
  high: { terrain: 112, ridge: 64, segments: 20, rings: 12, trees: 275, grass: 1050, flowers: 180, rocks: 145 },
};

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let mixed = Math.imul(state ^ state >>> 15, state | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

// Seam softening where a rock or a trunk meets the ground (mesh-blend.js), in metres. One radius per group keeps the
// instanced batches culled.
const ROCK_BLEND = Object.freeze({ radius: 0.16 });
const TRUNK_BLEND = Object.freeze({ radius: 0.12 });

export const FLAG_SIZE = Object.freeze({ width: 1.2, height: 0.75, segments: 12 });

// A flat sheet in world space, hanging from the pole at `topRight` and streaming toward -x over the bridge. nature-flag.js moves its vertices every frame.
function createFlagPart(topRight) {
  const sheet = grid(FLAG_SIZE.segments);
  for (let vertex = 0; vertex < sheet.positions.length; vertex += 3) {
    sheet.positions[vertex] = topRight[0] - FLAG_SIZE.width + (sheet.positions[vertex] + 0.5) * FLAG_SIZE.width;
    sheet.positions[vertex + 1] = topRight[1] - (0.5 - sheet.positions[vertex + 1]) * FLAG_SIZE.height;
    sheet.positions[vertex + 2] = topRight[2];
  }
  return { name: 'Flag', geometry: sheet, matrix: mat4.create(), material: { ...material('cloth', [0.64, 0.09, 0.06], 0.78), doubleSided: true } };
}

function material(tag, color, roughness = 0.9, metallic = 0) {
  return { tag, color, roughness, metallic, emission: 0 };
}

function geometry(positions, normals, indices) {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function transform(position, scale = [1, 1, 1], rotation = [0, 0, 0]) {
  const orientation = quat.fromEuler(quat.create(), ...rotation.map(angle => angle * 180 / Math.PI));
  return mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
}

function organicSphere(segments, rings, frequency, amplitude) {
  const mesh = sphere(segments, rings);
  function radius(horizontal, height, depth) {
    return 1 + amplitude * (
      Math.sin(horizontal * frequency + height * 2) * Math.sin(depth * frequency * 0.9 + height * frequency * 0.7)
      + 0.55 * Math.cos(depth * frequency * 1.3 - horizontal * frequency * 0.6) * Math.cos(height * frequency)
    );
  }
  const derivativeStep = 0.001;
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    const direction = Array.from(mesh.positions.subarray(offset, offset + 3));
    const distance = radius(...direction);
    const gradient = direction.map((value, axis) => {
      const before = [...direction];
      const after = [...direction];
      before[axis] = value - derivativeStep;
      after[axis] = value + derivativeStep;
      return (radius(...after) - radius(...before)) / (2 * derivativeStep);
    });
    const radialGradient = gradient.reduce((sum, value, axis) => sum + value * direction[axis], 0);
    const normal = direction.map((value, axis) => distance * value - (gradient[axis] - radialGradient * value));
    const normalLength = Math.hypot(...normal);
    for (let axis = 0; axis < 3; axis++) {
      mesh.positions[offset + axis] = direction[axis] * distance;
      mesh.normals[offset + axis] = normal[axis] / normalLength;
    }
  }
  return mesh;
}

function heightfield(columns, rows, minimum, maximum, height) {
  const positions = [];
  const normals = [];
  const indices = [];
  const derivativeStep = 0.04;
  for (let row = 0; row <= rows; row++) {
    const depth = minimum[1] + (maximum[1] - minimum[1]) * row / rows;
    for (let column = 0; column <= columns; column++) {
      const horizontal = minimum[0] + (maximum[0] - minimum[0]) * column / columns;
      const slopeX = (height(horizontal + derivativeStep, depth) - height(horizontal - derivativeStep, depth)) / (2 * derivativeStep);
      const slopeZ = (height(horizontal, depth + derivativeStep) - height(horizontal, depth - derivativeStep)) / (2 * derivativeStep);
      const length = Math.hypot(slopeX, 1, slopeZ);
      positions.push(horizontal, height(horizontal, depth), depth);
      normals.push(-slopeX / length, 1 / length, -slopeZ / length);
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const first = row * (columns + 1) + column;
      const below = first + columns + 1;
      indices.push(first, below, first + 1, first + 1, below, below + 1);
    }
  }
  return geometry(positions, normals, indices);
}

function streamGeometry(segments, streamCenter, streamWidth) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let index = 0; index <= segments; index++) {
    const depth = -63 + 95 * index / segments;
    const center = streamCenter(depth);
    const width = streamWidth(depth);
    positions.push(center - width, 0.22, depth, center + width, 0.22, depth);
    normals.push(0, 1, 0, 0, 1, 0);
    if (index < segments) {
      const first = index * 2;
      indices.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
    }
  }
  return geometry(positions, normals, indices);
}

// Both faces have their own normals so the blades remain visible from every viewpoint.
function grassTuft(blades, segments, reed = false) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let blade = 0; blade < blades; blade++) {
    const angle = blade * 2.399963;
    const height = (reed ? 1.8 : 0.65) * (0.72 + 0.28 * Math.sin(blade * 4.3 + 2) ** 2);
    const bend = reed ? 0.22 : 0.38;
    const width = reed ? 0.022 : 0.043;
    const baseX = Math.cos(angle) * 0.12;
    const baseZ = Math.sin(angle) * 0.12;
    for (const facing of [1, -1]) {
      const base = positions.length / 3;
      for (let segment = 0; segment <= segments; segment++) {
        const progress = segment / segments;
        const taper = width * (1 - progress * 0.94);
        const derivative = 2 * bend * progress / height;
        const length = Math.hypot(1, derivative);
        for (const side of [-1, 1]) {
          positions.push(
            baseX + Math.cos(angle) * bend * progress ** 2 - Math.sin(angle) * taper * side,
            height * progress,
            baseZ + Math.sin(angle) * bend * progress ** 2 + Math.cos(angle) * taper * side,
          );
          normals.push(facing * Math.cos(angle) / length, -facing * derivative / length, facing * Math.sin(angle) / length);
        }
      }
      for (let segment = 0; segment < segments; segment++) {
        const first = base + segment * 2;
        if (facing > 0) indices.push(first, first + 2, first + 1, first + 1, first + 2, first + 3);
        else indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
      }
    }
  }
  return geometry(positions, normals, indices);
}

function flowerHead(petalMesh) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let petal = 0; petal < 6; petal++) {
    const angle = petal * FULL_TURN / 5;
    const scale = petal === 5 ? [0.06, 0.035, 0.06] : [0.105, 0.025, 0.055];
    const center = petal === 5 ? [0, 0.025, 0] : [Math.cos(angle) * 0.085, 0, Math.sin(angle) * 0.085];
    const matrix = transform(center, scale, [0, -angle, 0]);
    const base = positions.length / 3;
    for (let offset = 0; offset < petalMesh.positions.length; offset += 3) {
      const point = Array.from(petalMesh.positions.subarray(offset, offset + 3));
      for (let axis = 0; axis < 3; axis++) {
        positions.push(matrix[axis] * point[0] + matrix[axis + 4] * point[1] + matrix[axis + 8] * point[2] + matrix[axis + 12]);
      }
      const localNormal = Array.from(petalMesh.normals.subarray(offset, offset + 3)).map((value, axis) => value / scale[axis]);
      const rotated = [
        Math.cos(angle) * localNormal[0] - Math.sin(angle) * localNormal[2],
        localNormal[1],
        Math.sin(angle) * localNormal[0] + Math.cos(angle) * localNormal[2],
      ];
      const length = Math.hypot(...rotated);
      normals.push(...rotated.map(value => value / length));
    }
    indices.push(...Array.from(petalMesh.indices, index => index + base));
  }
  return geometry(positions, normals, indices);
}

function worldBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const positions = part.geometry.positions;
    const matrix = part.matrix;
    for (let offset = 0; offset < positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * positions[offset] + matrix[axis + 4] * positions[offset + 1] + matrix[axis + 8] * positions[offset + 2] + matrix[axis + 12];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  return { minimum, maximum };
}

/** A seeded world of shared meshes; colors are linear RGB, sky colors are display RGB. */
export function createNatureWorld({ seed = 67, detail = 'balanced' } = {}) {
  if (!Number.isFinite(seed)) throw new TypeError('Nature seed must be a finite number.');
  if (!Object.hasOwn(DETAIL_PRESETS, detail)) throw new RangeError(`Unknown nature detail: ${detail}`);
  const settings = DETAIL_PRESETS[detail];
  const random = randomGenerator(seed);
  const phase = random() * FULL_TURN;
  const parts = [];
  const foliage = [
    material('foliage', [0.065, 0.19, 0.035]),
    material('foliage', [0.11, 0.27, 0.048]),
    material('foliage', [0.16, 0.32, 0.065]),
    material('foliage', [0.042, 0.13, 0.068]),
    material('foliage', [0.075, 0.22, 0.1]),
  ];
  const meadow = [
    material('grass', [0.18, 0.31, 0.045]),
    material('grass', [0.28, 0.39, 0.08]),
    material('grass', [0.11, 0.24, 0.034]),
  ];
  const stones = [
    material('rock', [0.23, 0.26, 0.23]),
    material('rock', [0.32, 0.34, 0.28]),
    material('rock', [0.17, 0.21, 0.2]),
  ];
  const bark = material('wood', [0.12, 0.068, 0.029]);
  const birchBark = material('wood', [0.62, 0.61, 0.5]);
  const flowerColors = [material('foliage', [0.7, 0.46, 0.07]), material('foliage', [0.36, 0.13, 0.45]), material('foliage', [0.77, 0.72, 0.53])];
  const canopyMesh = organicSphere(settings.segments, settings.rings, 8, 0.065);
  const distantCanopyMesh = organicSphere(10, 6, 5, 0.055);
  const trunkMesh = cylinder(10);
  const rockMesh = organicSphere(12, 8, 4, 0.11);
  const tuftMesh = grassTuft(7, detail === 'low' ? 3 : 5);
  const reedMesh = grassTuft(5, 5, true);
  const blossomMesh = flowerHead(sphere(8, 5));

  function add(name, mesh, position, scale, surface, rotation, blend) {
    const part = { name, geometry: mesh, matrix: transform(position, scale, rotation), material: surface };
    if (blend) part.blend = blend;
    parts.push(part);
  }
  function streamCenter(depth) {
    return Math.sin(depth * 0.09 + 0.7) * 3.7 + Math.sin(depth * 0.034) * 3;
  }
  function streamWidth(depth) {
    return 2.3 + 0.6 * Math.sin(depth * 0.07 + 1) + Math.max(0, depth) * 0.028;
  }
  function terrainHeight(horizontal, depth) {
    const bankDistance = Math.abs(horizontal - streamCenter(depth)) - streamWidth(depth);
    const bank = Math.max(0, Math.min(1, bankDistance / 1.6));
    const hills = 0.65 + 0.28 * Math.sin(horizontal * 0.23 + phase) * Math.cos(depth * 0.16)
      + 0.16 * Math.sin(depth * 0.43 + horizontal * 0.34)
      + Math.max(0, bankDistance - 4) ** 1.6 * 0.025;
    return -0.52 + bank * (hills + 0.52);
  }

  add('Wildflower valley', heightfield(settings.terrain, settings.terrain, [-42, -63], [42, 32], terrainHeight), [0, 0, 0], [1, 1, 1], material('terrain', [0.135, 0.23, 0.052]));
  add('Silverwater stream', streamGeometry(settings.terrain * 3, streamCenter, streamWidth), [0, 0, 0], [1, 1, 1], material('water', [0.034, 0.18, 0.19], 0.13, 0.32));

  for (let ridge = 2; ridge >= 0; ridge--) {
    const centerDepth = -77 - ridge * 33;
    const ridgePhase = phase + ridge * 2.7;
    const ridgeHeight = (horizontal, depth) => {
      const distance = (depth - centerDepth) / 25;
      const silhouette = 13 + ridge * 4 + 9 * Math.sin(horizontal * 0.047 + ridgePhase) ** 2
        + 6 * Math.cos(horizontal * 0.083 - ridgePhase) ** 4;
      const valleyOpening = ridge === 0 ? 1 - 0.65 * Math.exp(-(((horizontal + 3) / 17) ** 2)) : 1;
      const crags = 1.4 * Math.sin(horizontal * 0.42 + depth * 0.29) + 0.7 * Math.cos(horizontal * 0.77 - depth * 0.38);
      return -0.6 + Math.exp(-(distance ** 2)) * (silhouette * valleyOpening + crags);
    };
    const mesh = heightfield(settings.ridge * 2, settings.ridge, [-115, centerDepth - 30], [115, centerDepth + 30], ridgeHeight);
    const colors = [[0.11, 0.18, 0.12], [0.19, 0.27, 0.27], [0.29, 0.36, 0.39]];
    add(`Alpine ridge ${ridge + 1}`, mesh, [0, 0, 0], [1, 1, 1], material('rock', colors[ridge]));
    if (ridge > 0) {
      const snowIndices = [];
      const snowLine = 25 + ridge * 2;
      for (let offset = 0; offset < mesh.indices.length; offset += 3) {
        const triangle = Array.from(mesh.indices.subarray(offset, offset + 3));
        if (triangle.every(index => mesh.positions[index * 3 + 1] > snowLine + Math.sin(mesh.positions[index * 3] * 0.24) * 1.2)) {
          snowIndices.push(...triangle);
        }
      }
      if (snowIndices.length) {
        const snowMesh = { positions: mesh.positions, normals: mesh.normals, indices: new Uint32Array(snowIndices) };
        add(`Snowfields ${ridge + 1}`, snowMesh, [0, 0.025, 0], [1, 1, 1], material('rock', [0.77, 0.81, 0.79], 0.76));
      }
    }
  }

  function tree(horizontal, depth, height, evergreen, index) {
    const ground = terrainHeight(horizontal, depth);
    const trunkRadius = height * (evergreen ? 0.033 : 0.047);
    add(`Tree ${index} trunk`, trunkMesh, [horizontal, ground + height * 0.44, depth], [trunkRadius, height * 0.88, trunkRadius], evergreen ? bark : birchBark, [0.025, random() * FULL_TURN, 0.035], TRUNK_BLEND);
    const mesh = depth < -29 ? distantCanopyMesh : canopyMesh;
    const yaw = random() * FULL_TURN;
    if (evergreen) {
      for (let layer = 0; layer < 6; layer++) {
        const progress = layer / 6;
        const radius = height * (0.25 - progress * 0.17);
        const angle = yaw + layer * 2.4;
        add(`Tree ${index} needles ${layer}`, mesh,
          [horizontal + Math.cos(angle) * radius * 0.15, ground + height * (0.27 + progress * 0.73), depth + Math.sin(angle) * radius * 0.15],
          [radius, height * 0.18, radius * (0.8 + random() * 0.2)], foliage[3 + layer % 2], [0.06, angle, -0.07]);
      }
    } else {
      for (let cluster = 0; cluster < 7; cluster++) {
        const angle = yaw + cluster * 2.399963;
        const radius = height * (0.19 + random() * 0.08);
        const spread = cluster === 6 ? 0 : height * 0.19;
        add(`Tree ${index} crown ${cluster}`, mesh,
          [horizontal + Math.cos(angle) * spread, ground + height * (0.69 + random() * 0.22), depth + Math.sin(angle) * spread],
          [radius * (0.85 + random() * 0.3), radius * (0.75 + random() * 0.3), radius], foliage[cluster % 3], [random() * 0.3, angle, random() * 0.2]);
      }
    }
  }

  // Foreground birches frame the river while the right bank stays open to the camera.
  tree(-10, 9, 7.4, false, 'river birch');
  tree(-14, 5, 8.2, false, 'companion birch');
  tree(13, -7, 7.7, true, 'sentinel pine');
  let treeCount = 0;
  for (let attempt = 0; treeCount < settings.trees && attempt < settings.trees * 12; attempt++) {
    const depth = -56 + random() * 75;
    const horizontal = -35 + random() * 70;
    const distance = Math.abs(horizontal - streamCenter(depth));
    if (distance < streamWidth(depth) + 3) continue;
    if (depth > 6 && horizontal > 1) continue;
    const clusterDensity = Math.sin(horizontal * 0.26 + depth * 0.15 + phase) * Math.cos(depth * 0.23);
    if (clusterDensity < -0.35 && random() < 0.83) continue;
    tree(horizontal, depth, 3.2 + random() * 4.2, random() < 0.62, treeCount);
    treeCount++;
  }

  let grassCount = 0;
  for (let attempt = 0; grassCount < settings.grass && attempt < settings.grass * 8; attempt++) {
    const depth = -34 + random() * 61;
    const horizontal = -24 + random() * 49;
    const bankDistance = Math.abs(horizontal - streamCenter(depth)) - streamWidth(depth);
    if (bankDistance < 0.6) continue;
    const height = terrainHeight(horizontal, depth);
    const scale = 0.5 + random() * 0.8;
    const reed = bankDistance < 1.5 && random() < 0.65;
    add(`Meadow tuft ${grassCount}`, reed ? reedMesh : tuftMesh, [horizontal, height - 0.015, depth], [scale, scale, scale], meadow[grassCount % meadow.length], [0, random() * FULL_TURN, 0]);
    grassCount++;
  }

  for (let index = 0; index < settings.rocks; index++) {
    const depth = -48 + random() * 77;
    const side = index % 2 ? -1 : 1;
    const horizontal = streamCenter(depth) + side * (streamWidth(depth) + random() * 2.4);
    const radius = 0.15 + random() ** 2 * 0.95;
    const ground = terrainHeight(horizontal, depth);
    add(`River stone ${index}`, rockMesh, [horizontal, ground + radius * 0.19, depth], [radius * 1.3, radius * 0.64, radius], stones[index % stones.length], [random() * 0.3, random() * FULL_TURN, random() * 0.4], ROCK_BLEND);
  }
  add('Glacial boulder', rockMesh, [-7.8, terrainHeight(-7.8, 12) + 0.6, 12], [2.3, 1.25, 1.65], stones[1], [0.1, 0.4, 0.2], ROCK_BLEND);
  add('Moss on glacial boulder', organicSphere(12, 8, 4, 0.11), [-7.85, terrainHeight(-7.8, 12) + 1.56, 12], [1.65, 0.25, 1.14], foliage[0], [0.1, 0.4, 0.2]);

  const stemMesh = cylinder(10);
  const flowerPatches = [[-7, 16], [8, 4], [-11, -3], [4, -18]];
  for (let index = 0; index < settings.flowers; index++) {
    const patch = flowerPatches[index % flowerPatches.length];
    const horizontal = patch[0] + (random() - 0.5) * 7;
    const depth = patch[1] + (random() - 0.5) * 6;
    if (Math.abs(horizontal - streamCenter(depth)) < streamWidth(depth) + 0.7) continue;
    const ground = terrainHeight(horizontal, depth);
    const height = 0.3 + random() * 0.36;
    add(`Wildflower ${index} stem`, stemMesh, [horizontal, ground + height / 2, depth], [0.013, height, 0.013], meadow[2]);
    add(`Wildflower ${index} blossom`, blossomMesh, [horizontal, ground + height, depth], [1, 1, 1], flowerColors[index % flowerColors.length], [0.1, random() * FULL_TURN, 0.12]);
  }

  const bridgeDepth = -2;
  const bridgeCenter = streamCenter(bridgeDepth);
  const bridgeLength = streamWidth(bridgeDepth) * 2 + 3.4;
  const timberMesh = box(0.045, 2);
  const fastenerMesh = cylinder(6, 0, 1);
  const warmWood = material('wood', [0.26, 0.13, 0.045], 0.66);
  const lightWood = material('wood', [0.34, 0.19, 0.065], 0.72);
  const iron = material('metal', [0.09, 0.1, 0.095], 0.38, 0.75);
  for (let plank = 0; plank < 36; plank++) {
    const x = bridgeCenter - bridgeLength / 2 + (plank + 0.5) * bridgeLength / 36;
    add(`Footbridge plank ${plank}`, timberMesh, [x, 1.2, bridgeDepth], [bridgeLength / 36 * 0.93, 0.14, 1.7], plank % 3 ? warmWood : lightWood);
    for (const side of [-1, 1]) add(`Footbridge nail ${plank} ${side}`, fastenerMesh, [x, 1.277, bridgeDepth + side * 0.58], [0.018, 0.018, 0.018], iron);
  }
  for (const side of [-1, 1]) {
    add(`Bridge support ${side}`, timberMesh, [bridgeCenter, 1.04, bridgeDepth + side * 0.6], [bridgeLength + 0.3, 0.26, 0.22], warmWood);
    add(`Bridge handrail ${side}`, timberMesh, [bridgeCenter, 2.26, bridgeDepth + side * 0.88], [bridgeLength + 0.3, 0.12, 0.13], lightWood);
    add(`Bridge lower rail ${side}`, timberMesh, [bridgeCenter, 1.73, bridgeDepth + side * 0.88], [bridgeLength, 0.08, 0.1], warmWood);
    for (let post = 0; post < 7; post++) {
      const x = bridgeCenter - bridgeLength / 2 + post * bridgeLength / 6;
      add(`Bridge post ${side} ${post}`, timberMesh, [x, 1.15, bridgeDepth + side * 0.88], [0.13, 2.24, 0.13], warmWood);
      add(`Bridge post cap ${side} ${post}`, timberMesh, [x, 2.3, bridgeDepth + side * 0.88], [0.21, 0.08, 0.21], iron);
    }
  }
  const flagPoleX = bridgeCenter + bridgeLength / 2;
  const flagPoleDepth = bridgeDepth + 0.88;
  add('Flagpole', cylinder(10), [flagPoleX, 3.3, flagPoleDepth], [0.06, 2, 0.06], warmWood);
  const flag = createFlagPart([flagPoleX - 0.03, 4.25, flagPoleDepth]);
  parts.push(flag);
  const camera = { eye: [15, 8, 23], target: [-2, 2, -12] };
  return {
    name: 'Silverwater valley',
    description: 'A winding alpine stream, sunlit birches, wildflower meadows and distant snowfields.',
    parts,
    flag,
    camera,
    bounds: worldBounds(parts),
    environment: {
      fogColor: [0.16, 0.23, 0.26],
      fogDensity: 0.0045,
      skyTop: [0.24, 0.48, 0.7],
      skyBottom: [0.78, 0.86, 0.87],
      lightDirection: [-0.46, 0.77, 0.44],
    },
    points: [
      { name: 'Valley overlook', ...camera },
      { name: 'By the water', eye: [7, 2.4, 14], target: [-3, 1.5, -15] },
      { name: 'Birch grove', eye: [-18, 4, 17], target: [-3, 3, -7] },
      { name: 'Mountain air', eye: [23, 15, -4], target: [-5, 5, -50] },
      { name: 'Footbridge', eye: [bridgeCenter + 8, 3.4, 9], target: [bridgeCenter, 1.2, bridgeDepth] },
    ],
  };
}

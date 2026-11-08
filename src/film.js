import './world-material-shader.js';
import './fog-shader.js';
import { mat4, quat, vec3 } from 'gl-matrix';
import { createCameraPath } from './camera-path.js';
import { createFilmActorRig } from './film-rig.js';
import { fitPerspectiveDistance } from './camera.js';
import { box, cylinder, sphere, torus } from './geometry.js';
import { extrude } from './modeling.js';
import { createAnimationClip, createAnimationPlayer } from './animation.js';
import { sampleScientistHead, sampleScientistHair, sampleScientistEye, scientistSkinColor, scientistEyeColor } from './film-character.js';
import { createMorphPose } from './morph.js';
import { CRADLE, cradlePivot } from './film-physics-definition.js';
import cradleRecording from './film-physics-clip.json' with { type: 'json' };

const CRADLE_CLIP = createAnimationClip(cradleRecording);

export const FILM_DURATION = 187;
const FULL_TURN = Math.PI * 2;
const HALF_PI = Math.PI / 2;

const materials = {
  steel: { tag: 'steel', color: [0.35, 0.39, 0.42], metallic: 0.94, roughness: 0.25, emission: 0 },
  graphite: { tag: 'graphite', color: [0.035, 0.043, 0.05], metallic: 0.7, roughness: 0.34, emission: 0 },
  copper: { tag: 'copper', color: [0.63, 0.25, 0.08], metallic: 0.92, roughness: 0.28, emission: 0 },
  ceramic: { tag: 'ceramic', color: [0.62, 0.57, 0.43], metallic: 0.12, roughness: 0.38, emission: 0 },
  orbit: { tag: 'light', color: [0.63, 0.83, 1], metallic: 0.15, roughness: 0.24, emission: 5 },
  amber: { tag: 'indicator', color: [1, 0.34, 0.035], metallic: 0.1, roughness: 0.3, emission: 4 },
  terrain: { tag: 'terrain', color: [0.38, 0.255, 0.12], metallic: 0, roughness: 0.94, emission: 0 },
  rock: { tag: 'terrain', color: [0.24, 0.19, 0.14], metallic: 0, roughness: 0.95, emission: 0 },
  fire: { tag: 'fire', color: [1, 0.24, 0.012], metallic: 0, roughness: 0.7, emission: 8 },
  core: { tag: 'fire', color: [1, 0.75, 0.26], metallic: 0, roughness: 0.5, emission: 18 },
  smoke: { tag: 'smoke', color: [0.2, 0.14, 0.1], metallic: 0, roughness: 1, emission: 0.04 },
  particle: { tag: 'particle', color: [1, 0.37, 0.035], metallic: 0, roughness: 0.65, emission: 6 },
  wood: { tag: 'wood', color: [0.17, 0.085, 0.035], metallic: 0, roughness: 0.82, emission: 0 },
  plaster: { tag: 'plaster', color: [0.115, 0.125, 0.105], metallic: 0, roughness: 0.95, emission: 0 },
  cloth: { tag: 'cloth', color: [0.022, 0.027, 0.025], metallic: 0, roughness: 0.91, emission: 0 },
  skin: { tag: 'skin', color: [0.29, 0.175, 0.115], metallic: 0, roughness: 0.76, emission: 0 },
  paper: { tag: 'paper', color: [0.73, 0.66, 0.48], metallic: 0, roughness: 0.96, emission: 0 },
  window: { tag: 'window', color: [0.51, 0.57, 0.51], metallic: 0, roughness: 0.8, emission: 1.8 },
  black: { tag: 'cloth', color: [0.003, 0.004, 0.004], metallic: 0, roughness: 1, emission: 0 },
  sage: { tag: 'terrain', color: [0.115, 0.125, 0.068], metallic: 0, roughness: 1, emission: 0 },
  water: { tag: 'water', color: [0.018, 0.025, 0.023], metallic: 0.7, roughness: 0.2, emission: 0 },
  olive: { tag: 'paint', color: [0.13, 0.16, 0.08], metallic: 0.2, roughness: 0.65, emission: 0 },
};

// Sculpted surfaces and landscape meshes are shared by every set.
function sampledSurface(columns, rows, sample) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const horizontal = column / columns;
      const vertical = row / rows;
      const point = sample(horizontal, vertical);
      const epsilon = 0.0001;
      const tangent = vec3.subtract(vec3.create(), sample(horizontal + epsilon, vertical), sample(horizontal - epsilon, vertical));
      const bitangent = vec3.subtract(vec3.create(), sample(horizontal, vertical + epsilon), sample(horizontal, vertical - epsilon));
      const normal = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), tangent, bitangent));
      positions.push(...point);
      normals.push(...normal);
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
  const radius = Math.hypot(horizontal, depth);
  const flats = Math.min(1, radius / 24);
  return -0.12 + flats * (Math.sin(horizontal * 0.071 + depth * 0.041) * 0.35 + Math.sin(depth * 0.17 - horizontal * 0.11) * 0.12 + Math.sin(horizontal * 0.91) * Math.cos(depth * 0.83) * 0.035);
}

function createLandscape() {
  return sampledSurface(140, 140, (horizontal, vertical) => {
    const position = [(horizontal - 0.5) * 400, 0, (0.5 - vertical) * 400];
    position[1] = desertHeight(position[0], position[2]);
    return position;
  });
}

function createRidge() {
  return sampledSurface(180, 20, (horizontal, vertical) => {
    const angle = horizontal * FULL_TURN;
    const peaks = 7 + 8 * Math.abs(Math.sin(angle * 3.1 + 0.4)) + 4 * Math.abs(Math.sin(angle * 11.5)) + 1.7 * Math.sin(angle * 47) + 0.8 * Math.cos(angle * 83);
    const radius = 145 + vertical * 72;
    return [Math.cos(angle) * radius, -1 + Math.max(0, 1 - Math.abs(vertical * 2 - 1)) ** 0.63 * peaks + Math.sin(vertical * 33 + angle * 51) * Math.sin(vertical * Math.PI) * 0.8, Math.sin(angle) * radius];
  });
}

function createFedoraCrown() {
  return sampledSurface(64, 32, (horizontal, vertical) => {
    const angle = horizontal * FULL_TURN;
    const elevation = 0.01 + vertical * (Math.PI - 0.02);
    const height = Math.cos(elevation) * 0.5;
    const radius = Math.sin(elevation) ** 0.28;
    const taper = 0.92 - height * 0.12;
    const horizontalPoint = Math.cos(angle) * radius * taper;
    const depth = Math.sin(angle) * radius * taper;
    const top = Math.exp(-1 * ((height - 0.5) / 0.12) ** 2);
    const crease = 0.17 * top * Math.exp(-1 * (depth / 0.25) ** 2);
    const pinch = 1 - 0.13 * top * Math.max(0, Math.sin(angle));
    return [horizontalPoint * pinch, height - crease, depth];
  });
}

function createScientistHeadMesh() {
  const surfaces = [
    { columns: 192, rows: 160, sample: sampleScientistHead, color: scientistSkinColor },
    ...[-1, 1].map(side => ({
      columns: 64,
      rows: 48,
      sample: (horizontal, vertical, expression) => sampleScientistEye(horizontal, vertical, side, expression === 3),
      color: point => scientistEyeColor(point, side),
    })),
  ];
  const meshes = surfaces.map(surface => {
    const mesh = sampledSurface(surface.columns, surface.rows, surface.sample);
    mesh.colors = new Float32Array(mesh.positions.length);
    for (let index = 0; index < mesh.positions.length; index += 3) {
      mesh.colors.set(surface.color(mesh.positions.subarray(index, index + 3)), index);
    }
    let closedLid;
    mesh.morphTargets = Array.from({ length: 4 }, (_, expression) => {
      const posed = sampledSurface(surface.columns, surface.rows, (horizontal, vertical) => surface.sample(horizontal, vertical, expression));
      if (expression === 0) closedLid = posed;
      let normalReference = mesh.normals;
      let posedNormals = posed.normals;
      if (expression === 1 && surface.sample === sampleScientistHead) {
        // Brow and blink positions add independently. Sample both endpoint
        // surfaces so one static brow delta balances the open and closed lid.
        const combined = sampledSurface(surface.columns, surface.rows, (horizontal, vertical) => {
          const base = sampleScientistHead(horizontal, vertical);
          const closed = sampleScientistHead(horizontal, vertical, 0);
          const brow = sampleScientistHead(horizontal, vertical, 1);
          return closed.map((value, axis) => value + brow[axis] - base[axis]);
        });
        normalReference = closedLid.normals;
        posedNormals = combined.normals;
      }
      const positions = new Float32Array(mesh.positions.length);
      const normals = new Float32Array(mesh.normals.length);
      for (let component = 0; component < positions.length; component++) {
        positions[component] = posed.positions[component] - mesh.positions[component];
        let referenceScale = 1;
        let posedScale = 1;
        if (surface.sample === sampleScientistHead && expression <= 1) {
          const depthComponent = component - component % 3 + 2;
          if (Math.abs(normalReference[depthComponent]) > 0.000001 && Math.abs(posedNormals[depthComponent]) > 0.000001) {
            // Lid depth changes preserve XY. Equal Z components encode normal
            // gradients, which blend correctly before the shader normalizes.
            referenceScale = mesh.normals[depthComponent] / normalReference[depthComponent];
            posedScale = mesh.normals[depthComponent] / posedNormals[depthComponent];
          }
        }
        normals[component] = posedNormals[component] * posedScale - normalReference[component] * referenceScale;
        if (surface.sample === sampleScientistHead && expression === 1) {
          const depthComponent = component - component % 3 + 2;
          const openScale = Math.abs(posed.normals[depthComponent]) > 0.000001 ? mesh.normals[depthComponent] / posed.normals[depthComponent] : 1;
          const openDelta = posed.normals[component] * openScale - mesh.normals[component];
          normals[component] = (normals[component] + openDelta) / 2;
        }
      }
      return { positions, normals };
    });
    return mesh;
  });
  // One retained geometry keeps the iris bound to the head without extra draws.
  const componentCount = meshes.reduce((total, mesh) => total + mesh.positions.length, 0);
  const geometry = {
    positions: new Float32Array(componentCount),
    normals: new Float32Array(componentCount),
    colors: new Float32Array(componentCount),
    indices: new Uint32Array(meshes.reduce((total, mesh) => total + mesh.indices.length, 0)),
    morphTargets: Array.from({ length: 4 }, () => ({ positions: new Float32Array(componentCount), normals: new Float32Array(componentCount) })),
  };
  let componentOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    for (const channel of ['positions', 'normals', 'colors']) geometry[channel].set(mesh[channel], componentOffset);
    for (let index = 0; index < mesh.indices.length; index++) geometry.indices[indexOffset + index] = mesh.indices[index] + componentOffset / 3;
    for (let target = 0; target < 4; target++) {
      for (const channel of ['positions', 'normals']) geometry.morphTargets[target][channel].set(mesh.morphTargets[target][channel], componentOffset);
    }
    componentOffset += mesh.positions.length;
    indexOffset += mesh.indices.length;
  }
  return geometry;
}

function createFedoraBrim() {
  return sampledSurface(64, 20, (horizontal, vertical) => {
    const angle = horizontal * FULL_TURN;
    const elevation = 0.01 + vertical * (Math.PI - 0.02);
    const radius = Math.sin(elevation);
    const curl = radius ** 4 * (0.10 * Math.cos(angle) ** 2 - 0.05 * Math.sin(angle));
    return [Math.cos(angle) * radius, Math.cos(elevation) * 0.035 + curl, Math.sin(angle) * radius];
  });
}

function createCoat() {
  const mesh = sampledSurface(32, 20, (horizontal, vertical) => {
    const angle = horizontal * FULL_TURN;
    const shoulder = Math.exp(-1 * ((vertical - 0.83) / 0.2) ** 2);
    const width = 0.76 + 0.25 * shoulder - 0.48 * Math.exp(-1 * ((vertical - 1.04) / 0.13) ** 2);
    const fold = 1 + 0.024 * Math.sin(angle * 7 + vertical * 3);
    return [Math.cos(angle) * width * fold, vertical - 0.5, Math.sin(angle) * (0.81 + 0.1 * shoulder) * fold];
  });
  // Unlike the head latitude, the coat profile runs upward. Reverse its winding and normals.
  for (let index = 0; index < mesh.normals.length; index++) mesh.normals[index] *= -1;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const second = mesh.indices[index + 1];
    mesh.indices[index + 1] = mesh.indices[index + 2];
    mesh.indices[index + 2] = second;
  }
  return mesh;
}

function createBuilder(meshes) {
  const parts = [];
  function add(name, mesh, position, scale, material, rotation = [0, 0, 0]) {
    const orientation = quat.fromEuler(quat.create(), ...rotation.map(angle => angle * 180 / Math.PI));
    const matrix = mat4.fromRotationTranslationScale(mat4.create(), orientation, position, scale);
    const part = { name, geometry: meshes[mesh], matrix, material: typeof material === 'string' ? materials[material] : material };
    parts.push(part);
    return part;
  }
  function beam(name, start, end, radius, material = 'steel') {
    const difference = vec3.subtract(vec3.create(), end, start);
    const length = vec3.length(difference);
    const direction = vec3.scale(vec3.create(), difference, 1 / length);
    const orientation = quat.rotationTo(quat.create(), [0, 1, 0], direction);
    const center = start.map((value, axis) => (value + end[axis]) / 2);
    parts.push({
      name,
      geometry: meshes.cylinder,
      matrix: mat4.fromRotationTranslationScale(mat4.create(), orientation, center, [radius, length, radius]),
      material: materials[material],
    });
  }
  function cable(name, points, radius, material = 'graphite', segments = 8) {
    const [start, bend, end] = points;
    let previous = start;
    for (let index = 1; index <= segments; index++) {
      const fraction = index / segments;
      const next = start.map((value, axis) => (1 - fraction) ** 2 * value + 2 * (1 - fraction) * fraction * bend[axis] + fraction ** 2 * end[axis]);
      beam(name, previous, next, radius, material);
      previous = next;
    }
  }
  return { parts, add, beam, cable };
}

function createApparatus(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  add('Optical bench', 'box', [0, -0.55, 0], [7, 0.22, 4.5], 'graphite');
  add('Pressure chamber', 'cylinder', [0, 0.5, 0], [0.92, 2.5, 0.92], 'graphite', [HALF_PI, 0, 0]);
  for (let index = 0; index < 11; index++) {
    const depth = -1.2 + index * 0.24;
    add('Machined cooling collar', 'ring', [0, 0.5, depth], [1.02, 1.02, 0.6], index % 2 ? 'steel' : 'copper');
    for (let bolt = 0; bolt < 12; bolt++) {
      const angle = bolt / 12 * FULL_TURN;
      add('Hexagonal collar fastener', 'bolt', [Math.cos(angle) * 1.02, 0.5 + Math.sin(angle) * 1.02, depth + 0.055], [0.04, 0.09, 0.04], 'steel', [HALF_PI, 0, 0]);
    }
  }
  add('Front iris', 'cylinder', [0, 0.5, 1.3], [0.8, 0.05, 0.8], 'steel', [HALF_PI, 0, 0]);
  add('Dark optical aperture', 'cylinder', [0, 0.5, 1.34], [0.5, 0.06, 0.5], 'graphite', [HALF_PI, 0, 0]);
  add('Incandescent filament rim', 'thinRing', [0, 0.5, 1.385], [0.48, 0.48, 0.48], 'amber');
  for (let index = 0; index < 64; index++) {
    const angle = index / 64 * FULL_TURN;
    add('Engraved calibration mark', 'box', [Math.cos(angle) * 0.68, 0.5 + Math.sin(angle) * 0.68, 1.342], [index % 8 ? 0.036 : 0.08, 0.009, 0.009], 'graphite', [0, 0, angle]);
  }
  for (const side of [-1, 1]) {
    add('Ceramic stand', 'box', [side * 1.2, -0.05, 0], [0.28, 0.8, 2.8], 'ceramic');
    for (let index = 0; index < 9; index++) {
      const depth = -1 + index * 0.25;
      beam('Copper vacuum pipe', [side * 1.06, 0.38, depth], [side * 1.8, 0.65, depth], 0.035, 'copper');
      add('Electrical feedthrough', 'cylinder', [side * 1.8, 0.44, depth], [0.075, 0.38, 0.075], 'ceramic');
      add('Feedthrough terminal', 'sphere', [side * 1.8, 0.67, depth], [0.065, 0.065, 0.065], 'copper');
    }
  }
  for (let index = 0; index < 6; index++) {
    add('Instrument rack', 'box', [-2.4, -0.27 + index * 0.23, -0.6], [0.8, 0.2, 1.4], 'graphite');
    add('Analog dial bezel', 'ring', [-2.4, -0.27 + index * 0.23, 0.13], [0.075, 0.075, 0.4], 'steel');
  }
  addCradle(builder);
  return builder.parts;
}

function addCradle({ add, beam }) {
  add('Cradle polished base', 'box', [0, -0.32, CRADLE.depth], [3.2, 0.16, 0.64], 'graphite');
  for (const horizontal of [-1.45, 1.45]) {
    for (const depthOffset of [-0.12, 0.12]) {
      beam('Cradle brass frame', [horizontal, -0.24, CRADLE.depth + depthOffset], [horizontal, CRADLE.pivotHeight, CRADLE.depth + depthOffset], 0.025, 'copper');
    }
  }
  for (const depthOffset of [-0.12, 0.12]) {
    beam('Cradle upper rail', [-1.45, CRADLE.pivotHeight, CRADLE.depth + depthOffset], [1.45, CRADLE.pivotHeight, CRADLE.depth + depthOffset], 0.025, 'copper');
  }
  const cordMaterial = { tag: 'cord', color: [0.13, 0.15, 0.16], metallic: 0.5, roughness: 0.45, emission: 0 };
  for (let index = 0; index < CRADLE.count; index++) {
    const pivot = cradlePivot(index);
    const ball = add(`Cradle ball ${index}`, 'sphere', [pivot[0], pivot[1] - CRADLE.length, pivot[2]], [CRADLE.radius, CRADLE.radius, CRADLE.radius], 'steel');
    for (const side of [-1, 1]) {
      const cord = add(`Cradle suspension ${index} ${side}`, 'cylinder', pivot, [0.0035, CRADLE.length, 0.0035], cordMaterial);
      cord.cradleCord = { ball, pivot: [pivot[0], pivot[1], pivot[2] + side * 0.12], depthOffset: side * 0.05 };
    }
  }
}

function createCradleAnimation(parts) {
  const player = createAnimationPlayer(CRADLE_CLIP, parts.filter(part => part.name.startsWith('Cradle ball ')));
  const cords = parts.filter(part => part.cradleCord);
  const direction = vec3.create();
  const center = vec3.create();
  const rotation = quat.create();
  const scale = vec3.fromValues(0.0035, 1, 0.0035);
  const vertical = vec3.fromValues(0, 1, 0);
  return time => {
    player.apply(time);
    for (const cord of cords) {
      const { ball, pivot, depthOffset } = cord.cradleCord;
      direction[0] = ball.matrix[12] - pivot[0];
      direction[1] = ball.matrix[13] - pivot[1];
      direction[2] = ball.matrix[14] + depthOffset - pivot[2];
      for (let axis = 0; axis < 3; axis++) center[axis] = pivot[axis] + direction[axis] / 2;
      scale[1] = vec3.length(direction);
      vec3.normalize(direction, direction);
      quat.rotationTo(rotation, vertical, direction);
      mat4.fromRotationTranslationScale(cord.matrix, rotation, center, scale);
    }
  };
}

function createAtom(meshes) {
  const { parts, add } = createBuilder(meshes);
  // A practical-looking tangle of heated filaments, with depth and a dark center.
  for (let index = 0; index < 32; index++) {
    const radius = 0.7 + index * 0.052;
    add('Heated filament orbit', 'thinRing', [Math.sin(index * 2.3) * 0.3, 0, Math.cos(index * 1.7) * 0.3], [radius * 1.9, radius * 0.7, radius], index % 7 ? 'steel' : 'orbit', [index * 0.127, index * 0.207, index * 0.043]);
  }
  for (let index = 0; index < 190; index++) {
    const angle = index * 2.399963;
    const radius = 1.8 + index % 13 * 0.23;
    add('Suspended luminous dust', 'rock', [Math.cos(angle) * radius, Math.sin(index * 1.7) * 2.5, Math.sin(angle) * radius], [0.009, 0.009, 0.009], index % 6 ? 'particle' : 'orbit');
  }
  return parts;
}

function createWaveChamber(meshes) {
  const { parts, add } = createBuilder(meshes);
  add('Black reflecting pool', 'box', [0, -0.08, 0], [30, 0.08, 30], 'water');
  for (let index = 0; index < 36; index++) {
    const radius = 0.18 + index * 0.097;
    add('Interference ripple crest', 'thinRing', [0, -0.012, 0], [radius, radius * 0.91, 0.14], index % 4 ? 'steel' : 'copper', [HALF_PI, 0, 0]);
  }
  for (let index = 0; index < 100; index++) {
    const angle = index * 2.399963;
    const radius = 0.6 + index % 19 * 0.15;
    add('Suspended droplet', 'sphere', [Math.cos(angle) * radius, 0.12 + index % 17 * 0.031, Math.sin(angle) * radius], [0.008, 0.021, 0.008], 'steel');
  }
  return parts;
}

function addDesert(builder) {
  const { add, beam } = builder;
  add('Undulating alluvial plain', 'landscape', [0, 0, 0], [1, 1, 1], 'terrain');
  add('Layered mountain horizon', 'ridge', [0, 0, 0], [1, 1, 1], 'rock');
  add('Distant blue mountain horizon', 'ridge', [0, 1, 0], [1.42, 0.8, 1.42], { ...materials.rock, color: [0.18, 0.2, 0.19] }, [0, 0.12, 0]);
  for (let index = 0; index < 180; index++) {
    const angle = index * 2.399963;
    const radius = 3 + (index / 180) ** 0.7 * 93;
    const horizontal = Math.cos(angle) * radius;
    const depth = Math.sin(angle) * radius;
    const ground = desertHeight(horizontal, depth);
    const size = 0.12 + index % 7 * 0.07;
    add('Scattered weathered shale', 'rock', [horizontal, ground, depth], [size * 2, size * 0.4, size], 'rock', [0.2, angle, 0.1]);
    for (let stem = 0; stem < 3; stem++) {
      const lean = angle + stem * 2.1;
      beam('Dry sagebrush stem', [horizontal + 0.8, ground, depth], [horizontal + 0.8 + Math.cos(lean) * size, ground + size * (0.5 + stem * 0.15), depth + Math.sin(lean) * size], 0.0045, 'sage');
    }
  }
}

function createDesert(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  addDesert(builder);
  for (const horizontal of [-1.3, 1.3]) {
    for (const depth of [-1.3, 1.3]) {
      beam('Test tower leg', [horizontal * 1.5, 0, depth * 1.5], [horizontal, 10, depth], 0.065);
      for (let level = 0; level < 5; level++) {
        beam('Tower diagonal brace', [horizontal, level * 2, depth], [-horizontal, level * 2 + 2, depth], 0.035);
        beam('Tower transverse brace', [horizontal, level * 2, depth], [horizontal, level * 2 + 2, -depth], 0.035);
      }
    }
  }
  add('Tower platform', 'box', [0, 10, 0], [3.2, 0.18, 3.2], 'steel');
  add('Suspended test vessel', 'sphere', [0, 11, 0], [0.85, 0.95, 0.85], 'graphite');
  add('Vessel equatorial seam', 'ring', [0, 11, 0], [0.87, 0.87, 0.87], 'steel', [HALF_PI, 0, 0]);
  for (let index = 0; index < 10; index++) {
    add('Ladder rung', 'cylinder', [1.5, 0.5 + index, 1.4], [0.027, 0.7, 0.027], 'steel', [0, 0, HALF_PI]);
  }
  beam('Signal cable', [0.15, 10, 0], [9, 0, 2], 0.021, 'graphite');
  add('Remote junction box', 'box', [9, 0.3, 2], [0.8, 0.7, 0.8], 'graphite');
  for (let index = 0; index < 19; index++) {
    const depth = 3 + index * 3.4;
    add('Amber ground signal lamp', 'sphere', [1.8, 0.07, depth], [0.055, 0.035, 0.055], 'amber');
  }
  for (const side of [-1, 1]) {
    add('Tower work lamp', 'sphere', [side * 1.15, 10.25, 0.95], [0.055, 0.08, 0.055], 'window');
    beam('Tower hoist upright', [side * 1.3, 10, -0.5], [side * 1.3, 14.6, -0.5], 0.045, 'steel');
    beam('Guy wire', [side * 1.3, 9.6, 0], [side * 17, 0, 9], 0.012, 'graphite');
  }
  beam('Tower hoist lintel', [-1.3, 14.6, -0.5], [1.3, 14.6, -0.5], 0.045, 'steel');
  return builder.parts;
}

function createIgnition(meshes) {
  const builder = createBuilder(meshes);
  addDesert(builder);
  // The player removes these proxy surfaces when enabling the volumetric explosion pass.
  builder.add('Ignition fallback core', 'sphere', [0, 7, 0], [6.8, 7, 6.8], 'fire');
  builder.add('Ignition fallback cloud', 'sphere', [0, 13, 0], [7, 4, 7], 'smoke');
  return builder.parts;
}

function addScientist(builder, position = [0, 0, 0], hat = true, rotation = 0) {
  const { add } = builder;
  const actorName = `Scientist ${builder.parts.length}`;
  const expressionPose = createMorphPose(4);
  const joints = new Map();
  const transform = point => [position[0] + point[0] * Math.cos(rotation) + point[2] * Math.sin(rotation), position[1] + point[1], position[2] - point[0] * Math.sin(rotation) + point[2] * Math.cos(rotation)];
  const actorMaterials = {
    skin: { ...materials.skin, color: [0.48, 0.285, 0.19], roughness: 0.72 },
    cloth: { ...materials.cloth, color: [0.075, 0.083, 0.075], roughness: 0.89 },
    graphite: { ...materials.graphite, color: [0.035, 0.031, 0.025], metallic: 0, roughness: 0.83 },
    lapel: { ...materials.cloth, color: [0.055, 0.061, 0.055], roughness: 0.83 },
    paper: { ...materials.paper, color: [0.8, 0.74, 0.6], roughness: 0.84 },
    black: { ...materials.black, color: [0.012, 0.015, 0.017], roughness: 0.82 },
    face: { ...materials.skin, color: [1, 1, 1], roughness: 0.74 },
  };
  const shape = (name, mesh, point, scale, material, angles = [0, 0, 0]) => {
    const surface = actorMaterials[material] ?? materials[material];
    const part = add(name, mesh, transform(point), scale, surface);
    const local = quat.fromEuler(quat.create(), ...angles.map(angle => angle * 180 / Math.PI));
    const orientation = quat.multiply(quat.create(), quat.setAxisAngle(quat.create(), [0, 1, 0], rotation), local);
    mat4.fromRotationTranslationScale(part.matrix, orientation, transform(point), scale);
    const head = name === 'Continuous sculpted head' || name === 'Swept hair' || name === 'Ear silhouette' || name.startsWith('Fedora') || name.startsWith('Facial ');
    const arm = ['Jacket sleeve', 'Shirt cuff', 'Resting hand silhouette'].includes(name);
    if (head || arm) {
      const side = point[0] < 0 ? -1 : 1;
      const jointName = head ? `${actorName} head` : `${actorName} arm ${side}`;
      if (!joints.has(jointName)) {
        joints.set(jointName, {
          name: jointName,
          kind: head ? 'head' : 'arm',
          side,
          rotation,
          pivot: transform(head ? [0, 1.575, -0.005] : [side * 0.205, 1.455, -0.018]),
          axis: head ? [0, 1, 0] : [Math.cos(rotation), 0, -Math.sin(rotation)],
        });
      }
      part.actorJoint = joints.get(jointName);
    }
    return part;
  };
  for (const side of [-1, 1]) {
    shape('Leather oxford', 'sphere', [side * 0.115, 0.062, 0.052], [0.073, 0.06, 0.15], 'graphite');
    shape('Tailored wool trouser', 'cylinder', [side * 0.108, 0.48, -0.01], [0.084, 0.81, 0.077], 'cloth');
    shape('Jacket sleeve', 'sphere', [side * 0.242, 1.17, -0.018], [0.072, 0.28, 0.079], 'cloth', [0.04, 0, side * 0.105]);
    shape('Shirt cuff', 'cylinder', [side * 0.276, 0.94, 0.007], [0.052, 0.04, 0.052], 'paper');
    shape('Resting hand silhouette', 'sphere', [side * 0.28, 0.858, 0.016], [0.047, 0.079, 0.035], 'skin');
    const mirror = side < 0 ? Math.PI : 0;
    shape('Notched wool lapel', 'lapel', [0, 1.36, 0.125], [0.9, 1.08, 1], 'lapel', [0, mirror, 0]);
    shape('Shirt collar', 'shirtCollar', [0, 1.525, 0.092], [0.9, 0.9, 1], 'paper', [0, mirror, 0]);
    shape('Ear silhouette', 'sphere', [side * 0.104, 1.668, -0.004], [0.018, 0.036, 0.026], 'skin');
  }
  shape('Sculpted tailored jacket', 'coat', [0, 1.185, 0], [0.225, 0.73, 0.125], 'cloth');
  shape('Tailored shoulder line', 'sphere', [0, 1.465, -0.012], [0.212, 0.042, 0.081], 'cloth');
  shape('Shirt front', 'box', [0, 1.425, 0.114], [0.08, 0.22, 0.012], 'paper');
  shape('Tie knot', 'sphere', [0, 1.50, 0.121], [0.013, 0.014, 0.008], 'graphite');
  shape('Narrow silk tie', 'box', [0, 1.402, 0.128], [0.017, 0.17, 0.006], 'graphite');
  shape('Welt breast pocket', 'box', [-0.135, 1.3, 0.13], [0.075, 0.008, 0.007], 'lapel');
  for (const height of [1.18, 1.08]) {
    shape('Horn jacket button', 'sphere', [0.017, height, 0.136], [0.009, 0.009, 0.003], 'graphite');
  }
  shape('Neck', 'sphere', [0, 1.551, -0.011], [0.057, 0.064, 0.057], 'skin');
  const face = shape('Continuous sculpted head', 'head', [0, 1.686, -0.01], [0.112, 0.157, 0.106], 'face');
  face.morph = expressionPose;
  shape('Swept hair', 'hair', [0, 1.686, -0.01], [0.114, 0.158, 0.108], 'graphite');
  if (hat) {
    shape('Fedora sweeping brim', 'hatBrim', [0, 1.799, 0], [0.169, 0.11, 0.145], 'cloth', [-0.06, 0, -0.035]);
    shape('Fedora tapered felt crown', 'hatCrown', [0, 1.844, -0.017], [0.123, 0.10, 0.112], 'cloth');
    shape('Fedora grosgrain band', 'cylinder', [0, 1.815, -0.017], [0.123, 0.026, 0.111], 'graphite');
  }
}

function addRoom(builder, laboratory = false) {
  const { add, beam } = builder;
  add('Shadowed floor', 'box', [0, -0.1, 0], [12, 0.15, 12], 'wood');
  add('Rear plaster below windows', 'box', [0, 0.6, -4.8], [12, 1.2, 0.15], 'plaster');
  add('Rear plaster above windows', 'box', [0, 4.4, -4.8], [12, 0.6, 0.15], 'plaster');
  const wallPiers = [[-6, -4.46], [-2.74, -1.16], [0.56, 2.14], [3.86, 6]];
  for (const [left, right] of wallPiers) {
    add('Plaster pier between openings', 'box', [(left + right) / 2, 2.65, -4.8], [right - left, 2.9, 0.15], 'plaster');
  }
  add('Side plaster wall', 'box', [-5.8, 2.3, 0], [0.15, 4.7, 12], 'plaster');
  add('Ceiling in shadow', 'box', [0, 4.65, 0], [12, 0.12, 12], 'black');
  for (let plank = 0; plank < 30; plank++) {
    add('Floorboard joint', 'box', [-5.8 + plank * 0.4, -0.018, 0], [0.013, 0.006, 12], 'graphite');
  }
  for (let index = 0; index < 3; index++) {
    const horizontal = -3.6 + index * 3.3;
    add('Tall luminous window', 'box', [horizontal, 2.65, -4.69], [1.65, 2.8, 0.04], 'window').castShadow = false;
    for (const side of [-1, 1]) {
      add('Window jamb', 'box', [horizontal + side * 0.86, 2.65, -4.61], [0.09, 2.95, 0.15], 'wood');
    }
    for (let slat = 0; slat < 19; slat++) {
      add('Venetian blind slat', 'box', [horizontal, 1.31 + slat * 0.148, -4.49], [1.72, 0.059, 0.13], 'wood', [-0.3, 0, 0]);
    }
    add('Window central mullion', 'box', [horizontal, 2.65, -4.42], [0.06, 2.8, 0.1], 'wood');
    add('Window sill', 'box', [horizontal, 1.2, -4.4], [1.95, 0.12, 0.52], 'wood');
  }
  for (let index = 0; index < 8; index++) {
    add('Timber wall batten', 'box', [-5.3 + index * 1.5, 1.05, -4.63], [0.05, 2, 0.05], 'wood');
  }
  add('Work desk top', 'box', [0, 0.79, 0], [3.8, 0.10, 1.6], laboratory ? 'graphite' : 'wood');
  for (const horizontal of [-1.65, 1.65]) {
    for (const depth of [-0.63, 0.63]) {
      add('Square desk leg', 'box', [horizontal, 0.39, depth], [0.075, 0.78, 0.075], 'wood');
    }
  }
  add('Slate chalkboard frame', 'box', [3.4, 2.55, -4.36], [2.4, 1.55, 0.16], 'wood');
  add('Slate chalkboard surface', 'box', [3.4, 2.55, -4.25], [2.28, 1.41, 0.025], 'black');
  for (let index = 0; index < 65; index++) {
    const horizontal = 2.38 + index % 13 * 0.15;
    const height = 1.98 + Math.floor(index / 13) * 0.24;
    beam('Chalk equation stroke', [horizontal, height, -4.224], [horizontal + 0.07, height + Math.sin(index * 2.7) * 0.065, -4.224], 0.003, 'paper');
  }
  for (let index = 0; index < 14; index++) {
    add('Loose research sheet', 'box', [-1.1 + index % 4 * 0.48, 0.846 + index * 0.002, -0.42 + Math.floor(index / 4) * 0.25], [0.4, 0.002, 0.26], 'paper', [0, index * 0.13, 0]);
  }
  for (let shelf = 0; shelf < 4; shelf++) {
    add('Bookshelf plank', 'box', [-4.6, 0.4 + shelf * 0.48, -3.8], [1.5, 0.055, 0.35], 'wood');
    for (let index = 0; index < 11; index++) {
      add('Cloth bound volume', 'box', [-5.2 + index * 0.12, 0.61 + shelf * 0.48, -3.8], [0.086, 0.34 + index % 3 * 0.02, 0.29], index % 3 ? 'wood' : 'cloth', [0, 0, index % 5 === 0 ? 0.09 : 0]);
    }
  }
  for (let index = 0; index < 3; index++) {
    const horizontal = -2.8 + index * 2.8;
    beam('Pendant lamp cable', [horizontal, 4.6, -1], [horizontal, 3.45, -1], 0.014, 'graphite');
    add('Pendant reflector', 'sphere', [horizontal, 3.4, -1], [0.28, 0.08, 0.28], 'graphite');
    add('Pendant warm bulb', 'sphere', [horizontal, 3.34, -1], [0.066, 0.045, 0.066], 'amber');
  }
}

function createOffice(meshes, laboratory = false) {
  const builder = createBuilder(meshes);
  addRoom(builder, laboratory);
  addScientist(builder, [0, 0, -1.7], !laboratory, laboratory ? 0.85 : -0.6);
  if (laboratory) {
    addScientist(builder, [2.8, 0, -1], false, -0.7);
    for (let index = 0; index < 8; index++) {
      builder.add('Vacuum amplifier housing', 'box', [-1.2 + index % 4 * 0.8, 1.09, -0.4 + Math.floor(index / 4) * 0.8], [0.54, 0.32, 0.4], 'graphite');
      const horizontal = -1.2 + index % 4 * 0.8;
      const depth = -0.4 + Math.floor(index / 4) * 0.8;
      builder.add('Bakelite valve socket', 'cylinder', [horizontal, 1.27, depth], [0.12, 0.055, 0.12], 'graphite');
      builder.add('Vacuum tube cathode', 'cylinder', [horizontal, 1.43, depth], [0.032, 0.24, 0.032], 'steel');
      for (let ring = 0; ring < 4; ring++) {
        builder.add('Vacuum tube grid hoop', 'thinRing', [horizontal, 1.31 + ring * 0.07, depth], [0.073, 0.073, 0.28], 'steel', [HALF_PI, 0, 0]);
      }
      for (const side of [-1, 1]) {
        builder.beam('Glowing valve filament', [horizontal + side * 0.048, 1.32, depth + 0.025], [horizontal + side * 0.045, 1.54, depth + 0.025], 0.004, 'amber');
        builder.beam('Valve glass edge reflection', [horizontal + side * 0.078, 1.29, depth], [horizontal + side * 0.071, 1.57, depth], 0.003, 'steel');
      }
    }
  } else {
    builder.add('Brass desk lamp stem', 'cylinder', [-1.45, 1.11, 0.25], [0.035, 0.7, 0.035], 'copper');
    builder.add('Lamp shade', 'sphere', [-1.45, 1.43, 0.25], [0.24, 0.075, 0.17], 'olive');
  }
  return builder.parts;
}

function addVehicle(builder, position) {
  const firstPart = builder.parts.length;
  const { add, beam } = builder;
  const place = point => point.map((value, axis) => value + position[axis]);
  add('Army jeep chassis', 'box', place([0, 0.54, 0]), [1.6, 0.26, 3.1], 'olive');
  add('Flat hood', 'box', place([0, 0.95, 0.9]), [1.55, 0.42, 1.2], 'olive');
  add('Rear tub', 'box', place([0, 0.87, -1.1]), [1.5, 0.48, 0.5], 'olive');
  for (const side of [-1, 1]) {
    add('Jeep body side', 'box', place([side * 0.73, 0.84, -0.5]), [0.12, 0.42, 1.55], 'olive');
    for (const depth of [-1, 1]) {
      add('Rubber road tire', 'tire', place([side * 0.85, 0.47, depth]), [0.33, 0.33, 0.45], 'black', [0, HALF_PI, 0]);
      add('Steel wheel hub', 'cylinder', place([side * 0.98, 0.47, depth]), [0.26, 0.025, 0.26], 'olive', [0, 0, HALF_PI]);
      add('Wheel axle cap', 'cylinder', place([side * 1.0, 0.47, depth]), [0.073, 0.045, 0.073], 'graphite', [0, 0, HALF_PI]);
      for (let lug = 0; lug < 6; lug++) {
        const angle = lug * FULL_TURN / 6;
        // Wheel fasteners are subpixel in the settlement shots; reuse the hub mesh.
        add('Wheel lug bolt', 'cylinder', place([side * 1.02, 0.47 + Math.cos(angle) * 0.11, depth + Math.sin(angle) * 0.11]), [0.014, 0.023, 0.014], 'steel', [0, 0, HALF_PI]);
      }
      add('Rolled steel wheel fender', 'box', place([side * 0.74, 0.96, depth]), [0.5, 0.065, 0.93], 'olive');
    }
    beam('Windshield pillar', place([side * 0.7, 1.05, 0.3]), place([side * 0.7, 1.9, 0.15]), 0.035, 'olive');
    add('Headlight', 'sphere', place([side * 0.53, 1.01, 1.54]), [0.14, 0.14, 0.04], 'ceramic');
  }
  beam('Windshield top rail', place([-0.7, 1.9, 0.15]), place([0.7, 1.9, 0.15]), 0.035, 'olive');
  for (let index = 0; index < 8; index++) {
    add('Radiator grille slot', 'box', place([-0.4 + index * 0.115, 0.9, 1.56]), [0.04, 0.34, 0.025], 'graphite');
  }
  add('Spare wheel', 'tire', place([0, 0.95, -1.54]), [0.33, 0.33, 0.45], 'black');
  add('Driver seat', 'box', place([-0.38, 0.98, -0.55]), [0.55, 0.14, 0.65], 'cloth');
  add('Passenger seat cushion', 'box', place([0.37, 0.99, -0.55]), [0.55, 0.13, 0.65], 'cloth');
  for (const side of [-1, 1]) {
    add('Seat back', 'box', place([side * 0.37, 1.23, -0.82]), [0.55, 0.45, 0.12], 'cloth', [-0.12, 0, 0]);
    add('Hood fold seam', 'box', place([side * 0.69, 1.167, 0.9]), [0.012, 0.007, 1.05], 'graphite');
    beam('Body grab handle', place([side * 0.81, 0.91, -1.0]), place([side * 0.81, 0.91, -0.74]), 0.02, 'steel');
  }
  add('Steering wheel', 'thinRing', place([-0.37, 1.3, -0.15]), [0.21, 0.21, 0.8], 'graphite', [0.52, 0, 0]);
  beam('Steering column', place([-0.37, 1.3, -0.15]), place([-0.37, 0.82, 0.25]), 0.025, 'graphite');
  beam('Front bumper', place([-1.02, 0.6, 1.68]), place([1.02, 0.6, 1.68]), 0.07, 'olive');
  for (const part of builder.parts.slice(firstPart)) part.motionGroup = 'vehicle';
}

function createSettlement(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  addDesert(builder);
  add('Unpaved main street', 'box', [0, -0.12, 0], [8, 0.045, 90], 'rock');
  for (const side of [-1, 1]) {
    for (let index = 0; index < 7; index++) {
      const horizontal = side * (12 + index % 2 * 4);
      const depth = -32 + index * 11;
      add('Research hut walls', 'box', [horizontal, 1.4, depth], [7, 2.8, 5.6], index % 3 ? 'wood' : 'plaster');
      for (const pitch of [-1, 1]) {
        add('Pitched corrugated roof', 'box', [horizontal + pitch * 1.8, 3.15, depth], [4.15, 0.11, 6.2], 'graphite', [0, 0, pitch * -0.36]);
      }
      for (const offset of [-2.2, 0, 2.2]) {
        add('Research hut window', 'box', [horizontal + offset, 1.6, depth + 2.83], [1, 0.9, 0.05], { ...materials.graphite, color: [0.035, 0.055, 0.067], metallic: 0.35, roughness: 0.2 });
        add('Window divider', 'box', [horizontal + offset, 1.6, depth + 2.87], [0.06, 0.95, 0.06], 'wood');
      }
      add('Dark hut doorway', 'box', [horizontal - 1.1, 1.05, depth + 2.86], [0.8, 2.1, 0.035], 'black');
      for (let siding = 0; siding < 9; siding++) {
        add('Weatherboard siding seam', 'box', [horizontal, 0.25 + siding * 0.29, depth + 2.84], [7, 0.018, 0.018], 'graphite');
      }
      beam('Telephone pole', [side * 5.5, 0, depth], [side * 5.5, 6, depth], 0.095, 'wood');
      beam('Pole crossbar', [side * 4.5, 5.5, depth], [side * 6.5, 5.5, depth], 0.055, 'wood');
      if (index < 6) {
        beam('Telephone wire', [side * 5.1, 5.6, depth], [side * 5.1, 5.6, depth + 11], 0.012, 'graphite');
      }
    }
  }
  addVehicle(builder, [1, -0.17, 8]);
  addVehicle(builder, [-2, -0.17, -12]);
  addScientist(builder, [4, 0, 6]);
  addScientist(builder, [5.3, 0, 5.5], false, -0.8);
  return builder.parts;
}

function addGadget(builder, center = [0, 2, 0]) {
  const firstPart = builder.parts.length;
  const { add, beam, cable } = builder;
  const place = point => point.map((value, axis) => value + center[axis]);
  add('Gadget steel pressure vessel', 'sphere', center, [0.97, 1.02, 0.97], 'graphite');
  for (let latitude = 0; latitude < 5; latitude++) {
    const elevation = -0.78 + latitude * 0.39;
    const radius = Math.sqrt(1 - elevation * elevation);
    add('Gadget circumferential seam', 'thinRing', place([0, elevation, 0]), [radius * 0.975, radius * 0.975, 1], 'steel', [HALF_PI, 0, 0]);
    for (let terminal = 0; terminal < 10; terminal++) {
      const angle = terminal / 10 * FULL_TURN + latitude * 0.18;
      const tip = [Math.cos(angle) * radius * 1.015, elevation * 1.015, Math.sin(angle) * radius * 1.015];
      const outer = [tip[0] * 1.11, tip[1] * 1.04, tip[2] * 1.11];
      beam('Radial connector socket', place(tip), place(outer), 0.055, 'steel');
      add('Ivory connector insulator', 'sphere', place(outer), [0.042, 0.042, 0.042], 'ceramic');
      const anchor = [Math.cos(angle) * 0.51, 1.73, Math.sin(angle) * 0.51];
      const bend = [tip[0] * (1.25 + latitude * 0.07), tip[1] + 0.6, tip[2] * (1.28 + latitude * 0.09)];
      cable('Sagging detonator lead', [place(outer), place(bend), place(anchor)], 0.011, terminal % 3 ? 'graphite' : 'copper', 7);
      add('Connector taped label', 'box', place([outer[0] * 1.04, outer[1], outer[2] * 1.04]), [0.037, 0.13, 0.018], 'paper', [0, HALF_PI - angle, 0.1]);
    }
  }
  for (let index = 0; index < 28; index++) {
    const angle = index / 28 * FULL_TURN;
    add('Equatorial hexagonal bolt', 'bolt', place([Math.cos(angle), 0, Math.sin(angle)]), [0.028, 0.058, 0.028], 'steel', [HALF_PI, 0, angle]);
  }
  add('Gadget top junction plate', 'cylinder', place([0, 1.72, 0]), [0.6, 0.045, 0.6], 'steel');
  for (const side of [-1, 1]) {
    beam('Suspension sling', place([side * 0.63, 0.8, 0]), place([side * 0.14, 2.03, 0]), 0.038, 'steel');
  }
  add('Hoist shackle', 'ring', place([0, 2.07, 0]), [0.15, 0.21, 0.25], 'steel');
  beam('Suspension cable', place([0, 2.28, 0]), place([0, 3.25, 0]), 0.026, 'steel');
  for (const part of builder.parts.slice(firstPart)) {
    part.motionGroup = 'gadget';
    part.motionPivot = place([0, 3.25, 0]);
  }
}

function createGadget(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  add('Assembly shed floor', 'box', [0, -0.12, 0], [10, 0.2, 12], 'wood');
  add('Dark shed rear wall', 'box', [0, 3, -4.6], [10, 6, 0.14], 'black');
  for (let index = 0; index < 28; index++) {
    add('Rough vertical wall plank', 'box', [-4.8 + index * 0.36, 2.7, -4.43], [0.31, 5.4, 0.07], 'wood');
  }
  for (const horizontal of [-2, 2]) {
    add('Heavy assembly gantry upright', 'box', [horizontal, 2.75, -1.3], [0.18, 5.5, 0.22], 'steel');
    beam('Gantry diagonal strut', [horizontal, 1.2, -1.3], [horizontal * 0.5, 5.5, -1.3], 0.038, 'steel');
  }
  add('Assembly gantry crossbar', 'box', [0, 5.5, -1.3], [4.5, 0.24, 0.24], 'steel');
  add('Slender side window', 'box', [-3.45, 3.25, -4.29], [1, 3.6, 0.025], 'window');
  for (let index = 0; index < 11; index++) {
    add('Shed window slat', 'box', [-3.45, 1.6 + index * 0.31, -4.24], [1.1, 0.065, 0.075], 'wood');
  }
  addGadget(builder, [0, 2.25, -1.3]);
  for (let index = 0; index < 10; index++) {
    add('Spare wire coil', 'thinRing', [-1.6 + index % 3 * 0.22, 0.04 + index * 0.006, 1.1], [0.25, 0.22, 0.4], 'graphite', [HALF_PI, 0, 0]);
  }
  return builder.parts;
}

function createControl(meshes) {
  const builder = createBuilder(meshes);
  const { add, beam } = builder;
  addRoom(builder, true);
  add('Detonator console', 'box', [0, 1.06, 0], [2.8, 0.38, 1.35], 'olive');
  for (let index = 0; index < 5; index++) {
    const horizontal = -1 + index * 0.5;
    add('Analog voltmeter bezel', 'ring', [horizontal, 1.266, -0.12], [0.19, 0.19, 0.19], 'steel', [HALF_PI, 0, 0]);
    add('Ivory meter face', 'cylinder', [horizontal, 1.26, -0.12], [0.177, 0.014, 0.177], 'paper');
    beam('Meter pointer', [horizontal, 1.277, -0.12], [horizontal - 0.08, 1.277, -0.02], 0.006, 'graphite');
    add('Console switch', 'cylinder', [horizontal, 1.32, 0.35], [0.035, 0.1, 0.035], 'steel');
    add('Signal pilot light', 'sphere', [horizontal, 1.29, -0.48], [0.028, 0.019, 0.028], 'amber');
    for (let mark = 0; mark < 18; mark++) {
      const angle = 0.18 + mark * 0.15;
      const start = [horizontal + Math.cos(angle) * 0.14, 1.278, -0.12 + Math.sin(angle) * 0.14];
      const end = [horizontal + Math.cos(angle) * 0.12, 1.278, -0.12 + Math.sin(angle) * 0.12];
      beam('Engraved meter scale', start, end, 0.002, 'graphite');
    }
    add('Instrument label plate', 'box', [horizontal, 1.258, 0.12], [0.23, 0.008, 0.06], 'paper');
  }
  add('Red firing button', 'cylinder', [0.9, 1.31, 0.38], [0.12, 0.065, 0.12], 'copper');
  addScientist(builder, [0, 0, -1.5], false, 0.65);
  return builder.parts;
}

function createPortrait(meshes) {
  const builder = createBuilder(meshes);
  addDesert(builder);
  addScientist(builder, [0, 0, 0], true, -0.22);
  const distantTower = createDesert(meshes).filter(part =>
    part.name.startsWith('Test tower') || part.name.startsWith('Tower') || part.name === 'Suspended test vessel');
  for (const part of distantTower) {
    part.matrix[12] += 15;
    part.matrix[14] -= 55;
    builder.parts.push(part);
  }
  return builder.parts;
}

function createSparks(meshes) {
  const builder = createBuilder(meshes);
  for (let index = 0; index < 480; index++) {
    const angle = index * 2.399963;
    const radius = 0.15 + (index % 67) / 67 * 5.7;
    const start = [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.65, Math.sin(index * 1.31) * 2.5];
    const end = [start[0] * 1.08, start[1] * 1.08 + 0.015, start[2] + 0.04];
    builder.beam('Incandescent particle streak', start, end, 0.005 + index % 4 * 0.003, index % 7 ? 'particle' : 'core');
  }
  return builder.parts;
}

function animateSet(parts, sceneName) {
  const animateActors = createFilmActorRig(parts, sceneName);
  const animatePhysics = sceneName === 'apparatus' ? createCradleAnimation(parts) : null;
  const moving = parts.filter(part =>
    sceneName === 'sparks' || sceneName === 'atom' ||
    (sceneName === 'waves' && part.name !== 'Black reflecting pool') ||
    Boolean(part.motionGroup) || part.name === 'Meter pointer' || part.name === 'Signal pilot light');
  const bases = moving.map(part => new Float32Array(part.matrix));
  const pivots = moving.map((part, index) => part.motionPivot ?? [bases[index][12] + 0.04, bases[index][13], bases[index][14] - 0.05]);
  const inversePivots = pivots.map(pivot => pivot.map(value => -value));
  const transform = mat4.create();
  const waveScale = [1, 1, 1];
  for (const part of moving) {
    if (part.name === 'Signal pilot light') part.material = { ...materials.amber };
  }
  return function animate(time) {
    animateActors(time);
    animatePhysics?.(time);
    moving.forEach((part, index) => {
      const base = bases[index];
      part.matrix.set(base);
      if (sceneName === 'sparks') {
        const cycle = (time * 0.27 + index * 0.037) % 1;
        const expansion = 0.12 + cycle * 1.65;
        part.matrix[12] = base[12] * expansion;
        part.matrix[13] = base[13] * expansion - cycle * cycle * 1.4;
        part.matrix[14] = base[14] + cycle * 2;
      } else if (sceneName === 'atom') {
        mat4.fromYRotation(transform, time * 0.13);
        mat4.multiply(part.matrix, transform, base);
      } else if (sceneName === 'waves') {
        const expansion = 1 + Math.sin(time * 0.65 + index * 0.12) * 0.07;
        waveScale[0] = expansion;
        waveScale[2] = expansion;
        mat4.scale(part.matrix, base, waveScale);
        part.matrix[13] += Math.sin(time * 1.2 + index * 0.22) * 0.006;
      } else if (part.motionGroup === 'gadget') {
        mat4.fromTranslation(transform, pivots[index]);
        mat4.rotateZ(transform, transform, Math.sin(time * 0.82) * 0.012);
        mat4.translate(transform, transform, inversePivots[index]);
        mat4.multiply(part.matrix, transform, base);
      } else if (part.motionGroup === 'vehicle') {
        part.matrix[14] += Math.sin(time * 0.065) * 1.8;
        part.matrix[13] += Math.sin(time * 5) * 0.012;
      } else if (part.name === 'Meter pointer') {
        mat4.fromTranslation(transform, pivots[index]);
        mat4.rotateY(transform, transform, Math.sin(time * 1.7 + index) * 0.25);
        mat4.translate(transform, transform, inversePivots[index]);
        mat4.multiply(part.matrix, transform, base);
      } else if (part.name === 'Signal pilot light') {
        part.material.emission = 1.8 + Math.sin(time * 2 + index * 0.7) * 0.6;
      } else {
        part.matrix[13] += Math.sin(time * 0.8) * 0.003;
      }
    });
  };
}

export function createFilmScenes() {
  const meshes = {
    hair: sampledSurface(96, 48, sampleScientistHair),
    box: box(0.025, 2),
    head: createScientistHeadMesh(),
    hatCrown: createFedoraCrown(),
    hatBrim: createFedoraBrim(),
    coat: createCoat(),
    lapel: extrude([[0.035, 0.15], [0.085, 0.13], [0.115, 0.085], [0.087, 0.066], [0.121, 0.03], [0.014, -0.15], [0.012, 0.025]], { depth: 0.003, bevel: 0.0007, bevelSegments: 2 }),
    shirtCollar: extrude([[0.009, 0.04], [0.05, 0.02], [0.059, -0.005], [0.025, -0.025]], { depth: 0.003, bevel: 0.0005, bevelSegments: 2 }),
    landscape: createLandscape(),
    ridge: createRidge(),
    cylinder: cylinder(16, 0.02, 2),
    bolt: cylinder(6, 0.03, 1),
    sphere: sphere(32, 20),
    rock: sphere(12, 8),
    ring: torus(0.055, 64, 8),
    thinRing: torus(0.008, 96, 6),
    tire: torus(0.25, 48, 12),
  };
  const studio = {
    fogColor: [0.014, 0.018, 0.018], fogDensity: 0.011,
    skyTop: [0.024, 0.035, 0.035], skyBottom: [0.1, 0.12, 0.11],
    lightDirection: [-0.4, 0.8, 0.5], daylight: 0.65,
  };
  const interior = {
    ...studio, fogDensity: 0, daylight: 0.75,
    skyTop: [0.12, 0.17, 0.18], skyBottom: [0.22, 0.23, 0.18],
    lightDirection: [-0.35, 0.55, -0.85],
    volumeFog: {
      density: 0.065, minimum: [-5.7, 0.03, -4.7], maximum: [5.7, 4.5, 5.5],
      color: [0.9, 0.83, 0.7], ambient: [0.02, 0.025, 0.03],
      anisotropy: 0.45, noiseAmount: 0.35, noiseScale: 0.4, drift: [0.025, 0.01, 0], steps: 24, maxDistance: 15,
    },
    keyIntensity: 0.7,
    fillIntensity: 0.35,
    ambientIntensity: 0.45,
    pointLights: [-2.8, 0, 2.8].map(horizontal => ({
      position: [horizontal, 3.34, -1], color: [1, 0.71, 0.43], intensity: 18, range: 9, radius: 0.08,
    })),
  };
  const desert = {
    fogColor: [0.25, 0.20, 0.13], fogDensity: 0.0035,
    skyTop: [0.11, 0.28, 0.38], skyBottom: [0.64, 0.57, 0.39],
    lightDirection: [-0.8, 0.29, -0.48], daylight: 1.05,
  };
  const night = {
    fogColor: [0.004, 0.007, 0.012], fogDensity: 0.007,
    skyTop: [0.035, 0.057, 0.083], skyBottom: [0.16, 0.19, 0.23],
    lightDirection: [-0.5, 0.6, 0.5], daylight: 0.24,
  };
  const desertShadows = { extent: 55, target: [0, 6, 0], eye: [-35, 45, 35], near: 1, far: 140 };
  const set = (parts, environment, shadowBounds, name) => ({ parts, environment, ground: false, ...(shadowBounds ? { shadowBounds } : {}), ...(name ? { animate: animateSet(parts, name) } : {}) });
  const towerParts = createDesert(meshes);
  const towerBuilder = createBuilder(meshes);
  addGadget(towerBuilder, [0, 11.3, 0]);
  towerParts.push(...towerBuilder.parts);
  return {
    apparatus: set(createApparatus(meshes), { ...studio, pointLights: [{ position: [0, 1.8, 2.5], color: [0.6, 0.75, 1], intensity: 1.8, radius: 0.15, range: 4 }] }, undefined, 'apparatus'),
    office: set(createOffice(meshes), { ...interior, pointLights: [...interior.pointLights, { position: [-1.45, 1.36, 0.25], color: [1, 0.82, 0.57], intensity: 1.8, range: 3, radius: 0.08 }] }, { extent: 7, target: [0, 1.6, -1], eye: [-4, 7, -10], near: 0.1, far: 30 }, 'office'),
    laboratory: set(createOffice(meshes, true), interior, { extent: 7, target: [0, 1.6, -1], eye: [-4, 7, -10], near: 0.1, far: 30 }, 'laboratory'),
    settlement: set(createSettlement(meshes), desert, desertShadows, 'settlement'),
    portrait: set(createPortrait(meshes), { ...desert, lightDirection: [-0.7, 0.55, 0.8] }, { extent: 6, target: [0, 1, 0], eye: [-8, 5, 6], near: 0.1, far: 35 }, 'portrait'),
    gadget: set(createGadget(meshes), { ...interior, volumeFog: { density: 0 }, lightDirection: [-0.8, 0.4, 0.5], daylight: 0.9 }, { extent: 5, target: [0, 2.5, -1], eye: [-8, 7, 4], near: 0.1, far: 30 }, 'gadget'),
    control: set(createControl(meshes), interior, { extent: 7, target: [0, 1.6, -1], eye: [-4, 7, -10], near: 0.1, far: 30 }, 'control'),
    atom: set(createAtom(meshes), { ...studio, daylight: 0.25, fogDensity: 0.035 }, undefined, 'atom'),
    waves: set(createWaveChamber(meshes), studio, undefined, 'waves'),
    sparks: set(createSparks(meshes), { ...night, daylight: 0.1 }, undefined, 'sparks'),
    desert: set(towerParts, desert, desertShadows, 'desert'),
    night: set(towerParts, night, desertShadows, 'night'),
    ignition: set(createIgnition(meshes), night, desertShadows),
  };
}

// Camera endpoints belong to shots; reused sets never carry playback state.
function shot(start, end, scene, eye, nextEye, target, nextTarget = target, fov = [40, 38], monochrome = 0, exposure = 0.95) {
  const duration = end - start;
  const channel = (first, last) => ({ interpolation: 'SMOOTH', keyframes: [
    { time: 0, value: first },
    { time: duration, value: last },
  ] });
  let eyeChannel = channel(eye, nextEye);
  if (['atom', 'gadget'].includes(scene)) {
    const horizontalTravel = nextEye[0] - eye[0];
    const depthTravel = nextEye[2] - eye[2];
    const midpoint = eye.map((value, axis) => (value + nextEye[axis]) / 2);
    midpoint[0] -= depthTravel * 0.14;
    midpoint[2] += horizontalTravel * 0.14;
    const tangent = eye.map((value, axis) => (nextEye[axis] - value) * 1.5 / duration);
    eyeChannel = { interpolation: 'CUBICSPLINE', keyframes: [
      { time: 0, value: eye, inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
      { time: duration / 2, value: midpoint, inTangent: tangent, outTangent: tangent },
      { time: duration, value: nextEye, inTangent: [0, 0, 0], outTangent: [0, 0, 0] },
    ] };
  }
  const cameraPath = createCameraPath({
    duration,
    eye: eyeChannel,
    target: channel(target, nextTarget),
    fov: channel(fov[0], fov[1]),
    far: 600,
  });
  return { start, end, scene, eye: [eye, nextEye], target: [target, nextTarget], fov, monochrome, exposure, cameraPath };
}

export const FILM_SHOTS = [
  shot(0, 7, 'apparatus', [0.45, 0.85, 4.6], [-0.1, 0.8, 4.2], [0, 0.55, 1.72], [0, 0.52, 1.72], [38, 38], 0.2),
  shot(7, 13, 'control', [1.8, 2.2, 2.2], [1.4, 1.9, 1.8], [0.3, 1.25, 0], [0.1, 1.25, 0], [35, 32]),
  shot(13, 20, 'apparatus', [-3.5, 1.8, 3.4], [-2.8, 1.3, 2.7], [-0.5, 0.5, 0], [0, 0.5, 0], [43, 40]),
  shot(20, 29, 'office', [2.4, 1.75, 0.6], [1.85, 1.72, 0.25], [-0.22, 1.52, -1.7], [-0.18, 1.56, -1.7], [30, 29]),
  shot(29, 34, 'sparks', [0, 0.3, 7], [0.6, 0.5, 6], [0, 0, 0], [0.2, 0, 0], [47, 45]),
  shot(34, 39, 'laboratory', [-3, 2.1, 3.7], [-2.5, 1.7, 2.8], [0, 1.25, 0], [0.4, 1.4, -0.5], [43, 39]),
  shot(39, 45, 'desert', [48, 2.1, 66], [43, 2.4, 60], [-12, 5.8, 0], [-10, 5.9, 0], [38, 37]),
  shot(45, 56, 'settlement', [0, 3.6, 54], [0.6, 2.8, 41], [1, 1.5, -9], [1, 1.5, -12], [41, 40]),
  shot(56, 64, 'settlement', [5.8, 1.2, 15], [4.8, 1.1, 13.5], [1, 0.8, 8.8], [1, 0.85, 9.2], [38, 36]),
  shot(64, 73, 'settlement', [8.4, 1.45, 10.8], [7.5, 1.5, 9.7], [4.5, 1.1, 5.7], [4.5, 1.2, 5.7], [33, 31]),
  shot(73, 85, 'office', [-3.1, 1.55, -0.5], [-2.6, 1.65, -0.8], [0.1, 1.38, -1.7], [0.1, 1.45, -1.7], [34, 32], 1),
  shot(85, 91, 'waves', [-2.8, 0.8, 4.2], [-1.8, 0.65, 3.8], [-0.3, 0, 0], [0.2, 0.02, 0], [40, 37], 0.4),
  shot(91, 98, 'atom', [0.5, 0.3, 6.8], [4.8, 2.5, 5.1], [0, 0, 0], [0, 0, 0], [48, 43]),
  shot(98, 105, 'gadget', [2.8, 3.1, 3.2], [2.2, 2.8, 2.6], [0, 2.25, -1.3], [0, 2.4, -1.3], [36, 32]),
  shot(105, 110, 'office', [1.25, 1.71, -0.95], [1.05, 1.71, -1.05], [0, 1.66, -1.7], [0, 1.66, -1.7], [30, 29], 1),
  shot(110, 118, 'desert', [4.7, 9.1, 6.2], [3.8, 10, 4.8], [0, 11, 0], [0, 11.3, 0], [36, 31]),
  shot(118, 126, 'gadget', [-1.6, 2.9, 1.4], [-1.2, 2.7, 1], [0, 2.5, -1.3], [0.1, 2.4, -1.3], [33, 30]),
  shot(126, 133, 'laboratory', [3.6, 2.2, 3.4], [2.8, 1.8, 2.6], [1.2, 1.4, -1.1], [1, 1.6, -1.4], [40, 35]),
  shot(133, 140, 'control', [-1.5, 2.1, 1.9], [-0.8, 1.8, 1.4], [0, 1.25, 0], [0.3, 1.25, 0], [35, 32]),
  shot(140, 145, 'desert', [16, 0.55, 25], [14, 0.7, 22], [0, 6.5, 0], [0, 7, 0], [40, 39]),
  shot(145, 154, 'portrait', [-0.4, 1.7, 3.7], [-0.2, 1.7, 3.3], [0.27, 1.48, 0], [0.28, 1.51, 0], [30, 28]),
  shot(154, 161, 'night', [50, 1.7, 74], [46, 2, 68], [-12, 6, 0], [-10, 6, 0], [38, 37], 0.1, 1.05),
  shot(161, 165, 'portrait', [0, 1.74, 1.8], [0.12, 1.74, 1.65], [0.12, 1.69, 0], [0.15, 1.69, 0], [28, 27]),
  shot(165, 168, 'control', [1.35, 1.85, 1.65], [1.1, 1.65, 1.3], [0.8, 1.27, 0.28], [0.85, 1.27, 0.3], [32, 28]),
  shot(168, 170, 'gadget', [1.7, 2.5, 0.8], [1.5, 2.5, 0.6], [0, 2.4, -1.3], [0, 2.4, -1.3], [30, 28]),
  shot(170, 172, 'sparks', [-0.3, 0.2, 5], [0.2, 0.1, 4.6], [0, 0, 0], [0, 0, 0], [45, 43]),
  shot(172, 174, 'night', [5, 10, 7], [4.5, 10.4, 6.5], [0, 11.3, 0], [0, 11.3, 0], [35, 32]),
  shot(174, 176, 'office', [1.2, 1.72, -0.95], [1.05, 1.72, -1.08], [0, 1.66, -1.7], [0, 1.66, -1.7], [30, 29], 1),
  shot(176, 178, 'control', [-0.3, 1.9, 1.5], [0.2, 1.8, 1.35], [0, 1.26, 0], [0.1, 1.26, 0], [32, 29]),
  shot(178, 179.5, 'sparks', [0, 0, 4.5], [0.3, 0.1, 4.1], [0, 0, 0], [0, 0, 0], [44, 42]),
  shot(179.5, 181, 'night', [28, 5, 38], [26, 5.5, 36], [0, 9, 0], [0, 9, 0], [42, 40]),
  shot(181, 184, 'ignition', [13, 5, 18], [16, 8, 22], [0, 6, 0], [0, 10, 0], [48, 51], 0, 0.85),
  shot(184, 187, 'ignition', [20, 10, 28], [23, 12, 32], [0, 12, 0], [0, 12, 0], [51, 53], 0, 0.85),
];

function smoothstep(value) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

export function sampleFilm(time, { aspect = 16 / 9 } = {}) {
  if (!Number.isFinite(time)) throw new TypeError('Film time must be finite.');
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError('Film aspect must be positive and finite.');
  const boundedTime = Math.max(0, Math.min(FILM_DURATION, time));
  const shotIndex = FILM_SHOTS.findIndex(candidate => boundedTime < candidate.end);
  const selected = FILM_SHOTS[shotIndex < 0 ? FILM_SHOTS.length - 1 : shotIndex];
  const camera = selected.cameraPath.sample(boundedTime - selected.start);
  if (aspect < 16 / 9) {
    if (selected.scene === 'portrait') {
      const bounds = selected.start === 145
        ? { minimum: [-0.38, 0, -0.2], maximum: [0.38, 2, 0.25] }
        : { minimum: [-0.27, 1.22, -0.2], maximum: [0.27, 2, 0.25] };
      const direction = vec3.subtract([], camera.eye, camera.target);
      const authoredDistance = Math.hypot(...direction);
      vec3.scale(direction, direction, 1 / authoredDistance);
      const center = bounds.minimum.map((value, axis) => (value + bounds.maximum[axis]) / 2);
      const fittingView = { ...camera, target: center, eye: center.map((value, axis) => value + direction[axis] * authoredDistance) };
      const distance = Math.max(authoredDistance, fitPerspectiveDistance(bounds, fittingView, aspect, 1.1));
      const framingAmount = Math.min(1, (16 / 9 - aspect) / (16 / 9 - 1));
      const framedDistance = authoredDistance + (distance - authoredDistance) * framingAmount;
      camera.target = camera.target.map((value, axis) => value + (center[axis] - value) * framingAmount);
      camera.eye = camera.target.map((value, axis) => value + direction[axis] * framedDistance);
    } else {
      camera.fov = Math.atan(Math.tan(camera.fov * Math.PI / 360) * (16 / 9) / aspect) * 360 / Math.PI;
      if (!Number.isFinite(camera.fov) || camera.fov >= 180) {
        throw new RangeError('Film aspect exceeds the supported lens range.');
      }
    }
  }
  const ignitionTime = boundedTime - 181;
  const flash = ignitionTime >= 0 && ignitionTime < 0.7 ? Math.exp(-ignitionTime * 7) : 0;
  const visibility = smoothstep(boundedTime / 0.8) * (1 - smoothstep((boundedTime - 185.8) / 1.2));
  const titleVisible = boundedTime >= 183.3;
  return {
    scene: selected.scene,
    shotIndex: shotIndex < 0 ? FILM_SHOTS.length - 1 : shotIndex,
    camera,
    exposure: selected.exposure + flash * 1.5,
    monochrome: selected.monochrome,
    fade: 1 - visibility,
    title: titleVisible ? 'OPPENHEIMER' : '',
    subtitle: titleVisible ? 'A 67js trailer study' : '',
    time: boundedTime,
    sceneTime: boundedTime - FILM_SHOTS.find(candidate => candidate.scene === selected.scene).start,
    explosionProgress: selected.scene === 'ignition' ? smoothstep(ignitionTime / 1.7) : 0,
    flash,
    titleOpacity: titleVisible ? smoothstep((boundedTime - 183.3) / 0.65) * visibility : 0,
    effects: {
      bloom: { strength: selected.scene === 'sparks' || selected.scene === 'atom' ? 0.3 : 0.12 },
      saturation: 0.72,
      contrast: 1.14,
      temperature: selected.scene === 'night' ? -0.08 : 0.035,
      vignette: 0.12,
      grain: 0.018,
    },
  };
}

// The two soft body films of docs/physics.md: a jelly cube landing and a flag lowered into folds on itself.
// Each is one recipe. The film test and the preview script both bake that recipe, so what is measured is what is rendered.
import { createHash } from 'node:crypto';
import '../tests/support/load-agent-scene-modules.mjs';
import { createAgentScene } from '../src/agent-scene.js';

export const FILM_FRAMES_PER_SECOND = 60;
const FLOOR_THICKNESS = 0.01;
const GROUND_NODE = { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.5, 0], scale: [8, 1, 8] };
const CAMERA = { fov: 34 };

function baseRecipe({ geometries, materials, nodes, motion, cloth, camera, floorColor = [0.55, 0.55, 0.58], environment }) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [...geometries, { id: 'floor', type: 'box', bevel: 0 }],
    materials: [...materials, { id: 'stone', color: floorColor }],
    nodes: [...nodes, GROUND_NODE],
    camera: { ...CAMERA, ...camera },
    motion,
    cloth,
    ...(environment ? { environment } : {}),
  };
}

/** A rounded jelly cube, 0.5 m across, dropped from 1.95 m above the floor. */
export function jellyCubeRecipe() {
  return baseRecipe({
    geometries: [{ id: 'jelly', type: 'box', bevel: 0.12, subdivisions: 3 }],
    materials: [{ id: 'gel', color: [0.25, 0.85, 0.45] }],
    nodes: [
      { id: 'cube', geometry: 'jelly', material: 'gel', translation: [0, 2.2, 0], scale: [0.5, 0.5, 0.5] },
      { id: 'clock' },
    ],
    // A recipe needs authored motion before a render job accepts a start time; the cloth bake reads the same clock.
    motion: { duration: 2, loop: false, tracks: [{ kind: 'node', id: 'clock', property: 'translation', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [0, 0, 0] }] }] },
    camera: { eye: [0.45, 0.22, 1.75], target: [0, 0.3, 0] },
    cloth: {
      duration: 2,
      sheets: [{ node: 'cube', softBody: { shape: 0.15, pressure: 1 }, stiffness: 0.9, bend: 0, damping: 2 }],
      colliders: [{ node: 'ground', shape: 'box' }],
    },
  });
}

// The pole's path: a side to side swing on the way down so the sheet ripples, a landing, then a pull across the floor that gathers
// the cloth into a crumpled ridge and flattens the rest into a thin layer.
const POLE_KEYFRAMES = [
  { time: 0, value: [0, 2.6, 0] },
  { time: 0.2, value: [0.1, 2.5, 0.3] },
  { time: 0.4, value: [-0.1, 2.1, -0.3] },
  { time: 0.6, value: [0.12, 1.7, 0.35] },
  { time: 0.8, value: [-0.1, 1.2, -0.3] },
  { time: 1.0, value: [0.1, 0.7, 0.3] },
  { time: 1.3, value: [0, 0.012, 0.9] },
  { time: 2.2, value: [0, 0.012, 2] },
  { time: 4, value: [0, 0.012, 2] },
];
export const FLAG_FILM_SECONDS = 4;
// A dark saturated cloth on a mid grey floor, lit by a low key from the side so every fold casts a shadow.
const FLAG_LOOK = { lightDirection: [-0.9, 0.45, 0.55], keyIntensity: 1.6, fillIntensity: 0.15, ambientIntensity: 0.25 };

/**
 * A flag hung from a pole by its top edge. The pole swings from side to side while it falls, so the sheet ripples, lands on the floor and
 * drags the cloth into a crumpled ridge on a thin layer. The sheet sets thickness 3.5 mm, which also sets the self collision radius,
 * so layers stack 6 mm apart instead of 3.7 cm.
 */
export function foldingFlagRecipe({ selfCollision = true } = {}) {
  return baseRecipe({
    geometries: [{ id: 'flag', type: 'grid', segments: 30 }],
    materials: [{ id: 'fabric', color: [0.62, 0.05, 0.1], doubleSided: true }],
    nodes: [
      { id: 'flag', geometry: 'flag', material: 'fabric', translation: [0, 2.1, 0], scale: [1.6, 1, 1] },
      { id: 'pole', translation: [0, 2.6, 0] },
    ],
    motion: { duration: FLAG_FILM_SECONDS, loop: false, tracks: [{ kind: 'node', id: 'pole', property: 'translation', interpolation: 'LINEAR', keyframes: POLE_KEYFRAMES }] },
    camera: { eye: [1.1, 1.1, 4.3], target: [0, 0.75, 0.9] },
    floorColor: [0.4, 0.4, 0.42],
    environment: FLAG_LOOK,
    cloth: {
      duration: FLAG_FILM_SECONDS,
      sheets: [{ node: 'flag', pin: ['top'], pinTo: { node: 'pole' }, selfCollision, stiffness: 0.6, bend: 0.001, damping: 2.5, friction: 0.25, thickness: 0.003 }],
      colliders: [{ node: 'ground', shape: 'box' }],
    },
  });
}

/**
 * How far the sheet's triangles face different ways: 0 for a flat sheet, toward 1 as the normals scatter. A triangle's normal is
 * taken up to its sign (a cloth has two faces), summed, and the length of that sum over the triangle count is taken from 1.
 */
export function normalSpread(vertices, indices) {
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let counted = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const a = indices[corner] * 3;
    const b = indices[corner + 1] * 3;
    const c = indices[corner + 2] * 3;
    const edgeOne = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]];
    const edgeTwo = [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]];
    let normalX = edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1];
    let normalY = edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2];
    let normalZ = edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0];
    const length = Math.hypot(normalX, normalY, normalZ);
    if (length < 1e-12) continue;
    const sign = normalZ < 0 ? -1 / length : 1 / length;
    normalX *= sign;
    normalY *= sign;
    normalZ *= sign;
    sumX += normalX;
    sumY += normalY;
    sumZ += normalZ;
    counted++;
  }
  return counted === 0 ? 0 : 1 - Math.hypot(sumX, sumY, sumZ) / counted;
}

/** The cloth node's vertices at `time` in world space (the recipe nodes use translation and scale only), as a copy. */
export function clothVertices(scene, node, time) {
  scene.sampleMotion(time);
  const local = scene.parts.find(part => part.name === node.id).geometry.positions;
  const world = new Float32Array(local.length);
  for (let index = 0; index < local.length; index++) {
    world[index] = local[index] * node.scale[index % 3] + node.translation[index % 3];
  }
  return world;
}

/**
 * Bakes a recipe and samples every frame. Returns the world vertex buffer of each frame, a hash of each frame, and
 * the milliseconds of the whole bake (scene creation plus the first sample) and of every later sample.
 */
export function recordFilm(recipe, nodeId, frameCount) {
  const node = recipe.nodes.find(candidate => candidate.id === nodeId);
  const started = performance.now();
  const scene = createAgentScene(recipe);
  const frames = [clothVertices(scene, node, 0)];
  const bakeMilliseconds = performance.now() - started;
  const sampleMilliseconds = [];
  for (let frame = 1; frame < frameCount; frame++) {
    const sampleStarted = performance.now();
    frames.push(clothVertices(scene, node, frame / FILM_FRAMES_PER_SECOND));
    sampleMilliseconds.push(performance.now() - sampleStarted);
  }
  const hashes = frames.map(frame => createHash('sha256').update(Buffer.from(frame.buffer)).digest('hex'));
  return { frames, hashes, bakeMilliseconds, sampleMilliseconds };
}

/** Lowest, highest and extent of a vertex buffer along one axis (0 x, 1 y, 2 z). */
export function axisRange(vertices, axis) {
  let low = Infinity;
  let high = -Infinity;
  for (let index = axis; index < vertices.length; index += 3) {
    low = Math.min(low, vertices[index]);
    high = Math.max(high, vertices[index]);
  }
  return { low, high, extent: high - low };
}

/** The frame where the body first rests on the floor, with the dent measured from there on. */
export function measureLanding(frames, restHeight) {
  const lowest = frame => axisRange(frame, 1).low;
  const contact = frames.findIndex(frame => lowest(frame) <= FLOOR_THICKNESS + 1e-3);
  if (contact === -1) {
    throw new Error(`measureLanding: the body never reached the floor within ${frames.length} frames; pass a longer film or lower the drop.`);
  }
  let deepest = contact;
  let deepestHeight = Infinity;
  for (let frame = contact; frame < frames.length; frame++) {
    const height = axisRange(frames[frame], 1).extent;
    if (height < deepestHeight) {
      deepestHeight = height;
      deepest = frame;
    }
  }
  return { contact, maxDentFrame: deepest, maxDentDepth: restHeight - deepestHeight, restHeight };
}

/** Smallest distance between two vertices that no triangle edge joins: the closest two layers of a fold come. */
export function unjoinedMinimumDistance(vertices, indices) {
  const count = vertices.length / 3;
  const joined = new Set();
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (let side = 0; side < 3; side++) {
      const first = indices[corner + side];
      const second = indices[corner + (side + 1) % 3];
      joined.add(Math.min(first, second) * count + Math.max(first, second));
    }
  }
  let minimum = Infinity;
  for (let first = 0; first < count; first++) {
    for (let second = first + 1; second < count; second++) {
      if (joined.has(first * count + second)) continue;
      const distance = Math.hypot(vertices[first * 3] - vertices[second * 3], vertices[first * 3 + 1] - vertices[second * 3 + 1], vertices[first * 3 + 2] - vertices[second * 3 + 2]);
      minimum = Math.min(minimum, distance);
    }
  }
  return minimum;
}

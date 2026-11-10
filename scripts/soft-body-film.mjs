// The two soft body films of docs/physics.md: a jelly cube landing and a flag lowered into folds on itself.
// Each is one recipe. The film test and the preview script both bake that recipe, so what is measured is what is rendered.
import { createHash } from 'node:crypto';
import '../tests/support/load-agent-scene-modules.mjs';
import { createAgentScene } from '../src/agent-scene.js';

export const FILM_FRAMES_PER_SECOND = 60;
const FLOOR_THICKNESS = 0.01;
const GROUND_NODE = { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.5, 0], scale: [8, 1, 8] };
const CAMERA = { fov: 34 };

function baseRecipe({ geometries, materials, nodes, motion, cloth, camera }) {
  return {
    format: '67js.scene', schemaVersion: 1,
    geometries: [...geometries, { id: 'floor', type: 'box', bevel: 0 }],
    materials: [...materials, { id: 'stone', color: [0.55, 0.55, 0.58] }],
    nodes: [...nodes, GROUND_NODE],
    camera: { ...CAMERA, ...camera },
    motion,
    cloth,
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

// The pole's path: a swing out and down so the flag ripples, a drag across the floor to lay it flat, then a short push back that crumples the near end.
const POLE_KEYFRAMES = [
  { time: 0, value: [0, 2.6, 0] },
  { time: 0.3, value: [0, 2.6, 0] },
  { time: 0.9, value: [0.25, 1.2, 0.4] },
  { time: 1.5, value: [0, 0.012, 1] },
  { time: 2.2, value: [0, 0.012, 1.3] },
  { time: 3.2, value: [0, 0.012, 0.9] },
  { time: 4, value: [0, 0.012, 0.9] },
];
export const FLAG_FILM_SECONDS = 4;

/**
 * A flag hung from a pole by its top edge. The pole swings down to the floor and drags the cloth flat, so it ends as a thin layer with
 * a fold. The sheet sets thickness 5 mm, which also sets the self collision radius, so layers stack 1 cm apart instead of 3.7 cm.
 */
export function foldingFlagRecipe({ selfCollision = true } = {}) {
  return baseRecipe({
    geometries: [{ id: 'flag', type: 'grid', segments: 24 }],
    materials: [{ id: 'fabric', color: [0.9, 0.2, 0.2], doubleSided: true }],
    nodes: [
      { id: 'flag', geometry: 'flag', material: 'fabric', translation: [0, 2.1, 0], scale: [1.6, 1, 1] },
      { id: 'pole', translation: [0, 2.6, 0] },
    ],
    motion: { duration: FLAG_FILM_SECONDS, loop: false, tracks: [{ kind: 'node', id: 'pole', property: 'translation', interpolation: 'LINEAR', keyframes: POLE_KEYFRAMES }] },
    camera: { eye: [1.1, 1.1, 4.3], target: [0, 0.75, 0.4] },
    cloth: {
      duration: FLAG_FILM_SECONDS,
      sheets: [{ node: 'flag', pin: ['top'], pinTo: { node: 'pole' }, selfCollision, stiffness: 0.9, bend: 0.01, damping: 2.5, friction: 0.25, thickness: 0.005 }],
      colliders: [{ node: 'ground', shape: 'box' }],
    },
  });
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
